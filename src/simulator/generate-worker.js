// Runs one generation off the server's event loop (generation takes several seconds of
// CPU, during which the page would otherwise receive no progress at all). Writes the
// files exactly as `npm run seed` does, then hands back what the page shows: the daily
// statistics, the detector view and a few real log lines per day. Never the salt.
import { parentPort, workerData } from 'node:worker_threads';
import { runSeed } from '../cli.js';
import { buildFeed } from './feed.js';

const started = Date.now();
try {
  const { options, dataDir, outDir } = workerData;
  const result = await runSeed(options, { dataDir, outDir });
  const elapsedMs = Date.now() - started;
  const feed = buildFeed({ appLogs: result.appLogs, data: result.data, anchorMs: result.sim.anchorMs, seed: options.seed });
  parentPort.postMessage({
    ok: true,
    elapsedMs,
    stats: result.stats,
    feed: [...feed.entries()],
    counts: { stateDocuments: Object.keys(result.data).length, appLogFiles: result.appLogs.size, cloudfrontFiles: result.cloudfront.size, requests: result.sim.requests.length },
  });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error.message });
}
