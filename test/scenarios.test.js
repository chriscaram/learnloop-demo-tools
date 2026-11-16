// Every scenario: well-formed, sealed by a stable fingerprint, generating a coherent
// dataset (state agrees with logs, personas intact), and showing the change it was
// designed for in the numbers the Governance Agent's detectors compare.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/generate.js';
import { completionPercent } from '../src/contract/progress.js';
import { DAY_MS, PERSONAS } from '../src/model.js';
import { replyDueAt } from '../src/contract/support.js';
import {
  canonicalJson, getScenario, loadScenarios, plainParameters, publicCard, scenarioFingerprint, validateScenario,
} from '../src/scenarios.js';

const ANCHOR = '2026-11-15';
const results = new Map();
const scenarioIds = [...loadScenarios().keys()];

before(() => {
  for (const id of scenarioIds) {
    if (id === 'lapsed-learners') continue; // generator.test.js covers it in full
    results.set(id, generate({ anchor: ANCHOR, salt: 'test-salt', seed: 42, scenario: id }));
  }
  results.set('lapsed-learners', generate({ anchor: ANCHOR, salt: 'test-salt', seed: 42, scenario: 'lapsed-learners' }));
});

test('scenario files: valid, one per id, verified or experimental with reasons', () => {
  assert.deepEqual(scenarioIds.sort(), ['abandoned-carts', 'lapsed-learners', 'outage-drop', 'slow-lessons', 'slow-support-replies', 'steady-state']);
  for (const def of loadScenarios().values()) {
    assert.ok(def.title && def.description && def.expected_finding);
    if (def.status === 'verified') assert.ok(def.verified_against.every((v) => v.file && v.threshold));
    assert.ok(plainParameters(def).length >= 5);
    const card = publicCard(def);
    assert.deepEqual(Object.keys(card).sort(), ['description', 'expected_finding', 'id', 'status', 'title'], 'a card names the expected finding and reveals no parameters');
    if (def.status === 'experimental') assert.ok(def.experimental_reason.length > 100, `${def.id} says exactly why it is experimental`);
  }
  const base = getScenario('steady-state');
  assert.throws(() => validateScenario({ ...base, parameters: { ...base.parameters, typo: 1 } }), /unknown parameters: typo/);
  assert.throws(() => validateScenario({ ...base, parameters: { ...base.parameters, outage: { fromDay: -35, toDay: -30, failureShare: 1, giveUpShare: 0, retriesMin: 0, retriesMax: 1 } } }), /Ana/);
  assert.throws(() => validateScenario({ ...base, status: 'verified', verified_against: [] }), /verified scenario/);
  assert.throws(() => getScenario('nope'), /unknown scenario/);
  const carts = getScenario('abandoned-carts');
  assert.throws(() => validateScenario({ ...carts, parameters: { ...carts.parameters, carts: { ...carts.parameters.carts, purchaseShare: 2 } } }), /purchaseShare/);
  assert.throws(() => validateScenario({ ...carts, parameters: { ...carts.parameters, carts: { ...carts.parameters.carts, extra: 1 } } }), /unknown carts parameters/);
  const support = getScenario('slow-support-replies');
  assert.throws(() => validateScenario({ ...support, parameters: { ...support.parameters, support: { ...support.parameters.support, rise: null } } }), /perWeekAfter differs/);
  assert.throws(() => validateScenario({ ...support, parameters: { ...support.parameters, support: { ...support.parameters.support, topicsAfter: { refunds: 1 } } } }), /topics/);
  assert.equal(getScenario('lapsed-learners').parameters.carts, undefined, 'lapsed-learners predates carts and support and keeps its definition (and fingerprint)');
});

