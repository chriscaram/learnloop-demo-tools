// Scenario definitions: what the simulated learners do, as data.
//
// Each scenario is ONE plain JSON file under scenarios/. JSON rather than a JS module,
// on purpose: a scenario is a list of numbers the generator interprets, never code it
// runs, so the definition can be hashed canonically (the "sealed envelope" fingerprint
// the simulator page shows before the demo) and revealed verbatim afterwards, and what
// is revealed is provably everything the generator was told. A JS module could hide
// behaviour in a function body that neither the fingerprint nor the reveal would show.
//
// The shared machinery (population, catalog, sessions, emit) stays in model.js and
// emit.js; the scenario only chooses its parameters.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOLLOW_UP_SURGE } from './compliance.js';
import { COURSES } from './content.js';

export const SCENARIOS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scenarios');
export const DEFAULT_SCENARIO = 'lapsed-learners';
export const SCENARIO_STATUSES = Object.freeze(['verified', 'experimental']);
const ID_PATTERN = /^[a-z][a-z0-9-]{1,40}$/;

const isInt = (v) => Number.isInteger(v);
const inWindow = (d) => isInt(d) && d >= -60 && d <= -1;

function fail(id, message) {
  throw new Error(`scenario ${id}: ${message}`);
}

/** Throws with a named reason unless `def` is a well-formed scenario. Returns `def`. */
export function validateScenario(def) {
  const id = def?.id ?? '(no id)';
  if (!def || typeof def !== 'object') fail(id, 'must be an object');
  if (!ID_PATTERN.test(def.id ?? '')) fail(id, 'id must be lower-case words joined by hyphens');
  for (const key of ['title', 'description', 'expected_finding']) {
    if (typeof def[key] !== 'string' || def[key].length < 10) fail(id, `${key} must be a sentence`);
  }
  if (!SCENARIO_STATUSES.includes(def.status)) fail(id, `status must be one of ${SCENARIO_STATUSES.join(', ')}`);
  if (def.status === 'verified') {
    if (!Array.isArray(def.verified_against) || def.verified_against.length === 0) fail(id, 'a verified scenario names the detector files and thresholds it crosses');
    for (const v of def.verified_against) if (!v?.file || !v?.threshold) fail(id, 'each verified_against entry needs file and threshold');
  } else if (typeof def.experimental_reason !== "string" || def.experimental_reason.length < 10) {
    fail(id, 'an experimental scenario says why in experimental_reason');
  }
  const p = def.parameters;
  if (!p || typeof p !== 'object') fail(id, 'parameters missing');
  const pop = p.population;
  if (!pop || ![pop.regular, pop.lapsing, pop.rarelyActive].every((n) => isInt(n) && n >= 2)) fail(id, 'population needs regular, lapsing and rarelyActive counts');
  if (pop.regular + pop.lapsing + pop.rarelyActive !== 420) fail(id, 'the population is 420 learners (the demo personas and the catalog assume it)');
  if (p.lapse !== null) {
    const { lastLessonFromDay: from, lastLessonToDay: to } = p.lapse ?? {};
    if (!inWindow(from) || !inWindow(to) || from > to) fail(id, 'lapse needs lastLessonFromDay <= lastLessonToDay inside -60..-1');
  }
  if (!Array.isArray(p.cancellations) || p.cancellations.length === 0) fail(id, 'cancellations must be a list of periods');
  let fromRare = 0;
  for (const c of p.cancellations) {
    if (!inWindow(c.fromDay) || !inWindow(c.toDay) || c.fromDay > c.toDay) fail(id, 'each cancellation period needs fromDay <= toDay inside -60..-1');
    if (![c.rarelyActive, c.stoppedLearning].every((n) => isInt(n) && n >= 0)) fail(id, 'cancellation counts are whole numbers');
    fromRare += c.rarelyActive;
  }
  if (fromRare > pop.rarelyActive) fail(id, 'more cancellations from rarely active learners than there are of them');
  const stopped = p.cancellations.reduce((s, c) => s + c.stoppedLearning, 0);
  if (stopped > 0 && p.lapse === null && p.outage === null) fail(id, 'stoppedLearning cancellations need a lapse or an outage that makes learners stop');
  if (p.slowdown !== null) {
    const s = p.slowdown ?? {};
    if (!inWindow(s.fromReleaseOnOrAfterDay) || !(s.lessonMedianMs > 0 && s.lessonMedianMs <= 10_000) || !(s.spread > 0 && s.spread < 1.5)) {
      fail(id, 'slowdown needs fromReleaseOnOrAfterDay, lessonMedianMs (1..10000) and spread (0..1.5)');
    }
  }
  if (p.outage !== null) {
    const o = p.outage ?? {};
    if (!inWindow(o.fromDay) || !inWindow(o.toDay) || o.fromDay > o.toDay) fail(id, 'outage needs fromDay <= toDay inside -60..-1');
    if (o.fromDay <= -33 && o.toDay >= -33) fail(id, "the outage may not cover day -33, Ana's scripted last lesson");
    if (!(o.failureShare > 0 && o.failureShare <= 1) || !(o.giveUpShare >= 0 && o.giveUpShare <= 1)) fail(id, 'outage shares are between 0 and 1');
    if (!isInt(o.retriesMin) || !isInt(o.retriesMax) || o.retriesMin < 0 || o.retriesMax < o.retriesMin || o.retriesMax > 5) fail(id, 'outage retries are 0..5');
  }
  validateCarts(id, p.carts ?? null);
  if (p.carts?.lapsedAddPerBrowseSession !== undefined && p.lapse === null) fail(id, 'carts.lapsedAddPerBrowseSession needs a lapse');
  validateSupport(id, p.support ?? null);
  validateCompliance(id, p.compliance ?? null);
  // carts, support and compliance are optional: a scenario written before they existed has none
  const known = ['population', 'lapse', 'cancellations', 'slowdown', 'outage', 'carts', 'support', 'compliance'];
  const extra = Object.keys(p).filter((k) => !known.includes(k));
  if (extra.length) fail(id, `unknown parameters: ${extra.join(', ')} (the generator would silently ignore them)`);
  validateStagedReveal(id, def);
  return def;
}

