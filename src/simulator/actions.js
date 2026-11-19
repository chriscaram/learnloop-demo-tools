// The simulator's actions: clear, generate, upload, verify, publish, and load (all five
// in a row). Each takes the AWS and git layers by injection (./layers.js), reports
// progress through `emit`, and in dry-run mode performs only reads: the write methods
// of both layers are replaced by functions that throw, so a dry run that tried to write
// would fail loudly instead of writing.
//
// Bucket names, the CloudFront prefix and the distribution come from the LearnLoop
// stack outputs (../stack.js uploadTargets) and from nowhere else; an action never reads
// a bucket, key or prefix from the request. The request names only the TARGET
// (production or staging, ../stack.js TARGETS), which decides the stack.
//
// Per target: the stack outputs, the salt, the buckets, the generated files and the
// loaded-state record (one record per target in state/loaded.json), so the stages
// progress on each target on their own. Production generates into LearnLoop's data/seed
// and ./out as before; Staging into state/staging/{seed,out}, so a staging load never
// touches LearnLoop's repository. Publishing to LearnLoop's main is Production only.
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DEFAULT_TARGET, TARGETS, isStackMissing, targetOf, uploadTargets } from '../stack.js';
import { mergesState, readStateDir, stateDocuments, uploadObjects, uploadSets, uploadState } from '../upload.js';
import { firstStage, getScenario, scenarioFingerprint, stageOf } from '../scenarios.js';
import { mergeSentence, totals as mergeTotals } from '../merge.js';
import { PLACEHOLDER_DISTRIBUTION_DOMAIN, PLACEHOLDER_DISTRIBUTION_ID } from '../generate.js';
import { catalogIndex, cloudfrontSentence, eventSentence, requestSentence } from './feed.js';
import { createRng } from '../rng.js';

export const SEED = 42;
export const APP_LOGS_PREFIX = 'app-logs/';
export const STATE_PREFIX = 'state/';
export const SEED_PATH = 'data/seed';
export const GENERATE_TIMEOUT_MS = 180_000;
export const DEFAULT_PACE_MS = 90_000;
export const MAX_PACE_MS = 150_000;
export const DRY_RUN_SALT = 'dry-run-rehearsal-salt';
export const CO_AUTHOR = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>';
const DELETE_BATCH = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class ActionError extends Error {}

function readOnly(layer, name) {
  const blocked = (method) => async () => { throw new ActionError(`dry run: ${name}.${method} was blocked (a dry run writes nothing)`); };
  return { ...layer, writes: false, put: blocked('put'), deleteMany: blocked('deleteMany'), add: blocked('add'), commit: blocked('commit'), push: blocked('push') };
}

const hasStage = (stage) => stage !== null && stage !== undefined;
/** "stage 0 (the history)", "stage 2": how a stage is named in messages. */
export const stageWords = (stage) => (stage === 0 ? 'the history (stage 0)' : `stage ${stage}`);

