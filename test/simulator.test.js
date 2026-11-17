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

function fakeAws() {
  const calls = [];
  const objects = new Map([
    ['stack-access-logs|cloudfront/E1STACKDIST.2026-09-01-00.AAAAAAAA.gz', Buffer.from('')],
    ['stack-app-logs|app-logs/service=learning/dt=2026-09-01/learning-2026-09-01-00.log', Buffer.from('{"kind":"event","event":"user_signed_in"}\n')],
  ]);
  return {
    calls, objects, writes: true,
    stackOutputs: async () => { calls.push(['stackOutputs']); return OUTPUTS; },
    secret: async (id) => { calls.push(['secret', id]); return 'test-salt'; },
    list: async (bucket, prefix) => {
      calls.push(['list', bucket, prefix]);
      return { keys: [...objects.keys()].filter((k) => k.startsWith(`${bucket}|${prefix}`)).map((k) => ({ key: k.split('|')[1], size: 1 })), truncated: false };
    },
    get: async (bucket, key) => { calls.push(['get', bucket, key]); return objects.get(`${bucket}|${key}`) ?? Buffer.from(''); },
    put: async (bucket, key, body) => { calls.push(['put', bucket, key]); objects.set(`${bucket}|${key}`, body); },
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
  assert.match(await page.text(), /Simulated activity — not real customer data\./);
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
    assert.deepEqual(Object.keys(s).filter((k) => k !== 'cases' && k !== 'stages').sort(), ['description', 'id', 'title'], s.id);
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
  const loaded = JSON.parse(await readFile(path.join(paths.stateDir, 'loaded.json'), 'utf8'));
  assert.equal(loaded.scenario, 'steady-state');
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
  const loaded = JSON.parse(await readFile(path.join(paths.stateDir, 'loaded.json'), 'utf8'));
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
test('a staged scenario: the card says how many stages, each stage has its own fingerprint, the reveal lists them all', async () => {
  const { scenarios, stagedLoad } = await (await fetch(`${base}/api/scenarios`)).json();
  const q4 = scenarios.find((s) => s.id === 'q4-three-signals');
  assert.equal(q4.stages, 3);
  assert.ok(!JSON.stringify(q4).includes('withheld'), 'the card never says what a stage withholds');
  assert.ok(stagedLoad.startOver.includes('onboard it again'), 'starting over says the application must be onboarded again');
  assert.match(stagedLoad.noPublish, /Nothing is committed or pushed/);
  const fp = async (q) => (await (await fetch(`${base}/api/fingerprint?scenario=q4-three-signals&anchor=2026-11-15${q}`)).json());
  const prints = [await fp('&stage=1'), await fp('&stage=2'), await fp('&stage=3')];
  assert.deepEqual(prints.map((p) => p.stage), [1, 2, 3]);
  assert.equal(new Set(prints.map((p) => p.fingerprint)).size, 3);
  assert.equal((await fetch(`${base}/api/fingerprint?scenario=q4-three-signals&anchor=2026-11-15&stage=4`)).status, 400);
  assert.equal((await fetch(`${base}/api/fingerprint?scenario=steady-state&anchor=2026-11-15&stage=1`)).status, 400);
  const reveal = await (await fetch(`${base}/api/scenarios/q4-three-signals/reveal?anchor=2026-11-15`)).json();
  assert.deepEqual(reveal.stages.map((s) => s.fingerprint), prints.map((p) => p.fingerprint));
  for (const s of reveal.stages) assert.equal(createHash('sha256').update(s.canonical).digest('hex'), s.fingerprint, `stage ${s.stage}: the sealed text gives the fingerprint`);
  assert.equal((await (await fetch(`${base}/api/scenarios/steady-state/reveal?anchor=2026-11-15`)).json()).stages, undefined);
});

test('staged loads: out of order is refused before anything is touched; only the last stage publishes by default; the choice is per load; start over', async () => {
  const load = async (body) => {
    const res = await post('/api/actions/load', { scenario: 'q4-three-signals', anchor: '2026-11-15', pace: 'fast', token: await token('load'), ...body });
    assert.equal(res.status, 202, JSON.stringify(await res.clone().json()));
    return events((await res.json()).runId);
  };
  const loaded = async () => JSON.parse(await readFile(path.join(paths.stateDir, 'loaded.json'), 'utf8'));
  // the request itself
  assert.equal((await post('/api/actions/load', { scenario: 'q4-three-signals', stage: 7, token: await token('load') })).status, 400);
  assert.equal((await post('/api/actions/load', { scenario: 'q4-three-signals', stage: 1, publish: 'yes', token: await token('load') })).status, 400);
  assert.equal((await post('/api/actions/load', { scenario: 'steady-state', publish: false, token: await token('load') })).status, 400, 'publish is a choice of a staged load only');

  aws.calls.length = 0;
  git.calls.length = 0;
  let list = await load({ stage: 2 });
  assert.equal(list.at(-1).type, 'error');
  assert.match(list.at(-1).message, /refusing to load: stage 2 adds to stage 1, and no stage of this scenario is loaded: load stage 1 first/);
  assert.equal(writesIn(aws.calls).length, 0, 'refused before Clear');

  git.setStatus([]);
  git.setStaged([]);
  list = await load({ stage: 1 });
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  assert.deepEqual(list.filter((e) => e.type === 'step' && e.status === 'skipped').map((e) => e.step), ['publish']);
  assert.ok(list.some((e) => e.type === 'note' && /stage 1 of 3 \(case 1\)/.test(e.message)));
  assert.ok(!git.calls.some(([n]) => ['add', 'commit', 'push'].includes(n)), 'stage 1 does not publish by default');
  const one = await loaded();
  assert.deepEqual([one.scenario, one.stage, one.stages, one.anchor], ['q4-three-signals', 1, 3, '2026-11-15']);
  const fp1 = (await (await fetch(`${base}/api/fingerprint?scenario=q4-three-signals&anchor=2026-11-15&stage=1`)).json()).fingerprint;
  assert.equal(one.fingerprint, fp1, 'what is loaded is sealed by the stage-1 fingerprint');
  assert.equal(aws.calls.filter(([n, b]) => n === 'put' && b === 'stack-state').length, 12, "Upload writes stage 1's starting state where LearnLoop reads it");

  list = await load({ stage: 3 });
  assert.match(list.at(-1).message, /stage 1 is loaded: load stage 2 before stage 3/);
  list = await load({ stage: 2, anchor: '2026-11-16' });
  assert.match(list.at(-1).message, /keeps the start date of the stages already loaded \(2026-11-15\)/);

  // stage 2, with publishing asked for on this load
  git.calls.length = 0;
  list = await load({ stage: 2, publish: true });
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  assert.ok(list.some((e) => e.type === 'step' && e.step === 'publish' && e.status === 'done'));
  assert.ok(git.calls.some(([n]) => n === 'add'), 'publish ran because it was asked for');
  assert.equal((await loaded()).stage, 2);

  // stage 3 publishes by default, by fingerprint only
  git.calls.length = 0;
  git.setStatus([' M data/seed/carts.json']);
  git.setStaged(['data/seed/carts.json']);
  list = await load({ stage: 3 });
  assert.equal(list.at(-1).type, 'done', JSON.stringify(list.filter((e) => e.type === 'error')));
  const commit = git.calls.find(([n]) => n === 'commit');
  assert.ok(commit, 'the last stage publishes');
  const three = await loaded();
  assert.equal(three.stage, 3);
  assert.match(commit[1], new RegExp(`^Seed: load sealed scenario ${three.fingerprint.slice(0, 12)} anchored on 2026-11-15`));
  assert.ok(!commit[1].includes('q4-three-signals') && !/stage/i.test(commit[1]), 'the commit message names neither the scenario nor the stage');
  assert.ok(commit[1].trimEnd().endsWith(CO_AUTHOR));
  assert.equal(three.published.commit, 'abc1234');

  list = await load({ stage: 2 });
  assert.match(list.at(-1).message, /stage 3 is already loaded.*start over with stage 1 and onboard the application in the Governance Agent again/);

  // start over: stage 1 again, without publishing
  git.calls.length = 0;
  git.setStatus([]);
  git.setStaged([]);
  list = await load({ stage: 1, publish: false });
  assert.equal(list.at(-1).type, 'done');
  assert.ok(!git.calls.some(([n]) => n === 'add'));
  assert.equal((await loaded()).stage, 1);
});
