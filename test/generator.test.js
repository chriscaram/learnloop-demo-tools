import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { EVENT_NAMES, pseudonymiseUser } from '../src/contract/logger.js';
import { completionPercent } from '../src/contract/progress.js';
import { generate } from '../src/generate.js';
import { CLOUDFRONT_FIELDS, encodeUserAgent } from '../src/emit.js';
import { formatJson } from '../src/files.js';
import { DAY_MS, LEARNING_ROUTES, PERSONAS } from '../src/model.js';

const ARGS = { anchor: '2026-11-03', salt: 'test-salt', seed: 42 };
const within = (actual, expected, tolerance = 0.05) => Math.abs(actual - expected) <= expected * tolerance;

let result;
let appRecords;
let anchorMs;
const dayOf = (iso) => Math.floor((Date.parse(iso) - anchorMs) / DAY_MS);

function digest(r) {
  const hash = createHash('sha256');
  for (const [domain, value] of Object.entries(r.data)) hash.update(domain).update(formatJson(value));
  for (const [key, body] of r.appLogs) hash.update(key).update(body);
  for (const [key, body] of r.cloudfront) hash.update(key).update(body);
  return hash.digest('hex');
}

before(() => {
  result = generate(ARGS);
  anchorMs = result.sim.anchorMs;
  appRecords = [];
  for (const [key, body] of result.appLogs) {
    for (const line of body.trimEnd().split('\n')) appRecords.push({ key, line, record: JSON.parse(line) });
  }
});

test('same arguments produce byte-identical output', () => {
  assert.equal(digest(generate(ARGS)), digest(result));
});

// The digest of the generator's output for these arguments BEFORE scenarios existed
// (commit ee4ba06). lapsed-learners must keep reproducing it byte for byte: the
// scenario refactor moved the numbers into scenarios/lapsed-learners.json, it must not
// have moved a single byte of output. If this fails, the default scenario changed.
const PRE_SCENARIO_DIGEST = '6ad44fd7990267fbc666e343893a1df0c4b0230cb556dffcc99f9bc86abd24f4';

test('lapsed-learners is byte-identical to the generator before scenarios (committed fingerprint)', () => {
  assert.equal(result.stats.scenario, 'lapsed-learners');
  assert.equal(digest(result), PRE_SCENARIO_DIGEST);
});

test('history: distinct learners on the learning routes, 30-day windows (±5%)', () => {
  const { window1, window2 } = result.stats;
  assert.ok(within(window1.learnersOnLessons, 340), `window1 ${window1.learnersOnLessons}`);
  assert.ok(within(window2.learnersOnLessons, 195), `window2 ${window2.learnersOnLessons}`);
  const drop = 1 - window2.learnersOnLessons / window1.learnersOnLessons;
  assert.ok(within(drop, 0.43, 0.1), `drop ${drop}`);
});

test('history: 14-day windows also drop by more than 35%', () => {
  const { fortnightBefore, fortnightLast, firstFortnight } = result.stats;
  assert.ok(1 - fortnightLast.learnersOnLessons / fortnightBefore.learnersOnLessons > 0.35);
  assert.ok(within(firstFortnight.learnersOnLessons, 340));
});

test('history: changes are gradual (no single-day cliff)', () => {
  const perDay = new Map();
  for (const r of result.sim.requests) {
    if (r.kind !== 'api' || !LEARNING_ROUTES.includes(r.route)) continue;
    const d = Math.floor((r.ts - anchorMs) / DAY_MS);
    if (!perDay.has(d)) perDay.set(d, new Set());
    perDay.get(d).add(r.userId);
  }
  // compare 7-day rolling distinct counts day over day
  const rolling = [];
  for (let end = -54; end <= -1; end += 1) {
    const users = new Set();
    for (let d = end - 6; d <= end; d += 1) for (const u of perDay.get(d) ?? []) users.add(u);
    rolling.push(users.size);
  }
  for (let i = 1; i < rolling.length; i += 1) {
    assert.ok(rolling[i - 1] - rolling[i] < 25, `drop of ${rolling[i - 1] - rolling[i]} in one day`);
  }
});

test('history: sign-ins, progress and catalog views change by -4% to -16%', () => {
  const { window1, window2 } = result.stats;
  for (const metric of ['signIns', 'progressViews', 'catalogViews']) {
    const change = 1 - window2[metric] / window1[metric];
    assert.ok(change > 0.04 && change < 0.16, `${metric} change ${change}`);
  }
});

