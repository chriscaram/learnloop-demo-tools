#!/usr/bin/env node
// npm run seed:upload
// Uploads <LearnLoop>/data/seed/*.json to the state bucket and the generated logs
// to the app-logs bucket and to the access-logs bucket under the distribution's
// standard-logging prefix. CloudFront files are regenerated with the real
// distribution id and domain, using the scenario, anchor, salt and seed of the last
// `npm run seed`.
//
// uploadObjects() and uploadState() are the shared part: the simulator (src/simulator/)
// uses them with its own S3 layer, so both paths put the same keys in the same places.
//
// The state documents: a single load, and stage 0 of a staged reveal, REPLACE them (as a
// load always did). Stages 1..n MERGE into the live documents instead (src/merge.js): they
// keep everything the app, the AI agents and the presenter wrote since the last load, add
// only the records the stage introduces, and report what they did not overwrite.
//
//   npm run seed:upload [-- --stack LearnLoopStaging]   (default LearnLoopProd)
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { OUT_DIR, formatJson } from './files.js';
import { assertCloudfrontKeys } from './stack.js';
import { mergeDomain } from './merge.js';

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

/** Whether a stage's state merges into the live state (stages 1..n) or replaces it (no stage, stage 0). */
export const mergesState = (stage) => stage !== null && stage !== undefined && stage >= 1;

