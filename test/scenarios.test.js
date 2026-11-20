// Every scenario: well-formed, sealed by a stable fingerprint, generating a coherent
// dataset (state agrees with logs, personas intact), and showing the change it was
// designed for in the numbers the Governance Agent's detectors compare.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, generate, INACTIVITY_BARS } from '../src/generate.js';
import { completionPercent } from '../src/contract/progress.js';
import { DAY_MS, PERSONAS, simulate } from '../src/model.js';
import { EMPLOYEE_PERSONA, FOLLOW_UP_SURGE, MANAGER_PERSONA, TRAINING_ROUTE } from '../src/compliance.js';
import { formatJson } from '../src/files.js';
import { createHash } from 'node:crypto';
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
  assert.deepEqual(scenarioIds.sort(), ['abandoned-carts', 'lapsed-learners', 'outage-drop', 'q4-three-signals', 'slow-lessons', 'steady-state']);
  for (const def of loadScenarios().values()) {
    assert.ok(def.title && def.description && def.expected_finding);
    if (def.status === 'verified') assert.ok(def.verified_against.every((v) => v.file && v.threshold));
    assert.ok(plainParameters(def).length >= 5);
    const card = publicCard(def);
    assert.deepEqual(Object.keys(card).filter((k) => !['cases', 'stages', 'firstStage'].includes(k)).sort(), ['description', 'id', 'title'], 'a card shows the title, the description, its prepared cases and how many stages only: no expected finding, no parameters');
    if (card.stages !== undefined) assert.ok(Number.isInteger(card.stages) && !JSON.stringify(card).includes('recent_traffic_withheld'), 'a card says how many stages, never what they withhold');
    assert.ok(!JSON.stringify(card).includes('"parameters"'));
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
  const support = getScenario('steady-state');
  assert.throws(() => validateScenario({ ...support, parameters: { ...support.parameters, support: { ...support.parameters.support, perWeekAfter: 24 } } }), /perWeekAfter differs/);
  assert.throws(() => validateScenario({ ...support, parameters: { ...support.parameters, support: { ...support.parameters.support, topicsAfter: { refunds: 1 } } } }), /topics/);
  assert.equal(getScenario('lapsed-learners').parameters.carts, undefined, 'lapsed-learners predates carts and support and keeps its definition (and fingerprint)');
  const three = getScenario('q4-three-signals');
  assert.throws(() => validateScenario({ ...three, parameters: { ...three.parameters, support: { ...three.parameters.support, help: {} } } }), /unknown support parameters: help/, 'the Help give-up case is gone');
  const comp = three.parameters.compliance;
  const withComp = (c) => ({ ...three, parameters: { ...three.parameters, compliance: c } });
  assert.throws(() => validateScenario(withComp({ ...comp, extra: 1 })), /unknown compliance parameters: extra/);
  assert.throws(() => validateScenario(withComp({ ...comp, requiredPassScore: 0 })), /requiredPassScore/);
  assert.throws(() => validateScenario(withComp({ ...comp, organizations: [{ ...comp.organizations[0], courses: [{ course: 'nope', assignedDay: -40, dueDay: -10 }] }] })), /course is one of/);
  assert.throws(() => validateScenario(withComp({ ...comp, organizations: [{ ...comp.organizations[0], courses: [{ course: 'sql', assignedDay: -10, dueDay: -40 }] }] })), /assignedDay < dueDay/);
  assert.throws(() => validateScenario(withComp({ ...comp, organizations: [{ ...comp.organizations[0], teams: comp.organizations[0].teams.map((t) => ({ ...t, behind: false })) }] })), /behind and teams that are not/);
  assert.throws(() => validateScenario(withComp({ ...comp, organizations: [...comp.organizations, comp.organizations[0]] })), /at most 300 employees/);
  assert.throws(() => validateScenario(withComp({ ...comp, followUp: { ...comp.followUp, staffWeights: [1, 1] } })), /staffWeights/);
  assert.throws(() => validateScenario(withComp({ ...comp, followUp: { ...comp.followUp, surgeFromDay: -20 } })), /surgeFromDay must be recent_window_from_day/);
  assert.throws(() => validateScenario(withComp({ ...comp, quizRetry: { share: 0.5, maxRetries: 9 } })), /quizRetry/);
  assert.throws(() => validateScenario({ ...three, parameters: { ...three.parameters, lapse: null, cancellations: carts.parameters.cancellations } }), /lapsedAddPerBrowseSession needs a lapse/);
  for (const id of ['abandoned-carts', 'steady-state', 'slow-lessons', 'outage-drop']) {
    assert.equal(getScenario(id).parameters.compliance, undefined, `${id} keeps its definition (no enterprise accounts)`);
    assert.equal(getScenario(id).parameters.carts.lapsedAddPerBrowseSession, undefined, `${id} keeps its definition`);
  }
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
  // no support backlog warning (LearnLoop no longer runs a daily backlog check)
  assert.ok(!text.includes('SupportReplyTimeout'), `${id}: no support backlog warning`);
}

