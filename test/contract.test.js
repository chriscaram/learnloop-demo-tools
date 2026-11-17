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

test('copied support rules match services/notifications/src/services/support.js', { skip: !available && 'LearnLoop repository not found' }, async () => {
  const copy = await import('../src/contract/support.js');
  const app = await load('services/notifications/src/services/support.js');
  assert.deepEqual([...copy.SUPPORT_TOPICS], [...app.SUPPORT_TOPICS]);
  for (let h = 0; h < 7 * 24; h += 5) {
    const iso = new Date(Date.UTC(2026, 10, 2, h)).toISOString();
    assert.equal(copy.replyDueAt(iso).toISOString(), app.replyDueAt(iso).toISOString(), iso);
  }
  const requests = [
    { id: 'sup_000000000002', status: 'open', created_at: '2026-11-05T10:00:00.000Z' },
    { id: 'sup_000000000001', status: 'open', created_at: '2026-11-02T10:00:00.000Z' },
    { id: 'sup_000000000003', status: 'answered', created_at: '2026-11-01T10:00:00.000Z' },
  ];
  for (const at of ['2026-11-03T09:00:00Z', '2026-11-03T11:00:00Z', '2026-11-09T07:00:00Z']) {
    assert.deepEqual(copy.overdueRequests(requests, new Date(at)).map((r) => r.id), app.overdueRequests(requests, new Date(at)).map((r) => r.id), at);
  }
  const { SUPPORT_REPLY_NOTIFICATION } = await import('../src/contract/actions.js');
  const inbox = await load('services/notifications/src/services/inbox.js');
  assert.ok(inbox.NOTIFICATION_TYPES.includes(SUPPORT_REPLY_NOTIFICATION.type));
});

/**
 * Runs the real LearnLoop handlers for every row of src/contract/actions.js and checks
 * the lines they write: the events in order (name, entity type, actor), then exactly one
 * request line with the route template.
 */