test('history: cohort B last lesson on day -45..-31; progress records agree with the logs', () => {
  const lastLessonEvent = new Map();
  for (const r of result.sim.requests) {
    for (const e of r.events ?? []) {
      if (e.event === 'lesson_started' || e.event === 'lesson_completed') lastLessonEvent.set(r.userId, new Date(e.ts).toISOString());
    }
  }
  const lastActivity = new Map();
  for (const c of result.data.progress.courses) {
    if (c.last_activity_at && (!lastActivity.has(c.user_id) || lastActivity.get(c.user_id) < c.last_activity_at)) {
      lastActivity.set(c.user_id, c.last_activity_at);
    }
  }
  for (const id of result.sim.groups.cohortB) {
    const last = lastLessonEvent.get(id);
    assert.ok(dayOf(last) >= -45 && dayOf(last) <= -31, `${id} last lesson on day ${dayOf(last)}`);
    assert.equal(lastActivity.get(id), last);
  }
  for (const [id, last] of lastLessonEvent) assert.equal(lastActivity.get(id), last, `progress agrees for ${id}`);
  // cohort B keeps signing in afterwards
  const cohortB = new Set(result.sim.groups.cohortB);
  const laterSignIns = result.sim.requests.filter((r) => r.route === '/api/auth/login' && r.status === 200
    && cohortB.has(r.userId) && Math.floor((r.ts - anchorMs) / DAY_MS) > -30).length;
  assert.ok(laterSignIns > 500);
});

test('history: cancellations per week (~4, then ~11); no traffic after cancelling', () => {
  const { weeks, window1, fortnightLast } = result.stats;
  assert.ok(within(window1.cancellations / (30 / 7), 4, 0.25), `first month ${window1.cancellations}`);
  assert.ok(within(fortnightLast.cancellations / 2, 11, 0.15), `last two weeks ${fortnightLast.cancellations}`);
  assert.ok(weeks.at(-1).cancellations > weeks[0].cancellations);
  const cancelledAt = new Map(result.data.subscriptions.filter((s) => s.cancelled_at).map((s) => [s.user_id, Date.parse(s.cancelled_at)]));
  for (const r of result.sim.requests) {
    if (r.kind === 'api' && cancelledAt.has(r.userId)) {
      assert.ok(r.ts < cancelledAt.get(r.userId) + 15 * 60_000, 'no traffic after cancelling');
    }
  }
});

test('history: renewals by the system, ~3 staff messages per week', () => {
  const renewals = appRecords.filter((a) => a.record.event === 'subscription_renewed');
  assert.ok(renewals.length > 600);
  assert.ok(renewals.every((a) => a.record.actor_type === 'system' && a.record['session.id'] === undefined));
  const staffMessages = appRecords.filter((a) => a.record.event === 'staff_message_sent');
  assert.ok(staffMessages.length >= 18 && staffMessages.length <= 34, `${staffMessages.length} staff messages`);
  assert.ok(staffMessages.every((a) => a.record.actor_type === 'staff'));
});

test('volume: under 120,000 CloudFront lines and 2,000 CloudFront objects per 30-day window', () => {
  const { volume } = result.stats;
  assert.ok(volume.cloudfrontLinesWindow1 < 120_000, `${volume.cloudfrontLinesWindow1}`);
  assert.ok(volume.cloudfrontLinesWindow2 < 120_000);
  assert.ok(volume.cloudfrontObjectsWindow1 < 2_000 && volume.cloudfrontObjectsWindow2 < 2_000);
});

test('no missing day or hour: one CloudFront object and learner-facing app logs for every hour', () => {
  const expectedHours = [];
  for (let h = 0; h < 60 * 24; h += 1) {
    expectedHours.push(new Date(anchorMs - 60 * DAY_MS + h * 3600_000).toISOString().slice(0, 13).replace('T', '-'));
  }
  const cfHours = [...result.cloudfront.keys()].map((k) => k.split('.')[1]);
  assert.deepEqual(cfHours, expectedHours);
  for (const service of ['identity', 'catalog', 'learning', 'billing', 'notifications']) {
    const hours = new Set([...result.appLogs.keys()].filter((k) => k.includes(`service=${service}/`)).map((k) => k.slice(-17, -4)));
    const missing = expectedHours.filter((h) => !hours.has(h));
    assert.deepEqual(missing, [], `${service} missing hours`);
  }
});

