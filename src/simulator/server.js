#!/usr/bin/env node
// npm run simulator [-- --port 8790]
//
// The LearnLoop Activity Simulator: a local page that generates the demo history,
// loads it into LearnLoop's AWS account and publishes the app's starting state, with
// progress streamed to the browser as Server-Sent Events. node:http only, no framework.
//
// Bound to 127.0.0.1 and nothing else, and every request must name 127.0.0.1 or
// localhost in its Host header (a page on another site cannot reach it through DNS
// rebinding). It runs with the operator's own AWS credentials and git setup.
//
//   GET  /api/scenarios                       the cards: id, title, description (no expected finding, no parameters)
//   GET  /api/scenarios/:id/business-review   business-docs/<id>.md, as a download with a neutral file name
//   GET  /api/fingerprint?scenario=&anchor=[&stage=]   SHA-256 of the sealed definition + seed + anchor [+ stage]
//   GET  /api/scenarios/:id/reveal?anchor=    the whole definition, in plain words too (and every stage's fingerprint)
//   GET  /api/state?target=[&readBack=1]      what is loaded now on that target (its record in state/loaded.json) [+ bucket read-back]
//   GET  /api/replay?target=                  the last real generation's saved statistics
//   POST /api/confirm      {action}           a single-use confirmation token (5 minutes)
//   POST /api/actions/:name {target, scenario, stage, anchor, dryRun, pace, publish, token}   start an action (202) or 409/403
//
// `target` is production (the LearnLoopProd stack, the default) or staging (LearnLoopStaging).
//   GET  /api/runs/:id/events                 the run's progress, as SSE (replayed from the start)
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DATA_DIR, LEARNLOOP_REPO, OUT_DIR, TOOLS_ROOT } from '../files.js';
import { todayUtc } from '../generate.js';
import { loadScenarios, plainParameters, plainStages, publicCard, scenarioFingerprint, canonicalJson, sealedInput, stageCount, stageOf } from '../scenarios.js';
import { ACTION_NAMES, APP_LOGS_PREFIX, CONFIRMED_ACTIONS, SEED, STAGED_LOAD_WORDING, STATE_PREFIX, TARGET_CHOICES, createActions, summariseKeys } from './actions.js';
import { DEFAULT_TARGET, TARGETS } from '../stack.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 8790;
export const TOKEN_TTL_MS = 5 * 60_000;
export const MAX_TOKENS = 50;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_EVENTS_PER_RUN = 5_000;
export const MAX_RUNS_KEPT = 20;
const PAGE_DIR = path.join(TOOLS_ROOT, 'simulator');
const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
const ANCHOR_RE = /^\d{4}-\d{2}-\d{2}$/;
export const BUSINESS_DOCS_DIR = path.join(TOOLS_ROOT, 'business-docs');
/** The download's name never names the scenario: the presenter uploads it to the agent as it is. */
export const BUSINESS_REVIEW_FILENAME = 'learnloop-q4-2026-business-review.md';

const sendJson = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

/** The stage a request names: null for none, else an integer the scenario has (400 otherwise). */
function stageParam(def, raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const stage = Number(raw);
  try {
    return stageOf(def, stage)?.stage ?? null;
  } catch (error) {
    throw Object.assign(new Error(error.message), { status: 400 });
  }
}

/** The target a request names: production by default, 400 for anything else than a known one. */
function targetParam(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_TARGET;
  if (!TARGETS[raw]) throw Object.assign(new Error(`unknown target '${raw}': production or staging`), { status: 400 });
  return raw;
}

function validAnchor(anchor) {
  if (!ANCHOR_RE.test(anchor ?? '') || Number.isNaN(Date.parse(`${anchor}T00:00:00Z`))) return false;
  return new Date(`${anchor}T00:00:00Z`).toISOString().slice(0, 10) === anchor;
}

/**
 * Build the request handler. `aws` and `git` are the layers (./layers.js); tests pass
 * fakes. Returns { handler, runner } so a test can await a run.
 */