// ------------------------------------------------------------------ the staged reveal
//
// A combined scenario may be loaded in stages, one case at a time, into ONE Governance
// Agent application (README, "Presenting the staged reveal"). Every stage is the SAME
// generation (same anchor, seed and population) with part of it withheld:
//
//   recent_traffic_withheld  "METHOD /route" pairs whose requests are left out of the
//                            logs from recent_window_from_day on (the window the agent
//                            reads again at every "Get usage telemetry"). Their earlier
//                            traffic stays: the agent reads the earlier window only once,
//                            when the application is onboarded (its history read), so it
//                            must already be the final one in stage 1.
//   recent_activity_withheld named parts of the activity (not whole routes) left out of the
//                            logs from recent_window_from_day on: `training_follow_up_surge`
//                            is the staff's follow-up above its earlier level
//                            (compliance.followUp.surgeFromDay must be that same day).
//   state_withheld           state documents (or the named part of one) written empty in
//                            that stage.
//
// `history_stage` (optional) is stage 0, loaded BEFORE the application is onboarded: the
// agent reads the earlier window only once, right after its first read, and that first
// read is the onboarding one. Stage 0 holds the final earlier window, the app's starting
// state, and of the recent window only what no case is about: its withheld routes,
// activities and state include stage 1's (a stage only adds). `recent_traffic_withheld:
// "all"` withholds every line from recent_window_from_day on, on every route (unmeasured,
// never an observed zero); q4-three-signals does not use it, because with no recent day
// observed the goals' daily series hold only the earlier window, and the agent's
// goal-trend rule finds the lapse and the checkout change that begin inside it
// (test/governance-agent.test.js shows both).
//
// The last stage withholds nothing, so it is the scenario's own output byte for byte.
// Each later stage withholds a subset of the one before: a stage only ever ADDS traffic,
// never removes any, because the agent keeps the highest distinct-user count it has read
// for a window and could never see a drop that an earlier stage had already filled in.
export const STATE_WITHHOLDABLE = Object.freeze(['carts', 'support_requests', 'support_reply_notifications', 'training_follow_up_surge_notifications']);
export const ACTIVITY_WITHHOLDABLE = Object.freeze([FOLLOW_UP_SURGE]);
const ROUTE_KEY = /^(GET|POST|PUT|PATCH|DELETE) \/api\/[A-Za-z0-9/{}_-]+$/;

