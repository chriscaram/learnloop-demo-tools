// The staged reveal of q4-three-signals (README, "Presenting the staged reveal"): one
// Governance Agent application, three loads, one case added per load.
//
// What the agent does that the stages are built around (read from its code, see the
// scenario's verified_against): it reads days -59..-30 only once, when the application is
// onboarded, and days -29..0 again at every "Get usage telemetry"; it keeps the highest
// distinct-user count it has read for a window; and a route with no request in a window
// has no baseline for that window. So every stage carries the final earlier window, a
// stage only ever adds recent traffic, and the last stage is the scenario itself.
//
// Case 3 (compliance training) is withheld as a named activity, not by route: from day
// -29 on, the staff's follow-up above its earlier level (training look-ups, reminders, the
// bell polling meanwhile and the employees opening those reminders) is left out in stages
// 1 and 2, so the routes it uses keep their ordinary recent traffic there.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { generate, INACTIVITY_BARS, isHeld, stageStats, stageView, stageWithhold } from '../src/generate.js';
import { FOLLOW_UP_SURGE, TRAINING_ROUTE } from '../src/compliance.js';
import { formatJson } from '../src/files.js';
import { DAY_MS, simulate } from '../src/model.js';
import {
  getScenario, plainStages, publicCard, scenarioFingerprint, sealedInput, stageCount, stageOf, validateScenario,
} from '../src/scenarios.js';
import { CLOUDFRONT_FIELDS } from '../src/emit.js';

const ID = 'q4-three-signals';
const ANCHOR = '2026-11-15';
const ARGS = { anchor: ANCHOR, salt: 'test-salt', seed: 42, scenario: ID };
// The digest of q4-three-signals at these arguments: every state document, every
// application log file and every CloudFront object. Updated deliberately when case 3
// became compliance training (was 411cfab7…, the Help case, from commit d0b2a8c on): the
// support parameters went back to the ordinary baseline, the Help give-up and its persona
// were removed, and the compliance pass added organizations.json, training_assignments.json,
// the employees' organisational fields, quiz retakes, the staff follow-up and reminders.
const Q4_DIGEST = '3524753b3504d9d5b27cba90e179f768b1cc4c9c32575a7ae1d6f2bfec523968';
const WEEK_OF_ANCHORS = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];
const ENROL = '/api/courses/{courseId}/enrol';
const HELP = '/api/me/support-requests';
const MESSAGE = '/api/admin/learners/{userId}/message';

const def = getScenario(ID);
const stages = new Map();

function digest(r) {
  const hash = createHash('sha256');
  for (const [domain, value] of Object.entries(r.data)) hash.update(domain).update(formatJson(value));
  for (const [key, body] of r.appLogs) hash.update(key).update(body);
  for (const [key, body] of r.cloudfront) hash.update(key).update(body);
  return hash.digest('hex');
}
const cfLines = (body) => gunzipSync(body).toString('utf8').split('\n').filter((l) => l && !l.startsWith('#'));
const F = Object.fromEntries(CLOUDFRONT_FIELDS.map((f, i) => [f, i]));

before(() => {
  for (const stage of [1, 2, 3]) stages.set(stage, generate({ ...ARGS, stage }));
});

test('stage 3 is q4-three-signals byte for byte (and so is no stage); stages 1 and 2 are not', () => {
  assert.equal(digest(stages.get(3)), Q4_DIGEST);
  assert.equal(digest(generate(ARGS)), Q4_DIGEST);
  assert.notEqual(digest(stages.get(1)), Q4_DIGEST);
  assert.notEqual(digest(stages.get(2)), Q4_DIGEST);
  assert.notEqual(digest(stages.get(1)), digest(stages.get(2)));
});

