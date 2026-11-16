// Entry point used by the CLI, the upload script and the tests.
import { DAY_MS, HISTORY_DAYS, LEARNING_ROUTES, simulate } from './model.js';
import { replyDueAt } from './contract/support.js';
import { emitLogs } from './emit.js';
import { SUPPORT_REPLY_NOTIFICATION } from './contract/actions.js';
import { DEFAULT_SCENARIO, getScenario, stageOf } from './scenarios.js';

export const PLACEHOLDER_DISTRIBUTION_ID = 'E000000SEEDLOG';
export const PLACEHOLDER_DISTRIBUTION_DOMAIN = 'd000000seedlog.cloudfront.net';

export function todayUtc(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/**
 * `stage` (a staged scenario only, 1..n; README "Presenting the staged reveal"): the same
 * generation with the stage's withheld traffic and state left out. No stage, or the last
 * one, is the whole scenario, byte for byte.
 */
export function generate({
  anchor = todayUtc(), salt, seed = 42, scenario = DEFAULT_SCENARIO, stage = null,
  distributionId = PLACEHOLDER_DISTRIBUTION_ID, distributionDomain = PLACEHOLDER_DISTRIBUTION_DOMAIN,
} = {}) {
  if (!salt) throw new Error('--salt is required (use the value stored in /learnloop/prod/log-pseudonym-salt)');
  const def = typeof scenario === 'object' && scenario ? scenario : getScenario(scenario);
  const st = stageOf(def, stage);
  const sim = simulate({ anchor, seed, scenario: def });
  const withhold = stageWithhold(sim, st);
  const logs = emitLogs(sim, { salt, seed, distributionId, distributionDomain, withhold });
  const view = stageView(sim, st);
  return { sim, data: view.data, ...logs, stats: stageStats(view, logs, st), stage: st?.stage ?? null };
}

/** The simulation as a stage shows it: withheld requests and state left out (the same object for no stage). */
export function stageView(sim, st) {
  const withhold = stageWithhold(sim, st);
  const data = stageState(sim.data, st);
  if (!withhold && data === sim.data) return sim;
  return { ...sim, data, requests: withhold ? sim.requests.filter((r) => !isWithheld(r, withhold)) : sim.requests };
}

/** computeStats over a stage view, labelled with the stage. */
export function stageStats(view, logs, st) {
  return { ...computeStats(view, logs), stage: st ? { stage: st.stage, of: st.count, addsCase: st.addsCase } : null };
}

/** What a stage leaves out of the logs: null when nothing (no stage, or the last one). */
export function stageWithhold(sim, st) {
  if (!st || st.withheldRoutes.size === 0) return null;
  return { routes: st.withheldRoutes, fromMs: sim.anchorMs + st.fromDay * DAY_MS };
}
/** Whether one simulated request is left out (by its start time; the logs decide per line). */
export const isWithheld = (r, withhold) => !!withhold && r.kind === 'api' && r.ts >= withhold.fromMs && withhold.routes.has(`${r.method} ${r.route}`);

/** The starting state of a stage: the withheld documents written empty. */
export function stageState(data, st) {
  if (!st || st.stateWithheld.size === 0) return data;
  const out = { ...data };
  if (st.stateWithheld.has('carts')) out.carts = [];
  if (st.stateWithheld.has('support_requests')) out.support_requests = [];
  if (st.stateWithheld.has('support_reply_notifications')) out.notifications = data.notifications.filter((n) => n.type !== SUPPORT_REPLY_NOTIFICATION.type);
  return out;
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
    carts: cartView(sim, api, dayOf),
    support: supportView(sim, dayOf),
    capabilities: capabilityView(api, dayOf),
  };
}

// The Governance Agent's ACTOR_INACTIVITY bars (drift/constants.js): a drop of at least
// ACTOR_INACTIVITY_DROP_PCT in distinct users between the two windows, with at least
// MIN_INACTIVITY_ACTORS in the earlier one.
export const INACTIVITY_BARS = Object.freeze({ dropPct: 33, minEarlierActors: 200 });

/**
 * Per LearnLoop service (one service directory = one code component, which is what
 * the agent's declared_in_code route rule maps a route to, and so one capability):
 * distinct client IPs per route (method-agnostic) in each detector window, the
 * service-level max across its routes (the capability-level count), its server-error
 * share, and the routes that cross the inactivity bars, ordered the way
 * detectActorInactivity names them (earlier actors, then route).
 */