/** state/loaded.json holds one record per target; a file from before targets is Production's. */
export function loadedByTarget(file) {
  if (!file) return {};
  if (Object.hasOwn(file, 'scenario')) return { [DEFAULT_TARGET]: file };
  return Object.fromEntries(Object.entries(file).filter(([k]) => TARGETS[k]));
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const dayOfKey = (key) => key.match(/\.(\d{4}-\d{2}-\d{2})-\d{2}\.[A-Z0-9]+\.gz$/)?.[1] ?? key.match(/dt=(\d{4}-\d{2}-\d{2})/)?.[1] ?? null;

/** Count, first and last day of a list of keys. */
export function summariseKeys(keys) {
  const days = keys.map((k) => dayOfKey(k.key ?? k)).filter(Boolean).sort();
  return { objects: keys.length, firstDay: days[0] ?? null, lastDay: days.at(-1) ?? null, days: new Set(days).size };
}

export function createActions({ aws, git, paths, scenarios = getScenario, now = () => new Date(), workerUrl = new URL('./generate-worker.js', import.meta.url), env = process.env, publishOff = false }) {
  // Production keeps the folders it always had; another target has its own subfolder.
  const targetDir = (dryRun, target = DEFAULT_TARGET) => path.join(paths.stateDir, ...(dryRun ? ['dry-run'] : []), ...(target === DEFAULT_TARGET ? [] : [target]));
  const stateFile = (dryRun, name, target = DEFAULT_TARGET) => path.join(targetDir(dryRun, target), name);
  const dataDirFor = (dryRun, target = DEFAULT_TARGET) => (!dryRun && target === DEFAULT_TARGET ? paths.dataDir : path.join(targetDir(dryRun, target), 'seed'));
  // The generated log files (out/) may live apart from the records (paths.scratchDir): in AWS
  // on the task's own disk, because writing ~8,700 small files one by one to EFS took about
  // 90 s of a 105 s generation. They are a cache of one generation, never the record of
  // what is loaded; after a restart an upload asks for Generate again.
  const scratchDir = (dryRun, target = DEFAULT_TARGET) => (paths.scratchDir
    ? path.join(paths.scratchDir, ...(dryRun ? ['dry-run'] : []), ...(target === DEFAULT_TARGET ? [] : [target]))
    : targetDir(dryRun, target));
  const outDirFor = (dryRun, target = DEFAULT_TARGET) => (!dryRun && target === DEFAULT_TARGET ? paths.outDir : path.join(scratchDir(dryRun, target), 'out'));
  const layers = (dryRun) => ({ aws: dryRun ? readOnly(aws, 'aws') : aws, git: dryRun ? readOnly(git, 'git') : git });
  // publishOff (the simulator running in AWS): no target publishes, whatever TARGETS says
  const targetOfCtx = (ctx) => withPublish(targetOf(ctx.target ?? DEFAULT_TARGET), publishOff);
  const loadedFile = path.join(paths.stateDir, 'loaded.json');
  async function readLoaded(target) {
    return loadedByTarget(await readJson(loadedFile))[target] ?? null;
  }
  async function writeLoaded(target, record) {
    const all = loadedByTarget(await readJson(loadedFile));
    await writeJson(loadedFile, { ...all, [target]: record });
  }

  async function targetsFor(ctx, { allowFallback = false } = {}) {
    const t = targetOfCtx(ctx);
    try {
      return uploadTargets(await layers(ctx.dryRun).aws.stackOutputs(t.stack));
    } catch (error) {
      const missing = isStackMissing(error);
      if (!allowFallback) {
        throw new ActionError(missing
          ? `${t.label}: the LearnLoop stack ${t.stack} was not found. It is not deployed (yet) in this AWS account and region; deploy it, or choose the other target. Nothing was changed.`
          : `${t.label}: the outputs of the LearnLoop stack ${t.stack} could not be read (${error.message}). Nothing was changed.`);
      }
      ctx.emit({ type: 'note', message: `Dry run: the outputs of the ${t.label} stack ${t.stack} could not be read (${missing ? 'the stack was not found: it is not deployed yet' : error.message}). Placeholder names are used; nothing is sent anywhere.` });
      return {
        stateBucket: '(state bucket)', appLogsBucket: '(app-logs bucket)', accessLogsBucket: '(access-logs bucket)', cloudfrontPrefix: 'cloudfront/',
        distributionId: PLACEHOLDER_DISTRIBUTION_ID, distributionDomain: PLACEHOLDER_DISTRIBUTION_DOMAIN, saltSecret: null, placeholder: true,
      };
    }
  }

  // ------------------------------------------------------------------ clear
  async function clear(ctx) {
    const { aws: a } = layers(ctx.dryRun);
    const targets = await targetsFor(ctx, { allowFallback: ctx.dryRun });
    const prefixes = [
      { target: 'cloudfront', bucket: targets.accessLogsBucket, prefix: targets.cloudfrontPrefix },
      { target: 'appLogs', bucket: targets.appLogsBucket, prefix: APP_LOGS_PREFIX },
    ];
    const result = {};
    for (const { target, bucket, prefix } of prefixes) {
      if (!prefix || !prefix.endsWith('/') || prefix === '/') throw new ActionError(`refusing to clear '${prefix}' in ${bucket}: the prefix must be a folder name ending in '/'`);
      if (targets.placeholder) {
        result[target] = { bucket, prefix, found: null, deleted: 0, note: 'not listed (no stack outputs)' };
        continue;
      }
      ctx.emit({ type: 'progress', step: 'clear', target, done: 0, total: null, message: `Listing s3://${bucket}/${prefix}` });
      const { keys, truncated } = await a.list(bucket, prefix);
      let deleted = 0;
      if (!ctx.dryRun) {
        for (let i = 0; i < keys.length; i += DELETE_BATCH) {
          deleted += await a.deleteMany(bucket, keys.slice(i, i + DELETE_BATCH).map((k) => k.key));
          ctx.emit({ type: 'progress', step: 'clear', target, done: deleted, total: keys.length });
        }
      }
      result[target] = { bucket, prefix, found: keys.length, deleted, truncated };
      ctx.emit({
        type: 'progress', step: 'clear', target, done: deleted, total: keys.length,
        message: ctx.dryRun ? `Dry run: would delete ${keys.length} objects under s3://${bucket}/${prefix}` : `Deleted ${deleted} objects under s3://${bucket}/${prefix}`,
      });
      if (truncated) ctx.emit({ type: 'note', message: `More objects remain under s3://${bucket}/${prefix} than one pass lists; run Clear again.` });
    }
    return result;
  }

  // ------------------------------------------------------------------ the stage order
  // A staged scenario adds one case per load to ONE Governance Agent application, so a
  // stage only makes sense on top of the one before, with the same start date (README,
  // "Presenting the staged reveal"), on the same target. The first stage (the history,
  // stage 0, when the scenario has one) is always allowed: it is also how the presenter
  // starts over. Returns the reason a stage cannot be loaded now, or null.
  async function stageOrderProblem(ctx) {
    const stage = ctx.stage ?? null;
    if (!hasStage(stage)) return null;
    const def = scenarios(ctx.scenario);
    const first = firstStage(def);
    if (stage === first) return null;
    const t = targetOfCtx(ctx);
    const loaded = await readLoaded(t.id);
    const startOver = first === 0 ? 'start over with the history (stage 0)' : `start over with stage ${first}`;
    if (!loaded || loaded.scenario !== ctx.scenario || !hasStage(loaded.stage)) {
      return `stage ${stage} adds to ${stageWords(stage - 1)}, and no stage of this scenario is loaded on ${t.label}: load ${stageWords(first)} first`;
    }
    if (loaded.anchor !== ctx.anchor) {
      return `stage ${stage} keeps the start date of the stages already loaded on ${t.label} (${loaded.anchor}), not ${ctx.anchor}`;
    }
    if (loaded.stage < stage - 1) return `${stageWords(loaded.stage)} is loaded on ${t.label}: load ${stageWords(loaded.stage + 1)} before stage ${stage}`;
    if (loaded.stage > stage) {
      return `${stageWords(loaded.stage)} is already loaded on ${t.label}, and a stage never takes traffic away: to go back, ${startOver} and onboard the application in the Governance Agent again`;
    }
    return null;
  }
  /** The stage the live state was loaded with, when a merge can use it as its base (same scenario, start date, an earlier or the same stage). */
  async function mergeBaseStage(ctx, st) {
    if (!st || !mergesState(st.stage)) return null;
    const loaded = await readLoaded(targetOfCtx(ctx).id);
    if (!loaded || loaded.scenario !== ctx.scenario || loaded.anchor !== ctx.anchor || !hasStage(loaded.stage)) return null;
    return loaded.stage <= st.stage ? loaded.stage : null;
  }
  async function checkStageOrder(ctx) {
    const problem = await stageOrderProblem(ctx);
    if (!problem) return;
    if (!ctx.dryRun) throw new ActionError(`refusing to load: ${problem}`);
    ctx.emit({ type: 'note', message: `Dry run: a real load would refuse here (${problem}).` });
  }

  // ------------------------------------------------------------------ generate
  function runWorker(workerData, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl, { workerData });
      const timer = setTimeout(() => { worker.terminate(); reject(new ActionError(`generation did not finish within ${GENERATE_TIMEOUT_MS / 1000} s`)); }, GENERATE_TIMEOUT_MS);
      const onMessage = (msg) => {
        if (msg.progress) return onProgress(msg.progress);
        worker.off('message', onMessage);
        clearTimeout(timer);
        worker.terminate();
        if (msg.ok) resolve(msg); else reject(new ActionError(msg.message));
        return undefined;
      };
      worker.on('message', onMessage);
      worker.once('error', (error) => { clearTimeout(timer); reject(new ActionError(error.message)); });
    });
  }

  async function generate(ctx) {
    const def = scenarios(ctx.scenario);
    const anchor = ctx.anchor;
    const st = stageOf(def, ctx.stage ?? null);
    const t = targetOfCtx(ctx);
    if (!ctx.chain) await checkStageOrder(ctx);
    const targets = await targetsFor(ctx, { allowFallback: ctx.dryRun });
    let salt;
    if (targets.placeholder) {
      salt = DRY_RUN_SALT;
    } else {
      try {
        salt = await layers(ctx.dryRun).aws.secret(targets.saltSecret);
      } catch (error) {
        if (!ctx.dryRun) throw new ActionError(`the pseudonym salt could not be read from ${targets.saltSecret}: ${error.message}`);
        ctx.emit({ type: 'note', message: `Dry run: the salt secret could not be read (${error.message}); a rehearsal salt is used.` });
        salt = DRY_RUN_SALT;
      }
    }
    const fingerprint = scenarioFingerprint(def, { seed: SEED, anchor, stage: st?.stage ?? null });
    ctx.emit({
      type: 'note',
      message: !st
        ? `Generating 60 days of activity before ${anchor} for ${t.label}.`
        : st.history
          ? `Generating the history for ${t.label}: days 60 to 30 before ${anchor}, and nothing after them (stage 0, loaded before onboarding).`
          : `Generating 60 days of activity before ${anchor} for ${t.label}: stage ${st.stage} of ${st.count} (case${st.stage > 1 ? `s 1 to ${st.stage}` : ' 1'}).`,
    });
    const dataDir = dataDirFor(ctx.dryRun, t.id);
    const outDir = outDirFor(ctx.dryRun, t.id);
    // a later stage merges into the live state: its base is the stage the target holds now
    // (recomputed from the same generation by the worker, written to <out>/merge-base/)
    const baseStage = await mergeBaseStage(ctx, st);
    const out = await runWorker({
      options: { scenario: def.id, stage: st?.stage ?? null, anchor, salt, seed: SEED, distributionId: targets.distributionId, distributionDomain: targets.distributionDomain },
      dataDir, outDir, baseStage,
    }, (p) => ctx.emit({ type: 'progress', step: 'generate', target: t.id, phase: p.phase, done: p.done, total: p.total }));
    const paceMs = Math.max(0, Math.min(MAX_PACE_MS, ctx.paceMs ?? DEFAULT_PACE_MS));
    const max = (key) => Math.max(0, ...out.stats.daily.map((d) => d[key] ?? 0));
    ctx.emit({
      type: 'generated', elapsedMs: out.elapsedMs, paceMs, counts: out.counts, days: out.stats.daily.length,
      scales: Object.fromEntries(['learnersOnLessons7d', 'signIns', 'cancellations', 'lessonP95Ms', 'lessonErrorPct'].map((k) => [k, max(k)])),
      message: paceMs > out.elapsedMs
        ? `The generator finished in ${(out.elapsedMs / 1000).toFixed(1)} s. The page now replays its ${out.stats.daily.length} days at presentation pace (about ${Math.round(paceMs / 1000)} s); the pace is for the audience, not the generator.`
        : `The generator finished in ${(out.elapsedMs / 1000).toFixed(1)} s.`,
    });
    const feed = new Map(out.feed);
    const perDay = paceMs / out.stats.daily.length;
    for (const row of out.stats.daily) {
      if (ctx.cancelled?.()) throw new ActionError('stopped');
      ctx.emit({ type: 'day', row, feed: feed.get(row.day) ?? [] });
      if (perDay > 0) await sleep(perDay);
    }
    const record = {
      target: t.id, scenario: def.id, stage: st?.stage ?? null, stages: st?.count ?? null, anchor, seed: SEED, fingerprint, at: now().toISOString(), dryRun: !!ctx.dryRun,
      distributionId: targets.distributionId, elapsedMs: out.elapsedMs, counts: out.counts, dataDir, outDir, baseStage,
    };
    await writeJson(stateFile(ctx.dryRun, 'generated.json', t.id), record);
    await writeJson(stateFile(ctx.dryRun, 'last-run.json', t.id), { ...record, daily: out.stats.daily, feed: out.feed });
    return { target: t.id, scenario: def.id, stage: st?.stage ?? null, anchor, fingerprint, elapsedMs: out.elapsedMs, counts: out.counts };
  }

  // ------------------------------------------------------------------ upload
  async function upload(ctx) {
    const t = targetOfCtx(ctx);
    const generated = await readJson(stateFile(ctx.dryRun, 'generated.json', t.id));
    if (!generated) throw new ActionError(ctx.dryRun ? `nothing generated in dry-run mode for ${t.label} yet: run Generate first` : `nothing generated for ${t.label} yet: run Generate first`);
    const targets = await targetsFor(ctx, { allowFallback: ctx.dryRun });
    if (!ctx.dryRun) {
      const manifest = await readJson(path.join(generated.outDir, 'manifest.json'));
      if (!manifest || manifest.scenario !== generated.scenario || manifest.anchor !== generated.anchor || (manifest.stage ?? null) !== (generated.stage ?? null)) {
        throw new ActionError(manifest
          ? 'the generated files on disk do not match the last generation; run Generate again'
          : 'the generated files are no longer on disk (the simulator was restarted since the last generation); run Generate again');
      }
      if (manifest.distributionId !== targets.distributionId) throw new ActionError(`the logs were generated for distribution ${manifest.distributionId}, the stack has ${targets.distributionId}; run Generate again`);
      const salt = await aws.secret(targets.saltSecret);
      if (salt !== manifest.salt) throw new ActionError(`the logs were generated with a different salt than ${targets.saltSecret}; run Generate again`);
    }
    const sets = await uploadSets({ targets, dataDir: generated.dataDir, outDir: generated.outDir });
    // Stage 0 and a single load replace the state; a later stage merges into the live state
    const merge = mergesState(generated.stage);
    if (merge && !ctx.dryRun) {
      const loaded = await readLoaded(t.id);
      if ((loaded?.stage ?? null) !== (generated.baseStage ?? null) || (loaded && (loaded.scenario !== generated.scenario || loaded.anchor !== generated.anchor))) {
        throw new ActionError(`what is loaded on ${t.label} changed since this stage was generated; run Generate again (or Load) so the merge starts from what the app holds now`);
      }
    }
    const totals = { state: merge ? 0 : sets.state.length, appLogs: sets.appLogs.length, cloudfront: sets.cloudfront.length };
    const destinations = {
      state: `s3://${targets.stateBucket}/${STATE_PREFIX}`,
      appLogs: `s3://${targets.appLogsBucket}/${APP_LOGS_PREFIX}`,
      cloudfront: `s3://${targets.accessLogsBucket}/${targets.cloudfrontPrefix}`,
    };
    ctx.emit({ type: 'upload-plan', totals, destinations, stateMode: merge ? 'merge' : 'replace' });
    let mergeResults = null;
    if (merge) {
      mergeResults = await mergeIntoLive(ctx, { targets, sets, generated });
      totals.state = mergeResults ? mergeResults.filter((r) => r.wouldWrite).length : 0;
    }
    const logSets = merge ? { ...sets, state: [] } : sets;
    let lastEmit = 0;
    const onProgress = (target, done, total) => {
      if (done === total || done - lastEmit >= 100 || done < lastEmit) {
        lastEmit = done;
        ctx.emit({ type: 'progress', step: 'upload', target, done, total });
      }
    };
    let counts;
    if (ctx.dryRun) {
      counts = {};
      for (const [target, items] of Object.entries(logSets)) {
        if (merge && target === 'state') continue;
        for (let i = 100; i < items.length; i += 100) { onProgress(target, i, items.length); await sleep(5); }
        onProgress(target, items.length, items.length);
        counts[target] = items.length;
      }
      ctx.emit({ type: 'note', message: 'Dry run: nothing was uploaded; the counts are what an upload would send.' });
    } else {
      counts = await uploadObjects({ targets, sets: logSets, put: aws.put, onProgress });
      if (merge) counts.state = mergeResults.filter((r) => r.written).length;
      await writeLoaded(t.id, {
        target: t.id, stack: t.stack,
        scenario: generated.scenario, stage: generated.stage ?? null, stages: generated.stages ?? null,
        anchor: generated.anchor, seed: generated.seed, fingerprint: generated.fingerprint,
        at: now().toISOString(), by: ctx.chain ? 'load' : 'upload', counts, published: null,
        state: merge ? { mode: 'merged', base: generated.baseStage ?? null, ...mergeSummary(mergeResults) } : { mode: 'replaced' },
      });
    }
    if (merge && ctx.dryRun) counts.state = 0;
    return { counts, destinations, dryRun: !!ctx.dryRun, stateMode: merge ? 'merge' : 'replace', merge: mergeResults ? mergeSummary(mergeResults) : null };
  }

  /** Totals of a merge across domains, and the domains it would write. */
  function mergeSummary(results) {
    const sum = {};
    for (const r of results) for (const [k, v] of Object.entries(mergeTotals(r))) if (k !== 'live' && k !== 'stage') sum[k] = (sum[k] ?? 0) + v;
    return { ...sum, documentsWritten: results.filter((r) => r.written).length, domainsChanged: results.filter((r) => r.wouldWrite).map((r) => r.domain) };
  }

  /**
   * Read the live state documents and merge the stage into them (src/merge.js). A real
   * upload writes the documents the stage adds to; a dry run reads and reports only. With
   * placeholder outputs (a dry run without the stack) there is nothing to read.
   */
  async function mergeIntoLive(ctx, { targets, sets, generated }) {
    const a = layers(ctx.dryRun).aws;
    if (targets.placeholder) {
      ctx.emit({ type: 'note', message: 'Dry run: the live state could not be read (no stack outputs), so the merge is not shown. A real load reads it first and only adds to it.' });
      return null;
    }
    const base = generated.baseStage !== null && generated.baseStage !== undefined ? await readStateDir(path.join(generated.outDir, 'merge-base')) : null;
    ctx.emit({
      type: 'note',
      message: `Stage ${generated.stage} adds to the live state in s3://${targets.stateBucket}/${STATE_PREFIX} instead of replacing it: every record the app, an AI agent or you wrote since the last load is kept, and only the records this stage introduces are added${base ? ` (compared with ${stageWords(generated.baseStage)}, the stage loaded before)` : ' (no earlier stage of this scenario is recorded as loaded, so nothing counts as removed in the app)'}.`,
    });
    const results = await uploadState({
      targets, stage: stateDocuments(sets.state), base, getObject: a.getObject, put: a.put, write: !ctx.dryRun,
      onDomain: (r) => ctx.emit({ type: 'merge', domain: r.domain, mode: r.mode, written: r.written, wouldWrite: r.wouldWrite, totals: mergeTotals(r), samples: r.samples, sentence: mergeSentence(r) }),
    });
    const sum = mergeSummary(results);
    const kept = `${sum.keptAppOnly ?? 0} record(s) written by the app since the last load kept`;
    const notOverwritten = (sum.conflicts ?? 0) ? `, ${sum.conflicts} record(s) the app holds differently left as the app has them` : '';
    ctx.emit({
      type: 'note',
      message: ctx.dryRun
        ? `Dry run: the merge would add ${sum.added ?? 0} record(s) to ${sum.domainsChanged.length} document(s) (${sum.domainsChanged.join(', ') || 'none'}); ${kept}${notOverwritten}. Nothing was written.`
        : `Merged: ${sum.added ?? 0} record(s) added to ${sum.documentsWritten} document(s) (${sum.domainsChanged.join(', ') || 'none'}); ${kept}${notOverwritten}.`,
    });
    return results;
  }

  // ------------------------------------------------------------------ verify
  async function verify(ctx) {
    const t = targetOfCtx(ctx);
    const generated = await readJson(stateFile(ctx.dryRun, 'generated.json', t.id));
    const rng = createRng(Date.now(), 'verify');
    let summary;
    let sampleKey;
    let sampleBody;
    let source;
    if (ctx.dryRun) {
      if (!generated) throw new ActionError('nothing generated in dry-run mode yet: run Generate first');
      const targets = await targetsFor(ctx, { allowFallback: true });
      const sets = await uploadSets({ targets, dataDir: generated.dataDir, outDir: generated.outDir });
      summary = {
        state: summariseKeys(sets.state.map(([k]) => k)),
        appLogs: summariseKeys(sets.appLogs.map(([k]) => k)),
        cloudfront: summariseKeys(sets.cloudfront.map(([k]) => k)),
      };
      const pool = [...sets.appLogs, ...sets.cloudfront];
      const [key, body] = pool[Math.floor(rng.next() * pool.length)];
      sampleKey = key;
      sampleBody = key.endsWith('.gz') ? (await import('node:zlib')).gunzipSync(body) : body;
      source = 'Dry run: read back from the local rehearsal folder, not from AWS.';
    } else {
      const targets = await targetsFor(ctx);
      const lists = {
        state: await aws.list(targets.stateBucket, STATE_PREFIX),
        appLogs: await aws.list(targets.appLogsBucket, APP_LOGS_PREFIX),
        cloudfront: await aws.list(targets.accessLogsBucket, targets.cloudfrontPrefix),
      };
      summary = Object.fromEntries(Object.entries(lists).map(([t, l]) => [t, { ...summariseKeys(l.keys), truncated: l.truncated }]));
      const pool = [
        ...lists.appLogs.keys.map((k) => [targets.appLogsBucket, k.key]),
        ...lists.cloudfront.keys.map((k) => [targets.accessLogsBucket, k.key]),
      ];
      if (pool.length === 0) throw new ActionError('the log prefixes are empty: nothing to read back');
      const [bucket, key] = pool[Math.floor(rng.next() * pool.length)];
      sampleKey = `s3://${bucket}/${key}`;
      sampleBody = await aws.get(bucket, key);
      source = 'Read back from your AWS account with your own credentials.';
    }
    const expected = generated?.counts ? { appLogs: generated.counts.appLogFiles, cloudfront: generated.counts.cloudfrontFiles, state: generated.counts.stateDocuments } : null;
    for (const [target, s] of Object.entries(summary)) ctx.emit({ type: 'verify', target, ...s, expected: expected?.[target] ?? null });
    const lines = String(sampleBody).trimEnd().split('\n').filter((l) => l && !l.startsWith('#')).slice(0, 6);
    let index = null;
    try {
      const dataDir = generated?.dataDir ?? paths.dataDir;
      index = catalogIndex({ courses: JSON.parse(await readFile(path.join(dataDir, 'courses.json'), 'utf8')), lessons: JSON.parse(await readFile(path.join(dataDir, 'lessons.json'), 'utf8')) });
    } catch { index = catalogIndex({ courses: [], lessons: [] }); }
    const sample = lines.map((line) => {
      if (line.startsWith('{')) {
        const record = JSON.parse(line);
        if (record.kind === 'event') return { sentence: eventSentence(record, null, index), raw: line };
        if (record.kind === 'request') return { sentence: requestSentence(record), raw: line };
        return { sentence: `The application logged an error (${record['error.type'] ?? record.message}).`, raw: line };
      }
      return { sentence: cloudfrontSentence(line, index), raw: line };
    });
    const result = { summary, expected, sample: { key: sampleKey, lines: sample }, source };
    ctx.emit({ type: 'sample', ...result.sample, source });
    return result;
  }

  // ------------------------------------------------------------------ publish
  async function publish(ctx) {
    const g = layers(ctx.dryRun).git;
    const t = targetOfCtx(ctx);
    if (t.publishOff) throw new ActionError(`refusing to publish: ${PUBLISH_OFF_WORDING}`);
    if (!t.publish) throw new ActionError(`refusing to publish: publishing the starting state to LearnLoop's main is offered for Production only, not ${t.label}`);
    const generated = await readJson(stateFile(ctx.dryRun, 'generated.json', t.id));
    if (!generated) throw new ActionError('nothing generated yet: run Generate first');
    const branch = await g.branch();
    if (branch !== 'main') throw new ActionError(`refusing to publish: the LearnLoop repository is on branch '${branch}', not main`);
    const dirty = await g.status();
    const pathOf = (line) => line.slice(3).replace(/^"|"$/g, '').split(' -> ').at(-1);
    const outside = dirty.filter((line) => !pathOf(line).startsWith(`${SEED_PATH}/`));
    if (outside.length) {
      throw new ActionError(`refusing to publish: the LearnLoop repository has changes outside ${SEED_PATH}/ (${outside.slice(0, 5).map(pathOf).join(', ')}${outside.length > 5 ? ', …' : ''}). Commit or stash them first.`);
    }
    const subject = env.SIMULATOR_COMMIT_SCENARIO_NAME === '1'
      ? `Seed: load scenario ${generated.scenario} anchored on ${generated.anchor}`
      : `Seed: load sealed scenario ${generated.fingerprint.slice(0, 12)} anchored on ${generated.anchor}`;
    const message = `${subject}\n\nDemo starting state generated by learnloop-demo-tools. The scenario is sealed: its\ndefinition stays in that repository; this commit names it by the first 12 characters\nof its SHA-256 fingerprint (${generated.fingerprint.slice(0, 12)}).\n\n${CO_AUTHOR}`;
    if (ctx.dryRun) {
      const repoSeed = path.join(git.repo, SEED_PATH);
      const changed = [];
      for (const file of (await readdir(generated.dataDir)).filter((f) => f.endsWith('.json')).sort()) {
        const mine = await readFile(path.join(generated.dataDir, file), 'utf8');
        const theirs = await readFile(path.join(repoSeed, file), 'utf8').catch(() => null);
        if (mine !== theirs) changed.push(`${SEED_PATH}/${file}`);
      }
      ctx.emit({ type: 'note', message: changed.length ? `Dry run: would commit ${changed.length} file(s) on main and push, which starts LearnLoop's deploy.` : 'Dry run: the files are unchanged; nothing would be committed.' });
      return { dryRun: true, wouldCommit: changed, message, skipped: changed.length === 0 };
    }
    await g.add([SEED_PATH]);
    const staged = await g.stagedChanged(['.']);
    const stagedOutside = staged.filter((f) => !f.startsWith(`${SEED_PATH}/`));
    if (stagedOutside.length) throw new ActionError(`refusing to publish: files outside ${SEED_PATH}/ are staged (${stagedOutside.slice(0, 5).join(', ')})`);
    if (staged.length === 0) {
      ctx.emit({ type: 'note', message: 'The starting state on LearnLoop main is already this one; nothing to commit.' });
      await markPublished({ skipped: true });
      return { skipped: true };
    }
    await g.commit(message);
    const head = await g.head();
    ctx.emit({ type: 'note', message: `Committed ${staged.length} file(s) as ${head}; pushing to main.` });
    await g.push();
    await markPublished({ commit: head, files: staged.length });
    return { commit: head, files: staged };

    async function markPublished(info) {
      const loaded = await readLoaded(t.id);
      if (loaded && loaded.fingerprint === generated.fingerprint) await writeLoaded(t.id, { ...loaded, published: { ...info, at: now().toISOString() } });
    }
  }

  // ------------------------------------------------------------------ load: all five
  // `ctx.publish` (a staged load): whether the last step runs. By default only the last
  // stage publishes — see publishByDefault().
  async function load(ctx) {
    const def = scenarios(ctx.scenario);
    const st = stageOf(def, ctx.stage ?? null);
    const t = targetOfCtx(ctx);
    await checkStageOrder(ctx);
    const doPublish = t.publish && (ctx.publish ?? publishByDefault(st));
    const results = {};
    for (const [name, fn] of [['clear', clear], ['generate', generate], ['upload', upload], ['verify', verify], ['publish', publish]]) {
      if (name === 'publish' && !doPublish) {
        ctx.emit({ type: 'step', step: name, status: 'skipped' });
        ctx.emit({
          type: 'note',
          message: t.publishOff ? `${PUBLISH_OFF_WORDING} ${t.label} reads this load's state from its state bucket.`
            : !t.publish
            ? `Publishing to LearnLoop's main is offered for Production only; ${t.label} reads this load's state from its own state bucket.`
            : `Publishing the starting state was left out for ${stageWords(st.stage)} of ${st.count}. LearnLoop already reads this stage's starting state from AWS (Upload wrote it); main and LearnLoop's deploy stay as they are until the last stage.`,
        });
        results[name] = { skipped: true, reason: t.publishOff ? 'publish_off' : t.publish ? 'not_requested' : 'not_offered_for_target' };
        continue;
      }
      ctx.emit({ type: 'step', step: name, status: 'started' });
      results[name] = await fn({ ...ctx, chain: true });
      ctx.emit({ type: 'step', step: name, status: 'done' });
    }
    return results;
  }

  /** What the page reads for one target: its loaded record and its generated records. */
  async function stateFor(target = DEFAULT_TARGET) {
    const t = targetOf(target);
    return {
      target: t.id,
      loaded: await readLoaded(t.id),
      generated: await readJson(stateFile(false, 'generated.json', t.id)),
      dryRunGenerated: await readJson(stateFile(true, 'generated.json', t.id)),
      lastRun: () => readJson(stateFile(false, 'last-run.json', t.id)),
    };
  }

  return { clear, generate, upload, verify, publish, load, stateFor, targetsFor };
}