test('the actions the history uses log exactly what src/contract/actions.js says', { skip: !available && 'LearnLoop repository not found' }, async () => {
  const { ACTIONS, SUPPORT_REPLY_NOTIFICATION } = await import('../src/contract/actions.js');
  const testing = await load('packages/shared/src/testing.js');
  const handlers = Object.fromEntries(await Promise.all(['catalog', 'notifications', 'admin', 'learning'].map(async (s) => [s, (await load(`services/${s}/src/handler.js`)).handler])));
  const { IDS } = testing;
  const env = testing.setupTestEnvironment({ data: { ...testing.fixtureData(), carts: [] } });
  const learner = await testing.testSessionCookie({ userId: IDS.learner });
  const staff = await testing.testSessionCookie({ userId: IDS.staff, role: 'staff' });
  const run = async (name, { cookie = learner, pathParameters, body, ok = 200 } = {}) => {
    const a = ACTIONS[name];
    env.logs.clear();
    const res = await handlers[a.service](testing.apiEvent(`${a.method} ${a.route}`, { cookie, pathParameters, body }));
    const records = env.logs.records;
    assert.equal(res.statusCode, ok, `${name}: ${res.body}`);
    const events = records.filter((r) => r.kind === 'event');
    const requests = records.filter((r) => r.kind === 'request');
    assert.deepEqual(events.map((e) => ({ event: e.event, entityType: e['entity.type'], actorType: e.actor_type })), a.events, name);
    assert.equal(requests.length, 1, name);
    assert.deepEqual([requests[0]['service.name'], requests[0]['http.method'], requests[0]['http.route']], [a.service, a.method, a.route], name);
    assert.equal(records.at(-1).kind, 'request', `${name}: the request line comes last`);
    for (const e of events) assert.equal(e.trace_id, requests[0].trace_id);
    return { body: JSON.parse(res.body), events };
  };
  try {
    const added = await run('cartAdd', { body: { courseId: IDS.data } });
    assert.equal(added.events[0]['entity.id'], IDS.data);
    assert.equal((await run('cartRead')).body.cart.count, 1);
    await run('cartRemove', { pathParameters: { courseId: IDS.data } });
    await run('cartAdd', { body: { courseId: IDS.data } });
    const enrolled = await run('enrol', { pathParameters: { courseId: IDS.data } });
    assert.equal(enrolled.events[0]['entity.id'], IDS.data);
    assert.equal((await run('cartRead')).body.cart.count, 0, 'enrolling takes the course out of the cart');
    const asked = await run('supportAsk', { body: { topic: 'certificate', body: 'Is there a certificate?' } });
    const requestId = asked.body.supportRequest.id;
    assert.equal(asked.events[0]['entity.id'], requestId);
    await run('supportList');
    await run('supportQueue', { cookie: staff });
    const replied = await run('supportReply', { cookie: staff, pathParameters: { requestId }, body: { body: 'Yes.' } });
    assert.match(replied.events[0]['entity.id'], /^ntf_[0-9a-f]{12}$/);
    assert.equal(replied.events[1]['entity.id'], requestId);
    const note = (await env.store.read('notifications')).find((n) => n.id === replied.events[0]['entity.id']);
    assert.deepEqual([note.type, note.title, note.link], [SUPPORT_REPLY_NOTIFICATION.type, SUPPORT_REPLY_NOTIFICATION.title, SUPPORT_REPLY_NOTIFICATION.link]);
    // the staff's follow-up: look an employee up, send a reminder; the employee opens it
    const training = await run('trainingLookup', { cookie: staff, pathParameters: { userId: IDS.learner } });
    assert.ok(Array.isArray(training.body.assignments) && training.body.learner.organization);
    const reminder = await run('staffMessage', { cookie: staff, pathParameters: { userId: IDS.learner }, body: { title: 'Reminder: complete "Cloud Foundations" by 20 Nov', body: 'Hi Lee, please finish the course.' } });
    const reminderId = reminder.events[0]['entity.id'];
    assert.equal(reminder.events[1]['entity.id'], reminderId, 'staff_message_sent names the notification');
    const stored = (await env.store.read('notifications')).find((n) => n.id === reminderId);
    assert.deepEqual([stored.type, stored.link, stored.read_at], ['staff_message', '/notifications', null]);
    const read = await run('notificationRead', { pathParameters: { notificationId: reminderId } });
    assert.equal(read.events[0]['entity.id'], reminderId);
    const graded = await run('quizSubmit', { pathParameters: { lessonId: IDS.lesson3 }, body: { answers: { q1: 1, q2: 1 } } });
    assert.equal(graded.events[0].value, 0);
    await run('quizSubmit', { pathParameters: { lessonId: IDS.lesson3 }, body: { answers: { q1: 0, q2: 0 } } });
    assert.equal((await env.store.read('quiz_results')).filter((q) => q.user_id === IDS.learner && q.lesson_id === IDS.lesson3).length, 2, 'a quiz can be taken again');
  } finally {
    env.logs.restore();
  }
});