test('fingerprint: canonical, stable, and sensitive to the definition, the seed and the anchor', () => {
  const def = getScenario('lapsed-learners');
  const fp = scenarioFingerprint(def, { seed: 42, anchor: ANCHOR });
  assert.match(fp, /^[0-9a-f]{64}$/);
  const reverseKeys = (v) => (Array.isArray(v) ? v.map(reverseKeys)
    : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().reverse().map((k) => [k, reverseKeys(v[k])])) : v);
  const reordered = reverseKeys(def);
  assert.notEqual(JSON.stringify(reordered), JSON.stringify(def));
  assert.equal(canonicalJson(reordered), canonicalJson(def));
  assert.equal(scenarioFingerprint(reordered, { seed: 42, anchor: ANCHOR }), fp);
  assert.notEqual(scenarioFingerprint(def, { seed: 43, anchor: ANCHOR }), fp);
  assert.notEqual(scenarioFingerprint(def, { seed: 42, anchor: '2026-11-16' }), fp);
  const tweaked = { ...def, parameters: { ...def.parameters, lapse: { ...def.parameters.lapse, lastLessonToDay: -30 } } };
  assert.notEqual(scenarioFingerprint(tweaked, { seed: 42, anchor: ANCHOR }), fp);
});

test('every scenario: a coherent dataset (state agrees with logs, personas intact, no missing hour)', () => {
  for (const [id, r] of results) {
    const { users, courses, lessons, enrolments, progress, subscriptions } = r.data;
    const anchorMs = r.sim.anchorMs;
    const dayOf = (iso) => Math.floor((Date.parse(iso) - anchorMs) / DAY_MS);
    assert.equal(users.filter((u) => u.role === 'learner').length, 420, id);
    assert.equal(users.filter((u) => u.role === 'staff').length, 3, id);
    // progress agrees with the last lesson event of every learner
    const lastLessonEvent = new Map();
    for (const q of r.sim.requests) {
      for (const e of q.events ?? []) {
        if (e.event === 'lesson_started' || e.event === 'lesson_completed') lastLessonEvent.set(q.userId, new Date(e.ts).toISOString());
      }
    }
    const lastActivity = new Map();
    for (const c of progress.courses) {
      if (c.last_activity_at && (!lastActivity.has(c.user_id) || lastActivity.get(c.user_id) < c.last_activity_at)) lastActivity.set(c.user_id, c.last_activity_at);
    }
    for (const [user, last] of lastLessonEvent) assert.equal(lastActivity.get(user), last, `${id}: progress agrees for ${user}`);
    // every started/completed record in the state has a matching lesson event when it is in the window
    const events = new Set();
    for (const q of r.sim.requests) for (const e of q.events ?? []) if (e.event === 'lesson_started') events.add(`${q.userId}|${e.entityId}`);
    for (const p of progress.lessons) {
      if (dayOf(p.started_at) >= -60) assert.ok(events.has(`${p.user_id}|${p.lesson_id}`), `${id}: a lesson_started log line for ${p.user_id} ${p.lesson_id}`);
    }
    // no traffic after cancelling
    const cancelledAt = new Map(subscriptions.filter((s) => s.cancelled_at).map((s) => [s.user_id, Date.parse(s.cancelled_at)]));
    for (const q of r.sim.requests) if (q.kind === 'api' && cancelledAt.has(q.userId)) assert.ok(q.ts < cancelledAt.get(q.userId) + 15 * 60_000, `${id}: no traffic after cancelling`);
    const cancelEvents = r.sim.requests.flatMap((q) => q.events ?? []).filter((e) => e.event === 'subscription_cancelled').length;
    assert.equal(cancelEvents, cancelledAt.size, `${id}: one cancellation event per cancelled subscription`);
    // personas
    const ana = users.find((u) => u.id === PERSONAS.ana.id);
    const cloud = courses.find((c) => c.title === 'Cloud Foundations');
    assert.ok(ana && users.find((u) => u.id === PERSONAS.marco.id) && users.find((u) => u.email === PERSONAS.sofia.email && u.role === 'staff'), id);
    assert.deepEqual(enrolments.filter((e) => e.user_id === ana.id).map((e) => e.course_id), [cloud.id], id);
    assert.equal(completionPercent(progress.lessons.filter((p) => p.user_id === ana.id), { lessons: lessons.filter((l) => l.course_id === cloud.id) }), 35, id);
    assert.equal(dayOf(progress.courses.find((c) => c.user_id === ana.id).last_activity_at), -33, id);
    const marcoLast = progress.courses.filter((c) => c.user_id === PERSONAS.marco.id).map((c) => c.last_activity_at).sort().at(-1);
    assert.equal(dayOf(marcoLast), -1, id);
    // one CloudFront object per hour for all 60 days
    assert.equal(r.cloudfront.size, 60 * 24, id);
    assert.equal(r.stats.daily.length, 60, id);
    checkCartsAndSupport(id, r);
  }
});

