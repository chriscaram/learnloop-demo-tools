// The copies in src/contract/ must behave exactly like the LearnLoop code they
// were taken from. Runs when the LearnLoop repository (with node_modules) is
// next to this one or at $LEARNLOOP_REPO; skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as copyLogger from '../src/contract/logger.js';
import { addMonths } from '../src/contract/billing.js';
import { completionPercent } from '../src/contract/progress.js';
import { LEARNLOOP_REPO } from '../src/files.js';
import { assertCloudfrontKeys, uploadTargets } from '../src/stack.js';

const available = existsSync(path.join(LEARNLOOP_REPO, 'node_modules/@learnloop/shared'));
const load = (rel) => import(pathToFileURL(path.join(LEARNLOOP_REPO, rel)).href);

test('copied logger matches packages/shared/src/logger.js', { skip: !available && 'LearnLoop repository not found' }, async () => {
  const app = await load('packages/shared/src/logger.js');
  assert.deepEqual([...copyLogger.EVENT_NAMES], [...app.EVENT_NAMES]);
  assert.equal(copyLogger.pseudonymiseUser('s', 'usr_0123456789ab'), app.pseudonymiseUser('s', 'usr_0123456789ab'));
  assert.equal(copyLogger.pseudonymiseSession('s', 'ses_1'), app.pseudonymiseSession('s', 'ses_1'));
  const base = { timestamp: '2026-11-01T10:00:00.000Z', service: 'learning', version: 'abc1234', environment: 'prod', traceId: 'a'.repeat(32), requestId: 'r=' };
  const request = { ...base, method: 'GET', route: '/api/lessons/{lessonId}', statusCode: 200, latencyMs: 80, userPseudoId: 'u_1', sessionPseudoId: 's_1', userAgent: 'Mozilla/5.0' };
  assert.equal(copyLogger.serialize(copyLogger.buildRequestRecord(request)), app.serialize(app.buildRequestRecord(request)));
  const event = { ...base, event: 'lesson_completed', entityType: 'lesson', entityId: 'les_0123456789ab', actorType: 'learner', value: 12, userPseudoId: 'u_1' };
  assert.equal(copyLogger.serialize(copyLogger.buildEventRecord(event)), app.serialize(app.buildEventRecord(event)));
  const log = { ...base, level: 'error', message: 'unhandled error', errorType: 'InternalError' };
  assert.equal(copyLogger.serialize(copyLogger.buildLogRecord(log)), app.serialize(app.buildLogRecord(log)));
});

test('copied addMonths and completionPercent match the services', { skip: !available && 'LearnLoop repository not found' }, async () => {
  const billing = await load('services/billing/src/services/subscription.js');
  const learning = await load('services/learning/src/services/progress.js');
  for (const iso of ['2026-01-31T08:00:00.000Z', '2026-10-10T23:59:59.999Z', '2024-02-29T00:00:00.000Z']) {
    assert.equal(addMonths(new Date(iso), 1).toISOString(), billing.addMonths(new Date(iso), 1).toISOString());
  }
  const course = { lessons: [{ id: 'a', duration_min: 14 }, { id: 'b', duration_min: 17 }, { id: 'c', duration_min: 18 }] };
  const progress = [{ lesson_id: 'a', status: 'completed' }, { lesson_id: 'b', status: 'started' }];
  assert.equal(completionPercent(progress, course), learning.completionPercent(progress, course));
});

test('upload targets come from stack outputs; CloudFront keys must sit under the logging prefix', () => {
  const outputs = {
    StateBucketName: 'state', AppLogsBucketName: 'app', AccessLogsBucketName: 'access', CloudFrontLogPrefix: 'cloudfront/',
    DistributionId: 'E1ABCDEF', DistributionDomainName: 'd1.cloudfront.net', LogPseudonymSaltSecretName: 'learnloop/prod/log-pseudonym-salt',
  };
  assert.equal(uploadTargets(outputs).cloudfrontPrefix, 'cloudfront/');
  assert.throws(() => uploadTargets({ ...outputs, CloudFrontLogPrefix: undefined }), /CloudFrontLogPrefix/);
  assertCloudfrontKeys(['cloudfront/E1ABCDEF.2026-10-01-14.ABCD1234.gz'], 'cloudfront/', 'E1ABCDEF');
  assert.throws(() => assertCloudfrontKeys(['logs/E1ABCDEF.2026-10-01-14.ABCD1234.gz'], 'cloudfront/', 'E1ABCDEF'));
  assert.throws(() => assertCloudfrontKeys(['cloudfront/EOTHER.2026-10-01-14.ABCD1234.gz'], 'cloudfront/', 'E1ABCDEF'));
});