function validateStagedReveal(id, def) {
  const r = def.staged_reveal;
  if (r === undefined) return;
  if (!r || typeof r !== 'object') fail(id, 'staged_reveal must be an object');
  const extra = Object.keys(r).filter((k) => !['recent_window_from_day', 'why', 'history_stage', 'stages'].includes(k));
  if (extra.length) fail(id, `unknown staged_reveal keys: ${extra.join(', ')}`);
  if (!inWindow(r.recent_window_from_day) || r.recent_window_from_day < -59) fail(id, 'staged_reveal.recent_window_from_day is a day inside -59..-1');
  if (typeof r.why !== 'string' || r.why.length < 10) fail(id, 'staged_reveal.why must be a sentence');
  if (!Array.isArray(def.cases) || !def.cases.length) fail(id, 'a staged reveal needs the cases it reveals');
  if (!Array.isArray(r.stages) || r.stages.length !== def.cases.length) fail(id, 'staged_reveal.stages has one stage per case');
  let previous = null;
  r.stages.forEach((s, i) => {
    const where = `staged_reveal.stages[${i}]`;
    const keys = Object.keys(s ?? {}).filter((k) => !['adds_case', 'expected_new_finding', 'recent_traffic_withheld', 'recent_activity_withheld', 'state_withheld'].includes(k));
    if (keys.length) fail(id, `unknown ${where} keys: ${keys.join(', ')}`);
    if (s.adds_case !== i + 1) fail(id, `${where}.adds_case is ${i + 1}: stage n adds case n`);
    if (typeof s.expected_new_finding !== 'string' || s.expected_new_finding.length < 10) fail(id, `${where}.expected_new_finding must be a sentence`);
    if (!Array.isArray(s.recent_traffic_withheld) || s.recent_traffic_withheld.some((k) => !ROUTE_KEY.test(k))) fail(id, `${where}.recent_traffic_withheld lists "METHOD /api/route" pairs`);
    if (!Array.isArray(s.state_withheld) || s.state_withheld.some((k) => !STATE_WITHHOLDABLE.includes(k))) fail(id, `${where}.state_withheld lists some of ${STATE_WITHHOLDABLE.join(', ')}`);
    if (new Set(s.recent_traffic_withheld).size !== s.recent_traffic_withheld.length) fail(id, `${where}.recent_traffic_withheld repeats a route`);
    const activities = s.recent_activity_withheld ?? [];
    if (!Array.isArray(activities) || activities.some((k) => !ACTIVITY_WITHHOLDABLE.includes(k)) || new Set(activities).size !== activities.length) {
      fail(id, `${where}.recent_activity_withheld lists some of ${ACTIVITY_WITHHOLDABLE.join(', ')}, once each`);
    }
    if (activities.includes(FOLLOW_UP_SURGE) && def.parameters?.compliance?.followUp?.surgeFromDay !== r.recent_window_from_day) {
      fail(id, `${where} withholds ${FOLLOW_UP_SURGE}: compliance.followUp.surgeFromDay must be recent_window_from_day`);
    }
    if (previous) {
      const before = previous.recent_activity_withheld ?? [];
      for (const k of s.recent_traffic_withheld) if (!previous.recent_traffic_withheld.includes(k)) fail(id, `${where} withholds ${k}, which the stage before showed: a stage may only add traffic`);
      for (const k of activities) if (!before.includes(k)) fail(id, `${where} withholds ${k}, which the stage before showed: a stage may only add traffic`);
      for (const k of s.state_withheld) if (!previous.state_withheld.includes(k)) fail(id, `${where} withholds ${k}, which the stage before wrote`);
      if (s.recent_traffic_withheld.length + activities.length === previous.recent_traffic_withheld.length + before.length) fail(id, `${where} reveals no traffic: each stage adds a case`);
    }
    previous = s;
  });
  if (r.history_stage !== undefined) {
    const h = r.history_stage;
    const where = 'staged_reveal.history_stage';
    if (!h || typeof h !== 'object') fail(id, `${where} must be an object`);
    const keys = Object.keys(h).filter((k) => !['loads', 'expected_new_finding', 'recent_traffic_withheld', 'recent_activity_withheld', 'state_withheld'].includes(k));
    if (keys.length) fail(id, `unknown ${where} keys: ${keys.join(', ')}`);
    for (const k of ['loads', 'expected_new_finding']) if (typeof h[k] !== 'string' || h[k].length < 10) fail(id, `${where}.${k} must be a sentence`);
    const first = r.stages[0];
    if (h.recent_traffic_withheld !== 'all') {
      if (!Array.isArray(h.recent_traffic_withheld) || h.recent_traffic_withheld.some((k) => !ROUTE_KEY.test(k)) || new Set(h.recent_traffic_withheld).size !== h.recent_traffic_withheld.length) {
        fail(id, `${where}.recent_traffic_withheld is "all" or lists "METHOD /api/route" pairs, once each`);
      }
      const acts = h.recent_activity_withheld ?? [];
      if (!Array.isArray(acts) || acts.some((k) => !ACTIVITY_WITHHOLDABLE.includes(k))) fail(id, `${where}.recent_activity_withheld lists some of ${ACTIVITY_WITHHOLDABLE.join(', ')}`);
      for (const k of first.recent_traffic_withheld) if (!h.recent_traffic_withheld.includes(k)) fail(id, `stage 1 withholds ${k}, which the history stage showed: a stage only adds`);
      for (const k of first.recent_activity_withheld ?? []) if (!acts.includes(k)) fail(id, `stage 1 withholds ${k}, which the history stage showed: a stage only adds`);
      if (h.recent_traffic_withheld.length + acts.length === first.recent_traffic_withheld.length + (first.recent_activity_withheld ?? []).length) fail(id, 'stage 1 reveals no traffic the history stage withholds: each stage adds a case');
    } else if (h.recent_activity_withheld !== undefined) {
      fail(id, `${where}: with recent_traffic_withheld "all" there is no recent activity left to withhold`);
    }
    if (!Array.isArray(h.state_withheld) || h.state_withheld.some((k) => !STATE_WITHHOLDABLE.includes(k))) fail(id, `${where}.state_withheld lists some of ${STATE_WITHHOLDABLE.join(', ')}`);
    for (const k of first.state_withheld) if (!h.state_withheld.includes(k)) fail(id, `stage 1 withholds ${k}, which the history stage wrote: a stage only adds`);
  }
  const last = r.stages.at(-1);
  if (last.recent_traffic_withheld.length || (last.recent_activity_withheld ?? []).length || last.state_withheld.length) fail(id, 'the last stage withholds nothing: it is the whole scenario');
}