export function createSimulator({ aws, git, paths, scenariosDir, businessDocsDir = BUSINESS_DOCS_DIR, now = () => new Date(), port = DEFAULT_PORT, workerUrl }) {
  const scenarios = () => loadScenarios(scenariosDir);
  const getDef = (id) => {
    const def = scenarios().get(id);
    if (!def) throw Object.assign(new Error(`unknown scenario '${id}'`), { status: 400 });
    return def;
  };
  const actions = createActions({ aws, git, paths, scenarios: getDef, now, workerUrl });
  const tokens = new Map();
  const runs = new Map();
  let current = null;

  const issueToken = (action) => {
    for (const [t, v] of tokens) if (v.expires < Date.now()) tokens.delete(t);
    if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
    const token = randomBytes(16).toString('hex');
    tokens.set(token, { action, expires: Date.now() + TOKEN_TTL_MS });
    return token;
  };
  const takeToken = (token, action) => {
    const entry = tokens.get(token ?? '');
    if (!entry) return false;
    tokens.delete(token);
    return entry.action === action && entry.expires >= Date.now();
  };

  function startRun(name, ctxBase) {
    const id = randomBytes(8).toString('hex');
    const run = { id, name, dryRun: ctxBase.dryRun, target: ctxBase.target, events: [], listeners: new Set(), done: false, startedAt: now().toISOString() };
    const emit = (event) => {
      if (run.events.length >= MAX_EVENTS_PER_RUN) return;
      const e = { ...event, at: now().toISOString() };
      run.events.push(e);
      for (const l of run.listeners) l(e);
    };
    runs.set(id, run);
    while (runs.size > MAX_RUNS_KEPT) runs.delete(runs.keys().next().value);
    current = run;
    run.promise = (async () => {
      emit({ type: 'start', action: name, dryRun: !!ctxBase.dryRun, target: ctxBase.target });
      try {
        const result = await actions[name]({ ...ctxBase, emit });
        emit({ type: 'done', action: name, result });
      } catch (error) {
        // the message verbatim, never the stack
        emit({ type: 'error', action: name, message: String(error?.message ?? error) });
      } finally {
        run.done = true;
        current = null;
        for (const l of run.listeners) l(null);
        run.listeners.clear();
      }
    })();
    return run;
  }

  async function readBody(req) {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request body too large'), { status: 413 });
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    } catch {
      throw Object.assign(new Error('the request body is not JSON'), { status: 400 });
    }
  }

  async function readState({ readBack, target }) {
    const { lastRun, ...forTarget } = await actions.stateFor(target);
    const state = { ...forTarget, stack: TARGETS[target].stack, running: current ? { action: current.name, id: current.id, dryRun: current.dryRun, target: current.target } : null };
    if (readBack) {
      try {
        const { uploadTargets } = await import('../stack.js');
        const t = uploadTargets(await aws.stackOutputs(TARGETS[target].stack));
        state.buckets = {
          state: summariseKeys((await aws.list(t.stateBucket, STATE_PREFIX, { maxPages: 5 })).keys),
          appLogs: summariseKeys((await aws.list(t.appLogsBucket, APP_LOGS_PREFIX, { maxPages: 20 })).keys),
          cloudfront: summariseKeys((await aws.list(t.accessLogsBucket, t.cloudfrontPrefix, { maxPages: 20 })).keys),
        };
      } catch (error) {
        state.bucketsError = error.message;
      }
    }
    return state;
  }

  // `port` may be a function, for a server listening on an ephemeral port (tests)
  const portOf = typeof port === 'function' ? port : () => port;

  async function handler(req, res) {
    const allowedHosts = new Set([`${HOST}:${portOf()}`, `localhost:${portOf()}`]);
    try {
      const url = new URL(req.url, `http://${HOST}:${portOf()}`);
      if (!allowedHosts.has(req.headers.host ?? '')) return sendJson(res, 421, { error: 'this server only answers on 127.0.0.1 or localhost' });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && !allowedHosts.has(origin.replace(/^http:\/\//, ''))) return sendJson(res, 403, { error: 'cross-site request refused' });
      }
      const p = url.pathname;

      if (req.method === 'GET' && STATIC[p]) {
        const [file, type] = STATIC[p];
        res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:" });
        return res.end(await readFile(path.join(PAGE_DIR, file)));
      }
      if (req.method === 'GET' && p === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && p === '/api/scenarios') {
        return sendJson(res, 200, { scenarios: [...scenarios().values()].map(publicCard), defaultAnchor: todayUtc(now()), seed: SEED, confirmations: CONFIRMED_ACTIONS, stagedLoad: STAGED_LOAD_WORDING, targets: TARGET_CHOICES, defaultTarget: DEFAULT_TARGET });
      }
      if (req.method === 'GET' && p === '/api/fingerprint') {
        const anchor = url.searchParams.get('anchor');
        if (!validAnchor(anchor)) return sendJson(res, 400, { error: 'anchor must be a date like 2026-11-15' });
        const def = getDef(url.searchParams.get('scenario'));
        const stage = stageParam(def, url.searchParams.get('stage'));
        return sendJson(res, 200, { scenario: def.id, stage, anchor, seed: SEED, fingerprint: scenarioFingerprint(def, { seed: SEED, anchor, stage }) });
      }
      const review = p.match(/^\/api\/scenarios\/([a-z0-9-]+)\/business-review$/);
      if (req.method === 'GET' && review) {
        const def = getDef(review[1]);
        const body = await readFile(path.join(businessDocsDir, `${def.id}.md`)).catch(() => null);
        if (!body) return sendJson(res, 404, { error: `no business review for '${def.id}' (business-docs/${def.id}.md)` });
        res.writeHead(200, {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="${BUSINESS_REVIEW_FILENAME}"`,
          'cache-control': 'no-store',
        });
        return res.end(body);
      }
      const reveal = p.match(/^\/api\/scenarios\/([a-z0-9-]+)\/reveal$/);
      if (req.method === 'GET' && reveal) {
        const anchor = url.searchParams.get('anchor');
        if (!validAnchor(anchor)) return sendJson(res, 400, { error: 'anchor must be a date like 2026-11-15' });
        const def = getDef(reveal[1]);
        // a staged scenario: every stage's sealed text and fingerprint, so the envelope can
        // show all of them and the page can recompute the one that was loaded
        const stages = plainStages(def).map((p) => ({
          ...p,
          canonical: canonicalJson(sealedInput(def, { seed: SEED, anchor, stage: p.stage })),
          fingerprint: scenarioFingerprint(def, { seed: SEED, anchor, stage: p.stage }),
        }));
        return sendJson(res, 200, {
          definition: def, seed: SEED, anchor, plain: plainParameters(def),
          canonical: canonicalJson(sealedInput(def, { seed: SEED, anchor })),
          fingerprint: scenarioFingerprint(def, { seed: SEED, anchor }),
          ...(stages.length ? { stages } : {}),
        });
      }
      if (req.method === 'GET' && p === '/api/state') return sendJson(res, 200, await readState({ readBack: url.searchParams.get('readBack') === '1', target: targetParam(url.searchParams.get('target')) }));
      if (req.method === 'GET' && p === '/api/replay') {
        const last = await (await actions.stateFor(targetParam(url.searchParams.get('target')))).lastRun();
        return sendJson(res, 200, { replay: last });
      }
      if (req.method === 'POST' && p === '/api/confirm') {
        const { action } = await readBody(req);
        if (!CONFIRMED_ACTIONS[action]) return sendJson(res, 400, { error: `'${action}' does not need a confirmation` });
        return sendJson(res, 200, { action, token: issueToken(action), expiresInSeconds: TOKEN_TTL_MS / 1000, warning: CONFIRMED_ACTIONS[action] });
      }
      const act = p.match(/^\/api\/actions\/([a-z]+)$/);
      if (req.method === 'POST' && act) {
        const name = act[1];
        if (!ACTION_NAMES.includes(name)) return sendJson(res, 404, { error: `no action '${name}'` });
        const body = await readBody(req);
        const dryRun = body.dryRun === true || url.searchParams.get('dryRun') === '1';
        if (current) return sendJson(res, 409, { error: `'${current.name}' is still running; wait for it to finish`, running: current.name, runId: current.id });
        // the scenario and anchor are the only inputs an action takes from the request
        const scenario = body.scenario ?? 'lapsed-learners';
        const anchor = body.anchor ?? todayUtc(now());
        const def = getDef(scenario);
        if (!validAnchor(anchor)) return sendJson(res, 400, { error: 'anchor must be a date like 2026-11-15' });
        const stage = stageParam(def, body.stage);
        const target = targetParam(body.target);
        if (body.publish !== undefined && typeof body.publish !== 'boolean') return sendJson(res, 400, { error: 'publish is true or false' });
        if (body.publish !== undefined && !stageCount(def)) return sendJson(res, 400, { error: 'publish can be chosen only for a staged load' });
        if ((body.publish === true || name === 'publish') && !TARGETS[target].publish) {
          return sendJson(res, 400, { error: `publishing to LearnLoop's main is offered for Production only, not ${TARGETS[target].label}` });
        }
        if (CONFIRMED_ACTIONS[name] && !takeToken(body.token, name)) {
          return sendJson(res, 403, { error: `${name} changes things outside this computer and needs a confirmation: confirm it in the dialog first` });
        }
        const paceMs = body.pace === 'fast' ? 0 : undefined;
        const run = startRun(name, { target, scenario, stage, anchor, dryRun, paceMs, publish: body.publish });
        return sendJson(res, 202, { runId: run.id, action: name, dryRun });
      }
      const ev = p.match(/^\/api\/runs\/([0-9a-f]+)\/events$/);
      if (req.method === 'GET' && ev) {
        const run = runs.get(ev[1]);
        if (!run) return sendJson(res, 404, { error: 'no such run' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        const write = (e) => { if (e) res.write(`data: ${JSON.stringify(e)}\n\n`); else res.end(); };
        for (const e of run.events) write(e);
        if (run.done) return res.end();
        run.listeners.add(write);
        req.on('close', () => run.listeners.delete(write));
        return undefined;
      }
      return sendJson(res, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(res, error.status ?? 500, { error: String(error?.message ?? error) });
    }
  }

  return { handler, runs, current: () => current, issueToken };
}

async function main() {
  const { values } = parseArgs({ options: { port: { type: 'string', default: String(process.env.SIMULATOR_PORT ?? DEFAULT_PORT) } } });
  const port = Number(values.port);
  const { createAwsLayer, createGitLayer } = await import('./layers.js');
  const sim = createSimulator({
    aws: await createAwsLayer(),
    git: createGitLayer(LEARNLOOP_REPO),
    paths: { stateDir: path.join(TOOLS_ROOT, 'state'), dataDir: DATA_DIR, outDir: OUT_DIR },
    port,
  });
  const server = createServer(sim.handler);
  server.listen(port, HOST, () => {
    console.log(`simulator: http://${HOST}:${port}  (LearnLoop repository: ${LEARNLOOP_REPO})`);
  });
}

if (import.meta.url === `file://${process.argv[1]}` || fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`simulator: ${error.message}`);
    process.exitCode = 1;
  });
}
