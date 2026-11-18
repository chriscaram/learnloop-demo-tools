// The simulator server, against fake AWS and git layers: confirmation tokens, one
// action at a time, dry-run writing nothing, bucket names only from the stack outputs,
// publish refusing a dirty LearnLoop tree, and the whole real chain with fakes.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSimulator } from '../src/simulator/server.js';
import { CO_AUTHOR } from '../src/simulator/actions.js';

const OUTPUTS = {
  StateBucketName: 'stack-state', AppLogsBucketName: 'stack-app-logs', AccessLogsBucketName: 'stack-access-logs',
  CloudFrontLogPrefix: 'cloudfront/', DistributionId: 'E1STACKDIST', DistributionDomainName: 'd1stack.cloudfront.net',
  LogPseudonymSaltSecretName: 'learnloop/prod/log-pseudonym-salt',
};
const WRITES = ['put', 'deleteMany', 'add', 'commit', 'push'];

// The S3 layer keeps an ETag per object, so a merge's conditional write can be checked.
// `stacks`: the stacks that exist (LearnLoopStaging is absent unless a test adds it).
function fakeAws({ stacks = { LearnLoopProd: OUTPUTS } } = {}) {
  const calls = [];
  const etags = new Map();
  let version = 0;
  const objects = new Map([
    ['stack-access-logs|cloudfront/E1STACKDIST.2026-09-01-00.AAAAAAAA.gz', Buffer.from('')],
    ['stack-app-logs|app-logs/service=learning/dt=2026-09-01/learning-2026-09-01-00.log', Buffer.from('{"kind":"event","event":"user_signed_in"}\n')],
  ]);
  return {
    calls, objects, writes: true,
    stacks, etags,
    stackOutputs: async (stackName) => {
      calls.push(['stackOutputs', stackName]);
      if (!stacks[stackName]) throw new Error(`Stack with id ${stackName} does not exist`);
      return stacks[stackName];
    },
    secret: async (id) => { calls.push(['secret', id]); return 'test-salt'; },
    list: async (bucket, prefix) => {
      calls.push(['list', bucket, prefix]);
      return { keys: [...objects.keys()].filter((k) => k.startsWith(`${bucket}|${prefix}`)).map((k) => ({ key: k.split('|')[1], size: 1 })), truncated: false };
    },
    get: async (bucket, key) => { calls.push(['get', bucket, key]); return objects.get(`${bucket}|${key}`) ?? Buffer.from(''); },
    getObject: async (bucket, key) => {
      calls.push(['getObject', bucket, key]);
      const k = `${bucket}|${key}`;
      return objects.has(k) ? { body: Buffer.from(objects.get(k)), etag: etags.get(k) ?? '"0"' } : null;
    },
    put: async (bucket, key, body, contentType, { ifMatch, ifNoneMatch } = {}) => {
      calls.push(['put', bucket, key, { ifMatch, ifNoneMatch }]);
      const k = `${bucket}|${key}`;
      if (ifMatch !== undefined && (etags.get(k) ?? '"0"') !== ifMatch) throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
      if (ifNoneMatch === '*' && objects.has(k)) throw Object.assign(new Error('precondition'), { name: 'PreconditionFailed', $metadata: { httpStatusCode: 412 } });
      objects.set(k, body);
      version += 1;
      etags.set(k, `"${version}"`);
    },
    deleteMany: async (bucket, keys) => { calls.push(['deleteMany', bucket, keys.length]); for (const k of keys) objects.delete(`${bucket}|${k}`); return keys.length; },
  };
}
function fakeGit(repo, { status = [], branch = 'main', staged = null } = {}) {
  const calls = [];
  return {
    calls, repo, writes: true, setStatus: (s) => { status = s; }, setStaged: (s) => { staged = s; },
    branch: async () => { calls.push(['branch']); return branch; },
    status: async () => { calls.push(['status']); return status; },
    add: async (paths) => { calls.push(['add', paths]); },
    stagedChanged: async () => { calls.push(['stagedChanged']); return staged ?? status.map((l) => l.slice(3)); },
    commit: async (message) => { calls.push(['commit', message]); },
    push: async () => { calls.push(['push']); },
    head: async () => 'abc1234',
  };
}

let root;
let server;
let base;
let aws;
let git;
let paths;
let repoSeedHashBefore;

