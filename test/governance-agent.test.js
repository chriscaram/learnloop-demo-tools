// The staged reveal against the Governance Agent's OWN detector code, when its repository
// is next to this one (../governance-agent, or $GOVERNANCE_AGENT_REPO); skipped otherwise,
// like the LearnLoop contract checks. Read-only: it imports the agent's pure functions and
// writes nothing there.
//
// It replays what the agent records for each read over the CloudFront traffic in the
// buckets at that moment. The demo flow (README, "Presenting the staged reveal"): load the
// history (stage 0), onboard LearnLoop the same day, then one "Get usage telemetry" after
// each of stages 1, 2 and 3, on the SAME application. The first read is the onboarding one,
// over stage 0's logs: route baselines for days -29..0 (there are none: stage 0 holds no
// recent traffic) and then, once, for days -59..-30 (backend/src/cadence.js
// continueAfterTelemetryIngest; a later read finds history_already_read). Every later read
// writes days -29..0 again, over that stage's logs (platform/telemetry/ingestion.js: one
// baseline per route the read saw, busiest first). The earlier window therefore comes ONLY
// from the stage-0 read, and the reads merge as the agent merges them: every baseline row
// is kept, the distinct users of a window are the max across them (drift/usage.js
// actorWindowsOf), day counts the latest row.
// Then it runs drift/detectors.js#observationsForGoal over all the rows, as
// drift/index.js#loadDriftWorld assembles them, for three goals linked one to one to the
// learning, catalog and admin capabilities (one service = one capability, the
// declared_in_code mapping).
//
// Since 2026-11-16 it also replays what the agent's application-log read (S2,
// aggregate_app_logs) counts for the manual follow-up rule: each stage's application-log
// lines, emitted exactly as seed:upload writes them, go through
// business-data/follow-up-patterns.js over the job's own 30-day windows (the current one at
// every read, the earlier one once at onboarding, over stage 0's logs), and the stored counts
// reach observationsForGoal as drift/index.js#loadDriftWorld assembles them.
//
// The state documents the agent reads at each read are the LIVE ones: the stage's state
// merged into what the app held (src/merge.js), with the notifications the approved AI
// agents wrote between the stages (applied_by_agent) kept.
//
// Start dates on all seven weekdays.
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLACEHOLDER_DISTRIBUTION_DOMAIN, PLACEHOLDER_DISTRIBUTION_ID, stageView, stageWithhold } from '../src/generate.js';
import { emitLogs } from '../src/emit.js';
import { DAY_MS, simulate } from '../src/model.js';
import { canonicalJson, getScenario, stageOf } from '../src/scenarios.js';
import { mergeState } from '../src/merge.js';
import { completeState } from '../src/files.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GA = path.resolve(process.env.GOVERNANCE_AGENT_REPO ?? path.join(HERE, '../../governance-agent'));
const DRIFT = path.join(GA, 'packages/modules/new-evolution-opportunity/drift');
const available = existsSync(path.join(DRIFT, 'detectors.js'));
const skip = available ? false : `the Governance Agent repository is not at ${GA} (set GOVERNANCE_AGENT_REPO)`;

