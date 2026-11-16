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
  // carts and support are optional: a scenario written before they existed has neither
  const known = ['population', 'lapse', 'cancellations', 'slowdown', 'outage', 'carts', 'support'];
  const extra = Object.keys(p).filter((k) => !known.includes(k));
  if (extra.length) fail(id, `unknown parameters: ${extra.join(', ')} (the generator would silently ignore them)`);
  return def;
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
  validateHelp(id, s.help);
  const extra = Object.keys(s).filter((k) => !['perWeekBefore', 'perWeekAfter', 'rise', 'topicsBefore', 'topicsAfter', 'replyMedianHoursBefore', 'replyMedianHoursAfter', 'slowdown', 'replySpread', 'personaQuestion', 'help'].includes(k));
  if (extra.length) fail(id, `unknown support parameters: ${extra.join(', ')}`);
}

// support.help is optional (a scenario written before it existed has none).
const HELP_KEYS = ['visitShare', 'checkShare', 'giveUpAfterHours', 'visitShareGivenUp', 'giveUp', 'persona'];
function validateHelp(id, h) {
  if (h === undefined) return;
  if (!h || typeof h !== 'object') fail(id, 'support.help must be an object when present');
  for (const k of ['visitShare', 'checkShare', 'visitShareGivenUp']) if (!isShare(h[k])) fail(id, `support.help.${k} is a share between 0 and 1`);
  if (!(typeof h.giveUpAfterHours === 'number' && h.giveUpAfterHours > 0 && h.giveUpAfterHours <= 24 * 30)) fail(id, 'support.help.giveUpAfterHours is 0..720 hours');
  if (h.giveUp !== null) {
    const g = h.giveUp ?? {};
    if (!isSpan(g) || !isShare(g.share)) fail(id, 'support.help.giveUp needs fromDay <= toDay inside -60..-1 and a share, or is null');
    const extraGiveUp = Object.keys(g).filter((k) => !['fromDay', 'toDay', 'share'].includes(k));
    if (extraGiveUp.length) fail(id, `unknown support.help.giveUp parameters: ${extraGiveUp.join(', ')}`);
  }
  if (typeof h.persona !== 'boolean') fail(id, 'support.help.persona is true or false');
  const extra = Object.keys(h).filter((k) => !HELP_KEYS.includes(k));
  if (extra.length) fail(id, `unknown support.help parameters: ${extra.join(', ')}`);
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
  lines.push(...plainCarts(p.carts ?? null), ...plainSupport(p.support ?? null));
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
  const h = s.help;
  if (h) {
    lines.push(`On ${pct(h.visitShare)} of their visits learners also open the Help page to look at their questions. A learner whose own question is still open checks it on ${pct(h.checkShare)} of their visits; one who finds it unanswered after more than ${hours(h.giveUpAfterHours)} gives up on Help: from then on they open it on only ${pct(h.visitShareGivenUp)} of their visits and ask nothing more.`);
    if (h.giveUp) lines.push(`${pct(h.giveUp.share)} of the learners give up on Help in the same way, each from a day ${span(h.giveUp.fromDay, h.giveUp.toDay)}, spread evenly.`);
    if (h.persona) lines.push('Lena Hoffmann (lena.hoffmann@example.com), an active learner, asks about an invoice 50 days before the start date and is answered within hours; she asks whether LearnLoop issues certificates of completion 12 days before, checks the Help page 9, 5 and 2 days before, and nobody answers it.');
  }
  if (s.personaQuestion) lines.push('Ana Moreno (ana.moreno@example.com) asks whether she will get a certificate for Cloud Foundations 5 days before the start date; nobody answers it.');
  return lines;
}

/** The card shown before the reveal: the title and the audience description only (no expected finding, no parameters). */
export function publicCard(def) {
  return { id: def.id, title: def.title, description: def.description, ...(def.cases ? { cases: def.cases } : {}) };
}