async function hashDir(dir) {
  const h = createHash('sha256');
  for (const f of (await readdir(dir)).sort()) h.update(f).update(await readFile(path.join(dir, f)));
  return h.digest('hex');
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'll-sim-'));
  const repo = path.join(root, 'LearnLoop');
  await mkdir(path.join(repo, 'data/seed'), { recursive: true });
  for (const f of ['users.json', 'courses.json']) await cp(new URL(`../package.json`, import.meta.url), path.join(repo, 'data/seed', f));
  repoSeedHashBefore = await hashDir(path.join(repo, 'data/seed'));
  paths = { stateDir: path.join(root, 'state'), dataDir: path.join(repo, 'data/seed'), outDir: path.join(root, 'out') };
  aws = fakeAws();
  git = fakeGit(repo);
  let port = 0;
  const sim = createSimulator({ aws, git, paths, port: () => port });
  server = createServer(sim.handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port;
  base = `http://127.0.0.1:${port}`;
});
after(async () => {
  server.close();
  await rm(root, { recursive: true, force: true });
});

const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const token = async (action) => (await (await post('/api/confirm', { action })).json()).token;
async function events(runId) {
  const text = await (await fetch(`${base}/api/runs/${runId}/events`)).text();
  return text.split('\n\n').filter(Boolean).map((chunk) => JSON.parse(chunk.replace(/^data: /, '')));
}
const writesIn = (calls) => calls.filter(([name]) => WRITES.includes(name));

test('the page and the scenario cards are served; a card carries no parameters', async () => {
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Simulated activity — not real customer data\./);
  const script = await (await fetch(`${base}/app.js`)).text();
  for (const text of [html, script]) assert.doesNotMatch(text, /prepared|mock|fake/i, 'the page never says prepared, mock or fake');
  assert.match(script, /Load the history — before onboarding/);
  assert.match(script, /Then onboard LearnLoop in the Governance Agent the same day/);
  assert.match(html, /Load into/);
  const { scenarios, confirmations } = await (await fetch(`${base}/api/scenarios`)).json();
  assert.ok(scenarios.length >= 4);
  for (const s of scenarios) assert.equal(s.parameters, undefined);
  assert.match(confirmations.publish, /deploy/);
  const fp = await (await fetch(`${base}/api/fingerprint?scenario=steady-state&anchor=2026-11-15`)).json();
  const reveal = await (await fetch(`${base}/api/scenarios/steady-state/reveal?anchor=2026-11-15`)).json();
  assert.equal(createHash('sha256').update(reveal.canonical).digest('hex'), fp.fingerprint);
  assert.equal(reveal.fingerprint, fp.fingerprint);
  assert.ok(reveal.definition.expected_finding.length > 20, 'the expected finding appears only when the envelope is opened');
});