test('a stage only leaves lines out: same objects, every other line identical, the left-out lines are the withheld routes and activity from day -29 on', () => {
  const full = stages.get(3);
  const routeOf = new Map(full.sim.requests.filter((r) => r.kind === 'api').map((r) => [`${r.method} ${r.path}`, r.route]));
  for (const stage of [1, 2]) {
    const st = stageOf(def, stage);
    const fromMs = full.sim.anchorMs + st.fromDay * DAY_MS;
    const withhold = stageWithhold(full.sim, st);
    const held = full.sim.requests.filter((r) => isHeld(r, withhold));
    const ids = new Set(held.filter((r) => r.kind === 'api').map((r) => r.requestId));
    // a CloudFront line left out is of a withheld route, or of a request of the withheld activity (same method, path and client)
    const heldLines = new Set(held.map((r) => `${r.method} ${r.path} ${r.ip}`));
    const r = stages.get(stage);
    assert.deepEqual([...r.cloudfront.keys()], [...full.cloudfront.keys()], `stage ${stage}: every CloudFront object, under the same key`);
    assert.deepEqual([...r.appLogs.keys()].filter((k) => !full.appLogs.has(k)), [], `stage ${stage}: no application log file the scenario does not have`);
    let left = 0;
    for (const [key, body] of full.cloudfront) {
      const kept = cfLines(r.cloudfront.get(key));
      const all = cfLines(body);
      // `kept` is `all` with some lines removed, in the same order
      let i = 0;
      for (const line of all) {
        if (kept[i] === line) { i += 1; continue; }
        const f = line.split('\t');
        const route = routeOf.get(`${f[F['cs-method']]} ${f[F['cs-uri-stem']]}`);
        assert.ok(st.withheldRoutes.has(`${f[F['cs-method']]} ${route}`) || heldLines.has(`${f[F['cs-method']]} ${f[F['cs-uri-stem']]} ${f[F['c-ip']]}`), `stage ${stage}: ${key} left out a line of ${route}`);
        assert.ok(Date.parse(`${f[F.date]}T${f[F.time]}Z`) >= fromMs - 1000, `stage ${stage}: a line left out before day ${st.fromDay}`);
        left += 1;
      }
      assert.equal(i, kept.length, `stage ${stage}: ${key} holds only lines of the full scenario`);
    }
    assert.ok(left > 200, `stage ${stage}: ${left} CloudFront lines left out`);
    for (const [key, body] of full.appLogs) {
      const kept = (r.appLogs.get(key) ?? '').split('\n').filter(Boolean);
      const all = body.split('\n').filter(Boolean);
      let i = 0;
      for (const line of all) {
        if (kept[i] === line) { i += 1; continue; }
        const record = JSON.parse(line);
        assert.ok(ids.has(record.request_id), `stage ${stage}: ${key} left out a line of a request that is not withheld`);
        assert.ok(Date.parse(record.timestamp) >= fromMs, `stage ${stage}: an application line left out before day ${st.fromDay}`);
      }
      assert.equal(i, kept.length, `stage ${stage}: ${key} holds only lines of the full scenario`);
    }
  }
});

/** Distinct client IPs per "METHOD route" and window, from the CloudFront objects themselves. */
function cloudfrontActors(r) {
  const routeOf = new Map(r.sim.requests.filter((q) => q.kind === 'api').map((q) => [`${q.method} ${q.path}`, q.route]));
  const windowOf = (ms) => {
    const d = Math.floor((ms - r.sim.anchorMs) / DAY_MS);
    return d >= -59 && d <= -30 ? 'earlier' : d >= -29 && d <= 0 ? 'recent' : null;
  };
  const out = new Map();
  for (const body of r.cloudfront.values()) {
    for (const line of cfLines(body)) {
      const f = line.split('\t');
      const route = routeOf.get(`${f[F['cs-method']]} ${f[F['cs-uri-stem']]}`);
      const w = windowOf(Date.parse(`${f[F.date]}T${f[F.time]}Z`));
      if (!route || !w) continue;
      const key = `${f[F['cs-method']]} ${route}|${w}`;
      if (!out.has(key)) out.set(key, new Set());
      out.get(key).add(f[F['c-ip']]);
    }
  }
  return new Map([...out].map(([k, v]) => [k, v.size]));
}

