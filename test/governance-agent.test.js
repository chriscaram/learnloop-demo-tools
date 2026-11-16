// The staged reveal against the Governance Agent's OWN detector code, when its repository
// is next to this one (../governance-agent, or $GOVERNANCE_AGENT_REPO); skipped otherwise,
// like the LearnLoop contract checks. Read-only: it imports the agent's pure functions and
// writes nothing there.
//
// It replays what the agent records for each "Get usage telemetry" over the CloudFront
// traffic of each stage: the first read (onboarding) writes route baselines for days
// -29..0 and then, once, for days -59..-30 (backend/src/cadence.js
// continueAfterTelemetryIngest); every later read writes days -29..0 again
// (platform/telemetry/ingestion.js: one baseline per route the read saw, busiest first).
// Then it runs drift/detectors.js#observationsForGoal over all the rows, as
// drift/index.js#loadDriftWorld assembles them, for three goals linked one to one to the
// learning, catalog and notifications capabilities (one service = one capability, the
// declared_in_code mapping).
//
// Start dates on all seven weekdays.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageView } from '../src/generate.js';
import { DAY_MS, simulate } from '../src/model.js';
import { canonicalJson, getScenario, stageOf } from '../src/scenarios.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GA = path.resolve(process.env.GOVERNANCE_AGENT_REPO ?? path.join(HERE, '../../governance-agent'));
const DRIFT = path.join(GA, 'packages/modules/new-evolution-opportunity/drift');
const available = existsSync(path.join(DRIFT, 'detectors.js'));
const skip = available ? false : `the Governance Agent repository is not at ${GA} (set GOVERNANCE_AGENT_REPO)`;

const ANCHORS = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];
const CAPABILITY_OF_SERVICE = { learning: 'cap_learning', catalog: 'cap_catalog', notifications: 'cap_notifications', admin: 'cap_admin', identity: 'cap_identity', billing: 'cap_billing' };
const GOALS = [
  ['g_learn', 'More learners actively progressing every week', 'cap_learning'],
  ['g_cart', 'Complete the purchases learners start', 'cap_catalog'],
  ['g_help', 'Answer learner questions within one business day, and keep learners using Help', 'cap_notifications'],
].map(([goal_id, statement, capability_id]) => ({
  goal_id, statement, status: 'confirmed', metric: { name: statement }, served_by: [{ capability_id, weight: 1, confirmed: true }],
}));

let ga;
before(async () => {
  if (!available) return;
  const load = (p) => import(path.join(GA, p));
  ga = {
    det: await load('packages/modules/new-evolution-opportunity/drift/detectors.js'),
    usage: await load('packages/modules/new-evolution-opportunity/drift/usage.js'),
    decompose: await load('packages/modules/new-evolution-opportunity/drift/decompose.js'),
    funnels: await load('packages/modules/new-evolution-opportunity/drift/funnels.js'),
    cohorts: await load('packages/modules/new-evolution-opportunity/drift/cohorts.js'),
    telemetry: await load('packages/platform/telemetry/index.js'),
  };
});

/** Route aggregates of one read, the way the CloudFront reader and the aggregator build them. */
function aggregates(requests, window) {
  const from = Date.parse(`${window.start}T00:00:00Z`);
  const to = Date.parse(`${window.end}T23:59:59.999Z`);
  const acc = new Map();
  for (const r of requests) {
    if (r.crawler || r.ts < from || r.ts > to) continue; // the bot filter runs before aggregation
    const route = r.kind === 'api' ? r.route : r.path;
    const key = `${r.method} ${route}`;
    let a = acc.get(key);
    if (!a) acc.set(key, (a = { route, method: r.method, service: r.service ?? null, requests: 0, errors: 0, ips: new Set(), days: {} }));
    a.requests += 1;
    if (r.status >= 500) a.errors += 1;
    a.ips.add(r.ip);
    const day = new Date(r.ts).toISOString().slice(0, 10);
    a.days[day] = (a.days[day] ?? 0) + 1;
  }
  return [...acc.values()].sort((a, b) => b.requests - a.requests).map((a) => ({
    scope_type: 'route', scope_key: a.route, route: a.route, http_method: a.method, service: a.service, requests: a.requests,
    unique_actors: a.ips.size, days: a.days, days_observed: Object.keys(a.days).length,
    error_rate_pct: (100 * a.errors) / a.requests, server_error_pct: (100 * a.errors) / a.requests, client_error_pct: 0,
    latency_ms: null, source_kinds: ['cloudfront_access_logs'], temporal: { by_hour: new Array(24).fill(0), by_dow: new Array(7).fill(0) },
  }));
}