/** The cart and support state agree with the logs the same simulation wrote. */
function checkCartsAndSupport(id, r) {
  const { carts, support_requests: support, enrolments, notifications, courses, users } = r.data;
  const courseIds = new Set(courses.map((c) => c.id));
  const events = r.sim.requests.flatMap((q) => (q.events ?? []).map((e) => ({ ...e, userId: q.userId, route: q.route })));
  const lastCartEvent = new Map();
  for (const e of events) if (['cart_item_added', 'cart_item_removed', 'course_enrolled'].includes(e.event)) lastCartEvent.set(`${e.userId}|${e.entityId}`, e);
  const enrolled = new Set(enrolments.map((e) => `${e.user_id}|${e.course_id}`));
  for (const cart of carts) {
    assert.ok(cart.items.length > 0, `${id}: no empty cart entry`);
    for (const item of cart.items) {
      const key = `${cart.user_id}|${item.course_id}`;
      assert.ok(courseIds.has(item.course_id), `${id}: a real course in the cart`);
      assert.ok(!enrolled.has(key), `${id}: nobody has a course in the cart they are enrolled in`);
      const last = lastCartEvent.get(key);
      assert.equal(last?.event, 'cart_item_added', `${id}: the last cart event for ${key} is the add`);
      assert.equal(new Date(last.ts).toISOString(), item.added_at, `${id}: added_at is the add event's time`);
    }
  }
  const byId = new Map(support.map((q) => [q.id, q]));
  const created = events.filter((e) => e.event === 'support_request_created');
  assert.deepEqual(created.map((e) => e.entityId).sort(), support.map((q) => q.id).sort(), `${id}: one support_request_created per request`);
  for (const e of created) assert.equal(new Date(e.ts).toISOString(), byId.get(e.entityId).created_at);
  const replies = events.filter((e) => e.event === 'support_reply_sent');
  assert.equal(replies.length, support.reduce((n, q) => n + q.replies.length, 0), `${id}: one support_reply_sent per reply`);
  const staffIds = new Set(users.filter((u) => u.role === 'staff').map((u) => u.id));
  const notificationIds = new Set(notifications.filter((n) => n.type === 'support_reply').map((n) => n.id));
  for (const q of support) {
    assert.equal(q.status === 'answered', q.replies.length > 0, `${id}: answered means replied`);
    assert.equal(q.answered_at, q.replies[0]?.created_at ?? null);
    for (const reply of q.replies) assert.ok(staffIds.has(reply.staff_id));
  }
  assert.equal(notificationIds.size, replies.length, `${id}: every reply created an inbox notification`);
  for (const e of events.filter((x) => x.event === 'notification_created' && x.route === '/api/admin/support-requests/{requestId}/reply')) assert.ok(notificationIds.has(e.entityId));
  // free text (questions, replies) and e-mails never reach the logs; every event is a known one
  const text = [...r.appLogs.values()].join('');
  for (const q of support) assert.ok(!text.includes(q.body.slice(0, 40)), `${id}: a question's text is not logged`);
  assert.ok(!text.includes('@'), `${id}: no e-mail in the logs`);
  for (const m of text.matchAll(/"entity\.id":"([^"]+)"/g)) assert.match(m[1], /^[a-z]{2,4}_[0-9a-f]{12}$|^[a-z][a-z0-9_]+$/);
  // the daily backlog check: one warning per open question past its reply time
  const warnings = r.sim.systemLogs.filter((l) => l.errorType === 'SupportReplyTimeout');
  for (const day of [-20, -10, -2]) {
    const at = r.sim.anchorMs + day * DAY_MS + 7 * 3600_000;
    const expected = support.filter((q) => Date.parse(q.created_at) < at && (!q.answered_at || Date.parse(q.answered_at) > at) && replyDueAt(q.created_at).getTime() <= at).length;
    const logged = warnings.filter((w) => w.ts >= at && w.ts < at + 3600_000).length;
    assert.equal(logged, expected, `${id}: backlog warnings on day ${day}`);
  }
}

