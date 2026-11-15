// Every scenario: well-formed, sealed by a stable fingerprint, generating a coherent
// dataset (state agrees with logs, personas intact), and showing the change it was
// designed for in the numbers the Governance Agent's detectors compare.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../src/generate.js';
import { completionPercent } from '../src/contract/progress.js';
import { DAY_MS, PERSONAS } from '../src/model.js';
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
  assert.deepEqual(scenarioIds.sort(), ['lapsed-learners', 'outage-drop', 'slow-lessons', 'steady-state']);
  for (const def of loadScenarios().values()) {
    assert.ok(def.title && def.description && def.expected_finding);
    if (def.status === 'verified') assert.ok(def.verified_against.every((v) => v.file && v.threshold));
    assert.ok(plainParameters(def).length >= 5);
    const card = publicCard(def);
    assert.deepEqual(Object.keys(card).sort(), ['description', 'id', 'status', 'title'], 'a card reveals no parameters');
  }
  const base = getScenario('steady-state');
  assert.throws(() => validateScenario({ ...base, parameters: { ...base.parameters, typo: 1 } }), /unknown parameters: typo/);
  assert.throws(() => validateScenario({ ...base, parameters: { ...base.parameters, outage: { fromDay: -35, toDay: -30, failureShare: 1, giveUpShare: 0, retriesMin: 0, retriesMax: 1 } } }), /Ana/);
  assert.throws(() => validateScenario({ ...base, status: 'verified', verified_against: [] }), /verified scenario/);
  assert.throws(() => getScenario('nope'), /unknown scenario/);
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
  }
});

const dv = (id) => results.get(id).stats;

test('steady-state: nothing crosses a detector threshold', () => {
  const s = dv('steady-state');
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