test('copied trainingState matches services/admin/src/services/training.js', { skip: !available && 'LearnLoop repository not found' }, async () => {
  const copy = await import('../src/contract/training.js');
  const app = await load('services/admin/src/services/training.js');
  assert.deepEqual([...copy.TRAINING_STATUSES], [...app.TRAINING_STATUSES]);
  const lessons = [{ id: 'l1', duration_min: 10, hasQuiz: false }, { id: 'l2', duration_min: 30, hasQuiz: true }, { id: 'l3', duration_min: 20, hasQuiz: true }];
  const done = (id, at) => ({ lesson_id: id, status: 'completed', started_at: at, completed_at: at });
  const quiz = (lesson, score, at) => ({ id: `q_${lesson}_${at}`, lesson_id: lesson, score, submitted_at: at });
  const records = [
    { lessons, progress: [], quizResults: [] },
    { lessons, progress: [done('l1', '2026-11-01T10:00:00.000Z')], quizResults: [] },
    { lessons, progress: [done('l1', '2026-11-01T10:00:00.000Z'), done('l2', '2026-11-02T10:00:00.000Z'), done('l3', '2026-11-03T10:00:00.000Z')], quizResults: [quiz('l2', 33, '2026-11-02T10:05:00.000Z'), quiz('l3', 100, '2026-11-03T10:05:00.000Z')] },
    { lessons, progress: [done('l1', '2026-11-01T10:00:00.000Z'), done('l2', '2026-11-02T10:00:00.000Z'), done('l3', '2026-11-03T10:00:00.000Z')], quizResults: [quiz('l2', 33, '2026-11-02T10:05:00.000Z'), quiz('l2', 67, '2026-11-02T10:09:00.000Z'), quiz('l3', 100, '2026-11-03T10:05:00.000Z')] },
    { lessons: [], progress: [], quizResults: [] },
  ];
  for (const pass of [60, 80]) {
    for (const due of ['2026-10-31T23:59:59.000Z', '2026-11-02T23:59:59.000Z', '2026-11-30T23:59:59.000Z']) {
      for (const record of records) {
        for (const now of ['2026-11-01T12:00:00Z', '2026-11-20T12:00:00Z']) {
          const a = { due_at: due, required_pass_score: pass };
          assert.deepEqual(copy.trainingState(a, record, new Date(now)), app.trainingState(a, record, new Date(now)), `${pass} ${due} ${now}`);
        }
      }
    }
  }
});

/**
 * The generated starting state, read by LearnLoop's own code: every state domain LearnLoop
 * has is written, the employees' required training reads through the real staff route, and
 * what it says is what the generator's statistics say.
 */
test('the compliance state reads through LearnLoop\'s training route as the generator counts it', { skip: !available && 'LearnLoop repository not found' }, async () => {
  const { generate } = await import('../src/generate.js');
  const { completeState } = await import('../src/files.js');
  const { PERSONAS } = await import('../src/model.js');
  const { EMPLOYEE_PERSONA } = await import('../src/compliance.js');
  const { DOMAINS } = await load('packages/shared/src/store.js');
  for (const id of ['q4-three-signals', 'steady-state']) {
    assert.deepEqual(Object.keys(completeState(generate({ anchor: '2026-11-15', salt: 'test-salt', seed: 42, scenario: id }).data)).sort(), [...DOMAINS].sort(), `${id}: one document per LearnLoop state domain`);
  }
  const r = generate({ anchor: '2026-11-15', salt: 'test-salt', seed: 42, scenario: 'q4-three-signals', stage: 1 });
  const testing = await load('packages/shared/src/testing.js');
  const admin = (await load('services/admin/src/handler.js')).handler;
  const env = testing.setupTestEnvironment({ data: r.data });
  try {
    const staff = await testing.testSessionCookie({ userId: PERSONAS.sofia.id, role: 'staff' });
    const lena = r.data.users.find((u) => u.email === EMPLOYEE_PERSONA.email);
    const res = await admin(testing.apiEvent('GET /api/admin/learners/{userId}/training', { cookie: staff, pathParameters: { userId: lena.id } }));
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);
    assert.equal(body.learner.name, EMPLOYEE_PERSONA.name);
    assert.ok(body.assignments.some((a) => a.status === 'overdue'), 'Lena is overdue on a required course');
    // the whole account, through the service: status counts as the generator's statistics give them
    const { getLearnerTraining } = await load('services/admin/src/services/training.js');
    const statuses = {};
    for (const u of r.data.users.filter((x) => x.organization_id)) {
      for (const a of (await getLearnerTraining(u.id, new Date(r.sim.anchorMs))).assignments) statuses[a.status] = (statuses[a.status] ?? 0) + 1;
    }
    assert.deepEqual(statuses, r.stats.compliance.statuses);
    const list = JSON.parse((await admin(testing.apiEvent('GET /api/admin/learners', { cookie: staff, query: { organization: lena.organization_id } }))).body);
    assert.ok(list.learners.length >= 50 && list.learners.every((l) => l.organization?.id === lena.organization_id));
  } finally {
    env.logs.restore();
  }
});