test('a scenario card shows no expected finding; every scenario has a business review to download under a neutral name', async () => {
  const { scenarios } = await (await fetch(`${base}/api/scenarios`)).json();
  for (const s of scenarios) {
    assert.deepEqual(Object.keys(s).filter((k) => !['cases', 'stages', 'firstStage'].includes(k)).sort(), ['description', 'id', 'title'], s.id);
    if (s.cases) assert.ok(s.cases.every((c) => c.title && c.what_changes && c.ai_agent), s.id);
    const res = await fetch(`${base}/api/scenarios/${s.id}/business-review`);
    assert.equal(res.status, 200, s.id);
    assert.match(res.headers.get('content-type'), /^text\/markdown/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="learnloop-q4-2026-business-review.md"');
    const text = await res.text();
    assert.match(text, /^# LearnLoop: Q4 2026 Business Review/);
    assert.ok(!text.includes(s.id), `${s.id}: the review never names the scenario`);
    assert.ok(!/scenario|simulat|generat/i.test(text), `${s.id}: written as the business would`);
  }
  const lapsed = await (await fetch(`${base}/api/scenarios/lapsed-learners/business-review`)).text();
  assert.equal(lapsed, await readFile(new URL('../../LearnLoop/docs/business/q4-2026-business-review.md', import.meta.url), 'utf8').catch(() => lapsed), 'lapsed-learners is the review in LearnLoop');
  assert.match(await (await fetch(`${base}/api/scenarios/abandoned-carts/business-review`)).text(), /Complete the purchases learners start/);
  assert.equal((await fetch(`${base}/api/scenarios/nope/business-review`)).status, 400);
});

test('refuses any other Host header and cross-site posts', async () => {
  const { request } = await import('node:http');
  const status = await new Promise((resolve) => {
    const req = request(`${base}/api/scenarios`, { headers: { host: 'attacker.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.end();
  });
  assert.equal(status, 421);
  const res = await fetch(`${base}/api/confirm`, { method: 'POST', headers: { origin: 'http://attacker.example' }, body: '{"action":"clear"}' });
  assert.equal(res.status, 403);
});

test('destructive actions refuse to start without a confirmation token, a wrong one, or a reused one', async () => {
  for (const action of ['clear', 'upload', 'publish', 'load']) {
    const res = await post(`/api/actions/${action}`, { scenario: 'steady-state', anchor: '2026-11-15' });
    assert.equal(res.status, 403, action);
    assert.match((await res.json()).error, /confirmation/);
  }
  const forPublish = await token('publish');
  assert.equal((await post('/api/actions/clear', { scenario: 'steady-state', token: forPublish })).status, 403, 'a token is bound to its action');
  const t = await token('clear');
  const first = await post('/api/actions/clear', { scenario: 'steady-state', anchor: '2026-11-15', dryRun: true, token: t });
  assert.equal(first.status, 202);
  await events((await first.json()).runId);
  assert.equal((await post('/api/actions/clear', { scenario: 'steady-state', dryRun: true, token: t })).status, 403, 'a token is single-use');
  assert.equal(writesIn(aws.calls).length, 0);
});

test('a dry-run load streams every step, refuses a second action meanwhile, and writes nothing to AWS, git or LearnLoop', async () => {
  aws.calls.length = 0;
  git.calls.length = 0;
  const started = await post('/api/actions/load', { scenario: 'outage-drop', anchor: '2026-11-15', dryRun: true, pace: 'fast', token: await token('load') });
  assert.equal(started.status, 202);
  const { runId } = await started.json();
  const busy = await post('/api/actions/verify', { scenario: 'outage-drop', dryRun: true });
  assert.equal(busy.status, 409);
  assert.match((await busy.json()).error, /still running/);
  const list = await events(runId);
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  assert.deepEqual(list.filter((e) => e.type === 'step' && e.status === 'done').map((e) => e.step), ['clear', 'generate', 'upload', 'verify', 'publish']);
  assert.equal(list.filter((e) => e.type === 'day').length, 60);
  assert.equal(writesIn(aws.calls).length, 0, JSON.stringify(writesIn(aws.calls)));
  assert.equal(writesIn(git.calls).length, 0, JSON.stringify(writesIn(git.calls)));
  assert.equal(await hashDir(paths.dataDir), repoSeedHashBefore, "LearnLoop's data/seed is untouched");
  await assert.rejects(readFile(path.join(paths.stateDir, 'loaded.json')), 'a dry run loads nothing');
  assert.ok((await readdir(path.join(paths.stateDir, 'dry-run', 'out', 'cloudfront'))).length === 1440);
  const plan = list.find((e) => e.type === 'upload-plan');
  assert.match(plan.destinations.cloudfront, /^s3:\/\/stack-access-logs\/cloudfront\/$/);
  for (const e of list) assert.ok(!JSON.stringify(e).includes('test-salt'), 'the salt never reaches the page');
});

test('the real chain (with fakes): bucket names only from the stack outputs, never from the request', async () => {
  aws.calls.length = 0;
  const hostile = { bucket: 'evil-bucket', stateBucket: 'evil', appLogsBucket: 'evil', accessLogsBucket: 'evil', prefix: '', cloudfrontPrefix: '' };
  const clear = await post('/api/actions/clear', { scenario: 'steady-state', anchor: '2026-11-15', ...hostile, token: await token('clear') });
  assert.equal(clear.status, 202);
  const clearEvents = await events((await clear.json()).runId);
  assert.equal(clearEvents.at(-1).type, 'done');
  const gen = await post('/api/actions/generate', { scenario: 'steady-state', anchor: '2026-11-15', pace: 'fast', ...hostile });
  assert.equal((await events((await gen.json()).runId)).at(-1).type, 'done');
  const up = await post('/api/actions/upload', { scenario: 'steady-state', anchor: '2026-11-15', ...hostile, token: await token('upload') });
  const upEvents = await events((await up.json()).runId);
  assert.equal(upEvents.at(-1).type, 'done', JSON.stringify(upEvents.filter((e) => e.type === 'error')));
  const ver = await post('/api/actions/verify', { scenario: 'steady-state', anchor: '2026-11-15', ...hostile });
  const verEvents = await events((await ver.json()).runId);
  assert.equal(verEvents.at(-1).type, 'done');

  const touched = aws.calls.filter(([name]) => ['list', 'get', 'put', 'deleteMany'].includes(name));
  const buckets = new Set(touched.map(([, bucket]) => bucket));
  assert.deepEqual([...buckets].sort(), ['stack-access-logs', 'stack-app-logs', 'stack-state']);
  assert.ok(!JSON.stringify(aws.calls).includes('evil'));
  const deleted = aws.calls.filter(([name]) => name === 'deleteMany');
  assert.deepEqual(deleted.map(([, b]) => b).sort(), ['stack-access-logs', 'stack-app-logs'], 'clear touches the two log buckets only');
  const puts = aws.calls.filter(([name]) => name === 'put');
  assert.ok(puts.filter(([, b, k]) => b === 'stack-access-logs').every(([, , k]) => /^cloudfront\/E1STACKDIST\.\d{4}-\d{2}-\d{2}-\d{2}\.[A-Z0-9]+\.gz$/.test(k)));
  assert.ok(puts.filter(([, b]) => b === 'stack-app-logs').every(([, , k]) => k.startsWith('app-logs/')));
  assert.ok(puts.filter(([, b]) => b === 'stack-state').every(([, , k]) => /^state\/[a-z_]+\.json$/.test(k)));
  assert.equal(puts.filter(([, b]) => b === 'stack-access-logs').length, 1440);
  const rows = verEvents.filter((e) => e.type === 'verify');
  for (const r of rows) assert.equal(r.objects, r.expected, `${r.target} read back`);
  const loaded = JSON.parse(await readFile(path.join(paths.stateDir, 'loaded.json'), 'utf8')).production;
  assert.equal(loaded.scenario, 'steady-state');
  assert.equal(loaded.stack, 'LearnLoopProd');
  assert.deepEqual(loaded.state, { mode: 'replaced' }, 'a single load replaces the state');
  assert.equal(loaded.by, 'upload');
  // the page's "currently loaded" read
  const state = await (await fetch(`${base}/api/state`)).json();
  assert.equal(state.loaded.fingerprint, loaded.fingerprint);
  const replay = await (await fetch(`${base}/api/replay`)).json();
  assert.equal(replay.replay.daily.length, 60);
});

test('publish: refuses off main and with changes outside data/seed/, skips when unchanged, commits with the co-author line', async () => {
  const run = async () => {
    const res = await post('/api/actions/publish', { scenario: 'steady-state', anchor: '2026-11-15', token: await token('publish') });
    return (await events((await res.json()).runId)).at(-1);
  };
  git.setStatus([' M web/src/App.jsx', ' M data/seed/users.json']);
  let last = await run();
  assert.equal(last.type, 'error');
  assert.match(last.message, /changes outside data\/seed\/ \(web\/src\/App\.jsx\)/);
  assert.equal(writesIn(git.calls).length, 0);

  git.setStatus([]);
  git.setStaged([]);
  last = await run();
  assert.equal(last.type, 'done');
  assert.equal(last.result.skipped, true);
  assert.ok(!git.calls.some(([n]) => n === 'commit' || n === 'push'));

  git.setStatus([' M data/seed/users.json', '?? data/seed/new.json']);
  git.setStaged(['data/seed/users.json', 'data/seed/new.json']);
  last = await run();
  assert.equal(last.type, 'done', last.message);
  const commit = git.calls.find(([n]) => n === 'commit');
  assert.match(commit[1], /^Seed: load sealed scenario [0-9a-f]{12} anchored on 2026-11-15/);
  assert.ok(commit[1].trimEnd().endsWith(CO_AUTHOR));
  assert.ok(!commit[1].includes('steady-state'), 'the commit message does not name the sealed scenario');
  assert.deepEqual(git.calls.find(([n]) => n === 'add')[1], ['data/seed']);
  assert.ok(git.calls.some(([n]) => n === 'push'));
  const loaded = JSON.parse(await readFile(path.join(paths.stateDir, 'loaded.json'), 'utf8')).production;
  assert.equal(loaded.published.commit, 'abc1234');
});

test('errors reach the page verbatim, without a stack trace', async () => {
  const bad = await post('/api/actions/generate', { scenario: 'no-such-scenario' });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, "unknown scenario 'no-such-scenario'");
  const badDate = await post('/api/actions/generate', { scenario: 'steady-state', anchor: '2026-02-30' });
  assert.equal(badDate.status, 400);
  // a publish off main fails inside the run: the message is streamed, nothing else
  const offMain = fakeGit(git.repo, { branch: 'feature' });
  let port = 0;
  const sim = createSimulator({ aws, git: offMain, paths, port: () => port });
  const s2 = createServer(sim.handler);
  await new Promise((resolve) => s2.listen(0, '127.0.0.1', resolve));
  port = s2.address().port;
  const t = await (await fetch(`http://127.0.0.1:${port}/api/confirm`, { method: 'POST', body: '{"action":"publish"}' })).json();
  const res = await fetch(`http://127.0.0.1:${port}/api/actions/publish`, { method: 'POST', body: JSON.stringify({ scenario: 'steady-state', token: t.token }) });
  const text = await (await fetch(`http://127.0.0.1:${port}/api/runs/${(await res.json()).runId}/events`)).text();
  s2.close();
  const last = JSON.parse(text.trim().split('\n\n').at(-1).replace(/^data: /, ''));
  assert.equal(last.message, "refusing to publish: the LearnLoop repository is on branch 'feature', not main");
  assert.ok(!text.includes('    at '), 'no stack trace');
});

// ------------------------------------------------------------------ the staged reveal
test('a staged scenario: the card says how many stages and that it starts with the history, each stage has its own fingerprint, the reveal lists them all', async () => {
  const { scenarios, stagedLoad, targets, defaultTarget } = await (await fetch(`${base}/api/scenarios`)).json();
  const q4 = scenarios.find((s) => s.id === 'q4-three-signals');
  assert.equal(q4.stages, 3);
  assert.equal(q4.firstStage, 0, 'the history is stage 0');
  assert.ok(!JSON.stringify(q4).includes('withheld'), 'the card never says what a stage withholds');
  assert.ok(stagedLoad.startOver.includes('onboard it again') && /history \(stage 0\)/.test(stagedLoad.startOver), 'starting over loads the history and says the application must be onboarded again');
  assert.match(stagedLoad.noPublish, /Nothing is committed or pushed/);
  assert.match(stagedLoad.history, /replaces the live state/);
  assert.deepEqual(targets.map((t) => [t.id, t.label, t.stack, t.publish]), [['production', 'Production', 'LearnLoopProd', true], ['staging', 'Staging', 'LearnLoopStaging', false]]);
  assert.equal(defaultTarget, 'production');
  const fp = async (q) => (await (await fetch(`${base}/api/fingerprint?scenario=q4-three-signals&anchor=2026-11-15${q}`)).json());
  const prints = [await fp('&stage=0'), await fp('&stage=1'), await fp('&stage=2'), await fp('&stage=3')];
  assert.deepEqual(prints.map((p) => p.stage), [0, 1, 2, 3]);
  assert.equal(new Set(prints.map((p) => p.fingerprint)).size, 4);
  assert.equal((await fetch(`${base}/api/fingerprint?scenario=q4-three-signals&anchor=2026-11-15&stage=4`)).status, 400);
  assert.equal((await fetch(`${base}/api/fingerprint?scenario=steady-state&anchor=2026-11-15&stage=1`)).status, 400);
  const reveal = await (await fetch(`${base}/api/scenarios/q4-three-signals/reveal?anchor=2026-11-15`)).json();
  assert.deepEqual(reveal.stages.map((s) => s.fingerprint), prints.map((p) => p.fingerprint));
  for (const s of reveal.stages) assert.equal(createHash('sha256').update(s.canonical).digest('hex'), s.fingerprint, `stage ${s.stage}: the sealed text gives the fingerprint`);
  assert.match(reveal.stages[0].lines.join(' '), /before the application is onboarded/);
  assert.equal((await (await fetch(`${base}/api/scenarios/steady-state/reveal?anchor=2026-11-15`)).json()).stages, undefined);
});

const STATE = (domain) => `stack-state|state/${domain}.json`;
const liveDoc = (domain) => JSON.parse(String(aws.objects.get(STATE(domain))));
const setLive = (domain, value) => { aws.objects.set(STATE(domain), Buffer.from(JSON.stringify(value))); aws.etags.set(STATE(domain), `"app-${Date.now()}-${domain}"`); };
const AGENT_NOTE = { id: 'ntf_agent_written', user_id: 'usr_a7e3c1d90b42', type: 'lesson_reminder', title: 'Pick up where you left off', body: 'Your next lesson is waiting.', link: '/courses', created_at: '2026-11-15T12:00:00.000Z', read_at: null, applied_by_agent: true };
const MARCO = 'usr_5d81f0c3a9e6';

test('staged loads: the history first and it replaces the state; later stages merge into the live state, keeping what the app and its AI agents wrote; out of order refused before anything is touched; only the last stage publishes by default; start over', async () => {
  const load = async (body) => {
    const res = await post('/api/actions/load', { scenario: 'q4-three-signals', anchor: '2026-11-15', pace: 'fast', token: await token('load'), ...body });
    assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
    return events((await res.json()).runId);
  };
  const loaded = async () => JSON.parse(await readFile(path.join(paths.stateDir, 'loaded.json'), 'utf8')).production;
  const statePuts = () => aws.calls.filter(([n, b]) => n === 'put' && b === 'stack-state');
  // the request itself
  assert.equal((await post('/api/actions/load', { scenario: 'q4-three-signals', stage: 7, token: await token('load') })).status, 400);
  assert.equal((await post('/api/actions/load', { scenario: 'q4-three-signals', stage: 1, publish: 'yes', token: await token('load') })).status, 400);
  assert.equal((await post('/api/actions/load', { scenario: 'steady-state', publish: false, token: await token('load') })).status, 400, 'publish is a choice of a staged load only');

  aws.calls.length = 0;
  git.calls.length = 0;
  let list = await load({ stage: 1 });
  assert.equal(list.at(-1).type, 'error');
  assert.match(list.at(-1).message, /refusing to load: stage 1 adds to the history \(stage 0\), and no stage of this scenario is loaded on Production: load the history \(stage 0\) first/);
  assert.equal(writesIn(aws.calls).length, 0, 'refused before Clear');

  // stage 0: the history, and the starting state replaces whatever the bucket held
  git.setStatus([]);
  git.setStaged([]);
  list = await load({ stage: 0 });
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  assert.deepEqual(list.filter((e) => e.type === 'step' && e.status === 'skipped').map((e) => e.step), ['publish']);
  assert.ok(list.some((e) => e.type === 'note' && /Generating the history for Production/.test(e.message)));
  assert.equal(list.find((e) => e.type === 'upload-plan').stateMode, 'replace');
  assert.ok(!list.some((e) => e.type === 'merge'));
  assert.equal(statePuts().length, 12, 'the history writes the whole starting state');
  assert.ok(statePuts().every(([, , , opts]) => !opts?.ifMatch), 'a replace is a plain write');
  assert.equal(aws.calls.filter(([n, b]) => n === 'put' && b === 'stack-access-logs').length, 1440, 'one CloudFront object per hour (the recent ones without the case routes)');
  assert.ok(!git.calls.some(([n]) => ['add', 'commit', 'push'].includes(n)), 'the history does not publish');
  let rec = await loaded();
  assert.deepEqual([rec.scenario, rec.stage, rec.stages, rec.anchor, rec.state.mode], ['q4-three-signals', 0, 3, '2026-11-15', 'replaced']);
  const fp0 = (await (await fetch(`${base}/api/fingerprint?scenario=q4-three-signals&anchor=2026-11-15&stage=0`)).json()).fingerprint;
  assert.equal(rec.fingerprint, fp0, 'what is loaded is sealed by the stage-0 fingerprint');
  assert.ok(liveDoc('carts').some((c) => c.user_id === MARCO && c.items.length === 2), "Marco's cart is in the starting state from the history on");

  // between the stages the app runs: an AI agent writes a notification, a learner reads one,
  // and the presenter checks Marco's cart out
  const notes = liveDoc('notifications');
  const readOne = { ...notes[0], read_at: '2026-11-15T13:00:00.000Z' };
  setLive('notifications', [readOne, ...notes.slice(1), AGENT_NOTE]);
  setLive('carts', liveDoc('carts').filter((c) => c.user_id !== MARCO));

  aws.calls.length = 0;
  list = await load({ stage: 1 });
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  assert.equal(list.find((e) => e.type === 'upload-plan').stateMode, 'merge');
  const merges = new Map(list.filter((e) => e.type === 'merge').map((e) => [e.domain, e]));
  assert.equal(merges.size, 12);
  assert.equal(merges.get('notifications').totals.keptAppOnly, 1, 'the AI agent\'s notification is counted as kept');
  assert.equal(merges.get('notifications').totals.changedInApp, 1, 'the read mark is the app\'s');
  assert.equal(merges.get('carts').totals.removedInApp, 1, "Marco's checked-out cart stays checked out");
  assert.ok([...merges.values()].every((e) => !e.totals.stageChanges), 'stage 1 changes no record the app holds');
  assert.equal(statePuts().length, 0, 'stage 1 adds no record, so no state document is written');
  assert.ok(liveDoc('notifications').some((n) => n.id === AGENT_NOTE.id && n.applied_by_agent === true));
  assert.equal(liveDoc('notifications')[0].read_at, readOne.read_at);
  assert.ok(!liveDoc('carts').some((c) => c.user_id === MARCO));
  rec = await loaded();
  assert.deepEqual([rec.stage, rec.state.mode, rec.state.base, rec.state.keptAppOnly], [1, 'merged', 0, 1]);

  list = await load({ stage: 3 });
  assert.match(list.at(-1).message, /stage 1 is loaded on Production: load stage 2 before stage 3/);
  list = await load({ stage: 2, anchor: '2026-11-16' });
  assert.match(list.at(-1).message, /keeps the start date of the stages already loaded on Production \(2026-11-15\)/);

  // stage 2, with publishing asked for on this load
  git.calls.length = 0;
  list = await load({ stage: 2, publish: true });
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  assert.ok(list.some((e) => e.type === 'step' && e.step === 'publish' && e.status === 'done'));
  assert.ok(git.calls.some(([n]) => n === 'add'), 'publish ran because it was asked for');
  assert.equal((await loaded()).stage, 2);

  // stage 3 adds the reminders of the surge to the live notifications, over the version read,
  // and publishes the stage's GENERATED state (not the merged live one) by default
  aws.calls.length = 0;
  git.calls.length = 0;
  git.setStatus([' M data/seed/notifications.json']);
  git.setStaged(['data/seed/notifications.json']);
  list = await load({ stage: 3 });
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  const n3 = list.find((e) => e.type === 'merge' && e.domain === 'notifications');
  assert.ok(n3.totals.added >= 120 && n3.written, `stage 3 adds the surge's reminders: ${n3.sentence}`);
  assert.deepEqual(statePuts().map(([, , k]) => k), ['state/notifications.json'], 'only the document the stage adds to is written');
  assert.ok(statePuts()[0][3].ifMatch, 'written over the version that was read (If-Match)');
  const live = liveDoc('notifications');
  assert.ok(live.some((n) => n.id === AGENT_NOTE.id), "the AI agent's notification survives stage 3");
  assert.equal(live.length, notes.length + 1 + n3.totals.added);
  const published = JSON.parse(await readFile(path.join(paths.dataDir, 'notifications.json'), 'utf8'));
  assert.ok(!published.some((n) => n.id === AGENT_NOTE.id) && published.length === notes.length + n3.totals.added, 'data/seed holds the stage\'s generated state');
  const commit = git.calls.find(([n]) => n === 'commit');
  assert.ok(commit, 'the last stage publishes');
  const three = await loaded();
  assert.equal(three.stage, 3);
  assert.match(commit[1], new RegExp(`^Seed: load sealed scenario ${three.fingerprint.slice(0, 12)} anchored on 2026-11-15`));
  assert.ok(!commit[1].includes('q4-three-signals') && !/stage/i.test(commit[1]), 'the commit message names neither the scenario nor the stage');
  assert.ok(commit[1].trimEnd().endsWith(CO_AUTHOR));
  assert.equal(three.published.commit, 'abc1234');

  list = await load({ stage: 2 });
  assert.match(list.at(-1).message, /stage 3 is already loaded on Production.*start over with the history \(stage 0\) and onboard the application in the Governance Agent again/);

  // start over: the history again, which replaces the live state (the agent's notification too)
  git.calls.length = 0;
  git.setStatus([]);
  git.setStaged([]);
  list = await load({ stage: 0, publish: false });
  assert.equal(list.at(-1).type, 'done');
  assert.ok(!git.calls.some(([n]) => n === 'add'));
  assert.equal((await loaded()).stage, 0);
  assert.ok(!liveDoc('notifications').some((n) => n.id === AGENT_NOTE.id), 'start over replaces the state');
});

test('a dry-run stage shows what the merge would do and writes nothing', async () => {
  // production holds stage 0 (the test above ended with a start over)
  setLive('notifications', [...liveDoc('notifications'), AGENT_NOTE]);
  aws.calls.length = 0;
  const res = await post('/api/actions/load', { scenario: 'q4-three-signals', anchor: '2026-11-15', stage: 1, dryRun: true, pace: 'fast', token: await token('load') });
  const list = await events((await res.json()).runId);
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  const n = list.find((e) => e.type === 'merge' && e.domain === 'notifications');
  assert.equal(n.totals.keptAppOnly, 1);
  assert.equal(n.written, false);
  assert.ok(list.some((e) => e.type === 'note' && /^Dry run: the merge would add 0 record/.test(e.message)));
  assert.equal(writesIn(aws.calls).length, 0);
  assert.ok(aws.calls.some(([name, b]) => name === 'getObject' && b === 'stack-state'), 'the live state is read (a read-only call)');
});

test('targets: Staging has its own stack, salt, buckets and stage record; a missing stack is said plainly; publishing is Production only', async () => {
  const STAGING = {
    StateBucketName: 'staging-state', AppLogsBucketName: 'staging-app-logs', AccessLogsBucketName: 'staging-access-logs',
    CloudFrontLogPrefix: 'cloudfront/', DistributionId: 'E2STAGING', DistributionDomainName: 'd2staging.cloudfront.net',
    LogPseudonymSaltSecretName: 'learnloop/staging/log-pseudonym-salt',
  };
  const load = async (body) => {
    const res = await post('/api/actions/load', { scenario: 'q4-three-signals', anchor: '2026-11-15', pace: 'fast', target: 'staging', token: await token('load'), ...body });
    assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
    return events((await res.json()).runId);
  };
  assert.equal((await post('/api/actions/load', { scenario: 'q4-three-signals', stage: 0, target: 'qa', token: await token('load') })).status, 400);
  const pub = await post('/api/actions/load', { scenario: 'q4-three-signals', stage: 0, target: 'staging', publish: true, token: await token('load') });
  assert.equal(pub.status, 400);
  assert.match((await pub.json()).error, /Production only/);
  assert.equal((await post('/api/actions/publish', { scenario: 'q4-three-signals', target: 'staging', token: await token('publish') })).status, 400);

  aws.calls.length = 0;
  let list = await load({ stage: 0 });
  assert.equal(list.at(-1).type, 'error');
  assert.match(list.at(-1).message, /Staging: the LearnLoop stack LearnLoopStaging was not found\. It is not deployed \(yet\)/);
  assert.equal(writesIn(aws.calls).length, 0);

  aws.stacks.LearnLoopStaging = STAGING;
  list = await load({ stage: 1 });
  assert.match(list.at(-1).message, /no stage of this scenario is loaded on Staging: load the history \(stage 0\) first/, 'stages progress per target');
  const seedBefore = await hashDir(paths.dataDir);
  aws.calls.length = 0;
  git.calls.length = 0;
  list = await load({ stage: 0 });
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  assert.ok(aws.calls.some(([n, id]) => n === 'secret' && id === 'learnloop/staging/log-pseudonym-salt'), "the staging stack's salt");
  const buckets = new Set(aws.calls.filter(([n]) => ['list', 'put', 'deleteMany', 'getObject'].includes(n)).map(([, b]) => b));
  assert.deepEqual([...buckets].sort(), ['staging-access-logs', 'staging-app-logs', 'staging-state']);
  assert.ok(list.some((e) => e.type === 'note' && /offered for Production only/.test(e.message)));
  assert.equal(git.calls.length, 0, 'a staging load never touches LearnLoop\'s repository');
  assert.equal(await hashDir(paths.dataDir), seedBefore, "LearnLoop's data/seed is not written by a staging load");
  const all = JSON.parse(await readFile(path.join(paths.stateDir, 'loaded.json'), 'utf8'));
  assert.deepEqual([all.staging.stage, all.staging.stack, all.production.stack], [0, 'LearnLoopStaging', 'LearnLoopProd'], 'one record per target');
  const state = await (await fetch(`${base}/api/state?target=staging`)).json();
  assert.equal(state.loaded.stack, 'LearnLoopStaging');
  assert.equal((await (await fetch(`${base}/api/state`)).json()).loaded.stack, 'LearnLoopProd');
  assert.equal((await fetch(`${base}/api/state?target=qa`)).status, 400);
});