/** Number of stages of a staged scenario that add a case (the history stage, stage 0, is not counted), or 0. */
export const stageCount = (def) => def?.staged_reveal?.stages?.length ?? 0;
/** Whether a staged scenario has a history stage (stage 0, loaded before onboarding). */
export const hasHistoryStage = (def) => !!def?.staged_reveal?.history_stage;
/** The first stage a staged scenario is loaded with: 0 with a history stage, else 1. */
export const firstStage = (def) => (hasHistoryStage(def) ? 0 : 1);

/**
 * One stage of a staged scenario, normalised for the generator: `null` for no stage (the
 * whole scenario, as before stages existed). Throws for a stage the scenario does not have.
 */
export function stageOf(def, stage) {
  if (stage === null || stage === undefined) return null;
  const count = stageCount(def);
  if (!count) throw new Error(`scenario ${def.id} has no stages`);
  const first = firstStage(def);
  if (!Number.isInteger(stage) || stage < first || stage > count) throw new Error(`scenario ${def.id} has stages ${first} to ${count}, not ${stage}`);
  if (stage === 0) {
    const h = def.staged_reveal.history_stage;
    const all = h.recent_traffic_withheld === 'all';
    return {
      stage: 0, count, final: false, history: true, addsCase: 0,
      fromDay: def.staged_reveal.recent_window_from_day,
      allRecentWithheld: all,
      withheldRoutes: new Set(all ? [] : h.recent_traffic_withheld),
      withheldActivities: new Set(all ? [] : h.recent_activity_withheld ?? []),
      stateWithheld: new Set(h.state_withheld),
    };
  }
  const s = def.staged_reveal.stages[stage - 1];
  return {
    stage, count, final: stage === count, history: false, addsCase: s.adds_case,
    fromDay: def.staged_reveal.recent_window_from_day,
    allRecentWithheld: false,
    withheldRoutes: new Set(s.recent_traffic_withheld),
    withheldActivities: new Set(s.recent_activity_withheld ?? []),
    stateWithheld: new Set(s.state_withheld),
  };
}

const isShare = (v) => typeof v === 'number' && v >= 0 && v <= 1;
const isSpan = (s) => s && inWindow(s.fromDay) && inWindow(s.toDay) && s.fromDay <= s.toDay;
const TOPICS = ['billing', 'certificate', 'account', 'course_content', 'other'];

// lapsedAddPerBrowseSession is optional: a scenario written before it existed has none
const CART_KEYS = ['addPerLessonSession', 'addPerBrowseSession', 'secondItemShare', 'purchaseShare', 'revisitShare', 'removeShare', 'change', 'personaCart', 'lapsedAddPerBrowseSession'];

function validateCarts(id, c) {
  if (c === null) return;
  if (typeof c !== 'object') fail(id, 'carts must be an object or null');
  for (const k of CART_KEYS.slice(0, 6)) if (!isShare(c[k])) fail(id, `carts.${k} is a share between 0 and 1`);
  if (c.change !== null) {
    const ch = c.change ?? {};
    if (!isSpan(ch) || !isShare(ch.abandonShare) || !isShare(ch.abandonerAddShare)) {
      fail(id, 'carts.change needs fromDay <= toDay inside -60..-1, abandonShare and abandonerAddShare (shares), or is null');
    }
    const extraChange = Object.keys(ch).filter((k) => !['fromDay', 'toDay', 'abandonShare', 'abandonerAddShare'].includes(k));
    if (extraChange.length) fail(id, `unknown carts.change parameters: ${extraChange.join(', ')}`);
  }
  if (typeof c.personaCart !== 'boolean') fail(id, 'carts.personaCart is true or false');
  if (c.lapsedAddPerBrowseSession !== undefined && !isShare(c.lapsedAddPerBrowseSession)) fail(id, 'carts.lapsedAddPerBrowseSession is a share between 0 and 1');
  const extra = Object.keys(c).filter((k) => !CART_KEYS.includes(k));
  if (extra.length) fail(id, `unknown carts parameters: ${extra.join(', ')}`);
}

function validateSupport(id, s) {
  if (s === null) return;
  if (typeof s !== 'object') fail(id, 'support must be an object or null');
  for (const k of ['perWeekBefore', 'perWeekAfter']) if (!(typeof s[k] === 'number' && s[k] >= 0 && s[k] <= 100)) fail(id, `support.${k} is 0..100 questions a week`);
  for (const k of ['replyMedianHoursBefore', 'replyMedianHoursAfter']) if (!(typeof s[k] === 'number' && s[k] > 0 && s[k] <= 24 * 30)) fail(id, `support.${k} is 0..720 hours`);
  if (!(typeof s.replySpread === 'number' && s.replySpread > 0 && s.replySpread < 1.5)) fail(id, 'support.replySpread is 0..1.5');
  for (const [k, before, after] of [['rise', 'perWeekBefore', 'perWeekAfter'], ['slowdown', 'replyMedianHoursBefore', 'replyMedianHoursAfter']]) {
    if (s[k] !== null && !isSpan(s[k])) fail(id, `support.${k} needs fromDay <= toDay inside -60..-1, or null`);
    if (s[k] === null && s[before] !== s[after]) fail(id, `support.${after} differs from ${before} but support.${k} is null`);
  }
  for (const k of ['topicsBefore', 'topicsAfter']) {
    const t = s[k];
    if (!t || typeof t !== 'object' || !Object.keys(t).length || Object.keys(t).some((x) => !TOPICS.includes(x)) || Object.values(t).some((w) => !(w > 0))) {
      fail(id, `support.${k} maps topics (${TOPICS.join(', ')}) to positive weights`);
    }
  }
  if (typeof s.personaQuestion !== 'boolean') fail(id, 'support.personaQuestion is true or false');
  const extra = Object.keys(s).filter((k) => !['perWeekBefore', 'perWeekAfter', 'rise', 'topicsBefore', 'topicsAfter', 'replyMedianHoursBefore', 'replyMedianHoursAfter', 'slowdown', 'replySpread', 'personaQuestion'].includes(k));
  if (extra.length) fail(id, `unknown support parameters: ${extra.join(', ')}`);
}