/**
 * A staged load publishes only at the last stage unless asked otherwise. Publishing
 * pushes data/seed to LearnLoop's main, which starts LearnLoop's production deploy, and
 * its "Preview reset" restores the app's state from main: the earlier stages' state is
 * already in AWS after Upload, so publishing them would only add deploys mid-demo.
 * A scenario without stages publishes as before.
 */
export function publishByDefault(st) {
  return !st || st.final;
}

/** The targets as the page lists them. */
export const TARGET_CHOICES = Object.freeze(Object.values(TARGETS).map(({ id, label, stack, publish }) => ({ id, label, stack, publish })));

/**
 * The simulator deployed in AWS (SIMULATOR_PUBLISH=off) never publishes: pushing to
 * LearnLoop's main starts its production deploy, and no credential that can do that is
 * kept in the account. Publishing stays with the local simulator.
 */
export const PUBLISH_OFF_WORDING = "Publishing the starting state to LearnLoop's main is done from the local simulator only; this one runs in AWS and holds no git credential.";

/** A target with publishing turned off when `publishOff` (the cloud simulator); unchanged otherwise. */
export function withPublish(target, publishOff) {
  return publishOff ? { ...target, publish: false, publishOff: true } : target;
}

/** What the confirmation says for a staged load, by whether it publishes, and for starting over. */
export const STAGED_LOAD_WORDING = Object.freeze({
  publish: "Clear the two log prefixes, generate this stage, upload and verify it, then commit and push data/seed/ to LearnLoop's main branch (which starts LearnLoop's deploy).",
  noPublish: "Clear the two log prefixes, generate this stage, upload and verify it. The app's live state is kept and only this stage's new records are added. Nothing is committed or pushed to LearnLoop.",
  history: "Clear the two log prefixes, generate the history (days 60 to 30 before the start date, nothing after them), upload it with the app's starting state, which replaces the live state, and verify it. Nothing is committed or pushed to LearnLoop.",
  startOver: "Load the history (stage 0) again, with today's date. This replaces the app's live state, including what the AI agents wrote. The Governance Agent keeps the highest number of people it has read for every period, so an application that has already read a later stage would never show the drops again: after this, remove the LearnLoop application in the Governance Agent and onboard it again.",
});

/** Which actions change something outside this machine, and so need a confirmation token. */
export const CONFIRMED_ACTIONS = Object.freeze({
  clear: 'Delete every object under the two log prefixes in the LearnLoop buckets (including any real log files written since the last load).',
  upload: "Write the LearnLoop app's state documents (a single load and the history replace them; a later stage adds to the live state) and add the generated log files in your AWS account.",
  publish: "Commit data/seed/ on LearnLoop's main branch and push it. Pushing to main also starts LearnLoop's production deploy.",
  load: "Clear the two log prefixes, generate, upload, verify, then commit and push data/seed/ to LearnLoop's main branch (which starts LearnLoop's deploy).",
});
export const ACTION_NAMES = Object.freeze(['clear', 'generate', 'upload', 'verify', 'publish', 'load']);

export async function resetDryRun(stateDir) {
  await rm(path.join(stateDir, 'dry-run'), { recursive: true, force: true });
}