test('health: 5xx below 0.3% per route per day, stable p95, regular releases', () => {
  const { health } = result.stats;
  assert.ok(health.worst5xxShare < 0.003, `${health.worst5xxShare}`);
  assert.ok(health.lessonsP95.min > 95 && health.lessonsP95.max < 145, JSON.stringify(health.lessonsP95));
  assert.ok(health.otherP95.min > 45 && health.otherP95.max < 75, JSON.stringify(health.otherP95));
  const starts = health.versions.map((v) => Date.parse(v.from));
  for (let i = 1; i < starts.length; i += 1) {
    const gap = (starts[i] - starts[i - 1]) / DAY_MS;
    assert.ok(gap >= 7.5 && gap <= 15, `release gap ${gap}`);
  }
  assert.ok(new Set(appRecords.map((a) => a.record['service.version'])).size >= 5);
});

test('app logs follow the logging contract', () => {
  const events = new Set(EVENT_NAMES);
  for (const { key, line, record } of appRecords) {
    assert.ok(!line.includes('\n'));
    assert.match(record.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.equal(record['deployment.environment'], 'prod');
    assert.equal(key, `app-logs/service=${record['service.name']}/dt=${record.timestamp.slice(0, 10)}/${record['service.name']}-${record.timestamp.slice(0, 10)}-${record.timestamp.slice(11, 13)}.log`);
    assert.match(record.trace_id, /^[0-9a-f]{32}$/);
    if (record.kind === 'request') {
      assert.ok(record['http.route'].startsWith('/api/') && !record['http.route'].includes('?'));
      assert.equal(typeof record['http.status_code'], 'number');
      assert.equal(typeof record.latency_ms, 'number');
      if (record['http.status_code'] !== 401) assert.match(record['user.id'], /^u_[0-9a-f]{16}$/);
    } else if (record.kind === 'event') {
      assert.ok(events.has(record.event), record.event);
      assert.ok(['learner', 'staff', 'system'].includes(record.actor_type));
    } else {
      assert.equal(record.kind, 'log');
    }
  }
});

test('no PII in app logs; every user.id is a pseudonymised seed user', () => {
  const pseudonyms = new Set(result.data.users.map((u) => pseudonymiseUser(ARGS.salt, u.id)));
  const names = result.data.users.map((u) => u.name);
  const text = appRecords.map((a) => a.line).join('\n');
  assert.ok(!text.includes('@'), 'no emails');
  assert.ok(!/\b(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d+/.test(text), 'no IPs');
  assert.ok(!text.includes('usr_'), 'no internal user ids');
  assert.ok(!text.includes('price') && !/"value":19\b/.test(text.replace(/"event":"(lesson_\w+|quiz_submitted)"[^\n]*/g, '')), 'no money');
  const nameSet = new Set(names);
  const leaked = [...new Set(text.match(/[A-Z][a-z]+ [A-Z][a-z]+/g) ?? [])].filter((pair) => nameSet.has(pair));
  assert.deepEqual(leaked, [], 'no names');
  assert.ok(nameSet.has('Ana Moreno'));
  for (const { record } of appRecords) {
    if (record['user.id']) assert.ok(pseudonyms.has(record['user.id']), `unknown ${record['user.id']}`);
  }
});

test('CloudFront logs: W3C header, 33 fields, real naming, stable IPs, ~1% crawler on public paths', () => {
  const ipsPerUser = new Map();
  for (const r of result.sim.requests) {
    if (!r.userId) continue;
    if (!ipsPerUser.has(r.userId)) ipsPerUser.set(r.userId, new Set());
    ipsPerUser.get(r.userId).add(r.ip);
  }
  assert.ok([...ipsPerUser.values()].every((s) => s.size === 1), 'one IP per learner');
  const learnerIps = new Map(result.sim.learners.map((u) => [u.id, u.ip]));
  const shared = [...learnerIps.values()].filter((ip, _, all) => all.indexOf(ip) !== all.lastIndexOf(ip)).length;
  assert.ok(shared / learnerIps.size <= 0.05);

  let lines = 0;
  let crawler = 0;
  for (const [key, body] of result.cloudfront) {
    assert.match(key, /^cloudfront\/E000000SEEDLOG\.\d{4}-\d{2}-\d{2}-\d{2}\.[A-Z0-9]{8}\.gz$/);
    const [version, fields, ...rows] = gunzipSync(body).toString('utf8').trimEnd().split('\n');
    assert.equal(version, '#Version: 1.0');
    assert.equal(fields, `#Fields: ${CLOUDFRONT_FIELDS.join(' ')}`);
    const hour = key.split('.')[1];
    for (const row of rows) {
      const cols = row.split('\t');
      assert.equal(cols.length, 33);
      assert.equal(`${cols[0]}-${cols[1].slice(0, 2)}`, hour);
      assert.equal(cols[11], '-');
      assert.equal(cols[12], '-');
      assert.ok(!cols[10].includes(' '));
      assert.match(cols[4], /^(192\.0\.2|198\.51\.100|203\.0\.113)\.\d+$/);
      if (cols[10].includes('Googlebot')) {
        crawler += 1;
        assert.ok(!cols[7].startsWith('/api/'), 'crawler only on public pages');
      }
      for (const m of cols[7].matchAll(/\/(usr|crs|les|ntf)_([^/]+)/g)) assert.match(m[2], /^[0-9a-f]{12}$/);
      lines += 1;
    }
  }
  assert.ok(crawler / lines > 0.007 && crawler / lines < 0.014, `crawler share ${crawler / lines}`);
  assert.equal(encodeUserAgent('Mozilla/5.0 (X11; Linux)'), 'Mozilla/5.0%20(X11;%20Linux)');
});

test('mock data: population, catalog shape, ids', () => {
  const { users, courses, lessons, subscriptions } = result.data;
  assert.equal(users.filter((u) => u.role === 'learner').length, 420);
  assert.equal(users.filter((u) => u.role === 'staff').length, 3);
  assert.ok(users.every((u) => u.email.endsWith('@example.com')));
  assert.equal(new Set(users.map((u) => u.email)).size, users.length);
  assert.equal(courses.length, 12);
  assert.deepEqual([...new Set(courses.map((c) => c.category))].sort(), ['Cloud', 'Data', 'Design', 'Leadership']);
  for (const c of courses) assert.ok(c.lesson_ids.length >= 6 && c.lesson_ids.length <= 10);
  for (const item of [...users, ...courses, ...lessons, ...result.data.notifications]) {
    assert.match(item.id, /^(usr|crs|les|ntf)_[0-9a-f]{12}$/);
  }
  for (const s of subscriptions) {
    const days = (anchorMs - Date.parse(s.started_at)) / DAY_MS;
    assert.ok(days >= 60 && days <= 200, `subscription started ${days} days before`);
    assert.equal(s.price_usd, 19);
  }
});

test('demo personas', () => {
  const { users, courses, lessons, enrolments, progress, notifications } = result.data;
  const ana = users.find((u) => u.email === 'ana.moreno@example.com');
  const marco = users.find((u) => u.email === 'marco.bellini@example.com');
  const sofia = users.find((u) => u.email === 'sofia.lindqvist@example.com');
  assert.equal(ana.id, PERSONAS.ana.id);
  assert.equal(marco.id, PERSONAS.marco.id);
  assert.equal(sofia.role, 'staff');

  const cloud = courses.find((c) => c.title === 'Cloud Foundations');
  assert.deepEqual(enrolments.filter((e) => e.user_id === ana.id).map((e) => e.course_id), [cloud.id]);
  const anaProgress = progress.lessons.filter((p) => p.user_id === ana.id);
  assert.equal(completionPercent(anaProgress, { lessons: lessons.filter((l) => l.course_id === cloud.id) }), 35);
  const anaActivity = progress.courses.find((c) => c.user_id === ana.id).last_activity_at;
  assert.equal(dayOf(anaActivity), -33);
  assert.equal(notifications.filter((n) => n.user_id === ana.id && !n.read_at).length, 0);
  const anaSignIns = result.sim.requests.filter((r) => r.userId === ana.id && r.route === '/api/auth/login');
  assert.ok(anaSignIns.filter((r) => r.ts > Date.parse(anaActivity)).length >= 8, 'Ana still signs in every few days');

  assert.equal(enrolments.filter((e) => e.user_id === marco.id).length, 2);
  const marcoLast = progress.courses.filter((c) => c.user_id === marco.id).map((c) => c.last_activity_at).sort().at(-1);
  assert.equal(dayOf(marcoLast), -1);
});