// compliance is optional (a scenario written before it existed has none): enterprise
// accounts whose employees must complete required courses by a date (src/compliance.js).
const COURSE_KEYS = COURSES.map((c) => c.key);
const COMPLIANCE_KEYS = ['requiredPassScore', 'organizations', 'behindShare', 'quizRetry', 'followUp', 'personas'];
const FOLLOW_UP_KEYS = ['daysBefore', 'daysAfter', 'chasePerDay', 'rampBoost', 'overduePerDay', 'minGapDays', 'readShare', 'surgeFromDay', 'staffWeights'];
const unknownKeys = (o, keys) => Object.keys(o).filter((k) => !keys.includes(k));

function validateCompliance(id, c) {
  if (c === null) return;
  if (!c || typeof c !== 'object') fail(id, 'compliance must be an object or null');
  if (unknownKeys(c, COMPLIANCE_KEYS).length) fail(id, `unknown compliance parameters: ${unknownKeys(c, COMPLIANCE_KEYS).join(', ')}`);
  if (!isInt(c.requiredPassScore) || c.requiredPassScore < 1 || c.requiredPassScore > 100) fail(id, 'compliance.requiredPassScore is a whole percentage 1..100');
  if (!Array.isArray(c.organizations) || !c.organizations.length || c.organizations.length > 5) fail(id, 'compliance.organizations lists one to five accounts');
  let total = 0;
  c.organizations.forEach((o, i) => {
    const where = `compliance.organizations[${i}]`;
    if (unknownKeys(o ?? {}, ['name', 'employees', 'teams', 'courses']).length) fail(id, `unknown ${where} keys: ${unknownKeys(o, ['name', 'employees', 'teams', 'courses']).join(', ')}`);
    if (typeof o.name !== 'string' || o.name.length < 3) fail(id, `${where}.name is the account's name`);
    if (!isInt(o.employees) || o.employees < 2 || o.employees > 200) fail(id, `${where}.employees is 2..200`);
    total += o.employees;
    if (!Array.isArray(o.teams) || o.teams.length < 2 || o.teams.some((t) => typeof t?.name !== 'string' || typeof t.behind !== 'boolean' || unknownKeys(t, ['name', 'behind']).length)) {
      fail(id, `${where}.teams lists at least two { name, behind } teams`);
    }
    if (!o.teams.some((t) => t.behind) || o.teams.every((t) => t.behind)) fail(id, `${where}.teams has teams that are behind and teams that are not`);
    if (!Array.isArray(o.courses) || !o.courses.length || o.courses.length > 3) fail(id, `${where}.courses lists one to three required courses`);
    for (const k of o.courses) {
      if (!COURSE_KEYS.includes(k?.course)) fail(id, `${where}.courses: course is one of ${COURSE_KEYS.join(', ')}`);
      if (!isInt(k.assignedDay) || !isInt(k.dueDay) || k.assignedDay < -200 || k.dueDay > 90 || k.dueDay <= k.assignedDay) fail(id, `${where}.courses: assignedDay < dueDay, within -200..90`);
      if (unknownKeys(k, ['course', 'assignedDay', 'dueDay']).length) fail(id, `unknown ${where}.courses keys`);
    }
    if (new Set(o.courses.map((k) => k.course)).size !== o.courses.length) fail(id, `${where}.courses repeats a course`);
  });
  if (total > 300) fail(id, 'compliance: at most 300 employees in all (the learners are 420)');
  if (!isShare(c.behindShare)) fail(id, 'compliance.behindShare is a share between 0 and 1');
  const q = c.quizRetry ?? {};
  if (!isShare(q.share) || !isInt(q.maxRetries) || q.maxRetries < 0 || q.maxRetries > 5 || unknownKeys(q, ['share', 'maxRetries']).length) fail(id, 'compliance.quizRetry needs share and maxRetries (0..5)');
  const f = c.followUp ?? {};
  if (unknownKeys(f, FOLLOW_UP_KEYS).length) fail(id, `unknown compliance.followUp parameters: ${unknownKeys(f, FOLLOW_UP_KEYS).join(', ')}`);
  if (!isInt(f.daysBefore) || f.daysBefore < 1 || f.daysBefore > 30 || !isInt(f.daysAfter) || f.daysAfter < 0 || f.daysAfter > 60) fail(id, 'compliance.followUp.daysBefore is 1..30 and daysAfter 0..60');
  for (const k of ['chasePerDay', 'overduePerDay', 'readShare']) if (!isShare(f[k])) fail(id, `compliance.followUp.${k} is a share between 0 and 1`);
  if (!(typeof f.rampBoost === 'number' && f.rampBoost >= 0 && f.rampBoost <= 10)) fail(id, 'compliance.followUp.rampBoost is 0..10');
  if (!isInt(f.minGapDays) || f.minGapDays < 1 || f.minGapDays > 14) fail(id, 'compliance.followUp.minGapDays is 1..14');
  if (!inWindow(f.surgeFromDay)) fail(id, 'compliance.followUp.surgeFromDay is a day inside -60..-1');
  if (!Array.isArray(f.staffWeights) || f.staffWeights.length !== 3 || f.staffWeights.some((w) => !(w >= 0)) || !f.staffWeights.some((w) => w > 0)) fail(id, 'compliance.followUp.staffWeights gives the three staff members a weight each');
  if (typeof c.personas !== 'boolean') fail(id, 'compliance.personas is true or false');
}

