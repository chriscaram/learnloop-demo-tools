// Later stages ADD to the live app state (src/merge.js, src/upload.js uploadState): every
// live record is kept, a record the stage introduces is added, a record the live document
// holds differently is never overwritten (reported), a record removed in the app since the
// last load stays removed. With an injected S3 layer: every live document is read before
// anything is written, writes are conditional on the ETag read, and a concurrent write by
// the app is merged again, a bounded number of times.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SAMPLES, RECORD_KEYS, mergeDomain, mergeSentence, mergeState, totals } from '../src/merge.js';
import { MAX_STATE_WRITE_ATTEMPTS, mergesState, uploadState } from '../src/upload.js';
import { completeState } from '../src/files.js';
import { stageState } from '../src/generate.js';
import { simulate } from '../src/model.js';
import { getScenario, stageOf } from '../src/scenarios.js';
import { loadedByTarget } from '../src/simulator/actions.js';
import { StackNotFoundError, isStackMissing, readStackOutputs, targetOf } from '../src/stack.js';

const n = (id, extra = {}) => ({ id, user_id: 'u1', type: 'staff_message', title: 't', body: 'b', link: '/', created_at: '2026-11-01T00:00:00.000Z', read_at: null, ...extra });

test('one list, three ways: kept, added, removed in the app, changed in the app, changed by the stage', () => {
  const base = [n('a'), n('b'), n('c')];
  const live = [n('a', { read_at: '2026-11-15T09:00:00.000Z' }), n('c'), n('agent', { applied_by_agent: true })]; // b removed, a read, agent added
  const stage = [n('a'), n('b'), n('c', { title: 'changed by the stage' }), n('d')];
  const r = mergeDomain('notifications', { live, stage, base });
  assert.deepEqual(r.document.map((x) => x.id), ['a', 'c', 'agent', 'd'], 'live first, in its order; then what the stage adds');
  assert.equal(r.document[0].read_at, '2026-11-15T09:00:00.000Z', 'the read mark is kept');
  assert.equal(r.document[1].title, 't', 'a record the app holds is never overwritten');
  assert.deepEqual(r.counts, { live: 3, stage: 4, added: 1, unchanged: 0, conflicts: 2, changedInApp: 1, stageChanges: 1, removedInApp: 1, keptAppOnly: 1 });
  assert.deepEqual(r.samples, { added: ['d'], changedInApp: ['a'], stageChanges: ['c'], removedInApp: ['b'] });
  assert.equal(r.written, true);
  assert.match(mergeSentence(r), /3 live records kept, 1 added by this stage, 1 written by the app since \(kept\), 1 removed in the app since the last load \(left removed\), 1 changed in the app since the last load \(kept as the app has them\), 1 this stage would change/);
  // nothing to add: nothing to write
  assert.equal(mergeDomain('notifications', { live, stage: [n('c')], base }).written, false);
  // without a base, a record the app no longer has is added again (nothing is known to have been loaded)
  assert.deepEqual(mergeDomain('notifications', { live: [], stage: [n('b')] }).document.map((x) => x.id), ['b']);
});

test('carts are one per learner, progress is two lists; a missing document is written as generated; an unknown domain is left alone', () => {
  const cart = (user, items) => ({ user_id: user, items: items.map((c) => ({ course_id: c, added_at: '2026-11-01T00:00:00.000Z' })) });
  const r = mergeDomain('carts', { live: [cart('marco', ['x'])], stage: [cart('marco', ['x', 'y']), cart('ana', ['z'])], base: [cart('marco', ['x', 'y'])] });
  assert.deepEqual(r.document, [cart('marco', ['x']), cart('ana', ['z'])], "Marco's cart as the app has it, Ana's added");
  assert.equal(r.counts.changedInApp, 1);
  const lesson = (u, l, status) => ({ user_id: u, course_id: 'c', lesson_id: l, status, started_at: 's', completed_at: null });
  const p = mergeDomain('progress', {
    live: { lessons: [lesson('u', 'l1', 'completed')], courses: [{ user_id: 'u', course_id: 'c', last_activity_at: 'x' }] },
    stage: { lessons: [lesson('u', 'l1', 'started'), lesson('u', 'l2', 'started')], courses: [{ user_id: 'u', course_id: 'c', last_activity_at: 'x' }] },
    base: { lessons: [lesson('u', 'l1', 'started')], courses: [] },
  });
  assert.deepEqual(p.document.lessons.map((x) => `${x.lesson_id}:${x.status}`), ['l1:completed', 'l2:started']);
  assert.deepEqual(totals(p), { live: 2, stage: 3, added: 1, unchanged: 1, conflicts: 1, changedInApp: 1, stageChanges: 0, removedInApp: 0, keptAppOnly: 0 });
  assert.equal(mergeDomain('users', { live: undefined, stage: [n('x')] }).mode, 'created');
  assert.equal(mergeDomain('something_new', { live: [1], stage: [2] }).document[0], 1);
  assert.throws(() => mergeDomain('users', { live: { not: 'a list' }, stage: [] }), /not a list; refusing to merge/);
  assert.deepEqual(Object.keys(RECORD_KEYS).sort(), ['carts', 'courses', 'enrolments', 'lessons', 'notifications', 'organizations', 'progress', 'quiz_results', 'subscriptions', 'support_requests', 'training_assignments', 'users']);
  const many = mergeDomain('users', { live: [], stage: Array.from({ length: 20 }, (_, i) => n(`u${i}`)) });
  assert.equal(many.samples.added?.length ?? MAX_SAMPLES, MAX_SAMPLES);
});