const dv = (id) => results.get(id).stats;

test('steady-state: nothing crosses a detector threshold', () => {
  const s = dv('steady-state');
  for (const [route, drop] of [['enrol', s.carts.enrolDropPct.ips], ['cart add', s.carts.cartAddDropPct.ips], ['cart read', s.carts.cartReadDropPct.ips]]) {
    assert.ok(Math.abs(drop) < 10, `${route} ${drop}`); // ACTOR_INACTIVITY_DROP_PCT = 33
  }
  assert.ok(s.support.weeks.every((w) => w.backlogWarnings <= 7 && w.asked <= 8), 'a few questions a week, answered within about a day');
  assert.equal(s.support.endState.overdueAtStart, 0);
  assert.ok(Math.abs(s.lessonUsersDropPct) < 5, `lesson users drop ${s.lessonUsersDropPct}`);
  for (const [route, drop] of Object.entries(s.distinctUserDropPct)) assert.ok(drop < 10, `${route} ${drop}`); // ACTOR_INACTIVITY_DROP_PCT = 33
  assert.ok(Math.abs(s.learningRequestTrendPct) < 10, `trend ${s.learningRequestTrendPct}`); // TREND_FLAT_PCT = 10
  for (const w of Object.values(s.detectorWindows)) {
    assert.ok(w.lessonP95Ms < 200 && w.lessonP99Ms < 300, `p95 ${w.lessonP95Ms}`); // budget 1000 / 2500
    assert.ok(w.learningServerErrorPct < 1); // INCIDENT_ERROR_RATE_PCT = 5
  }
  assert.ok(s.health.worst5xxShare < 0.003);
  const weekly = s.weeks.map((w) => w.cancellations);
  assert.ok(Math.max(...weekly) <= 8, `weekly cancellations ${weekly}`);
});

test('slow-lessons: lesson p95 above the 1000 ms budget in both windows, from one release on, nothing else moves', () => {
  const s = dv('slow-lessons');
  const releaseDay = Math.floor((Date.parse(s.slowRelease.from) - results.get('slow-lessons').sim.anchorMs) / DAY_MS);
  assert.ok(releaseDay >= -50 && releaseDay <= -37, `release day ${releaseDay}`);
  assert.ok(s.health.versions.some((v) => v.version === s.slowRelease.version), 'the slowdown starts with a real release');
  for (const [name, w] of Object.entries(s.detectorWindows)) {
    assert.ok(w.lessonP95Ms > 1500, `${name} p95 ${w.lessonP95Ms}`); // well above DEFAULT_ROUTE_LATENCY_BUDGET.p95_ms = 1000
    assert.ok(w.lessonLatencySamples > 1000, 'MIN_LATENCY_SAMPLES = 100');
    assert.equal(w.learningServerErrorPct, 0);
  }
  for (const d of s.daily) {
    if (d.day < releaseDay) assert.ok(d.lessonP95Ms < 200, `day ${d.day} before the release: ${d.lessonP95Ms}`);
    if (d.day > releaseDay) assert.ok(d.lessonP95Ms > 1500, `day ${d.day} after the release: ${d.lessonP95Ms}`);
  }
  assert.ok(Math.abs(s.lessonUsersDropPct) < 5 && Math.abs(s.learningRequestTrendPct) < 10, 'usage stays flat');
  const other = dv('steady-state').detectorWindows.recent;
  assert.ok(Math.abs(s.detectorWindows.recent.usersOnLessonRoutes - other.usersOnLessonRoutes) < 15);
});