const ANCHORS = ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'];
const CAPABILITY_OF_SERVICE = { learning: 'cap_learning', catalog: 'cap_catalog', notifications: 'cap_notifications', admin: 'cap_admin', identity: 'cap_identity', billing: 'cap_billing' };
// The compliance goal is linked to the capability that holds the staff's training look-ups
// and reminders (services/admin): no current detector may raise anything about it in any
// stage (docs/signal-spec.md says why).
const GOALS = [
  ['g_learn', 'More learners actively progressing every week', 'cap_learning'],
  ['g_cart', 'Complete the purchases learners start', 'cap_catalog'],
  ['g_compliance', '95% of mandatory training completed on time across enterprise accounts', 'cap_admin'],
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
    followUpPatterns: await load('packages/platform/business-data/follow-up-patterns.js'),
    followUp: await load('packages/modules/new-evolution-opportunity/drift/follow-up.js'),
    records: await load('packages/platform/business-data/application-records.js'),
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

/** The app-log read windows of aggregate_app_logs (backend log-routes-job.js logWindowFor): 30 days ending today 00:00 UTC. */
function logWindow(anchor, back = 0) {
  const end = Date.parse(`${anchor}T00:00:00Z`) - back * 30 * DAY_MS;
  return { start: new Date(end - 30 * DAY_MS).toISOString(), end: new Date(end).toISOString() };
}

/** One follow-up read of the stage's application logs, stored the way the job stores it. */
function followUpRead(appLogs, window, knownRoutes) {
  const agg = ga.followUpPatterns.createFollowUpAggregator({ window, knownRoutes });
  for (const text of appLogs.values()) for (const line of text.split('\n')) agg.add(line);
  const result = ga.followUpPatterns.assertFollowUpAggregateOnly(agg.result());
  return { window_start: window.start, window_end: window.end, partial: 0, days_with_lines: result.days_with_lines, patterns: result.patterns, signal_id: 'sig_app_logs' };
}

/**
 * The agent's read of LearnLoop's state documents (owner decision 2026-11-17): the stage's
 * starting state, as seed:upload writes it under state/, through the agent's own records
 * aggregator with the default (LearnLoop-shaped) declaration, read on the start date.
 */
function recordsRead(data, anchor) {
  const declaration = ga.records.validateRecordDeclaration({ bucket: 'learnloop-prod-state-000000000000', prefix: 'state/' });
  const documents = Object.fromEntries(Object.entries(data).map(([k, v]) => [`${k}.json`, v]));
  const agg = ga.records.assertRecordAggregateOnly(ga.records.aggregateDeadlineRecords(documents, declaration, { now: `${anchor}T00:00:00.000Z` }));
  return { ...agg, signal_id: 'sig_records' };
}

function detect(rows, capabilities, followUpRows = [], applicationRecords = null) {
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
    followUps: ga.followUp.followUpSeriesByCapability(followUpRows, ga.followUp.routeCapabilityMap(rows)),
    applicationRecords,
  };
  const standDowns = [];
  const observations = GOALS.flatMap((goal) => {
    const r = det.observationsForGoal(goal, world);
    standDowns.push(...r.stood_down.filter((s) => s.code === 'NBF-USAGE-MANUAL_FOLLOW_UP'));
    return r.observations.map((o) => ({ goal: goal.goal_id, code: o.code, fingerprint: canonicalJson(o.fingerprint ?? {}), facts: o.facts, signal_ids: o.signal_ids }));
  });
  observations.standDowns = standDowns;
  return observations;
}

/** What an approved AI agent writes into the live notifications between two stages. */
const agentNotes = (stage, data, anchor) => data.users.filter((u) => u.role === 'learner').slice(0, 25).map((u, i) => ({
  id: `ntf_agent_${stage}_${i}`, user_id: u.id, type: stage === 1 ? 'lesson_reminder' : 'cart_reminder', title: 'Pick up where you left off', body: 'A short note from the AI agent.',
  link: '/courses', created_at: new Date(Date.parse(`${anchor}T10:00:00Z`) + i * 1000).toISOString(), read_at: null, applied_by_agent: true,
}));

/**
 * The four reads of the staged reveal: onboarding over the history (stage 0), with the
 * history read, then one current-window read per stage, detected after each. Returns
 * [stage 0, stage 1, stage 2, stage 3] observations.
 */
