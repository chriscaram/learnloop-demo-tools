#!/usr/bin/env node
// npm run seed -- [--scenario lapsed-learners] [--stage n (0 = the history)] [--anchor YYYY-MM-DD] --salt <value> [--seed 42] [--data-dir <path>]
//                 [--distribution-id E...] [--distribution-domain dxxxx.cloudfront.net]
// Writes the mock state to <LearnLoop>/data/seed/ and 60 days of logs to ./out/.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { PLACEHOLDER_DISTRIBUTION_DOMAIN, PLACEHOLDER_DISTRIBUTION_ID, generate, todayUtc } from './generate.js';
import { DATA_DIR, OUT_DIR, writeData, writeLogs } from './files.js';
import { DEFAULT_SCENARIO, getScenario, stageOf } from './scenarios.js';

export async function runSeed(options, { dataDir = DATA_DIR, outDir = OUT_DIR, onProgress = null } = {}) {
  const result = generate({ ...options, onProgress });
  await writeData(result.data, dataDir);
  await writeLogs(result, outDir, { onFile: onProgress && ((done, total) => onProgress({ phase: 'files', done, total })) });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, 'manifest.json'), `${JSON.stringify({
    scenario: options.scenario ?? DEFAULT_SCENARIO,
    stage: options.stage ?? null,
    anchor: options.anchor,
    seed: options.seed,
    salt: options.salt,
    distributionId: options.distributionId,
    distributionDomain: options.distributionDomain,
    dataDir,
  }, null, 2)}\n`);
  await writeFile(path.join(outDir, 'stats.json'), `${JSON.stringify(result.stats, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({
    options: {
      scenario: { type: 'string', default: DEFAULT_SCENARIO },
      stage: { type: 'string' },
      anchor: { type: 'string', default: todayUtc() },
      salt: { type: 'string', default: process.env.LOG_PSEUDONYM_SALT },
      seed: { type: 'string', default: '42' },
      'data-dir': { type: 'string', default: DATA_DIR },
      'distribution-id': { type: 'string', default: PLACEHOLDER_DISTRIBUTION_ID },
      'distribution-domain': { type: 'string', default: PLACEHOLDER_DISTRIBUTION_DOMAIN },
    },
  });
  if (!values.salt) {
    console.error('seed: --salt is required (the value of the target stack\'s LogPseudonymSaltSecretName secret: learnloop/prod/log-pseudonym-salt for LearnLoopProd, the learnloop/staging/ one for LearnLoopStaging)');
    process.exit(2);
  }
  const stage = values.stage === undefined ? null : Number(values.stage);
  try {
    stageOf(getScenario(values.scenario), stage);
  } catch (error) {
    console.error(`seed: ${error.message}`);
    process.exit(2);
  }
  const options = {
    scenario: values.scenario,
    stage,
    anchor: values.anchor,
    salt: values.salt,
    seed: Number(values.seed),
    distributionId: values['distribution-id'],
    distributionDomain: values['distribution-domain'],
  };
  const dataDir = path.resolve(values['data-dir']);
  const { stats, appLogs, cloudfront } = await runSeed(options, { dataDir });
  console.log(`seed: scenario ${options.scenario}${stage !== null ? ` (stage ${stage})` : ''}, anchor ${options.anchor}, seed ${options.seed}`);
  console.log(`seed: wrote ${dataDir}/*.json, ${appLogs.size} app log files and ${cloudfront.size} CloudFront log files to ${OUT_DIR}`);
  console.log(`seed: learners on lesson routes ${stats.window1.learnersOnLessons} (days -60..-31) and ${stats.window2.learnersOnLessons} (days -30..-1)`);
}