test('revealed routes have the same distinct people per window in every stage; a withheld route keeps its earlier window and has no recent one; the withheld activity only takes people away from its routes\' recent window', () => {
  const full = cloudfrontActors(stages.get(3));
  const activityRoutes = new Set(stages.get(3).sim.requests.filter((r) => r.activity === FOLLOW_UP_SURGE).map((r) => `${r.method} ${r.route}`));
  assert.ok(activityRoutes.has(`GET ${TRAINING_ROUTE}`) && activityRoutes.has(`POST ${MESSAGE}`));
  for (const stage of [1, 2]) {
    const st = stageOf(def, stage);
    const mine = cloudfrontActors(stages.get(stage));
    for (const [key, n] of full) {
      const [route, w] = key.split('|');
      if (st.withheldRoutes.has(route) && w === 'recent') assert.equal(mine.get(key), undefined, `stage ${stage}: ${route} has no recent traffic`);
      else if (activityRoutes.has(route) && w === 'recent') assert.ok((mine.get(key) ?? 0) <= n, `stage ${stage}: ${key}`);
      else assert.equal(mine.get(key), n, `stage ${stage}: ${key} as in the full scenario`);
    }
    // the staff routes keep their recent window: the follow-up at its earlier level is there
    for (const route of [`GET ${TRAINING_ROUTE}`, `POST ${MESSAGE}`, 'GET /api/admin/learners']) assert.equal(mine.get(`${route}|recent`), 1, `stage ${stage}: ${route} from the office`);
    assert.deepEqual([...mine.keys()].filter((k) => !full.has(k)), [], `stage ${stage}: nothing the full scenario does not have`);
  }
  // each stage reveals more than the one before, and stage 2 shows what stage 1 shows
  const one = cloudfrontActors(stages.get(1));
  const two = cloudfrontActors(stages.get(2));
  for (const [key, n] of one) assert.equal(two.get(key), n, `stage 2 keeps ${key}`);
  assert.ok(two.size > one.size);
});

test('the starting state: stage 1 has no carts, stage 2 adds them, stage 3 adds the reminders of the surge; accounts, assignments and Help are there from stage 1', () => {
  const [one, two, three] = [1, 2, 3].map((s) => stages.get(s).data);
  const surge = stages.get(3).sim.activityNotifications.get(FOLLOW_UP_SURGE);
  assert.ok(surge.size >= 120, `${surge.size} reminders in the surge`);
  assert.deepEqual(one.carts, []);
  assert.deepEqual(two.carts, three.carts);
  assert.ok(three.carts.length >= 120);
  for (const domain of ['users', 'courses', 'lessons', 'enrolments', 'progress', 'subscriptions', 'quiz_results', 'support_requests', 'organizations', 'training_assignments']) {
    assert.deepEqual(one[domain], three[domain], `stage 1 ${domain}`);
    assert.deepEqual(two[domain], three[domain], `stage 2 ${domain}`);
  }
  assert.ok(three.support_requests.length > 10 && three.notifications.some((n) => n.type === 'support_reply'), 'Help is an ordinary feature in every stage');
  assert.ok(three.training_assignments.length >= 400 && three.organizations.length === 3);
  for (const data of [one, two]) {
    assert.deepEqual(data.notifications, three.notifications.filter((n) => !surge.has(n.id)));
    assert.ok(data.notifications.some((n) => /^(Reminder|Overdue):/.test(n.title)), 'the reminders at the earlier level are there');
  }
});