function detectStages(def, anchor) {
  const sim = simulate({ anchor, seed: 42, scenario: def });
  const services = [...new Set(sim.requests.filter((r) => r.kind === 'api').map((r) => r.service))];
  const capabilities = services.map((s) => ({ capability_id: CAPABILITY_OF_SERVICE[s] ?? `cap_${s}`, name: s, status: 'confirmed', criticality: 'high', entry_points: [], depends_on: [] }));
  const current = ga.telemetry.telemetryWindow({ asOf: anchor, days: 30 });
  const history = ga.telemetry.telemetryWindow({ asOf: new Date(Date.parse(`${current.start}T00:00:00Z`) - DAY_MS).toISOString(), days: 30 });
  const rows = [];
  const followUpRows = [];
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
  let live = null;
  for (const stage of [0, 1, 2, 3]) {
    const st = stageOf(def, stage);
    const { requests, data } = stageView(sim, st);
    // the live state: stage 0 replaces it; a later stage merges into it, after the AI
    // agent approved at the stage before wrote its notifications
    const stageDocs = JSON.parse(JSON.stringify(completeState(data)));
    if (stage === 0) live = stageDocs;
    else {
      if (stage >= 2) live.notifications.push(...agentNotes(stage - 1, live, anchor));
      const base = JSON.parse(JSON.stringify(completeState(stageView(sim, stageOf(def, stage - 1)).data)));
      live = Object.fromEntries(mergeState({ live, stage: stageDocs, base }).map((r) => [r.domain, r.document]));
    }
    read(requests, current);
    if (stage === 0) read(requests, history); // the history read happens once, right after the onboarding read
    // The application logs of the same stage, as seed:upload writes them, read by the
    // follow-up aggregator over the job's windows (current every time, earlier once).
    const { appLogs } = emitLogs(sim, {
      salt: 'harness-salt', seed: 42, distributionId: PLACEHOLDER_DISTRIBUTION_ID, distributionDomain: PLACEHOLDER_DISTRIBUTION_DOMAIN,
      withhold: stageWithhold(sim, st),
    });
    const knownRoutes = [...new Set(rows.map((r) => r.scope_key))];
    const reads = stage === 0 ? [logWindow(anchor), logWindow(anchor, 1)] : [logWindow(anchor)];
    for (const w of reads) {
      clock += 5;
      followUpRows.push({ ...followUpRead(appLogs, w, knownRoutes), created_at: new Date(clock).toISOString() });
    }
    seen.push(detect(rows, capabilities, followUpRows, recordsRead(live, anchor)));
    seen.at(-1).rows = rows.length;
  }
  return seen;
}

const FOLLOW_UP = 'NBF-USAGE-MANUAL_FOLLOW_UP';
const key = (o) => `${o.goal}|${o.code}|${o.fingerprint}`;

// detectStages is the expensive part (three log emissions per start date); both tests below
// read the full scenario's stages, so they share one computation per start date.
const staged = new Map();
const stagesOf = (def, anchor) => {
  const k = `${def.id}|${def.parameters?.compliance === null ? 'nocompliance' : 'full'}|${def.staged_reveal.history_stage.recent_traffic_withheld === 'all' ? 'empty-history' : 'history'}|${anchor}`;
  if (!staged.has(k)) staged.set(k, detectStages(def, anchor));
  return staged.get(k);
};

