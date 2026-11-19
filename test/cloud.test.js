// The simulator deployed in AWS (infra/): the CloudFront Function lets a request through
// only with the expected password, run as written (its `crypto` import swapped for
// node:crypto); the template holds the hash, never the password; and the image and the
// CodeBuild asset agree on what the image is built from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { authHashOf, basicAuthFunctionCode } from '../infra/lib/edge-auth.mjs';

function edgeHandler(code) {
  const body = code.replace("import crypto from 'crypto';", '');
  return new Function('crypto', `${body}\nreturn handler;`)({ createHash });
}
const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const request = (authorization) => ({ request: { uri: '/', headers: authorization ? { authorization: { value: authorization } } : {} } });

test('the edge function lets through only the expected password, and holds only its hash', async () => {
  const code = basicAuthFunctionCode(authHashOf('presenter', 's3cret-Pass'));
  assert.ok(!code.includes('s3cret-Pass'));
  const handler = edgeHandler(code);
  const ok = await handler(request(basic('presenter', 's3cret-Pass')));
  assert.equal(ok.uri, '/', 'the request goes on to the origin');
  for (const auth of [null, basic('presenter', 'wrong'), basic('other', 's3cret-Pass'), 'Bearer x']) {
    const res = await handler(request(auth));
    assert.equal(res.statusCode, 401, String(auth));
    assert.match(res.headers['www-authenticate'].value, /^Basic realm=/);
  }
});

test('a missing or malformed hash stops the synth instead of deploying an open page', () => {
  for (const bad of [undefined, '', 'abc', 'Z'.repeat(64)]) assert.throws(() => basicAuthFunctionCode(bad), /authHash/);
});

test('the image is built from exactly what .dockerignore and the CodeBuild asset leave in', async () => {
  const stack = await readFile(new URL('../infra/lib/simulator-stack.mjs', import.meta.url), 'utf8');
  const asset = JSON.parse(stack.match(/ASSET_EXCLUDE = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  const ignore = (await readFile(new URL('../.dockerignore', import.meta.url), 'utf8')).split('\n').filter((l) => l && !l.startsWith('#'));
  assert.deepEqual([...ignore].sort(), [...asset].sort());
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  for (const dir of ['src', 'simulator', 'scenarios', 'business-docs']) assert.match(dockerfile, new RegExp(`^COPY ${dir} `, 'm'), dir);
  assert.match(dockerfile, /SIMULATOR_PUBLISH=off/, 'the cloud image never publishes');
  assert.match(dockerfile, /^USER node$/m);
});

test('the task is sized for the generator, deploys without a gap, and keeps the log files off EFS', async () => {
  const stack = await readFile(new URL('../infra/lib/simulator-stack.mjs', import.meta.url), 'utf8');
  assert.match(stack, /TASK_SIZE = Object\.freeze\(\{ cpu: 2048, memoryLimitMiB: 4096 \}\)/);
  assert.match(stack, /\.\.\.TASK_SIZE,/);
  // rolling: the new task is healthy before the old one goes; a browser stays on one of the two
  assert.match(stack, /minHealthyPercent: 100,\s*maxHealthyPercent: 200,/);
  assert.match(stack, /stickinessCookieDuration: /);
  // the count is the service's own, so a deploy neither starts nor stops the simulator
  assert.match(stack, /^\s*desiredCount,$/m);
  const script = await readFile(new URL('../infra/scripts/cloud.mjs', import.meta.url), 'utf8');
  assert.match(script, /desiredCount=\$\{desiredCount\}/);
  assert.match(script, /desiredCount: wasRunning \? 1 : 0/);
  assert.match(script, /is running on \$\{busy\.target\}: deploy when it has finished/);
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /SIMULATOR_DATA_ROOT=\/data/);
  assert.match(dockerfile, /SIMULATOR_SCRATCH_ROOT=\/tmp\/simulator/, 'out/ on the task disk, not on the EFS mount');
});