/** Every scenario under scenarios/, validated, keyed by id, in file-name order. */
export function loadScenarios(dir = SCENARIOS_DIR) {
  const out = new Map();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const def = validateScenario(JSON.parse(readFileSync(path.join(dir, file), 'utf8')));
    if (`${def.id}.json` !== file) throw new Error(`scenario file ${file} declares id ${def.id}`);
    out.set(def.id, Object.freeze(def));
  }
  return out;
}

export function getScenario(id = DEFAULT_SCENARIO, dir = SCENARIOS_DIR) {
  const def = loadScenarios(dir).get(id);
  if (!def) throw new Error(`unknown scenario '${id}' (known: ${[...loadScenarios(dir).keys()].join(', ')})`);
  return def;
}

/**
 * Canonical JSON: object keys sorted at every depth, no whitespace. The page's
 * simulator/app.js implements the same rule, so the browser can recompute the
 * fingerprint from the revealed definition on its own.
 */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** What is sealed: the whole definition plus the two other inputs that decide the output. */
export function sealedInput(def, { seed, anchor, stage = null }) {
  // a stage is a fourth input; without one the sealed text is what it always was
  return stage === null || stage === undefined ? { anchor, scenario: def, seed } : { anchor, scenario: def, seed, stage };
}

export function scenarioFingerprint(def, { seed, anchor, stage = null }) {
  return createHash('sha256').update(canonicalJson(sealedInput(def, { seed, anchor, stage }))).digest('hex');
}

const dayWord = (d) => `${-d} day${d === -1 ? '' : 's'} before the start date`;
const span = (from, to) => `between ${-from} and ${-to} day${to === -1 ? '' : 's'} before the start date`;

/** The parameters as plain sentences, generated from the numbers so the two cannot disagree. */
export function plainParameters(def) {
  const p = def.parameters;
  const lines = [];
  lines.push(`${p.population.regular + p.population.lapsing} of the 420 paying learners open lessons two to five days a week; ${p.population.rarelyActive} sign in rarely and do not open lessons.`);
  if (p.lapse) {
    lines.push(`${p.population.lapsing} of the active learners open their last lesson ${span(p.lapse.lastLessonFromDay, p.lapse.lastLessonToDay)}, spread evenly. Afterwards they keep signing in every few days but never open a lesson again.`);
  } else {
    lines.push('No group of learners changes its habits on its own.');
  }
  if (p.slowdown) {
    lines.push(`The first release on or after ${dayWord(p.slowdown.fromReleaseOnOrAfterDay)} makes every lesson page slow: half of the requests take more than ${(p.slowdown.lessonMedianMs / 1000).toFixed(1)} seconds (before: under a tenth of a second). Learners do not react to it.`);
  } else {
    lines.push('Response times stay flat: about a tenth of a second on lesson pages.');
  }
  if (p.outage) {
    const o = p.outage;
    lines.push(`${span(o.fromDay, o.toDay).replace(/^b/, 'B')}, ${Math.round(o.failureShare * 100)}% of attempts to open a lesson fail with a server error; learners retry ${o.retriesMin} to ${o.retriesMax} times, then leave.`);
    lines.push(`${Math.round(o.giveUpShare * 100)}% of the active learners who ran into the errors never open a lesson again after the outage, though they keep signing in.`);
  } else {
    lines.push('There is no outage: server errors stay below 0.3% on every route, every day.');
  }
  const total = p.cancellations.reduce((s, c) => s + c.rarelyActive + c.stoppedLearning, 0);
  const periods = p.cancellations.map((c) => {
    const n = c.rarelyActive + c.stoppedLearning;
    const weeks = (c.toDay - c.fromDay + 1) / 7;
    return `${n} ${span(c.fromDay, c.toDay)} (about ${(n / weeks).toFixed(1)} a week${c.stoppedLearning ? `, ${c.stoppedLearning} of them by learners who had stopped opening lessons` : ''})`;
  });
  lines.push(`${total} subscriptions are cancelled: ${periods.join('; ')}.`);
  lines.push(...plainCarts(p.carts ?? null), ...plainSupport(p.support ?? null), ...plainCompliance(p.compliance ?? null));
  lines.push('A release goes out every 10 to 14 days, on a weekday. About 1% of requests come from a search-engine crawler, on public pages only.');
  return lines;
}