test('the agent\'s own detectors: the history (stage 0) raises nothing, stage 1 the lesson finding only, stage 2 adds the enrol finding, stage 3 adds the manual follow-up finding, nothing earlier changes; the earlier window read only at stage 0', { skip }, () => {
  const def = getScenario('q4-three-signals');
  for (const anchor of ANCHORS) {
    const seen = stagesOf(def, anchor);
    const actor = (list, goal) => list.filter((o) => o.goal === goal && o.code === 'NBF-USAGE-ACTOR_INACTIVITY');
    const goalsWith = (list) => [...new Set(list.map((o) => o.goal))].sort();
    const [s0, s1, s2, s3] = seen;
    // stage 0, read at onboarding with the history read: nothing at all, on any goal
    assert.deepEqual(s0.map((o) => [o.goal, o.code]), [], `${anchor} stage 0: ${JSON.stringify(s0.map((o) => [o.goal, o.code]))}`);
    assert.ok(s0.rows > 0, `${anchor} stage 0: the history read wrote the earlier window`);
    // stage 1: lessons only, and nothing at all about the store or the required training
    assert.deepEqual(goalsWith(s1), ['g_learn'], `${anchor} stage 1: ${JSON.stringify(s1.map((o) => [o.goal, o.code]))}`);
    assert.equal(actor(s1, 'g_learn').length, 1);
    assert.ok(actor(s1, 'g_learn')[0].facts.inactive_routes.some((r) => r.route === '/api/lessons/{lessonId}'));
    // stage 2: the enrolment finding is added; nothing about the required training yet
    assert.deepEqual(goalsWith(s2), ['g_cart', 'g_learn'], `${anchor} stage 2`);
    const enrol = actor(s2, 'g_cart')[0].facts.inactive_routes;
    assert.deepEqual(enrol.map((r) => r.route), ['/api/courses/{courseId}/enrol'], `${anchor} stage 2: ${JSON.stringify(enrol)}`);
    assert.ok(enrol[0].earlier_actors >= 200 && enrol[0].drop_pct >= 33, `${anchor} stage 2: ${JSON.stringify(enrol)}`);
    // stages 0, 1 and 2: the follow-up pattern is SEEN (the staff's ordinary reminders) and the
    // rule stands down on the growth bar, by name — it is not silent for lack of data
    for (const [list, n] of [[s0, 0], [s1, 1], [s2, 2]]) {
      assert.ok(!list.some((o) => o.code === FOLLOW_UP), `${anchor} stage ${n}: no manual follow-up finding`);
      const reasons = list.standDowns.filter((d) => d.goal_id === 'g_compliance').map((d) => d.reason);
      assert.equal(reasons.length, 1, `${anchor} stage ${n}: one stand-down on the compliance goal`);
      assert.ok(['follow_up_not_growing', 'follow_up_too_few_messages'].includes(reasons[0]), `${anchor} stage ${n}: ${reasons[0]}`);
      const figures = list.standDowns.find((d) => d.goal_id === 'g_compliance').figures;
      assert.ok(figures.growth_ratio < 1.6, `${anchor} stage ${n}: growth ${figures.growth_ratio} far under the 2x bar`);
    }
    // stage 3: exactly stage 2 plus ONE manual follow-up finding, on the compliance goal and
    // the admin capability (where the staff's look-ups live)
    const added = s3.filter((o) => !new Set(s2.map(key)).has(key(o)));
    assert.deepEqual(added.map((o) => `${o.goal}|${o.code}`), [`g_compliance|${FOLLOW_UP}`], `${anchor} stage 3 adds: ${JSON.stringify(added.map((o) => [o.goal, o.code]))}`);
    const f = added[0].facts;
    assert.equal(f.lookup_route, '/api/admin/learners/{userId}/training', anchor);
    assert.equal(f.contact_event, 'staff_message_sent', anchor);
    assert.equal(f.operators, 3, `${anchor}: the three staff`);
    assert.ok(f.growth_ratio >= 2.5, `${anchor}: growth ${f.growth_ratio}`);
    assert.ok(f.paired_pct >= 90, `${anchor}: paired ${f.paired_pct}`);
    assert.ok(f.response_improvement_z === null || f.response_improvement_z < 1.645, `${anchor}: z ${f.response_improvement_z}`);
    assert.ok(added[0].signal_ids.includes('sig_app_logs'), `${anchor}: the app-log read is cited (rule 12)`);
    // ...and with LearnLoop's records read: the outcome per deadline is flat, the overdue work
    // sits in the three behind teams, and only the message bodies stay unread.
    const r = f.records;
    assert.ok(r, `${anchor}: the records reached the finding`);
    assert.equal(r.on_time_pct_by_deadline.length, 3, `${anchor}: the three past deadlines`);
    assert.ok(Math.abs(r.outcome_change_pts) <= 10, `${anchor}: on time ${r.on_time_pct_by_deadline}`);
    assert.ok(r.on_time_pct_overall >= 50 && r.on_time_pct_overall <= 75, `${anchor}: ${r.on_time_pct_overall}`);
    assert.deepEqual(r.behind_teams.map((t) => t.label).sort(), ['Patient services', 'Retail branches', 'Warehouse operations'], `${anchor}: ${JSON.stringify(r.behind_teams)}`);
    assert.ok(r.behind_share_of_overdue_pct >= 60, `${anchor}: ${r.behind_share_of_overdue_pct}`);
    assert.ok(r.at_risk >= 60, `${anchor}: at risk ${r.at_risk}`);
    assert.ok(added[0].signal_ids.includes('sig_records'), `${anchor}: the records read is cited (rule 12)`);
    assert.deepEqual(f.not_measured, ['message_wording']);
    // every observation of a stage is still there, with the same fingerprint, in the next
    for (const [before, after, n] of [[s0, s1, 1], [s1, s2, 2], [s2, s3, 3]]) {
      const later = new Set(after.map(key));
      for (const o of before) assert.ok(later.has(key(o)), `${anchor} stage ${n} keeps ${o.goal} ${o.code} ${o.fingerprint}`);
    }
  }
});

