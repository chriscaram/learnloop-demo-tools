#!/usr/bin/env node
// npm run seed:upload
// Uploads <LearnLoop>/data/seed/*.json to the state bucket and the generated logs
// to the app-logs bucket and to the access-logs bucket under the distribution's
// standard-logging prefix. CloudFront files are regenerated with the real
// distribution id and domain, using the scenario, anchor, salt and seed of the last
// `npm run seed`.
//
// uploadObjects() is the shared part: the simulator (src/simulator/) uses it with its
// own S3 layer, so both paths put the same keys in the same places.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { OUT_DIR } from './files.js';
import { assertCloudfrontKeys } from './stack.js';

export const UPLOAD_CONCURRENCY = 16;

/** Put every [key, body] with a bounded number of requests in flight. */
export async function putAll(put, bucket, items, contentType, onProgress = () => {}) {
  let done = 0;
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
    while (queue.length) {
      const [key, body] = queue.shift();
      await put(bucket, key, body, contentType);
      done += 1;
      onProgress(done, items.length);
    }
  }));
  return done;
}

/**
 * The three upload sets, read back from disk so what is uploaded is exactly what the
 * generator wrote: state documents from `dataDir`, app logs and CloudFront files from
 * `outDir`. CloudFront keys are placed under the stack's logging prefix and checked.
 */
export async function uploadSets({ targets, dataDir, outDir }) {
  const state = [];
  for (const file of (await readdir(dataDir)).filter((f) => f.endsWith('.json')).sort()) {
    state.push([`state/${file}`, await readFile(path.join(dataDir, file))]);
  }
  const appLogs = [];
  const appRoot = path.join(outDir, 'app-logs');
  for (const entry of (await readdir(appRoot, { recursive: true, withFileTypes: true }))) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    appLogs.push([path.relative(outDir, full).split(path.sep).join('/'), await readFile(full)]);
  }
  appLogs.sort((a, b) => a[0].localeCompare(b[0]));
  const cloudfront = [];
  for (const file of (await readdir(path.join(outDir, 'cloudfront'))).filter((f) => f.endsWith('.gz')).sort()) {
    cloudfront.push([`${targets.cloudfrontPrefix}${file}`, await readFile(path.join(outDir, 'cloudfront', file))]);
  }
  assertCloudfrontKeys(cloudfront.map(([k]) => k), targets.cloudfrontPrefix, targets.distributionId);
  if (!appLogs.every(([k]) => k.startsWith('app-logs/'))) throw new Error('an application log key falls outside app-logs/');
  return { state, appLogs, cloudfront };
}

/** Upload the three sets. `put(bucket, key, body, contentType)` is the S3 layer. */
export async function uploadObjects({ targets, sets, put, onProgress = () => {} }) {
  const counts = {};
  counts.state = await putAll(put, targets.stateBucket, sets.state, 'application/json', (d, t) => onProgress('state', d, t));
  counts.appLogs = await putAll(put, targets.appLogsBucket, sets.appLogs, 'application/x-ndjson', (d, t) => onProgress('appLogs', d, t));
  counts.cloudfront = await putAll(put, targets.accessLogsBucket, sets.cloudfront, 'application/gzip', (d, t) => onProgress('cloudfront', d, t));
  return counts;
}

async function main() {
  const { PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
  const { runSeed } = await import('./cli.js');
  const { readStackOutputs, uploadTargets } = await import('./stack.js');
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const s3 = new S3Client({ region });

  const targets = uploadTargets(await readStackOutputs());
  const manifest = JSON.parse(await readFile(path.join(OUT_DIR, 'manifest.json'), 'utf8'));

  const secrets = new SecretsManagerClient({ region });
  const salt = (await secrets.send(new GetSecretValueCommand({ SecretId: targets.saltSecret }))).SecretString;
  if (salt !== manifest.salt) {
    throw new Error(`the salt used for \`npm run seed\` differs from the ${targets.saltSecret} secret; re-run the seed with the deployed salt`);
  }

  console.log(`seed:upload: generating logs for distribution ${targets.distributionId} (scenario ${manifest.scenario ?? 'lapsed-learners'})`);
  await runSeed(
    { ...manifest, distributionId: targets.distributionId, distributionDomain: targets.distributionDomain },
    { dataDir: manifest.dataDir },
  );
  const sets = await uploadSets({ targets, dataDir: manifest.dataDir, outDir: OUT_DIR });
  const put = (Bucket, Key, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }));
  const counts = await uploadObjects({
    targets, sets, put,
    onProgress: (target, done, total) => { if (done % 500 === 0 || done === total) console.log(`seed:upload: ${target} ${done}/${total}`); },
  });
  console.log(`seed:upload: ${counts.state} state documents -> s3://${targets.stateBucket}/state/`);
  console.log(`seed:upload: ${counts.appLogs} app log files -> s3://${targets.appLogsBucket}/app-logs/`);
  console.log(`seed:upload: ${counts.cloudfront} CloudFront log files -> s3://${targets.accessLogsBucket}/${targets.cloudfrontPrefix}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`seed:upload: ${error.message}`);
    process.exitCode = 1;
  });
}