test('outage-drop: server errors above 5% in both windows, a lost third on the progress route, a falling trend', () => {
  const s = dv('outage-drop');
  const { outage } = getScenario('outage-drop').parameters;
  for (const [name, w] of Object.entries(s.detectorWindows)) {
    assert.ok(w.learningServerErrorPct > 6.5, `${name} server errors ${w.learningServerErrorPct}%`); // INCIDENT_ERROR_RATE_PCT = 5
  }
  assert.ok(s.detectorWindows.earlier.usersPerRoute['/api/lessons/{lessonId}/progress'] >= 200, 'MIN_INACTIVITY_ACTORS = 200');
  assert.ok(s.distinctUserDropPct['/api/lessons/{lessonId}/progress'] >= 35, `progress drop ${s.distinctUserDropPct['/api/lessons/{lessonId}/progress']}`); // 33
  assert.ok(s.learningRequestTrendPct <= -20, `trend ${s.learningRequestTrendPct}`); // TREND_NEGATIVE_PCT = 10
  for (const d of s.daily) {
    const inside = d.day >= outage.fromDay && d.day <= outage.toDay;
    if (inside) assert.ok(d.lessonErrorPct > 60, `day ${d.day}: ${d.lessonErrorPct}%`);
    else assert.ok(d.lessonErrorPct < 1, `day ${d.day} outside the outage: ${d.lessonErrorPct}%`);
  }
  const lost = new Set(results.get('outage-drop').sim.groups.lostAfterOutage);
  const anchorMs = results.get('outage-drop').sim.anchorMs;
  for (const q of results.get('outage-drop').sim.requests) {
    if (lost.has(q.userId) && q.route === '/api/lessons/{lessonId}/progress') {
      assert.ok(Math.floor((q.ts - anchorMs) / DAY_MS) <= outage.toDay, 'a learner who gave up opens no lesson after the outage');
    }
  }
});

test('lapsed-learners: the lesson routes lose more than a third of their users, health flat', () => {
  const s = dv('lapsed-learners');
  assert.ok(s.lessonUsersDropPct >= 38, `drop ${s.lessonUsersDropPct}`);
  assert.ok(s.detectorWindows.earlier.usersOnLessonRoutes >= 300);
  assert.ok(s.distinctUserDropPct['/api/me/progress'] < 10, 'the busiest route of the capability barely moves');
  for (const w of Object.values(s.detectorWindows)) assert.ok(w.learningServerErrorPct < 1 && w.lessonP95Ms < 200);
});

test('abandoned-carts: the enrol route loses about 45% of its people while cart routes and learning stay flat', () => {
  for (const anchor of ['2026-11-15', '2026-11-18', '2026-11-20']) {
    const s = anchor === ANCHOR ? dv('abandoned-carts') : generate({ anchor, salt: 'test-salt', seed: 42, scenario: 'abandoned-carts' }).stats;
    const enrol = '/api/courses/{courseId}/enrol';
    const earlier = s.carts.actorWindows.earlier[enrol].ips;
    assert.ok(earlier >= 280, `${anchor}: ${earlier} people enrol in days -59..-30`); // MIN_INACTIVITY_ACTORS = 200
    assert.ok(s.carts.enrolDropPct.ips >= 38 && s.carts.enrolDropPct.ips <= 50, `${anchor}: enrol drop ${s.carts.enrolDropPct.ips}`); // ACTOR_INACTIVITY_DROP_PCT = 33
    assert.ok(Math.abs(s.carts.cartAddDropPct.ips) < 15, `${anchor}: cart add drop ${s.carts.cartAddDropPct.ips}`);
    assert.ok(Math.abs(s.carts.cartReadDropPct.ips) < 10, `${anchor}: cart read drop ${s.carts.cartReadDropPct.ips}`);
    assert.ok(Math.abs(s.lessonUsersDropPct) < 5 && Math.abs(s.learningRequestTrendPct) < 7, `${anchor}: learning stays flat (${s.lessonUsersDropPct}, ${s.learningRequestTrendPct})`);
    // learners with nothing new to start record less progress (about -15%), well under the 33% bar
    for (const route of Object.keys(s.distinctUserDropPct)) assert.ok(s.distinctUserDropPct[route] < 25, `${anchor}: ${route} ${s.distinctUserDropPct[route]}`);
    assert.ok(s.health.worst5xxShare < 0.003);
    assert.ok(s.carts.endState.learnersWithItems >= 120 && s.carts.endState.learnersWithItems <= 175, `${anchor}: ${s.carts.endState.learnersWithItems} learners with a waiting cart`);
  }
  const r = results.get('abandoned-carts');
  const marco = r.data.carts.find((c) => c.user_id === PERSONAS.marco.id);
  const titles = new Map(r.data.courses.map((c) => [c.id, c.title]));
  assert.deepEqual(marco.items.map((i) => titles.get(i.course_id)), ['Python for Data Work', 'Data Visualization Fundamentals']);
  assert.deepEqual(marco.items.map((i) => Math.floor((Date.parse(i.added_at) - r.sim.anchorMs) / DAY_MS)), [-16, -9]);
});