function detect(rows, capabilities) {
  const { det, usage: U, decompose, funnels, cohorts } = ga;
  const usageByWindow = new Map(det.USAGE_WINDOWS.map((w) => [w, U.usageByCapability(capabilities, rows, { windowDays: w, sourceDays: {}, partialDays: {} }).usage]));
  const { byCapability } = U.groupRoutesByCapability(rows);
  const observedDays = U.sourceObservedDays(rows, {}, { partial: {} });
  const dayMaps = new Map();
  const actorWindows = new Map();
  const routeActorWindows = new Map();
  for (const c of capabilities) {
    const list = byCapability.get(c.capability_id) ?? [];
    const kinds = [...new Set(list.flatMap((r) => r.detail?.source_kinds ?? []))];
    dayMaps.set(c.capability_id, U.withZeroDays(decompose.mergeDayMaps(list.map((r) => r.detail?.days)), kinds, observedDays));
    actorWindows.set(c.capability_id, U.actorWindowsOf(list));
    const perRoute = new Map();
    for (const r of list) perRoute.set(r.scope_key, [...(perRoute.get(r.scope_key) ?? []), r]);
    routeActorWindows.set(c.capability_id, new Map([...perRoute].map(([k, v]) => [k, U.actorWindowsOf(v)])));
  }
  const built = funnels.buildFunnels(capabilities, usageByWindow.get(det.USAGE_WINDOWS[0]));
  const world = {
    application_id: 'app_test', goals: GOALS, capabilities, usageByWindow, dayMaps, actorWindows, routeActorWindows,
    funnels: built.funnels, funnel_truncation: built.truncated, funnel_roots: built.roots, signalsById: new Map(), signals: [],
    cohortObservations: new Map(), cohortAvailability: cohorts.cohortDataAvailability([]), cohortScan: [], countries: [], unmapped_routes: [], measured_capabilities: 0,
  };
  return GOALS.flatMap((goal) => det.observationsForGoal(goal, world).observations.map((o) => ({ goal: goal.goal_id, code: o.code, fingerprint: canonicalJson(o.fingerprint ?? {}), facts: o.facts })));
}

test('the agent\'s own detectors: stage 1 raises the lesson finding only, each later stage adds its case, nothing earlier changes', { skip }, () => {
  const def = getScenario('q4-three-signals');
  for (const anchor of ANCHORS) {
    const sim = simulate({ anchor, seed: 42, scenario: def });
    const services = [...new Set(sim.requests.filter((r) => r.kind === 'api').map((r) => r.service))];
    const capabilities = services.map((s) => ({ capability_id: CAPABILITY_OF_SERVICE[s] ?? `cap_${s}`, name: s, status: 'confirmed', criticality: 'high', entry_points: [], depends_on: [] }));
    const current = ga.telemetry.telemetryWindow({ asOf: anchor, days: 30 });
    const history = ga.telemetry.telemetryWindow({ asOf: new Date(Date.parse(`${current.start}T00:00:00Z`) - DAY_MS).toISOString(), days: 30 });
    const rows = [];
    let clock = Date.parse('2030-01-01T00:00:00Z');
    const read = (requests, window) => {
      for (const aggregate of aggregates(requests, window)) {
        const b = ga.telemetry.reconstructBaseline({
          aggregate, window, sourceKind: 'cloudfront_access_logs', capabilityId: aggregate.service ? CAPABILITY_OF_SERVICE[aggregate.service] : null,
          signalId: 'sig_cloudfront', sourceGapDays: new Set(),
        });
        clock += 5;
        rows.push({ ...b, id: `tbase_${rows.length}`, created_at: new Date(clock).toISOString(), detail: { ...b.detail, insufficient_reasons: b.insufficient_reasons } });
      }
    };
    const seen = [];
    for (const stage of [1, 2, 3]) {
      const { requests } = stageView(sim, stageOf(def, stage));
      read(requests, current);
      if (stage === 1) read(requests, history); // the history read happens once, at onboarding
      seen.push(detect(rows, capabilities));
    }
    const actor = (list, goal) => list.filter((o) => o.goal === goal && o.code === 'NBF-USAGE-ACTOR_INACTIVITY');
    const goalsWith = (list) => [...new Set(list.map((o) => o.goal))].sort();
    const [s1, s2, s3] = seen;
    // stage 1: lessons only, and nothing at all about the store or Help
    assert.deepEqual(goalsWith(s1), ['g_learn'], `${anchor} stage 1: ${JSON.stringify(s1.map((o) => [o.goal, o.code]))}`);
    assert.equal(actor(s1, 'g_learn').length, 1);
    assert.ok(actor(s1, 'g_learn')[0].facts.inactive_routes.some((r) => r.route === '/api/lessons/{lessonId}'));
    // stage 2: the enrolment finding is added; nothing about Help yet
    assert.deepEqual(goalsWith(s2), ['g_cart', 'g_learn'], `${anchor} stage 2`);
    const enrol = actor(s2, 'g_cart')[0].facts.inactive_routes;
    assert.deepEqual(enrol.map((r) => r.route), ['/api/courses/{courseId}/enrol'], `${anchor} stage 2: ${JSON.stringify(enrol)}`);
    assert.ok(enrol[0].earlier_actors >= 200 && enrol[0].drop_pct >= 33, `${anchor} stage 2: ${JSON.stringify(enrol)}`);
    // stage 3: the Help finding is added
    assert.deepEqual(goalsWith(s3), ['g_cart', 'g_help', 'g_learn'], `${anchor} stage 3`);
    const help = actor(s3, 'g_help')[0].facts.inactive_routes;
    assert.deepEqual(help.map((r) => r.route), ['/api/me/support-requests'], `${anchor} stage 3: ${JSON.stringify(help)}`);
    assert.ok(help[0].earlier_actors >= 200 && help[0].drop_pct >= 33);
    // every observation of a stage is still there, with the same fingerprint, in the next
    for (const [before, after, n] of [[s1, s2, 2], [s2, s3, 3]]) {
      const later = new Set(after.map((o) => `${o.goal}|${o.code}|${o.fingerprint}`));
      for (const o of before) assert.ok(later.has(`${o.goal}|${o.code}|${o.fingerprint}`), `${anchor} stage ${n} keeps ${o.goal} ${o.code} ${o.fingerprint}`);
    }
  }
});
