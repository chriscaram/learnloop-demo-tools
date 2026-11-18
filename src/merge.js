// Merging a later stage's starting state into the LIVE app state, instead of replacing it.
//
// Between two stages of a staged reveal the app keeps running: the AI agents the presenter
// approved write their notifications (`applied_by_agent: true`), learners and the
// presenter mark notifications read, and the merged agent code may create records of its
// own. Replacing `state/<domain>.json` with the stage's generated document would erase all
// of that. So stages 1..n MERGE (stage 0 and "Start over" still replace, as a load always
// did):
//
//   every live record is kept, as it is;
//   a record the stage introduces (in the stage's state, not in the state loaded before
//     it, the "base") and not live yet is added;
//   a record the stage has that the live document already holds with a different value is
//     NOT edited: it is reported as a conflict (the stage never overwrites what the app,
//     an AI agent or the presenter wrote);
//   a record of the base that is no longer live was removed in the app (a course the
//     presenter checked out of a cart, say): it stays removed, and is reported.
//
// Records are matched per domain by the key in RECORD_KEYS. The base is the state of the
// stage loaded before (the same generation, so it is recomputed exactly; see
// src/generate.js stageData), which is what tells "removed in the app" apart from "new in
// this stage". Pure: no I/O. src/simulator/actions.js and src/upload.js do the reading
// and writing.
import { canonicalJson } from './scenarios.js';

/** How a record of each LearnLoop state domain is identified. `progress` is an object of two lists. */
export const RECORD_KEYS = Object.freeze({
  users: (r) => r.id,
  courses: (r) => r.id,
  lessons: (r) => r.id,
  enrolments: (r) => r.id,
  subscriptions: (r) => r.id,
  notifications: (r) => r.id,
  quiz_results: (r) => r.id,
  support_requests: (r) => r.id,
  organizations: (r) => r.id,
  training_assignments: (r) => r.id,
  carts: (r) => r.user_id,
  progress: Object.freeze({
    lessons: (r) => `${r.user_id}|${r.course_id}|${r.lesson_id}`,
    courses: (r) => `${r.user_id}|${r.course_id}`,
  }),
});

/** In words, for the page and the README: what one record of a domain is. */
export const RECORD_KEY_WORDS = Object.freeze({
  users: 'id', courses: 'id', lessons: 'id', enrolments: 'id', subscriptions: 'id', notifications: 'id',
  quiz_results: 'id', support_requests: 'id', organizations: 'id', training_assignments: 'id',
  carts: 'user_id (one cart per learner)',
  progress: 'lessons: user_id + course_id + lesson_id; courses: user_id + course_id',
});

export const MAX_SAMPLES = 5;

const same = (a, b) => canonicalJson(a) === canonicalJson(b);

/** One list of records, three ways. Returns { merged, counts, samples }. */
function mergeList(keyOf, live, stage, base) {
  const index = (list) => {
    const m = new Map();
    for (const r of list ?? []) m.set(String(keyOf(r)), r);
    return m;
  };
  const liveMap = index(live);
  const baseMap = index(base);
  // conflicts = changedInApp (the live record differs from the one loaded before: the app,
  // an AI agent or the presenter changed it) + stageChanges (the app has it as it was
  // loaded, and this stage generated it differently); neither is overwritten
  const counts = { live: live.length, stage: stage.length, added: 0, unchanged: 0, conflicts: 0, changedInApp: 0, stageChanges: 0, removedInApp: 0, keptAppOnly: 0 };
  const samples = { added: [], changedInApp: [], stageChanges: [], removedInApp: [] };
  const sample = (kind, key) => { if (samples[kind].length < MAX_SAMPLES) samples[kind].push(key); };
  const added = [];
  const stageKeys = new Set();
  for (const r of stage) {
    const key = String(keyOf(r));
    stageKeys.add(key);
    if (liveMap.has(key)) {
      if (same(liveMap.get(key), r)) counts.unchanged += 1;
      else {
        counts.conflicts += 1;
        const kind = baseMap.has(key) && same(baseMap.get(key), liveMap.get(key)) ? 'stageChanges' : 'changedInApp';
        counts[kind] += 1;
        sample(kind, key);
      }
    } else if (baseMap.has(key)) {
      counts.removedInApp += 1;
      sample('removedInApp', key);
    } else {
      counts.added += 1;
      sample('added', key);
      added.push(r);
    }
  }
  for (const key of liveMap.keys()) if (!stageKeys.has(key)) counts.keptAppOnly += 1;
  return { merged: [...live, ...added], counts, samples };
}