// Case 3 is a pass over the finished simulation with its own random streams: without it the
// agent finds exactly the same things about lessons and enrolment (same codes, fingerprints,
// and the same inactive lesson and enrol routes with the same numbers). Its only footprint on
// those capabilities is the quiz route (employees retaking quizzes) and, through it, the
// learning goal's daily request trend; both are disclosed in docs/signal-spec.md. Without it
// there is no follow-up surge, so the manual follow-up rule never fires in any stage.
test('the compliance case leaves the lesson and enrol findings as they are, in every stage', { skip }, () => {
  const def = getScenario('q4-three-signals');
  const without = { ...def, parameters: { ...def.parameters, compliance: null } };
  const LESSON_AND_ENROL = new Set(['/api/lessons/{lessonId}', '/api/courses/{courseId}/lessons', '/api/lessons/{lessonId}/progress', '/api/courses/{courseId}/enrol']);
  const view = (list) => list.filter((o) => o.code === 'NBF-USAGE-ACTOR_INACTIVITY').map((o) => ({
    goal: o.goal, fingerprint: o.fingerprint, routes: o.facts.inactive_routes.filter((r) => LESSON_AND_ENROL.has(r.route)),
  }));
  for (const anchor of ['2026-11-15', '2026-11-18', '2026-11-21']) {
    const [a, b] = [stagesOf(def, anchor), stagesOf(without, anchor)];
    const others = (list) => list.filter((o) => o.code !== FOLLOW_UP).map((o) => `${o.goal}|${o.code}`).sort();
    for (let i = 0; i < 4; i += 1) {
      assert.deepEqual(view(a[i]), view(b[i]), `${anchor} stage ${i}: the inactivity findings`);
      assert.deepEqual(others(a[i]), others(b[i]), `${anchor} stage ${i}: the same observations`);
      assert.ok(!b[i].some((o) => o.code === FOLLOW_UP), `${anchor} stage ${i}: no follow-up finding without the compliance case`);
    }
  }
});


// Why the history stage keeps the ordinary recent activity (the routes no case is about)
// instead of no recent traffic at all: with nothing observed after day -30, a goal's daily
// series holds only days -59..-30, inside which the lapse (days -45..-31) and the checkout
// change (from days -40..-30) already begin, so the goal-trend rule's split halves fall and
// it raises the lesson AND the purchase goal at onboarding, before either case is loaded.
test('the history stage with NO recent traffic at all would raise the goal trend on the lesson and purchase goals at onboarding (why stage 0 keeps the ordinary recent activity)', { skip }, () => {
  const def = getScenario('q4-three-signals');
  const r = def.staged_reveal;
  const { recent_activity_withheld: _a, ...h } = r.history_stage;
  const empty = { ...def, staged_reveal: { ...r, history_stage: { ...h, recent_traffic_withheld: 'all' } } };
  for (const anchor of ['2026-11-15', '2026-11-21']) {
    const [s0] = stagesOf(empty, anchor);
    const trend = s0.filter((o) => o.code === 'NBF-DRIFT-GOAL_TREND_NEGATIVE').map((o) => o.goal).sort();
    assert.deepEqual(trend, ['g_cart', 'g_learn'], `${anchor}: ${JSON.stringify(s0.map((o) => [o.goal, o.code]))}`);
    assert.ok(!s0.some((o) => o.code === 'NBF-USAGE-ACTOR_INACTIVITY'), `${anchor}: no route has a recent window, so no inactivity`);
  }
});
