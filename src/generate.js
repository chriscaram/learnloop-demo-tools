// Entry point used by the CLI, the upload script and the tests.
import { DAY_MS, HISTORY_DAYS, LEARNING_ROUTES, simulate } from './model.js';
import { emitLogs } from './emit.js';
import { DEFAULT_SCENARIO, getScenario } from './scenarios.js';

export const PLACEHOLDER_DISTRIBUTION_ID = 'E000000SEEDLOG';
export const PLACEHOLDER_DISTRIBUTION_DOMAIN = 'd000000seedlog.cloudfront.net';

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

export function generate({
  anchor = todayUtc(), salt, seed = 42, scenario = DEFAULT_SCENARIO,
  distributionId = PLACEHOLDER_DISTRIBUTION_ID, distributionDomain = PLACEHOLDER_DISTRIBUTION_DOMAIN,
} = {}) {
  if (!salt) throw new Error('--salt is required (use the value stored in /learnloop/prod/log-pseudonym-salt)');
  const def = typeof scenario === 'object' && scenario ? scenario : getScenario(scenario);
  const sim = simulate({ anchor, seed, scenario: def });
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
    scenario: sim.scenario.id,
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
    slowRelease: sim.slowRelease,
    ...detectorView(sim, api, dayOf, learnerIds),
    daily: dailySeries(sim, api, dayOf, learnerIds),
  };
}

/** Lesson routes, plus the quiz route, as the page and the detector view group them. */
const LESSON_ROUTES = new Set([...LEARNING_ROUTES, '/api/lessons/{lessonId}/quiz']);
/** The broadest plausible "Course delivery and learner progress" capability: every learning-service route. */
const LEARNING_SERVICE_ROUTES = new Set([...LESSON_ROUTES, '/api/me/progress']);

/**
 * The numbers the Governance Agent's detectors compare, computed the way they compute
 * them, over the two 30-day windows its telemetry read covers (days -59..-30 and
 * -29..0; day 0 holds no seeded history). Distinct users are counted per route, like
 * the route-level actor windows; the error share is weighted over the learning routes,
 * like a capability's server_error_pct; the trend is split-half means of daily
 * requests, like trendOf().
 */
function detectorView(sim, api, dayOf, learnerIds) {
  const windows = { earlier: [-59, -30], recent: [-29, -1] };
  const view = {};
  for (const [name, [from, to]] of Object.entries(windows)) {
    const inWin = api.filter((r) => { const d = dayOf(r.ts); return d >= from && d <= to; });
    const usersOn = (route) => new Set(inWin.filter((r) => r.route === route && r.userId).map((r) => r.userId)).size;
    const lessonLatencies = inWin.filter((r) => LESSON_ROUTES.has(r.route)).map((r) => r.latencyMs);
    const learning = inWin.filter((r) => LEARNING_SERVICE_ROUTES.has(r.route));
    view[name] = {
      days: `${from}..${to === -1 ? 0 : to}`,
      usersOnLessonRoutes: new Set(inWin.filter((r) => LEARNING_ROUTES.includes(r.route) && learnerIds.has(r.userId)).map((r) => r.userId)).size,
      usersPerRoute: Object.fromEntries([...LESSON_ROUTES, '/api/me/progress'].map((route) => [route, usersOn(route)])),
      lessonP95Ms: percentile(lessonLatencies, 95),
      lessonP99Ms: percentile(lessonLatencies, 99),
      lessonLatencySamples: lessonLatencies.length,
      learningServerErrorPct: learning.length ? Math.round((learning.filter((r) => r.status >= 500).length / learning.length) * 10_000) / 100 : 0,
      lessonOnlyServerErrorPct: (() => {
        const lessons = inWin.filter((r) => LESSON_ROUTES.has(r.route));
        return lessons.length ? Math.round((lessons.filter((r) => r.status >= 500).length / lessons.length) * 10_000) / 100 : 0;
      })(),
    };
  }
  const dropPct = (route) => {
    const a = view.earlier.usersPerRoute[route];
    const b = view.recent.usersPerRoute[route];
    return a ? Math.round(((a - b) / a) * 1000) / 10 : null;
  };
  // split-half trend of daily requests on the learning routes over days -59..-1 (59 observed days)
  const perDay = new Map();
  for (const r of api) {
    if (!LEARNING_SERVICE_ROUTES.has(r.route)) continue;
    const d = dayOf(r.ts);
    if (d >= -59 && d <= -1) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  }
  const series = [];
  for (let d = -59; d <= -1; d += 1) series.push(perDay.get(d) ?? 0);
  const mid = Math.floor(series.length / 2);
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const firstHalf = mean(series.slice(0, mid));
  const secondHalf = mean(series.slice(mid));
  return {
    detectorWindows: view,
    distinctUserDropPct: Object.fromEntries([...LESSON_ROUTES, '/api/me/progress'].map((route) => [route, dropPct(route)])),
    lessonUsersDropPct: view.earlier.usersOnLessonRoutes
      ? Math.round(((view.earlier.usersOnLessonRoutes - view.recent.usersOnLessonRoutes) / view.earlier.usersOnLessonRoutes) * 1000) / 10 : null,
    learningRequestTrendPct: firstHalf ? Math.round(((secondHalf - firstHalf) / firstHalf) * 1000) / 10 : null,
  };
}

/** One row per simulated day, for the simulator page's chart. */
function dailySeries(sim, api, dayOf, learnerIds) {
  const days = [];
  const byDay = new Map();
  for (let d = -HISTORY_DAYS; d <= -1; d += 1) {
    const row = {
      day: d, date: new Date(sim.anchorMs + d * DAY_MS).toISOString().slice(0, 10), requests: 0, signIns: 0,
      lessonStarts: 0, lessonCompletions: 0, cancellations: 0, lessonRequests: 0, lessonErrors: 0, lessonLatencies: [], learners: new Set(),
    };
    byDay.set(d, row);
    days.push(row);
  }
  for (const r of sim.requests) {
    const row = byDay.get(dayOf(r.ts));
    if (!row) continue;
    row.requests += 1;
    if (r.kind !== 'api') continue;
    if (LESSON_ROUTES.has(r.route)) {
      row.lessonRequests += 1;
      row.lessonLatencies.push(r.latencyMs);
      if (r.status >= 500) row.lessonErrors += 1;
      if (LEARNING_ROUTES.includes(r.route) && learnerIds.has(r.userId)) row.learners.add(r.userId);
    }
    for (const e of r.events) {
      if (e.event === 'user_signed_in' && learnerIds.has(r.userId)) row.signIns += 1;
      else if (e.event === 'lesson_started') row.lessonStarts += 1;
      else if (e.event === 'lesson_completed') row.lessonCompletions += 1;
      else if (e.event === 'subscription_cancelled') row.cancellations += 1;
    }
  }
  return days.map((row, i) => {
    const week = new Set();
    for (let j = Math.max(0, i - 6); j <= i; j += 1) for (const u of days[j].learners) week.add(u);
    const { lessonLatencies, learners, ...rest } = row;
    return {
      ...rest,
      learnersOnLessons: learners.size,
      // a full week is needed for a weekly count; the first six days have none
      learnersOnLessons7d: i >= 6 ? week.size : null,
      lessonP95Ms: percentile(lessonLatencies, 95),
      lessonErrorPct: row.lessonRequests ? Math.round((row.lessonErrors / row.lessonRequests) * 1000) / 10 : 0,
    };
  });
}