test('q4-three-signals: each stage merged over the one before adds only its own records and changes nothing the app holds (carts from the history on)', () => {
  const def = getScenario('q4-three-signals');
  const sim = simulate({ anchor: '2026-11-15', seed: 42, scenario: def });
  const state = (s) => JSON.parse(JSON.stringify(completeState(stageState(sim.data, stageOf(def, s), sim))));
  const [s0, s1, s2, s3] = [0, 1, 2, 3].map(state);
  assert.ok(s0.carts.some((c) => c.user_id === 'usr_5d81f0c3a9e6' && c.items.length === 2), "Marco's two courses wait in his cart from the history on");
  assert.deepEqual(s0, s1, 'the history and stage 1 have the same starting state');
  assert.deepEqual(s1, s2, 'stage 2 adds traffic only');
  for (const [live, next, k] of [[s0, s1, 1], [s1, s2, 2], [s2, s3, 3]]) {
    const results = mergeState({ live, stage: next, base: live });
    const written = results.filter((r) => r.written).map((r) => r.domain);
    assert.deepEqual(written, k === 3 ? ['notifications'] : [], `stage ${k} writes ${written}`);
    for (const r of results) assert.equal(totals(r).conflicts ?? 0, 0, `stage ${k} ${r.domain}`);
    if (k === 3) assert.equal(totals(results.find((r) => r.domain === 'notifications')).added, s3.notifications.length - s2.notifications.length);
  }
  assert.equal(mergesState(0), false);
  assert.equal(mergesState(null), false);
  assert.equal(mergesState(1), true);
});

/** An S3 layer in memory with ETags; `race` writes once on the app's behalf right after a read. */
function memoryS3(docs, { race = null } = {}) {
  const store = new Map(Object.entries(docs).map(([k, v]) => [`state/${k}.json`, { body: Buffer.from(JSON.stringify(v)), etag: '"1"' }]));
  const calls = [];
  let raced = 0;
  return {
    store, calls,
    getObject: async (bucket, key) => {
      calls.push(['get', key]);
      const hit = store.get(key);
      const out = hit ? { body: hit.body, etag: hit.etag } : null;
      if (race && key === race.key && raced < race.times) {
        raced += 1;
        const doc = JSON.parse(String(hit.body));
        store.set(key, { body: Buffer.from(JSON.stringify([...doc, race.record(raced)])), etag: `"app-${raced}"` });
      }
      return out;
    },
    put: async (bucket, key, body, type, { ifMatch, ifNoneMatch } = {}) => {
      calls.push(['put', key, ifMatch ?? ifNoneMatch]);
      const hit = store.get(key);
      if ((ifMatch && hit?.etag !== ifMatch) || (ifNoneMatch === '*' && hit)) throw Object.assign(new Error('precondition'), { $metadata: { httpStatusCode: 412 } });
      store.set(key, { body: Buffer.from(body), etag: `"w${calls.length}"` });
    },
  };
}
const targets = { stateBucket: 'state-bucket' };

