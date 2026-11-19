// Runs one generation off the server's event loop (generation takes several seconds of
// CPU, during which the page would otherwise receive no progress at all). Writes the
// files exactly as `npm run seed` does, posting { progress } messages as it goes (the
// simulated day, the share of requests written as log lines, the files saved), then hands
// back what the page shows: the daily statistics, the detector view and a few real log
// lines per day. Never the salt.
import { parentPort, workerData } from 'node:worker_threads';
import { runSeed } from '../cli.js';
import { buildFeed } from './feed.js';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { completeState, writeData } from '../files.js';
import { stageState } from '../generate.js';
import { getScenario, stageOf } from '../scenarios.js';

const started = Date.now();
try {
  const { options, dataDir, outDir, baseStage = null } = workerData;
  // progress messages before the result: the page shows them while the generator runs
  const result = await runSeed(options, { dataDir, outDir, onProgress: (p) => parentPort.postMessage({ progress: p }) });
  // A later stage merges into the live state; its base is the state of the stage loaded
  // before, from this same generation (src/merge.js), written next to the logs.
  const baseDir = path.join(outDir, 'merge-base');
  await rm(baseDir, { recursive: true, force: true });
  if (baseStage !== null) {
    const st = stageOf(getScenario(options.scenario), baseStage);
    await writeData(stageState(result.sim.data, st, result.sim), baseDir);
  }
  const elapsedMs = Date.now() - started;
  const feed = buildFeed({ appLogs: result.appLogs, data: result.data, anchorMs: result.sim.anchorMs, seed: options.seed });
  parentPort.postMessage({
    ok: true,
    elapsedMs,
    stats: result.stats,
    feed: [...feed.entries()],
    counts: { stateDocuments: Object.keys(completeState(result.data)).length, appLogFiles: result.appLogs.size, cloudfrontFiles: result.cloudfront.size, requests: result.sim.requests.length },
  });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message });
}
