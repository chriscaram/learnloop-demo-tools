#!/usr/bin/env node
// npm run cloud -- <command>     (from the repository root)
//
//   deploy [--rotate-password]  read the LearnLoop stacks, make sure the password exists,
//                               cdk deploy TelemetryActivitySimulator, build the image in
//                               CodeBuild, and start the simulator again if it was running
//   start                       one task, waits until it answers; prints the address
//   stop                        no task (the load balancer stays; nothing runs)
//   status                      tasks wanted / running, the address
//   password                    the address, the user name and the password
//
// Needs only Node and the AWS CLI with credentials for the account (the image is built in
// CodeBuild, not here). Every wait is bounded and says so when it gives up.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { authHashOf } from '../lib/edge-auth.mjs';

const run = promisify(execFile);
const INFRA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGION = process.env.AWS_REGION ?? 'us-east-1';
export const STACK = 'TelemetryActivitySimulator';
export const PASSWORD_SECRET = 'telemetry-activity-simulator/password';
export const USERNAME = 'presenter';
const LEARNLOOP_STACKS = ['LearnLoopProd', 'LearnLoopStaging'];
const BUCKET_OUTPUTS = ['StateBucketName', 'AppLogsBucketName', 'AccessLogsBucketName'];
const BUILD_WAIT_MS = 25 * 60_000;
const START_WAIT_MS = 10 * 60_000;
const POLL_MS = 10_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function aws(...args) {
  const { stdout } = await run('aws', [...args, '--region', REGION, '--output', 'json'], { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function stackOutputs(name) {
  try {
    const out = await aws('cloudformation', 'describe-stacks', '--stack-name', name);
    return Object.fromEntries((out.Stacks[0].Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  } catch (error) {
    if (/does not exist/.test(String(error.stderr ?? error.message))) return null;
    throw error;
  }
}

async function readPassword() {
  try {
    return JSON.parse((await aws('secretsmanager', 'get-secret-value', '--secret-id', PASSWORD_SECRET)).SecretString);
  } catch (error) {
    if (/ResourceNotFoundException/.test(String(error.stderr ?? error.message))) return null;
    throw error;
  }
}

async function ensurePassword({ rotate }) {
  const existing = await readPassword();
  if (existing && !rotate) return existing;
  const value = { username: USERNAME, password: randomBytes(18).toString('base64url') };
  if (existing) await aws('secretsmanager', 'put-secret-value', '--secret-id', PASSWORD_SECRET, '--secret-string', JSON.stringify(value));
  else {
    await aws('secretsmanager', 'create-secret', '--name', PASSWORD_SECRET, '--description', 'Password for the Telemetry Activity Simulator page (CloudFront Basic auth)',
      '--secret-string', JSON.stringify(value), '--tags', 'Key=Application,Value=telemetry-activity-simulator');
  }
  console.log(existing ? 'password rotated' : 'password created');
  return value;
}

async function learnloopContext() {
  const ctx = [];
  for (const stack of LEARNLOOP_STACKS) {
    const out = await stackOutputs(stack);
    if (!out) { console.log(`${stack}: not deployed, the simulator gets no access to it`); continue; }
    const missing = [...BUCKET_OUTPUTS, 'LogPseudonymSaltSecretName'].filter((k) => !out[k]);
    if (missing.length) throw new Error(`${stack}: outputs missing: ${missing.join(', ')}`);
    ctx.push({ stack, buckets: BUCKET_OUTPUTS.map((k) => out[k]), saltSecret: out.LogPseudonymSaltSecretName });
  }
  if (!ctx.length) throw new Error('no LearnLoop stack is deployed: there is nothing for the simulator to load into');
  return ctx;
}

async function service() {
  const out = await stackOutputs(STACK);
  if (!out) throw new Error(`${STACK} is not deployed yet: npm run cloud -- deploy`);
  const svc = (await aws('ecs', 'describe-services', '--cluster', out.ClusterName, '--services', out.ServiceName)).services[0];
  return { out, desired: svc?.desiredCount ?? 0, running: svc?.runningCount ?? 0, deployments: svc?.deployments ?? [] };
}

async function buildImage(project) {
  const id = (await aws('codebuild', 'start-build', '--project-name', project)).build.id;
  console.log(`image build ${id} started in CodeBuild`);
  const until = Date.now() + BUILD_WAIT_MS;
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const b = (await aws('codebuild', 'batch-get-builds', '--ids', id)).builds[0];
    if (b.buildStatus === 'SUCCEEDED') { console.log('image built and pushed'); return; }
    if (b.buildStatus !== 'IN_PROGRESS') throw new Error(`image build ${b.buildStatus} in phase ${b.currentPhase}; logs: ${b.logs?.deepLink ?? 'see CodeBuild'}`);
  }
  throw new Error(`the image build did not finish within ${BUILD_WAIT_MS / 60_000} minutes; it may still be running in CodeBuild (${id})`);
}

async function setDesired(count, { force = false } = {}) {
  const { out } = await service();
  await aws('ecs', 'update-service', '--cluster', out.ClusterName, '--service', out.ServiceName, '--desired-count', String(count), ...(force ? ['--force-new-deployment'] : []));
  return out;
}

async function waitStarted() {
  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until) {
    const s = await service();
    const primary = s.deployments.find((d) => d.status === 'PRIMARY');
    if (s.running >= 1 && s.deployments.length === 1 && primary?.rolloutState === 'COMPLETED') return s.out;
    if (primary?.rolloutState === 'FAILED') throw new Error(`the task did not start: ${primary.rolloutStateReason}`);
    await sleep(POLL_MS);
  }
  throw new Error(`the simulator did not answer within ${START_WAIT_MS / 60_000} minutes; see the log group in the ${STACK} outputs`);
}

const commands = {
  async deploy(flags) {
    // a stack left by a failed deploy has no service yet: nothing was running
    const before = await service().catch(() => null);
    const wasRunning = (before?.desired ?? 0) > 0;
    const learnloop = await learnloopContext();
    const { username, password } = await ensurePassword({ rotate: flags.includes('--rotate-password') });
    console.log(`cdk deploy ${STACK} (LearnLoop stacks: ${learnloop.map((l) => l.stack).join(', ')})`);
    await run('npx', ['cdk', 'deploy', STACK, '--require-approval', 'never', '-c', `authHash=${authHashOf(username, password)}`, '-c', `learnloop=${JSON.stringify(learnloop)}`],
      { cwd: INFRA, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, AWS_REGION: REGION, CDK_DEFAULT_REGION: REGION } });
    const out = await stackOutputs(STACK);
    await buildImage(out.ImageBuildProject);
    if (wasRunning) {
      console.log('it was running: starting it again with the new image');
      await setDesired(1, { force: true });
      await waitStarted();
    }
    console.log(`deployed: ${out.Url}  (${wasRunning ? 'running' : 'stopped; npm run cloud -- start'})`);
  },
  async start() {
    await setDesired(1, { force: true });
    console.log('starting one task (about two minutes)…');
    const out = await waitStarted();
    const pw = await readPassword();
    console.log(`running: ${out.Url}  user ${pw?.username ?? USERNAME}  (npm run cloud -- password)`);
  },
  async stop() {
    await setDesired(0);
    console.log('stopped: no task runs. npm run cloud -- start to bring it back.');
  },
  async status() {
    const s = await service();
    console.log(`${s.out.Url}  wanted ${s.desired}, running ${s.running}${s.deployments.length > 1 ? ' (a deployment is in progress)' : ''}`);
  },
  async password() {
    const out = await stackOutputs(STACK);
    const pw = await readPassword();
    if (!pw) throw new Error('no password yet: npm run cloud -- deploy creates it');
    console.log(`${out?.Url ?? '(not deployed)'}\nuser:     ${pw.username}\npassword: ${pw.password}`);
  },
};

const [name, ...flags] = process.argv.slice(2);
if (!commands[name]) {
  console.error(`usage: npm run cloud -- ${Object.keys(commands).join(' | ')}`);
  process.exitCode = 2;
} else {
  commands[name](flags).catch((error) => {
    console.error(`cloud ${name}: ${String(error.stderr || error.message).trim()}`);
    process.exitCode = 1;
  });
}