function capabilityView(api, dayOf) {
  const windows = { earlier: [-59, -30], recent: [-29, -1] };
  const byService = new Map();
  for (const r of api) {
    const d = dayOf(r.ts);
    const w = d >= windows.earlier[0] && d <= windows.earlier[1] ? 'earlier' : d >= windows.recent[0] && d <= windows.recent[1] ? 'recent' : null;
    if (!w) continue;
    if (!byService.has(r.service)) byService.set(r.service, { routes: new Map(), earlier: { requests: 0, errors: 0 }, recent: { requests: 0, errors: 0 } });
    const svc = byService.get(r.service);
    svc[w].requests += 1;
    if (r.status >= 500) svc[w].errors += 1;
    if (!svc.routes.has(r.route)) svc.routes.set(r.route, { earlier: new Set(), recent: new Set() });
    svc.routes.get(r.route)[w].add(r.ip);
  }
  const drop = (a, b) => (a ? Math.round(((a - b) / a) * 1000) / 10 : null);
  // A route with no request in a window has no baseline for that window at all (the
  // agent writes one per route it saw), so it is unmeasured there, not a 100% drop.
  const routeDrop = (a, b) => (a && b ? drop(a, b) : null);
  const out = {};
  for (const [service, svc] of [...byService.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const routes = Object.fromEntries([...svc.routes.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([route, w]) => [route, {
      earlier: w.earlier.size, recent: w.recent.size, dropPct: routeDrop(w.earlier.size, w.recent.size),
    }]));
    const max = (w) => Math.max(0, ...Object.values(routes).map((r) => r[w]));
    const inactiveRoutes = Object.entries(routes)
      .filter(([, r]) => r.dropPct !== null && r.earlier >= INACTIVITY_BARS.minEarlierActors && r.dropPct >= INACTIVITY_BARS.dropPct)
      .sort((a, b) => (b[1].earlier - a[1].earlier) || a[0].localeCompare(b[0]))
      .map(([route]) => route);
    out[service] = {
      routes,
      serviceMax: { earlier: max('earlier'), recent: max('recent'), dropPct: drop(max('earlier'), max('recent')) },
      serverErrorPct: Object.fromEntries(['earlier', 'recent'].map((w) => [w, svc[w].requests ? Math.round((svc[w].errors / svc[w].requests) * 10_000) / 100 : 0])),
      inactiveRoutes,
    };
  }
  return out;
}

/** Enrolment and cart routes, the support routes: what a route-level distinct-actor window counts. */
export const COMMERCE_ROUTES = Object.freeze([
  '/api/courses/{courseId}/enrol', '/api/me/cart', '/api/me/cart/items', '/api/me/cart/items/{courseId}',
  '/api/me/support-requests', '/api/admin/support-requests', '/api/admin/support-requests/{requestId}/reply',
]);

/**
 * Per route and detector window: distinct signed-in users, distinct client IPs (the
 * CloudFront actor key is a keyed hash of c-ip, so shared addresses count once), and
 * requests. Then the cart's end state.
 */
function cartView(sim, api, dayOf) {
  const windows = { earlier: [-59, -30], recent: [-29, -1] };
  const actors = {};
  for (const [name, [from, to]] of Object.entries(windows)) {
    const inWin = api.filter((r) => { const d = dayOf(r.ts); return d >= from && d <= to; });
    actors[name] = Object.fromEntries(COMMERCE_ROUTES.map((route) => {
      const rows = inWin.filter((r) => r.route === route);
      return [route, { users: new Set(rows.filter((r) => r.userId).map((r) => r.userId)).size, ips: new Set(rows.map((r) => r.ip)).size, requests: rows.length }];
    }));
  }
  const drop = (route, key) => {
    const a = actors.earlier[route][key];
    return a ? Math.round(((a - actors.recent[route][key]) / a) * 1000) / 10 : null;
  };
  const events = (name, from, to) => api.reduce((n, r) => n + r.events.filter((e) => e.event === name && dayOf(e.ts) >= from && dayOf(e.ts) <= to).length, 0);
  const carts = sim.data.carts;
  const items = carts.flatMap((c) => c.items);
  return {
    actorWindows: actors,
    enrolDropPct: { users: drop('/api/courses/{courseId}/enrol', 'users'), ips: drop('/api/courses/{courseId}/enrol', 'ips') },
    cartAddDropPct: { users: drop('/api/me/cart/items', 'users'), ips: drop('/api/me/cart/items', 'ips') },
    cartReadDropPct: { users: drop('/api/me/cart', 'users'), ips: drop('/api/me/cart', 'ips') },
    events: Object.fromEntries(Object.entries(windows).map(([name, [from, to]]) => [name, {
      cartItemsAdded: events('cart_item_added', from, to),
      cartItemsRemoved: events('cart_item_removed', from, to),
      enrolments: events('course_enrolled', from, to),
    }])),
    endState: {
      learnersWithItems: carts.length,
      items: items.length,
      oldestItemDay: items.length ? Math.min(...items.map((i) => dayOf(Date.parse(i.added_at)))) : null,
      newestItemDay: items.length ? Math.max(...items.map((i) => dayOf(Date.parse(i.added_at)))) : null,
    },
  };
}

/** ISO weeks (Monday to Sunday) inside days -60..-1: questions asked and answered, reply times, the questions still open. */
function supportView(sim, dayOf) {
  const requests = sim.data.support_requests;
  const median = (xs) => {
    if (!xs.length) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    return Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10;
  };
  const weeks = [];
  const firstMonday = (() => {
    let d = -HISTORY_DAYS;
    while (new Date(sim.anchorMs + d * DAY_MS).getUTCDay() !== 1) d += 1;
    return d;
  })();
  for (let start = firstMonday; start + 6 <= -1; start += 7) {
    const end = start + 6;
    const fromMs = sim.anchorMs + start * DAY_MS;
    const toMs = sim.anchorMs + (end + 1) * DAY_MS;
    const asked = requests.filter((r) => { const t = Date.parse(r.created_at); return t >= fromMs && t < toMs; });
    const answered = requests.filter((r) => r.answered_at && Date.parse(r.answered_at) >= fromMs && Date.parse(r.answered_at) < toMs);
    weeks.push({
      days: `${start}..${end}`,
      from: new Date(fromMs).toISOString().slice(0, 10),
      asked: asked.length,
      answered: answered.length,
      medianReplyHours: median(answered.map((r) => (Date.parse(r.answered_at) - Date.parse(r.created_at)) / 3_600_000)),
      answeredWithinTarget: answered.filter((r) => Date.parse(r.answered_at) <= replyDueAt(r.created_at).getTime()).length,
      openAtEnd: requests.filter((r) => Date.parse(r.created_at) < toMs && (!r.answered_at || Date.parse(r.answered_at) >= toMs)).length,
      topics: asked.reduce((acc, r) => ({ ...acc, [r.topic]: (acc[r.topic] ?? 0) + 1 }), {}),
    });
  }
  const anchorDate = new Date(sim.anchorMs);
  const open = requests.filter((r) => r.status === 'open');
  const helpLearners = (from, to) => new Set(sim.requests.filter((q) => q.route === '/api/me/support-requests' && q.userId
    && dayOf(q.ts) >= from && dayOf(q.ts) <= to).map((q) => q.userId)).size;
  const answeredIn = (from, to) => requests.filter((r) => { const d = dayOf(Date.parse(r.created_at)); return d >= from && d <= to; });
  const windowView = (from, to) => {
    const asked = answeredIn(from, to);
    return {
      helpLearners: helpLearners(from, to),
      asked: asked.length,
      answeredWithinTarget: asked.filter((r) => r.answered_at && Date.parse(r.answered_at) <= replyDueAt(r.created_at).getTime()).length,
      medianReplyHours: median(asked.filter((r) => r.answered_at).map((r) => (Date.parse(r.answered_at) - Date.parse(r.created_at)) / 3_600_000)),
    };
  };
  return {
    total: requests.length,
    windows: { earlier: windowView(-59, -30), recent: windowView(-29, -1) },
    weeks,
    endState: {
      open: open.length,
      overdueAtStart: open.filter((r) => replyDueAt(r.created_at) <= anchorDate).length,
      oldestOpenDay: open.length ? Math.min(...open.map((r) => dayOf(Date.parse(r.created_at)))) : null,
      openTopics: open.reduce((acc, r) => ({ ...acc, [r.topic]: (acc[r.topic] ?? 0) + 1 }), {}),
    },
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
