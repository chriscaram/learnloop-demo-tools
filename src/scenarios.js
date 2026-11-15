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
  } else if (typeof def.experimental_reason !== 'string') {
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
  const known = ['population', 'lapse', 'cancellations', 'slowdown', 'outage'];
  const extra = Object.keys(p).filter((k) => !known.includes(k));
  if (extra.length) fail(id, `unknown parameters: ${extra.join(', ')} (the generator would silently ignore them)`);
  return def;
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
export function sealedInput(def, { seed, anchor }) {
  return { anchor, scenario: def, seed };
}

export function scenarioFingerprint(def, { seed, anchor }) {
  return createHash('sha256').update(canonicalJson(sealedInput(def, { seed, anchor }))).digest('hex');
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
  lines.push('A release goes out every 10 to 14 days, on a weekday. About 1% of requests come from a search-engine crawler, on public pages only.');
  return lines;
}

/** The card shown before the reveal: no parameters, no expected finding. */
export function publicCard(def) {
  return { id: def.id, title: def.title, description: def.description, status: def.status };
}
