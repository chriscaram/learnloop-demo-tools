// Entry point used by the CLI, the upload script and the tests.
import { DAY_MS, HISTORY_DAYS, LEARNING_ROUTES, simulate } from './model.js';
import { emitLogs } from './emit.js';

export const PLACEHOLDER_DISTRIBUTION_ID = 'E000000SEEDLOG';
export const PLACEHOLDER_DISTRIBUTION_DOMAIN = 'd000000seedlog.cloudfront.net';

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function generate({
  anchor = todayUtc(), salt, seed = 42,
  distributionId = PLACEHOLDER_DISTRIBUTION_ID, distributionDomain = PLACEHOLDER_DISTRIBUTION_DOMAIN,
} = {}) {
  if (!salt) throw new Error('--salt is required (use the value stored in /learnloop/prod/log-pseudonym-salt)');
  const sim = simulate({ anchor, seed });
  const logs = emitLogs(sim, { salt, seed, distributionId, distributionDomain });
  return { sim, data: sim.data, ...logs, stats: computeStats(sim, logs) };
}

const percentile = (values, p) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

export function computeStats(sim, logs) {
  const dayOf = (ms) => Math.floor((ms - sim.anchorMs) / DAY_MS);
  const learnerIds = new Set(sim.learners.map((u) => u.id));
  const api = sim.requests.filter((r) => r.kind === 'api');
  const inDays = (from, to) => (r) => {
    const d = dayOf(r.ts);
    return d >= from && d <= to;
  };
  const learningUsers = (from, to) => new Set(api
    .filter(inDays(from, to))
    .filter((r) => LEARNING_ROUTES.includes(r.route) && learnerIds.has(r.userId))
    .map((r) => r.userId)).size;
  const events = api.flatMap((r) => r.events.map((e) => ({ ...e, userId: r.userId })));
  const allEvents = [...events, ...sim.systemEvents];
  const countEvents = (name, from, to, filter = () => true) => allEvents
    .filter((e) => e.event === name && dayOf(e.ts) >= from && dayOf(e.ts) <= to && filter(e)).length;
  const learnerEvent = (e) => learnerIds.has(e.userId);
  const routeCount = (route, from, to) => api.filter(inDays(from, to)).filter((r) => r.route === route && learnerIds.has(r.userId)).length;

  const window = (from, to) => ({
    days: `${from}..${to}`,
    learnersOnLessons: learningUsers(from, to),
    signIns: countEvents('user_signed_in', from, to, learnerEvent),
    progressViews: routeCount('/api/me/progress', from, to),
    catalogViews: routeCount('/api/courses', from, to),
    lessonStarts: countEvents('lesson_started', from, to),
    lessonCompletions: countEvents('lesson_completed', from, to),
    cancellations: countEvents('subscription_cancelled', from, to),
    renewals: countEvents('subscription_renewed', from, to),
    staffMessages: countEvents('staff_message_sent', from, to),
  });

  const cloudfrontLines = (from, to) => sim.requests.filter(inDays(from, to)).length;
  const cloudfrontObjects = (from, to) => [...logs.cloudfront.keys()].filter((k) => {
    const [, stamp] = k.split('.');
    const day = dayOf(Date.parse(`${stamp.slice(0, 10)}T00:00:00Z`));
    return day >= from && day <= to;
  }).length;

  const weeks = [];
  for (let end = -1; end - 6 >= -HISTORY_DAYS; end -= 7) {
    const start = end - 6;
    weeks.unshift({
      days: `${start}..${end}`,
      from: new Date(sim.anchorMs + start * DAY_MS).toISOString().slice(0, 10),
      to: new Date(sim.anchorMs + end * DAY_MS).toISOString().slice(0, 10),
      learnersOnLessons: learningUsers(start, end),
      lessonCompletions: countEvents('lesson_completed', start, end),
      cancellations: countEvents('subscription_cancelled', start, end),
      signIns: countEvents('user_signed_in', start, end, learnerEvent),
    });
  }

  // health: worst 5xx share per route per day, p95 latency per day for lesson and other routes
  const byRouteDay = new Map();
  const latency = new Map();
  for (const r of api) {
    const key = `${r.route}|${dayOf(r.ts)}`;
    const entry = byRouteDay.get(key) ?? { total: 0, errors: 0 };
    entry.total += 1;
    if (r.status >= 500) entry.errors += 1;
    byRouteDay.set(key, entry);
    const cls = `${LEARNING_ROUTES.includes(r.route) || r.route === '/api/lessons/{lessonId}/quiz' ? 'lessons' : 'other'}|${dayOf(r.ts)}`;
    if (!latency.has(cls)) latency.set(cls, []);
    latency.get(cls).push(r.latencyMs);
  }
  const worst5xx = Math.max(...[...byRouteDay.values()].map((e) => e.errors / e.total));
  const p95 = (cls) => [...latency.entries()].filter(([k]) => k.startsWith(cls)).map(([, v]) => percentile(v, 95));

  return {
    window1: window(-60, -31),
    window2: window(-30, -1),
    fortnightBefore: window(-44, -31),
    fortnightLast: window(-14, -1),
    firstFortnight: window(-60, -46),
    weeks,
    volume: {
      cloudfrontLinesWindow1: cloudfrontLines(-60, -31),
      cloudfrontLinesWindow2: cloudfrontLines(-30, -1),
      cloudfrontObjectsWindow1: cloudfrontObjects(-60, -31),
      cloudfrontObjectsWindow2: cloudfrontObjects(-30, -1),
      appLogObjects: logs.appLogs.size,
    },
    health: {
      worst5xxShare: worst5xx,
      lessonsP95: { min: Math.min(...p95('lessons')), max: Math.max(...p95('lessons')) },
      otherP95: { min: Math.min(...p95('other')), max: Math.max(...p95('other')) },
      versions: sim.versions.map((v) => ({ version: v.version, from: new Date(v.fromMs).toISOString() })),
    },
    population: {
      learners: sim.learners.length,
      staff: sim.staff.length,
      cancelledByEnd: sim.data.subscriptions.filter((s) => s.status === 'cancelled').length,
    },
  };
}
