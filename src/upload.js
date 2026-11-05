#!/usr/bin/env node
// npm run seed:upload
// Uploads <LearnLoop>/data/seed/*.json to the state bucket and the generated logs
// to the app-logs bucket and to the access-logs bucket under the distribution's
// standard-logging prefix. CloudFront files are regenerated with the real
// distribution id and domain, using the anchor, salt and seed of the last
// `npm run seed`.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { OUT_DIR } from './files.js';
import { runSeed } from './cli.js';
import { assertCloudfrontKeys, readStackOutputs, uploadTargets } from './stack.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const s3 = new S3Client({ region });

async function putAll(bucket, items, contentType) {
  let done = 0;
  const queue = [...items];
  await Promise.all(Array.from({ length: 16 }, async () => {
    while (queue.length) {
      const [key, body] = queue.shift();
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
      done += 1;
      if (done % 500 === 0) console.log(`seed:upload: ${done}/${items.length} to ${bucket}`);
    }
  }));
}

async function main() {
  const targets = uploadTargets(await readStackOutputs());
  const manifest = JSON.parse(await readFile(path.join(OUT_DIR, 'manifest.json'), 'utf8'));

  const secrets = new SecretsManagerClient({ region });
  const salt = (await secrets.send(new GetSecretValueCommand({ SecretId: targets.saltSecret }))).SecretString;
  if (salt !== manifest.salt) {
    throw new Error(`the salt used for \`npm run seed\` differs from the ${targets.saltSecret} secret; re-run the seed with the deployed salt`);
  }

  console.log(`seed:upload: generating logs for distribution ${targets.distributionId}`);
  const result = await runSeed(
    { ...manifest, distributionId: targets.distributionId, distributionDomain: targets.distributionDomain },
    { dataDir: manifest.dataDir },
  );
  // generated keys are "cloudfront/<id>.<hour>.<unique>.gz"; place them under the configured prefix
  const cloudfront = [...result.cloudfront].map(([key, body]) => [`${targets.cloudfrontPrefix}${key.slice('cloudfront/'.length)}`, body]);
  assertCloudfrontKeys(cloudfront.map(([k]) => k), targets.cloudfrontPrefix, targets.distributionId);

  const state = [];
  for (const file of (await readdir(manifest.dataDir)).filter((f) => f.endsWith('.json')).sort()) {
    state.push([`state/${file}`, await readFile(path.join(manifest.dataDir, file))]);
  }
  await putAll(targets.stateBucket, state, 'application/json');
  console.log(`seed:upload: ${state.length} state documents -> s3://${targets.stateBucket}/state/`);
  await putAll(targets.appLogsBucket, [...result.appLogs], 'application/x-ndjson');
  console.log(`seed:upload: ${result.appLogs.size} app log files -> s3://${targets.appLogsBucket}/app-logs/`);
  await putAll(targets.accessLogsBucket, cloudfront, 'application/gzip');
  console.log(`seed:upload: ${cloudfront.length} CloudFront log files -> s3://${targets.accessLogsBucket}/${targets.cloudfrontPrefix}`);
}

main().catch((error) => {
  console.error(`seed:upload: ${error.message}`);
  process.exitCode = 1;
});