test('slow-support-replies: more questions on a few topics, replies from about a day to about a week, a backlog of open questions', () => {
  const s = dv('slow-support-replies');
  const first = s.support.weeks.slice(0, 3);
  const last = s.support.weeks.slice(-2);
  const avg = (ws, k) => ws.reduce((a, w) => a + w[k], 0) / ws.length;
  assert.ok(avg(last, 'asked') >= 4 * Math.max(1, avg(first, 'asked')), `asked ${avg(first, 'asked')} -> ${avg(last, 'asked')} a week`);
  assert.ok(first.every((w) => w.medianReplyHours === null || w.medianReplyHours <= 60), 'answered within about a day at first');
  assert.ok(last.every((w) => w.medianReplyHours >= 120), `about a week at the end: ${last.map((w) => w.medianReplyHours)}`);
  assert.ok(last.every((w) => w.answeredWithinTarget <= 2));
  const lastTopics = last.reduce((acc, w) => { for (const [k, v] of Object.entries(w.topics)) acc[k] = (acc[k] ?? 0) + v; return acc; }, {});
  const sorted = Object.values(lastTopics).sort((a, b) => b - a);
  assert.ok(sorted.slice(0, 3).reduce((a, b) => a + b, 0) >= 0.8 * sorted.reduce((a, b) => a + b, 0), `three topics carry most questions: ${JSON.stringify(lastTopics)}`);
  assert.ok(s.support.endState.open >= 30 && s.support.endState.overdueAtStart >= 25, JSON.stringify(s.support.endState));
  // what the deployed daily check will log once the state is loaded: far above MIN_GROUP_SIZE = 10 a week
  assert.ok(s.support.projectedWarningsPerDay.every((n) => n >= 25), `${s.support.projectedWarningsPerDay}`);
  assert.ok(first.every((w) => w.backlogWarnings <= 7));
  assert.ok(Math.abs(s.lessonUsersDropPct) < 5 && Math.abs(s.carts.enrolDropPct.ips) < 10, 'nothing else moves');
  const r = results.get('slow-support-replies');
  const ana = r.data.support_requests.filter((q) => q.user_id === PERSONAS.ana.id);
  assert.equal(ana.length, 1);
  assert.deepEqual([ana[0].topic, ana[0].status], ['certificate', 'open']);
  const sofia = r.data.users.find((u) => u.email === PERSONAS.sofia.email);
  const repliesBy = r.data.support_requests.flatMap((q) => q.replies).reduce((acc, x) => ({ ...acc, [x.staff_id]: (acc[x.staff_id] ?? 0) + 1 }), {});
  assert.equal(Object.entries(repliesBy).sort((a, b) => b[1] - a[1])[0][0], sofia.id, 'Sofia answers the most questions');
});