const pct = (v) => (v > 0 && v < 0.01 ? `${Math.round(v * 1000) / 10}%` : `${Math.round(v * 100)}%`);
const hours = (h) => (h < 48 ? `${Math.round(h)} hours` : `${(h / 24).toFixed(1).replace(/\.0$/, '')} days`);
const topicWords = (t) => {
  const total = Object.values(t).reduce((a, b) => a + b, 0);
  return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, w]) => `${k.replace('_', ' ')} ${Math.round((100 * w) / total)}%`).join(', ');
};

function plainCarts(c) {
  if (!c) return ['No cart or checkout activity is generated: in this history nobody uses the cart.'];
  const lines = ['Learners get every new course through the cart: when they have finished the courses they are enrolled in, they put the next one in the cart and check out.'];
  lines.push(`They also put courses in the cart for later in about ${pct(c.addPerBrowseSession)} of the visits where they only look around and ${pct(c.addPerLessonSession)} of the visits where they open a lesson (two courses in ${pct(c.secondItemShare)} of those).`);
  lines.push(`${pct(c.purchaseShare)} of the times a learner decides about the cart end with the checkout completed; otherwise the courses stay in it. A learner with something in the cart comes back to it in ${pct(c.revisitShare)} of later visits and removes a course in ${pct(c.removeShare)} of them.`);
  if (c.change) {
    lines.push(`${pct(c.change.abandonShare)} of the learners stop completing the checkout, each from a day ${span(c.change.fromDay, c.change.toDay)}, spread evenly. They keep putting courses in the cart (when they need a new course and already have one waiting, they add another in ${pct(c.change.abandonerAddShare)} of those visits) and keep opening the lessons of courses they already have.`);
  }
  if (c.lapsedAddPerBrowseSession !== undefined) {
    lines.push(`Learners who have stopped opening lessons keep looking around and put a course in their cart in ${pct(c.lapsedAddPerBrowseSession)} of their visits, but never complete the checkout.`);
  }
  if (c.personaCart) lines.push('Marco Bellini (marco.bellini@example.com) puts Python for Data Work in his cart 16 days before the start date and Data Visualization Fundamentals 9 days before, opens the checkout page and leaves without completing it.');
  return lines;
}

function plainSupport(s) {
  if (!s) return ['No questions are sent to the support team.'];
  const lines = [];
  lines.push(s.rise
    ? `Learners ask the team about ${s.perWeekBefore} questions a week until ${-s.rise.fromDay} days before the start date, ${s.perWeekAfter > s.perWeekBefore ? 'rising' : 'falling'} evenly to about ${s.perWeekAfter} a week by ${-s.rise.toDay} days before (topics before: ${topicWords(s.topicsBefore)}; after: ${topicWords(s.topicsAfter)}).`
    : `Learners ask the team about ${s.perWeekBefore} questions a week (topics: ${topicWords(s.topicsBefore)}).`);
  lines.push(s.slowdown
    ? `Staff take up a question a median of ${hours(s.replyMedianHoursBefore)} after it is asked (log-normal spread ${s.replySpread}) until ${-s.slowdown.fromDay} days before the start date, slowing evenly to ${hours(s.replyMedianHoursAfter)} by ${-s.slowdown.toDay} days before; the next staff visit after that (weekdays, office hours) answers it, so questions not taken up by the start date stay open.`
    : `Staff take up a question a median of ${hours(s.replyMedianHoursBefore)} after it is asked (log-normal spread ${s.replySpread}); the next staff visit after that (weekdays, office hours) answers it, so most questions are answered the same day or the next morning.`);
  if (s.personaQuestion) lines.push('Ana Moreno (ana.moreno@example.com) asks whether she will get a certificate for Cloud Foundations 5 days before the start date; nobody answers it.');
  return lines;
}

const dayRef = (d) => (d < 0 ? `${-d} day${d === -1 ? '' : 's'} before the start date` : d === 0 ? 'on the start date' : `${d} day${d === 1 ? '' : 's'} after the start date`);