/** The state set as documents: state/<domain>.json -> parsed value, keyed by domain. */
export function stateDocuments(stateSet) {
  return Object.fromEntries(stateSet.map(([key, body]) => [key.replace(/^state\//, '').replace(/\.json$/, ''), JSON.parse(String(body))]));
}

/** Reads the merge base (the state loaded before) written next to the logs, or null. */
export async function readStateDir(dir) {
  try {
    const out = {};
    for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()) out[file.replace(/\.json$/, '')] = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
    return out;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export const MAX_STATE_WRITE_ATTEMPTS = 2;
const isPreconditionFailed = (error) => error?.$metadata?.httpStatusCode === 412 || error?.name === 'PreconditionFailed' || error?.code === 'PreconditionFailed';

/**
 * Merge the stage's state documents into the live ones and write the merged documents back.
 * `getObject(bucket, key)` -> { body, etag } or null when the key does not exist;
 * `put(bucket, key, body, contentType, { ifMatch, ifNoneMatch })`. Every live document is
 * read before anything is written. A document is written only if the stage adds to it, and
 * only over the version that was read (If-Match on its ETag, the way LearnLoop itself
 * writes): if the app wrote it in between, it is read and merged again, at most
 * MAX_STATE_WRITE_ATTEMPTS times in all. `write: false` (a dry run) reads and reports only.
 */
export async function uploadState({ targets, stage, base, getObject, put, write = true, onDomain = () => {} }) {
  const key = (domain) => `state/${domain}.json`;
  const readLive = async (domain) => {
    const got = await getObject(targets.stateBucket, key(domain));
    if (!got) return { live: undefined, etag: null };
    try {
      return { live: JSON.parse(String(got.body)), etag: got.etag ?? null };
    } catch {
      throw new Error(`state/${domain}.json in s3://${targets.stateBucket} is not JSON; refusing to merge into it (nothing was written)`);
    }
  };
  const plans = [];
  for (const domain of Object.keys(stage).sort()) {
    const { live, etag } = await readLive(domain);
    plans.push({ domain, etag, result: mergeDomain(domain, { live, stage: stage[domain], base: base?.[domain] }) });
  }
  const results = [];
  for (const plan of plans) {
    let { result, etag } = plan;
    let written = false;
    if (write && result.written) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          await put(targets.stateBucket, key(plan.domain), formatJson(result.document), 'application/json', etag ? { ifMatch: etag } : { ifNoneMatch: '*' });
          written = true;
          break;
        } catch (error) {
          if (!isPreconditionFailed(error) || attempt >= MAX_STATE_WRITE_ATTEMPTS) {
            throw new Error(`state/${plan.domain}.json could not be written${isPreconditionFailed(error) ? ': the app kept changing it while it was merged' : ''} (${error.message})`);
          }
          const again = await readLive(plan.domain);
          etag = again.etag;
          result = mergeDomain(plan.domain, { live: again.live, stage: stage[plan.domain], base: base?.[plan.domain] });
          if (!result.written) break;
        }
      }
    }
    const out = { ...result, written, wouldWrite: result.written };
    delete out.document;
    results.push(out);
    onDomain(out);
  }
  return results;
}

/** Upload the three sets. `put(bucket, key, body, contentType)` is the S3 layer. `sets.state` may be empty (merged separately). */
export async function uploadObjects({ targets, sets, put, onProgress = () => {} }) {
  const counts = {};
  counts.state = await putAll(put, targets.stateBucket, sets.state, 'application/json', (d, t) => onProgress('state', d, t));
  counts.appLogs = await putAll(put, targets.appLogsBucket, sets.appLogs, 'application/x-ndjson', (d, t) => onProgress('appLogs', d, t));
  counts.cloudfront = await putAll(put, targets.accessLogsBucket, sets.cloudfront, 'application/gzip', (d, t) => onProgress('cloudfront', d, t));
  return counts;
}

async function main() {
  const { values } = parseArgs({ options: { stack: { type: 'string' }, 'replace-state': { type: 'boolean', default: false } } });
  const { GetObjectCommand, PutObjectCommand, S3Client } = await import('@aws-sdk/client-s3');
  const { GetSecretValueCommand, SecretsManagerClient } = await import('@aws-sdk/client-secrets-manager');
  const { runSeed } = await import('./cli.js');
  const { STACK_NAME, readStackOutputs, targetOf, uploadTargets } = await import('./stack.js');
  const { completeState } = await import('./files.js');
  const { stageState } = await import('./generate.js');
  const { getScenario, stageOf } = await import('./scenarios.js');
  const { mergeSentence } = await import('./merge.js');
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const s3 = new S3Client({ region });

  const stackName = values.stack ? targetOf(values.stack).stack : STACK_NAME;
  const targets = uploadTargets(await readStackOutputs(stackName, { region }));
  const manifest = JSON.parse(await readFile(path.join(OUT_DIR, 'manifest.json'), 'utf8'));

  const secrets = new SecretsManagerClient({ region });
  const salt = (await secrets.send(new GetSecretValueCommand({ SecretId: targets.saltSecret }))).SecretString;
  if (salt !== manifest.salt) {
    throw new Error(`the salt used for \`npm run seed\` differs from the ${targets.saltSecret} secret (stack ${stackName}); re-run the seed with that stack's salt`);
  }

  console.log(`seed:upload: stack ${stackName}, generating logs for distribution ${targets.distributionId} (scenario ${manifest.scenario ?? 'lapsed-learners'}${manifest.stage !== null && manifest.stage !== undefined ? `, stage ${manifest.stage}` : ''})`);
  const result = await runSeed(
    { ...manifest, distributionId: targets.distributionId, distributionDomain: targets.distributionDomain },
    { dataDir: manifest.dataDir },
  );
  const sets = await uploadSets({ targets, dataDir: manifest.dataDir, outDir: OUT_DIR });
  const put = (Bucket, Key, Body, ContentType, { ifMatch, ifNoneMatch } = {}) => s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType, IfMatch: ifMatch, IfNoneMatch: ifNoneMatch }));
  const merge = mergesState(manifest.stage) && !values['replace-state'];
  if (merge) {
    // the command line keeps no record of what is loaded: the base is the stage before
    const def = getScenario(manifest.scenario);
    const base = completeState(stageState(result.sim.data, stageOf(def, manifest.stage - 1), result.sim));
    const getObject = async (Bucket, Key) => {
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket, Key }));
        return { body: Buffer.from(await out.Body.transformToByteArray()), etag: out.ETag };
      } catch (error) {
        if (error?.name === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
        throw error;
      }
    };
    console.log(`seed:upload: stage ${manifest.stage} merges into the live state (base: stage ${manifest.stage - 1}); --replace-state replaces it instead`);
    await uploadState({ targets, stage: stateDocuments(sets.state), base, getObject, put, onDomain: (r) => console.log(`seed:upload: ${mergeSentence(r)}`) });
  }
  const counts = await uploadObjects({
    targets, sets: merge ? { ...sets, state: [] } : sets, put,
    onProgress: (target, done, total) => { if (done % 500 === 0 || done === total) console.log(`seed:upload: ${target} ${done}/${total}`); },
  });
  if (!merge) console.log(`seed:upload: ${counts.state} state documents -> s3://${targets.stateBucket}/state/`);
  console.log(`seed:upload: ${counts.appLogs} app log files -> s3://${targets.appLogsBucket}/app-logs/`);
  console.log(`seed:upload: ${counts.cloudfront} CloudFront log files -> s3://${targets.accessLogsBucket}/${targets.cloudfrontPrefix}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`seed:upload: ${error.message}`);
    process.exitCode = 1;
  });
}