const emptyLike = (value) => (Array.isArray(value) ? [] : Object.fromEntries(Object.keys(value ?? {}).map((k) => [k, []])));

/**
 * Merge one domain. `live` is the parsed live document (undefined when the state bucket has
 * none: then the stage's document is written as it is), `stage` the stage's generated
 * document, `base` the state loaded before (undefined: nothing is known to have been loaded,
 * so nothing counts as removed in the app).
 */
export function mergeDomain(domain, { live, stage, base }) {
  if (live === undefined) {
    return { domain, document: stage, written: true, mode: 'created', counts: { added: Array.isArray(stage) ? stage.length : null }, samples: {} };
  }
  const keys = RECORD_KEYS[domain];
  if (!keys) {
    // a domain this tool does not know the records of: never touched
    return { domain, document: live, written: false, mode: 'unknown_domain', counts: {}, samples: {}, differs: !same(live, stage) };
  }
  if (typeof keys === 'function') {
    if (!Array.isArray(live)) throw new Error(`state/${domain}.json in the state bucket is not a list; refusing to merge into it`);
    const r = mergeList(keys, live, stage, base ?? emptyLike(stage));
    return { domain, document: r.merged, written: r.counts.added > 0, mode: 'merged', counts: r.counts, samples: r.samples };
  }
  if (!live || typeof live !== 'object' || Array.isArray(live)) throw new Error(`state/${domain}.json in the state bucket is not an object; refusing to merge into it`);
  const document = { ...live };
  const counts = {};
  const samples = {};
  let written = false;
  for (const [part, keyOf] of Object.entries(keys)) {
    if (live[part] !== undefined && !Array.isArray(live[part])) throw new Error(`state/${domain}.json: '${part}' is not a list; refusing to merge into it`);
    const r = mergeList(keyOf, live[part] ?? [], stage[part] ?? [], base?.[part] ?? []);
    document[part] = r.merged;
    counts[part] = r.counts;
    samples[part] = r.samples;
    if (r.counts.added > 0) written = true;
  }
  return { domain, document, written, mode: 'merged', counts, samples };
}

/** Sum of a domain's counts (the two lists of progress added up). */
export function totals(result) {
  const parts = result.mode === 'merged' && RECORD_KEYS[result.domain] && typeof RECORD_KEYS[result.domain] !== 'function'
    ? Object.values(result.counts) : [result.counts];
  const out = {};
  for (const c of parts) for (const [k, v] of Object.entries(c)) if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
  return out;
}

/**
 * Merge every domain of a stage's state. `live` maps domain -> parsed document (absent =
 * no document in the bucket), `stage` and `base` map domain -> document. Domains only live
 * (not generated by this tool) are left as they are and not listed.
 */
export function mergeState({ live, stage, base = null }) {
  return Object.keys(stage).sort().map((domain) => mergeDomain(domain, {
    live: Object.hasOwn(live, domain) ? live[domain] : undefined,
    stage: stage[domain],
    base: base ? base[domain] : undefined,
  }));
}

/** One sentence per domain, for the page and the command line. */
export function mergeSentence(result) {
  if (result.mode === 'created') return `${result.domain}: not in the state bucket yet; written as this stage generated it.`;
  if (result.mode === 'unknown_domain') return `${result.domain}: left as it is.`;
  const t = totals(result);
  const parts = [`${t.live} live record${t.live === 1 ? '' : 's'} kept`];
  parts.push(t.added ? `${t.added} added by this stage` : 'nothing to add');
  if (t.keptAppOnly) parts.push(`${t.keptAppOnly} written by the app since (kept)`);
  if (t.removedInApp) parts.push(`${t.removedInApp} removed in the app since the last load (left removed)`);
  if (t.changedInApp) parts.push(`${t.changedInApp} changed in the app since the last load (kept as the app has them)`);
  if (t.stageChanges) parts.push(`${t.stageChanges} this stage would change (not overwritten: kept as the app has them)`);
  return `${result.domain}: ${parts.join(', ')}.`;
}