// The detector bars (drift/constants.js) for each stage, on all seven start weekdays: the
// stage's new drop crosses them, the earlier ones are still crossed with the same numbers,
// and the cases not revealed yet show nothing (their routes have one measured window).
test('each stage adds exactly its case: the new drop or surge appears, the earlier ones stay, nothing comes early (all seven start weekdays)', () => {
  for (const anchor of WEEK_OF_ANCHORS) {
    const sim = simulate({ anchor, seed: 42, scenario: def });
    const stats = [1, 2, 3].map((stage) => stageStats(stageView(sim, stageOf(def, stage)), { cloudfront: new Map(), appLogs: new Map() }, stageOf(def, stage)));
    const view = (stage) => stats[stage - 1].capabilities;
    const complianceAt = (stage) => stats[stage - 1].compliance;
    const k3 = complianceAt(3);
    const [c1, c2, c3] = [view(1), view(2), view(3)];
    for (const [stage, c] of [[1, c1], [2, c2], [3, c3]]) {
      const at = `${anchor} stage ${stage}`;
      // 1. lessons: the same finding in every stage, from the same numbers
      assert.deepEqual(c.learning, c3.learning, `${at}: learning is the same in every stage`);
      assert.ok(c.learning.inactiveRoutes.includes('/api/lessons/{lessonId}'), `${at}: lessons ${c.learning.inactiveRoutes}`);
      const lessons = c.learning.routes['/api/lessons/{lessonId}'];
      assert.ok(lessons.earlier >= 300 && lessons.dropPct >= 38, `${at}: lessons ${JSON.stringify(lessons)}`);
      // 2. enrolment: crosses the bars from stage 2 on; before, no recent window at all
      const enrol = c.catalog.routes[ENROL];
      assert.equal(enrol.earlier, c3.catalog.routes[ENROL].earlier, `${at}: the enrol route's earlier window is final from stage 1`);
      if (stage >= 2) {
        assert.deepEqual(c.catalog, c3.catalog, `${at}: catalog as in the full scenario`);
        assert.deepEqual(c.catalog.inactiveRoutes, [ENROL], `${at}: catalog`);
        assert.ok(enrol.earlier >= INACTIVITY_BARS.minEarlierActors && enrol.dropPct >= INACTIVITY_BARS.dropPct, `${at}: enrol ${JSON.stringify(enrol)}`);
      } else {
        assert.deepEqual(c.catalog.inactiveRoutes, [], `${at}: nothing about the store yet`);
        for (const r of [ENROL, '/api/me/cart/items', '/api/me/cart/items/{courseId}']) assert.equal(c.catalog.routes[r]?.recent ?? 0, 0, `${at}: ${r} has no recent traffic`);
        for (const r of ['/api/me/cart', '/api/courses', '/api/courses/{courseId}']) assert.deepEqual(c.catalog.routes[r], c3.catalog.routes[r], `${at}: ${r} as in the full scenario`);
      }
      // 3. compliance: the follow-up surge is in the recent window in stage 3 only; before,
      // the recent window holds the follow-up at its earlier level, day for day
      const k = complianceAt(stage);
      const { earlier, recent } = k.windows;
      assert.deepEqual(earlier, k3.windows.earlier, `${at}: the earlier window is final from stage 1`);
      if (stage === 3) {
        assert.ok(recent.reminders >= 2.2 * earlier.reminders && recent.trainingLookups >= 2.2 * earlier.trainingLookups, `${at}: the surge ${earlier.reminders} -> ${recent.reminders}`);
      } else {
        assert.ok(recent.reminders >= 0.7 * earlier.reminders && recent.reminders <= 1.4 * earlier.reminders, `${at}: no surge yet ${earlier.reminders} -> ${recent.reminders}`);
        assert.ok(recent.trainingLookups <= 1.4 * earlier.trainingLookups, `${at}: no surge yet in the look-ups`);
        assert.equal(k.surgeRequestsInLogs, 0);
      }
      assert.deepEqual(k.byTeam, k3.byTeam, `${at}: the assignments read the same in every stage`);
      assert.deepEqual(c.notifications.inactiveRoutes, [], `${at}: nothing in notifications`);
      assert.equal(c.notifications.routes[HELP]?.earlier, c3.notifications.routes[HELP]?.earlier);
      // the capability-level max never moves (the busiest route of each service is revealed in every stage)
      for (const svc of ['learning', 'catalog', 'notifications']) assert.ok(c[svc].serviceMax.dropPct < 10, `${at}: ${svc} max ${c[svc].serviceMax.dropPct}`);
      assert.deepEqual(c.admin.inactiveRoutes, [], `${at}: admin`);
      for (const svc of ['admin', 'billing', 'identity']) assert.deepEqual(c[svc].inactiveRoutes, [], `${at}: ${svc}`);
    }
  }
});