test('uploadState: reads every document first, writes only what the stage adds to, If-Match on the ETag read; a dry run writes nothing', async () => {
  const s3 = memoryS3({ notifications: [n('a'), n('agent', { applied_by_agent: true })], users: [n('u')] });
  const stage = { notifications: [n('a'), n('b')], users: [n('u')], carts: [] };
  const results = await uploadState({ targets, stage, base: { notifications: [n('a')], users: [n('u')], carts: [] }, ...s3 });
  const firstPut = s3.calls.findIndex(([k]) => k === 'put');
  assert.equal(s3.calls.slice(0, firstPut).filter(([k]) => k === 'get').length, 3, 'all three documents read before the first write');
  assert.deepEqual(s3.calls.filter(([k]) => k === 'put'), [['put', 'state/carts.json', '*'], ['put', 'state/notifications.json', '"1"']]);
  assert.deepEqual(JSON.parse(String(s3.store.get('state/notifications.json').body)).map((x) => x.id), ['a', 'agent', 'b']);
  assert.deepEqual(results.map((r) => [r.domain, r.written]), [['carts', true], ['notifications', true], ['users', false]]);
  const dry = memoryS3({ notifications: [n('a')] });
  const r = await uploadState({ targets, stage: { notifications: [n('a'), n('b')] }, base: null, ...dry, write: false });
  assert.deepEqual([r[0].wouldWrite, r[0].written], [true, false]);
  assert.ok(!dry.calls.some(([k]) => k === 'put'));
});

test('uploadState: the app writing in between is merged again (its record kept), at most MAX_STATE_WRITE_ATTEMPTS times, then a named failure', async () => {
  const record = (i) => n(`app-${i}`, { applied_by_agent: true });
  const once = memoryS3({ notifications: [n('a')] }, { race: { key: 'state/notifications.json', times: 1, record } });
  await uploadState({ targets, stage: { notifications: [n('a'), n('b')] }, base: { notifications: [n('a')] }, ...once });
  assert.deepEqual(JSON.parse(String(once.store.get('state/notifications.json').body)).map((x) => x.id), ['a', 'app-1', 'b'], "the app's record written meanwhile is kept");
  const always = memoryS3({ notifications: [n('a')] }, { race: { key: 'state/notifications.json', times: 99, record } });
  await assert.rejects(uploadState({ targets, stage: { notifications: [n('a'), n('b')] }, base: { notifications: [n('a')] }, ...always }), /kept changing it while it was merged/);
  assert.equal(always.calls.filter(([k]) => k === 'put').length, MAX_STATE_WRITE_ATTEMPTS);
  const broken = memoryS3({});
  broken.store.set('state/users.json', { body: Buffer.from('{not json'), etag: '"1"' });
  await assert.rejects(uploadState({ targets, stage: { users: [] }, ...broken }), /not JSON; refusing to merge into it \(nothing was written\)/);
});

test('targets: production and staging by id or stack name; a missing stack says so; the loaded record is kept per target', async () => {
  assert.equal(targetOf('staging').stack, 'LearnLoopStaging');
  assert.equal(targetOf('LearnLoopStaging').id, 'staging');
  assert.equal(targetOf().stack, 'LearnLoopProd');
  assert.throws(() => targetOf('LearnLoopQa'), /unknown target/);
  const client = { send: async () => { throw Object.assign(new Error('Stack with id LearnLoopStaging does not exist'), { name: 'ValidationError' }); } };
  await assert.rejects(readStackOutputs('LearnLoopStaging', { region: 'us-east-1', client }), (e) => e instanceof StackNotFoundError && isStackMissing(e) && /'LearnLoopStaging' was not found in us-east-1: it is not deployed \(yet\)/.test(e.message));
  const ok = { send: async () => ({ Stacks: [{ Outputs: [{ OutputKey: 'StateBucketName', OutputValue: 'b' }] }] }) };
  assert.deepEqual(await readStackOutputs('LearnLoopProd', { client: ok }), { StateBucketName: 'b' });
  // a loaded.json from before targets is Production's record
  assert.deepEqual(loadedByTarget({ scenario: 'q4-three-signals', stage: 2 }), { production: { scenario: 'q4-three-signals', stage: 2 } });
  assert.deepEqual(loadedByTarget({ production: { stage: 1 }, staging: { stage: 0 }, junk: 1 }), { production: { stage: 1 }, staging: { stage: 0 } });
  assert.deepEqual(loadedByTarget(null), {});
});