function plainCompliance(c) {
  if (!c) return [];
  const courseTitle = (key) => COURSES.find((x) => x.key === key).title;
  const employees = c.organizations.reduce((n, o) => n + o.employees, 0);
  const lines = [`${employees} of the learners are employees of ${c.organizations.length} enterprise accounts, chosen among the learners already enrolled in their account's first required course who never cancel; each is in a team with a manager. ${pct(c.behindShare)} of the employees who did not complete their account's first required course on time are in the teams marked as behind; the others mostly in the other teams.`];
  for (const o of c.organizations) {
    lines.push(`${o.name}: ${o.employees} employees in ${o.teams.map((t) => `${t.name}${t.behind ? ' (behind)' : ''}`).join(', ')}; required courses ${o.courses.map((k) => `${courseTitle(k.course)} (assigned ${dayRef(k.assignedDay)}, due ${dayRef(k.dueDay)})`).join(' and ')}.`);
  }
  lines.push(`A required course counts as completed when every lesson is completed and every quiz in it has an attempt of ${c.requiredPassScore}% or more. After a quiz attempt below that on a required course, the employee takes it again at once in ${pct(c.quizRetry.share)} of the cases, up to ${c.quizRetry.maxRetries} more times. Nothing else about how employees learn changes.`);
  const f = c.followUp;
  lines.push(`On weekdays staff chase every required course not completed yet, by hand: from ${f.daysBefore} days before the due date (${pct(f.chasePerDay)} of the courses a day, rising to ${pct(f.chasePerDay * (1 + f.rampBoost))} on the last day) until ${f.daysAfter} days after it (${pct(f.overduePerDay)} a day), at most once every ${f.minGapDays} days per course. They do it in their ordinary Admin visits: they search the learner list (loaded once per visit), open the employee's Training and send one reminder from the same template; ${f.staffWeights.map((w) => pct(w / f.staffWeights.reduce((a, b) => a + b, 0))).join(', ')} of them are sent by Sofia Lindqvist, Daniel Okafor and Priya Nair.`);
  lines.push(`Employees open ${pct(f.readShare)} of the reminders on their next visit and otherwise carry on as before.`);
  lines.push(`From ${dayRef(f.surgeFromDay)} on, each day's follow-up up to what the same weekday four weeks earlier had is the ordinary follow-up; the rest is the surge.`);
  if (c.personas) lines.push(`Lena Hoffmann (${'lena.hoffmann@example.com'}) is an employee in a team that is behind who still signs in, overdue on a required course she has started; Tobias Brandt (${'tobias.brandt@example.com'}) is her manager.`);
  return lines;
}

/** The card shown before the reveal: the title and the audience description only (no expected finding, no parameters). */
export function publicCard(def) {
  // `stages`: only how many, so the page can offer one button per case. Which traffic each
  // stage withholds is part of the sealed definition and appears only in the reveal.
  return {
    id: def.id, title: def.title, description: def.description,
    ...(def.cases ? { cases: def.cases } : {}),
    ...(stageCount(def) ? { stages: stageCount(def), firstStage: firstStage(def) } : {}),
  };
}

const STATE_WORDS = {
  training_follow_up_surge_notifications: 'the reminders sent in the left-out follow-up are not in notifications.json',
  carts: 'the saved carts (carts.json) are empty',
  support_requests: 'there are no support questions (support_requests.json is empty)',
  support_reply_notifications: 'no learner has a reply notification from the team',
};

/** The staged reveal in plain sentences, one entry per stage. */
export function plainStages(def) {
  const r = def.staged_reveal;
  if (!r) return [];
  const history = r.history_stage ? [{
    stage: 0, addsCase: 0,
    lines: [
      'Stage 0 loads the history, before the application is onboarded in the Governance Agent.',
      `${r.history_stage.loads}`,
      r.history_stage.recent_traffic_withheld === 'all'
        ? `From ${-r.recent_window_from_day} days before the start date on, nothing is in the logs: no request on any route, no event, no log line.`
        : `From ${-r.recent_window_from_day} days before the start date on, these requests are left out of the logs: ${r.history_stage.recent_traffic_withheld.join(', ')}${(r.history_stage.recent_activity_withheld ?? []).includes(FOLLOW_UP_SURGE) ? ", and the staff's follow-up of required training above its earlier level" : ''}. Everything before that day is the same as in the last stage.`,
      ...(r.history_stage.state_withheld.length ? [`In the app's starting state ${r.history_stage.state_withheld.map((k) => STATE_WORDS[k]).join(', and ')}.`] : []),
      `Expected: ${r.history_stage.expected_new_finding}`,
    ],
  }] : [];
  return [...history, ...r.stages.map((s, i) => {
    const caseTitle = def.cases[s.adds_case - 1].title;
    const lines = [`Stage ${i + 1} adds case ${s.adds_case}: ${caseTitle}.`];
    const activities = s.recent_activity_withheld ?? [];
    if (s.recent_traffic_withheld.length) {
      lines.push(`From ${-r.recent_window_from_day} days before the start date on, these requests are left out of the logs: ${s.recent_traffic_withheld.join(', ')}. Everything before that day is the same as in the last stage.`);
    }
    if (activities.includes(FOLLOW_UP_SURGE)) {
      lines.push(`From ${-r.recent_window_from_day} days before the start date on, the staff's follow-up of required training above its earlier level (its training look-ups and reminders, the bell polling meanwhile and the employees opening those reminders) is left out of the logs; the follow-up at the earlier level stays, day for day.`);
    }
    if (!s.recent_traffic_withheld.length && !activities.length) {
      lines.push('Nothing is left out: this is the whole scenario, exactly as it is generated in one load.');
    }
    if (s.state_withheld.length) lines.push(`In the app's starting state ${s.state_withheld.map((k) => STATE_WORDS[k]).join(', and ')}.`);
    lines.push(`Expected: ${s.expected_new_finding}`);
    return { stage: i + 1, addsCase: s.adds_case, lines };
  })];
}