test('the stage definitions: validated, sealed one fingerprint per stage, revealed in plain words, never on the card', () => {
  assert.equal(stageCount(def), 3);
  assert.equal(stageCount(getScenario('abandoned-carts')), 0);
  assert.throws(() => stageOf(def, 4), /stages 1 to 3/);
  assert.throws(() => stageOf(getScenario('steady-state'), 1), /no stages/);
  assert.equal(stageOf(def, null), null);
  assert.equal(stageOf(def, 3).final, true);
  const fps = [1, 2, 3].map((stage) => scenarioFingerprint(def, { seed: 42, anchor: ANCHOR, stage }));
  assert.equal(new Set([...fps, scenarioFingerprint(def, { seed: 42, anchor: ANCHOR })]).size, 4, 'each stage has its own fingerprint');
  assert.deepEqual(Object.keys(sealedInput(def, { seed: 42, anchor: ANCHOR })), ['anchor', 'scenario', 'seed'], 'without a stage the sealed text is unchanged');
  assert.equal(sealedInput(def, { seed: 42, anchor: ANCHOR, stage: 2 }).stage, 2);
  const plain = plainStages(def);
  assert.equal(plain.length, 3);
  assert.match(plain[0].lines.join(' '), /POST \/api\/courses\/\{courseId\}\/enrol/);
  assert.match(plain[1].lines.join(' '), /follow-up of required training above its earlier level/);
  assert.doesNotMatch(plain[1].lines.join(' '), /these requests are left out/);
  assert.match(plain[2].lines.join(' '), /Nothing is left out/);
  assert.deepEqual(publicCard(def).stages, 3);
  // the rules a staged reveal must keep
  const r = def.staged_reveal;
  const withStages = (fn) => ({ ...def, staged_reveal: { ...r, stages: r.stages.map((s, i) => fn({ ...s }, i)) } });
  assert.throws(() => validateScenario(withStages((s, i) => (i === 1 ? { ...s, recent_traffic_withheld: [...s.recent_traffic_withheld, 'GET /api/me/progress'] } : s))), /may only add traffic/);
  assert.throws(() => validateScenario(withStages((s, i) => (i === 2 ? { ...s, state_withheld: ['carts'] } : s))), /withholds nothing|which the stage before wrote/);
  assert.throws(() => validateScenario(withStages((s, i) => (i === 1 ? { ...s, recent_traffic_withheld: r.stages[0].recent_traffic_withheld } : s))), /reveals no traffic/);
  assert.throws(() => validateScenario(withStages((s, i) => (i === 0 ? { ...s, adds_case: 2 } : s))), /adds_case/);
  assert.throws(() => validateScenario(withStages((s) => ({ ...s, recent_traffic_withheld: ['/api/me/cart'] }))), /METHOD \/api\/route/);
  assert.throws(() => validateScenario({ ...def, staged_reveal: { ...r, stages: r.stages.slice(0, 2) } }), /one stage per case/);
  assert.throws(() => validateScenario({ ...def, staged_reveal: { ...r, recent_window_from_day: -60 } }), /recent_window_from_day/);
  assert.throws(() => validateScenario({ ...def, staged_reveal: { ...r, extra: 1 } }), /unknown staged_reveal keys: extra/);
  assert.throws(() => validateScenario(withStages((s, i) => (i === 1 ? { ...s, recent_activity_withheld: [] } : s))), /reveals no traffic|may only add traffic/);
  assert.throws(() => validateScenario(withStages((s, i) => (i === 2 ? { ...s, recent_activity_withheld: [FOLLOW_UP_SURGE] } : s))), /reveals no traffic|withholds nothing/);
  assert.throws(() => validateScenario(withStages((s) => ({ ...s, recent_activity_withheld: ['help_give_up'] }))), /recent_activity_withheld lists/);
});