const dv = (id) => results.get(id).stats;

test('steady-state: nothing crosses a detector threshold', () => {
  const s = dv('steady-state');
  for (const [route, drop] of [['enrol', s.carts.enrolDropPct.ips], ['cart add', s.carts.cartAddDropPct.ips], ['cart read', s.carts.cartReadDropPct.ips]]) {
    assert.ok(Math.abs(drop) < 10, `${route} ${drop}`); // ACTOR_INACTIVITY_DROP_PCT = 33
  }
  assert.ok(s.support.weeks.every((w) => w.asked <= 8), 'a few questions a week, answered within about a day');
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

// The five single-signal scenarios at ANCHOR, seed 42, salt 'test-salt': every state
// document, application log file and CloudFront object, digested BEFORE the compliance case
// existed (commit 7d888e3). Adding it must leave them byte for byte as they were.
const SINGLE_SIGNAL_DIGESTS = Object.freeze({
  'lapsed-learners': '2e24b575c198a3ff96feda3bac54eb0d1c8db3b63563d29a3fc5b9b501767ee8',
  'steady-state': 'ae1c9e73598a83d1db416224e7b76ead3f23641cc647cd40943ee9df89c86723',
  'slow-lessons': '8e03398b4ccbd09a248e5867452bb79538fe6524cf3edfe5f0e8022f4086ef04',
  'abandoned-carts': '54502f73c66b62d4c6b03437745cde0d9b11724185820b8b493b442bbf7ff6de',
  'outage-drop': '7b1adb0d98bffc6c2ac4c21ac48c638b67fbae9a91d27c367e439ae22c5f676b',
});

test('the single-signal scenarios are byte for byte what they were before the compliance case', () => {
  for (const [id, expected] of Object.entries(SINGLE_SIGNAL_DIGESTS)) {
    const r = results.get(id);
    const hash = createHash('sha256');
    for (const [domain, value] of Object.entries(r.data)) hash.update(domain).update(formatJson(value));
    for (const [key, body] of r.appLogs) hash.update(key).update(body);
    for (const [key, body] of r.cloudfront) hash.update(key).update(body);
    assert.equal(hash.digest('hex'), expected, id);
    assert.equal(r.data.organizations, undefined, `${id}: no enterprise accounts in its data (written empty by writeData)`);
    assert.equal(r.stats.compliance, null, id);
  }
});

// q4-three-signals: two drops, each in the routes of a different LearnLoop service (one
// service directory = one code component = one capability for the agent's route mapping),
// and the compliance case, which no current detector reads. Checked for start dates on all
// seven weekdays. The detector names a capability's qualifying route with the most earlier
// users, so each service must have exactly the intended routes over the bars and
// everything else in it well under them.
const WEEK_OF_ANCHORS = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];
const LESSON_ROUTE_SET = new Set(['/api/lessons/{lessonId}', '/api/courses/{courseId}/lessons', '/api/lessons/{lessonId}/progress', '/api/lessons/{lessonId}/quiz']);
const q4Stats = new Map();
const q4At = (anchor) => {
  if (!q4Stats.has(anchor)) q4Stats.set(anchor, anchor === ANCHOR ? dv('q4-three-signals') : computeStats(simulate({ anchor, seed: 42, scenario: getScenario('q4-three-signals') }), { cloudfront: new Map(), appLogs: new Map() }));
  return q4Stats.get(anchor);
};

test('q4-three-signals: lessons and enrolment each lose about half of their people, Help stays ordinary, on all seven start weekdays', () => {
  for (const anchor of WEEK_OF_ANCHORS) {
    const s = q4At(anchor);
    const c = s.capabilities;
    const route = (svc, r) => c[svc].routes[r];
    // 1. learning: the lesson routes, not the dashboard read every visitor makes
    assert.ok(c.learning.inactiveRoutes.length >= 3, `${anchor}: learning ${c.learning.inactiveRoutes}`);
    for (const r of c.learning.inactiveRoutes) assert.ok(LESSON_ROUTE_SET.has(r), `${anchor}: ${r} is a lesson route`);
    for (const r of ['/api/lessons/{lessonId}', '/api/lessons/{lessonId}/progress']) {
      assert.ok(route('learning', r).earlier >= 300 && route('learning', r).dropPct >= 38, `${anchor}: ${r} ${JSON.stringify(route('learning', r))}`);
    }
    // 2. catalog: the enrol route alone; the cart routes stay flat
    const enrol = route('catalog', '/api/courses/{courseId}/enrol');
    assert.deepEqual(c.catalog.inactiveRoutes, ['/api/courses/{courseId}/enrol'], `${anchor}: catalog`);
    assert.ok(enrol.earlier >= 280 && enrol.dropPct >= 40, `${anchor}: enrol ${JSON.stringify(enrol)}`);
    assert.ok(route('catalog', '/api/me/cart/items').dropPct < 25, `${anchor}: cart adds ${route('catalog', '/api/me/cart/items').dropPct}`);
    for (const r of ['/api/me/cart', '/api/courses', '/api/courses/{courseId}']) assert.ok(Math.abs(route('catalog', r).dropPct) < 10, `${anchor}: ${r}`);
    // 3. notifications: Help is an ordinary feature now; nothing in the service crosses a bar
    assert.deepEqual(c.notifications.inactiveRoutes, [], `${anchor}: notifications`);
    assert.ok((route('notifications', '/api/me/support-requests')?.earlier ?? 0) < INACTIVITY_BARS.minEarlierActors, `${anchor}: a few learners ask the team`);
    assert.ok(s.support.weeks.every((w) => w.asked <= 8) && s.support.endState.overdueAtStart <= 2, `${anchor}: questions answered within about a day`);
    // the capability-level max hides each drop (the route-level fallback names it), and
    // nothing else crosses the bars: billing, identity, and admin (one office address)
    for (const svc of ['learning', 'catalog', 'notifications']) assert.ok(c[svc].serviceMax.dropPct < 10, `${anchor}: ${svc} max ${c[svc].serviceMax.dropPct}`);
    for (const svc of ['admin', 'billing', 'identity']) assert.deepEqual(c[svc].inactiveRoutes, [], `${anchor}: ${svc}`);
    assert.ok(Math.max(...Object.values(c.admin.routes).map((r) => r.earlier)) < INACTIVITY_BARS.minEarlierActors, `${anchor}: staff are a handful of people`);
    // healthy: no incident for the drift engine to confirm
    for (const svc of Object.values(c)) for (const pct of Object.values(svc.serverErrorPct)) assert.ok(pct < 0.5, `${anchor}: server errors ${pct}%`); // INCIDENT_ERROR_RATE_PCT = 5
    assert.ok(s.health.worst5xxShare < 0.005, `${anchor}: worst route-day ${s.health.worst5xxShare}`);
    assert.ok(s.health.lessonsP95.max < 200 && s.health.otherP95.max < 100, `${anchor}: latency flat`);
    assert.ok(s.carts.endState.learnersWithItems >= 120 && s.carts.endState.learnersWithItems <= 175, `${anchor}: ${s.carts.endState.learnersWithItems} learners with a waiting cart`);
  }
});

// Case 3, compliance training: the facts a future detector would read (docs/signal-spec.md),
// with margin, on all seven start weekdays.
test('q4-three-signals case 3: overdue training concentrated in some teams, the staff chasing by hand far more often, completion not improving', () => {
  const def = getScenario('q4-three-signals');
  const behindTeams = new Set(def.parameters.compliance.organizations.flatMap((o) => o.teams.filter((t) => t.behind).map((t) => `${o.name} | ${t.name}`)));
  for (const anchor of WEEK_OF_ANCHORS) {
    const k = q4At(anchor).compliance;
    assert.ok(k.employees >= 200 && k.employees <= 260 && k.organizations === 3, `${anchor}: ${k.employees} employees`);
    // state: overdue concentrated in the teams marked behind
    for (const [team, t] of Object.entries(k.byTeam)) {
      if (!t.dueByStart) continue;
      if (behindTeams.has(team)) assert.ok(t.overduePct >= 45, `${anchor}: ${team} ${t.overduePct}% overdue`);
      else assert.ok(t.overduePct <= 25, `${anchor}: ${team} ${t.overduePct}% overdue`);
    }
    const overdueAll = Object.values(k.byTeam).reduce((n, t) => n + t.overdue, 0);
    const overdueBehind = Object.entries(k.byTeam).filter(([team]) => behindTeams.has(team)).reduce((n, [, t]) => n + t.overdue, 0);
    assert.ok(overdueBehind / overdueAll >= 0.6, `${anchor}: ${overdueBehind} of ${overdueAll} overdue courses are in the behind teams`);
    assert.ok(k.statuses.overdue >= 45, `${anchor}: ${k.statuses.overdue} overdue`);
    const atRisk = Object.values(k.byOrganization).reduce((n, o) => n + o.atRisk, 0);
    assert.ok(atRisk >= 40, `${anchor}: ${atRisk} at risk`);
    // completion on time stays far from 95% and does not improve from one due date to the next
    const past = Object.values(k.waves).filter((w) => w.dueDay < 0).sort((a, b) => a.dueDay - b.dueDay);
    assert.equal(past.length, 3);
    for (const w of past) assert.ok(w.onTimePct >= 45 && w.onTimePct <= 80, `${anchor}: on time ${w.onTimePct}%`);
    assert.ok(past.at(-1).onTimePct <= past[0].onTimePct + 8, `${anchor}: completion does not improve ${past.map((w) => w.onTimePct)}`);
    // logs: the staff's manual follow-up, about three times as much in the recent window
    const { earlier, recent } = k.windows;
    assert.ok(earlier.reminders >= 70 && recent.reminders >= 2.2 * earlier.reminders, `${anchor}: reminders ${earlier.reminders} -> ${recent.reminders}`);
    assert.ok(recent.trainingLookups >= 2.2 * earlier.trainingLookups && recent.trainingLookups >= recent.reminders, `${anchor}: look-ups ${earlier.trainingLookups} -> ${recent.trainingLookups}`);
    assert.ok(recent.reminders + earlier.reminders >= 300, `${anchor}: hundreds of reminders`);
    assert.ok(recent.maxRemindersPerStaffWeek >= 30, `${anchor}: ${recent.maxRemindersPerStaffWeek} reminders by one person in one week`);
    assert.ok(recent.reminderTitles <= 8 && recent.topTitleShare >= 15, `${anchor}: one template (${recent.reminderTitles} titles)`);
    assert.deepEqual(recent.officeIps, ['203.0.113.10'], `${anchor}: from the office`);
    // and the reminders do not bring the employees back: at most half are followed by any lesson
    // activity on the course within 7 days, and tripling them does not raise that share
    const followed = (w) => w.remindersFollowedByLessonIn7Days / w.reminders;
    // (at most 60% in the earlier window since 2026-11-19, when the learners' visits started to
    // rise through it, visitRate; the recent window, after the surge, stays under 35%)
    assert.ok(followed(earlier) <= 0.6 && followed(recent) <= 0.35, `${anchor}: ${earlier.remindersFollowedByLessonIn7Days} of ${earlier.reminders} and ${recent.remindersFollowedByLessonIn7Days} of ${recent.reminders} followed by a lesson`);
    for (const w of [earlier, recent]) assert.ok(followed(w) <= 0.6, `${anchor}: ${w.remindersFollowedByLessonIn7Days} of ${w.reminders} followed by a lesson`);
    assert.ok(followed(recent) <= followed(earlier) + 0.06, `${anchor}: followed by a lesson ${followed(earlier).toFixed(2)} -> ${followed(recent).toFixed(2)}`);
    assert.ok(earlier.employeeFailedQuizAttempts + recent.employeeFailedQuizAttempts >= 25, `${anchor}: failed quiz attempts`);
    // peaks before each due date: the busiest reminder day is within ten days before one
    const dues = Object.values(k.waves).map((w) => w.dueDay);
    const busiest = [...k.daily].sort((a, b) => b.reminders - a.reminders).slice(0, 5);
    for (const d of busiest) assert.ok(dues.some((due) => d.day <= due + 21 && d.day >= due - 10), `${anchor}: day ${d.day} is near a due date`);
  }
});

test('q4-three-signals: the compliance state agrees with the logs', () => {
  const r = results.get('q4-three-signals');
  const { users, training_assignments: assignments, organizations, notifications, quiz_results: quiz } = r.data;
  const anchorMs = r.sim.anchorMs;
  const employees = users.filter((u) => u.organization_id);
  const byId = new Map(users.map((u) => [u.id, u]));
  for (const u of employees) {
    assert.ok(organizations.some((o) => o.id === u.organization_id));
    assert.equal(typeof u.department, 'string');
    if (u.manager_id) assert.equal(byId.get(u.manager_id).organization_id, u.organization_id, 'the manager works for the same account');
    assert.deepEqual(Object.keys(u), ['id', 'email', 'name', 'role', 'created_at', 'organization_id', 'manager_id', 'department'], 'organisational fields only');
  }
  assert.ok(users.filter((u) => !u.organization_id).every((u) => Object.keys(u).length === 5));
  for (const a of assignments) {
    assert.ok(byId.get(a.user_id).organization_id === a.organization_id);
    assert.deepEqual(Object.keys(a), ['id', 'organization_id', 'user_id', 'course_id', 'assigned_at', 'due_at', 'required_pass_score']);
  }
  // every quiz attempt in the window has its quiz_submitted line, and the other way round
  const events = r.sim.requests.flatMap((q) => (q.events ?? []).map((e) => ({ ...e, userId: q.userId, route: q.route })));
  const submitted = new Set(events.filter((e) => e.event === 'quiz_submitted').map((e) => `${e.userId}|${e.entityId}|${new Date(e.ts).toISOString()}`));
  const inWindow = quiz.filter((q) => Date.parse(q.submitted_at) >= anchorMs - 60 * DAY_MS);
  assert.equal(submitted.size, inWindow.length);
  for (const q of inWindow) assert.ok(submitted.has(`${q.user_id}|${q.lesson_id}|${q.submitted_at}`), `a log line for quiz attempt ${q.id}`);
  // every staff message is a notification, every opened one has its notification_opened
  const sent = events.filter((e) => e.event === 'staff_message_sent').map((e) => e.entityId);
  const staffMessages = notifications.filter((n) => n.type === 'staff_message' && Date.parse(n.created_at) >= anchorMs - 60 * DAY_MS);
  assert.deepEqual([...sent].sort(), staffMessages.map((n) => n.id).sort());
  const opened = new Map(events.filter((e) => e.event === 'notification_opened').map((e) => [e.entityId, new Date(e.ts).toISOString()]));
  for (const n of staffMessages) assert.equal(n.read_at, opened.get(n.id) ?? null, `${n.id} read_at`);
  // a training look-up is of an employee, always followed by that employee's reminder
  const staffIds = new Set(users.filter((u) => u.role === 'staff').map((u) => u.id));
  const lookups = r.sim.requests.filter((q) => q.route === TRAINING_ROUTE);
  assert.ok(lookups.length >= 300);
  for (const q of lookups) {
    assert.ok(staffIds.has(q.userId) && q.ip === '203.0.113.10');
    assert.ok(byId.get(q.path.split('/')[4]).organization_id, 'only employees are looked up');
  }
  // the sealed tag of the surge never reaches a log line or a state document
  assert.ok(![...r.appLogs.values()].join('').includes(FOLLOW_UP_SURGE));
  assert.ok(!JSON.stringify(r.data).includes(FOLLOW_UP_SURGE));
});

test('q4-three-signals: personas (Ana lapsed, Marco with a waiting cart, Lena overdue on required training, Tobias her manager, Sofia sending reminders)', () => {
  for (const anchor of [ANCHOR, '2026-11-18', '2026-11-20']) {
    const r = anchor === ANCHOR ? results.get('q4-three-signals') : generate({ anchor, salt: 'test-salt', seed: 42, scenario: 'q4-three-signals' });
    const { users, carts, courses, training_assignments: assignments, notifications, organizations } = r.data;
    const k = r.stats.compliance;
    const lena = users.find((u) => u.email === EMPLOYEE_PERSONA.email);
    const tobias = users.find((u) => u.email === MANAGER_PERSONA.email);
    assert.deepEqual([lena.name, lena.role, tobias.name, tobias.role], [EMPLOYEE_PERSONA.name, 'learner', MANAGER_PERSONA.name, 'learner'], anchor);
    assert.equal(lena.manager_id, tobias.id, `${anchor}: Tobias manages Lena`);
    assert.equal(tobias.manager_id, null);
    const team = `${organizations.find((o) => o.id === lena.organization_id).name} | ${lena.department}`;
    assert.ok(k.byTeam[team].overduePct >= 45, `${anchor}: Lena's team ${team} is behind`);
    const mine = k.byManager[MANAGER_PERSONA.name];
    assert.ok(mine.overdue >= 3, `${anchor}: ${mine.overdue} overdue in Tobias's team`);
    const lenaAssignments = assignments.filter((a) => a.user_id === lena.id);
    assert.equal(lenaAssignments.length, 2);
    const reminders = notifications.filter((n) => n.user_id === lena.id && n.type === 'staff_message' && /^(Reminder|Overdue)/.test(n.title));
    assert.ok(reminders.length >= 3, `${anchor}: Lena has ${reminders.length} reminders`);
    const lessonDays = r.sim.requests.filter((q) => q.userId === lena.id && q.route === '/api/me/progress').map((q) => Math.floor((q.ts - r.sim.anchorMs) / DAY_MS));
    assert.ok(lessonDays.some((d) => d >= -7), `${anchor}: Lena still signs in`);
    // Ana and Marco keep their scripts and are not employees
    for (const id of [PERSONAS.ana.id, PERSONAS.marco.id]) assert.equal(users.find((u) => u.id === id).organization_id, undefined, anchor);
    assert.ok(!notifications.some((n) => n.user_id === PERSONAS.ana.id && !n.read_at), `${anchor}: Ana has no unread notification`);
    const titles = new Map(courses.map((c) => [c.id, c.title]));
    assert.deepEqual(carts.find((c) => c.user_id === PERSONAS.marco.id).items.map((i) => titles.get(i.course_id)), ['Python for Data Work', 'Data Visualization Fundamentals'], anchor);
    // Sofia sends most of the reminders
    const byStaff = k.windows.recent.remindersByStaff;
    assert.ok(byStaff['Sofia Lindqvist'] > byStaff['Daniel Okafor'] && byStaff['Sofia Lindqvist'] > byStaff['Priya Nair'], `${anchor}: ${JSON.stringify(byStaff)}`);
  }
});

// Case 3 is a pass over the finished simulation with its own random streams. Without it,
// the routes cases 1 and 2 are read from carry exactly the same people, and the end state
// those cases rest on (progress, enrolments, carts) is the same.
test('q4-three-signals: the compliance case changes nothing cases 1 and 2 are read from (all seven start weekdays)', () => {
  const def = getScenario('q4-three-signals');
  const without = { ...def, parameters: { ...def.parameters, compliance: null } };
  const CASE_ROUTES = { learning: ['/api/lessons/{lessonId}', '/api/courses/{courseId}/lessons', '/api/lessons/{lessonId}/progress', '/api/me/progress'] };
  for (const anchor of WEEK_OF_ANCHORS) {
    const [a, b] = [def, without].map((d) => simulate({ anchor, seed: 42, scenario: d }));
    const [ca, cb] = [a, b].map((sim) => computeStats(sim, { cloudfront: new Map(), appLogs: new Map() }).capabilities);
    for (const r of CASE_ROUTES.learning) assert.deepEqual(ca.learning.routes[r], cb.learning.routes[r], `${anchor}: ${r}`);
    assert.deepEqual(ca.catalog, cb.catalog, `${anchor}: every catalog route, the max and the inactive route`);
    for (const domain of ['enrolments', 'progress', 'carts', 'courses', 'lessons', 'subscriptions']) assert.deepEqual(a.data[domain], b.data[domain], `${anchor}: ${domain}`);
    // what it adds to learning is quiz retakes by employees: the same people, more attempts
    assert.ok(ca.learning.routes['/api/lessons/{lessonId}/quiz'].recent >= cb.learning.routes['/api/lessons/{lessonId}/quiz'].recent);
    assert.ok(a.data.quiz_results.length > b.data.quiz_results.length);
  }
});
