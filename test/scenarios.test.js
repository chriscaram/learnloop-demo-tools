// Every scenario: well-formed, sealed by a stable fingerprint, generating a coherent
// dataset (state agrees with logs, personas intact), and showing the change it was
// designed for in the numbers the Governance Agent's detectors compare.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, generate, INACTIVITY_BARS } from '../src/generate.js';
import { completionPercent } from '../src/contract/progress.js';
import { DAY_MS, HELP_PERSONA, PERSONAS, simulate } from '../src/model.js';
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
    assert.deepEqual(Object.keys(card).filter((k) => k !== 'cases').sort(), ['description', 'id', 'title'], 'a card shows the title, the description and its prepared cases only: no expected finding, no parameters');
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
  const help = three.parameters.support.help;
  const withHelp = (h) => ({ ...three, parameters: { ...three.parameters, support: { ...three.parameters.support, help: h } } });
  assert.throws(() => validateScenario(withHelp({ ...help, visitShare: 1.5 })), /support.help.visitShare/);
  assert.throws(() => validateScenario(withHelp({ ...help, giveUp: { ...help.giveUp, share: 2 } })), /support.help.giveUp/);
  assert.throws(() => validateScenario(withHelp({ ...help, extra: 1 })), /unknown support.help parameters: extra/);
  assert.throws(() => validateScenario({ ...three, parameters: { ...three.parameters, lapse: null, cancellations: carts.parameters.cancellations } }), /lapsedAddPerBrowseSession needs a lapse/);
  for (const id of ['abandoned-carts', 'steady-state', 'slow-lessons', 'outage-drop']) {
    assert.equal(getScenario(id).parameters.support.help, undefined, `${id} keeps its definition (no Help visits)`);
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

// q4-three-signals: three drops, each in the routes of a different LearnLoop service (one
// service directory = one code component = one capability for the agent's route mapping),
// checked for start dates on all seven weekdays. The detector names a capability's
// qualifying route with the most earlier users, so each service must have exactly the
// intended routes over the bars and everything else in it well under them.
const WEEK_OF_ANCHORS = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];
const LESSON_ROUTE_SET = new Set(['/api/lessons/{lessonId}', '/api/courses/{courseId}/lessons', '/api/lessons/{lessonId}/progress', '/api/lessons/{lessonId}/quiz']);

test('q4-three-signals: lessons, enrolment and Help each lose about half of their people, in three different services, on all seven start weekdays', () => {
  const def = getScenario('q4-three-signals');
  for (const anchor of WEEK_OF_ANCHORS) {
    const s = anchor === ANCHOR ? dv('q4-three-signals') : computeStats(simulate({ anchor, seed: 42, scenario: def }), { cloudfront: new Map(), appLogs: new Map() });
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
    // 3. notifications: the Help route alone; the bell and the inbox stay flat
    const help = route('notifications', '/api/me/support-requests');
    assert.deepEqual(c.notifications.inactiveRoutes, ['/api/me/support-requests'], `${anchor}: notifications`);
    assert.ok(help.earlier >= 270 && help.dropPct >= 40, `${anchor}: Help ${JSON.stringify(help)}`);
    for (const r of ['/api/me/notifications/unread-count', '/api/me/notifications', '/api/me/notifications/{notificationId}/read']) {
      assert.ok(route('notifications', r).dropPct < 20, `${anchor}: ${r} ${route('notifications', r).dropPct}`);
    }
    // the capability-level max hides each drop (the route-level fallback names it), and
    // nothing else crosses the bars: billing, identity, and admin (one office address)
    for (const svc of ['learning', 'catalog', 'notifications']) assert.ok(c[svc].serviceMax.dropPct < 10, `${anchor}: ${svc} max ${c[svc].serviceMax.dropPct}`);
    for (const svc of ['admin', 'billing', 'identity']) assert.deepEqual(c[svc].inactiveRoutes, [], `${anchor}: ${svc}`);
    assert.ok(Math.max(...Object.values(c.admin.routes).map((r) => r.earlier)) < INACTIVITY_BARS.minEarlierActors, `${anchor}: staff are a handful of people`);
    // healthy: no incident for the drift engine to confirm
    for (const svc of Object.values(c)) for (const pct of Object.values(svc.serverErrorPct)) assert.ok(pct < 0.5, `${anchor}: server errors ${pct}%`); // INCIDENT_ERROR_RATE_PCT = 5
    assert.ok(s.health.worst5xxShare < 0.005, `${anchor}: worst route-day ${s.health.worst5xxShare}`);
    assert.ok(s.health.lessonsP95.max < 200 && s.health.otherP95.max < 100, `${anchor}: latency flat`);
    // the end state the three AI agents would work from
    assert.ok(s.carts.endState.learnersWithItems >= 120 && s.carts.endState.learnersWithItems <= 175, `${anchor}: ${s.carts.endState.learnersWithItems} learners with a waiting cart`);
    const { open, overdueAtStart, openTopics } = s.support.endState;
    assert.ok(open >= 15 && overdueAtStart >= open - 3, `${anchor}: ${open} open questions, ${overdueAtStart} overdue`);
    const repetitive = (openTopics.certificate ?? 0) + (openTopics.billing ?? 0) + (openTopics.account ?? 0);
    assert.ok(repetitive / open >= 0.85, `${anchor}: open questions are about the same few topics ${JSON.stringify(openTopics)}`);
    const { earlier, recent } = s.support.windows;
    assert.ok(earlier.answeredWithinTarget / earlier.asked >= 0.5 && recent.answeredWithinTarget <= 2, `${anchor}: answers slow down (${earlier.answeredWithinTarget}/${earlier.asked} -> ${recent.answeredWithinTarget}/${recent.asked})`);
    assert.ok(earlier.medianReplyHours < 36 && recent.medianReplyHours > 24 * 7, `${anchor}: reply ${earlier.medianReplyHours} h -> ${recent.medianReplyHours} h`);
  }
});

test('q4-three-signals: personas (Ana lapsed, Marco with a waiting cart, Lena with an unanswered question, Sofia with an open queue)', () => {
  const r = results.get('q4-three-signals');
  const { users, carts, support_requests: support, courses } = r.data;
  const day = (iso) => Math.floor((Date.parse(iso) - r.sim.anchorMs) / DAY_MS);
  const lena = users.find((u) => u.id === HELP_PERSONA.id);
  assert.deepEqual([lena.email, lena.name, lena.role], [HELP_PERSONA.email, HELP_PERSONA.name, 'learner']);
  const staffIds = new Set(users.filter((u) => u.role === 'staff').map((u) => u.id));
  const [invoice, certificate, ...more] = support.filter((q) => q.user_id === lena.id);
  assert.equal(more.length, 0);
  assert.deepEqual([invoice.topic, day(invoice.created_at), invoice.status], ['billing', -50, 'answered']);
  assert.ok(staffIds.has(invoice.replies[0].staff_id));
  assert.ok(Date.parse(invoice.answered_at) - Date.parse(invoice.created_at) < 3 * DAY_MS, 'her first question was answered promptly');
  assert.deepEqual([certificate.topic, day(certificate.created_at), certificate.status, certificate.replies.length], ['certificate', -12, 'open', 0]);
  const checks = r.sim.requests.filter((q) => q.userId === lena.id && q.method === 'GET' && q.route === '/api/me/support-requests').map((q) => Math.floor((q.ts - r.sim.anchorMs) / DAY_MS));
  for (const d of [-9, -5, -2]) assert.ok(checks.includes(d), `Lena checks Help on day ${d}`);
  assert.ok(!carts.some((c) => c.user_id === lena.id || c.user_id === PERSONAS.ana.id));
  assert.ok(!support.some((q) => q.user_id === PERSONAS.ana.id), 'Ana keeps only her lapsed-learner script');
  const titles = new Map(courses.map((c) => [c.id, c.title]));
  assert.deepEqual(carts.find((c) => c.user_id === PERSONAS.marco.id).items.map((i) => titles.get(i.course_id)), ['Python for Data Work', 'Data Visualization Fundamentals']);
  const sofiaReplies = support.flatMap((q) => q.replies).filter((x) => x.staff_id === PERSONAS.sofia.id).length;
  assert.ok(sofiaReplies >= support.flatMap((q) => q.replies).length / 3, 'Sofia answers the largest share of questions');
  assert.ok(support.filter((q) => q.status === 'open').length >= 15, 'Sofia finds an open queue in Admin');
  // staff look at the queue and reply far less in the recent window
  const staff = r.sim.requests.filter((q) => q.kind === 'api' && staffIds.has(q.userId));
  const count = (rt, from, to) => staff.filter((q) => q.route === rt && day(new Date(q.ts).toISOString()) >= from && day(new Date(q.ts).toISOString()) <= to).length;
  const reply = '/api/admin/support-requests/{requestId}/reply';
  assert.ok(count(reply, -29, -1) < count(reply, -59, -30) / 2, 'fewer replies');
  assert.ok(count('/api/admin/support-requests', -29, -1) < count('/api/admin/support-requests', -59, -30) * 0.75, 'the queue is opened less');
});
