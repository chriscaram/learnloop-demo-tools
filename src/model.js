// Behaviour model for the seeded history. One simulation produces both the
// request stream (turned into CloudFront and application logs by emit.js) and
// the end state (written as data/seed/*.json), so the two always agree.
import { addMonths } from './contract/billing.js';
import {
  BROWSER_USER_AGENTS, COURSES, EDGE_LOCATIONS, FIRST_NAMES, HOURLY_WEIGHTS, LAST_NAMES, WEEKDAY_FACTORS,
} from './content.js';
import { createRng } from './rng.js';
import { getScenario } from './scenarios.js';

export const DAY_MS = 86_400_000;
export const HISTORY_DAYS = 60;
const MIN_MS = 60_000;

export const PERSONAS = Object.freeze({
  ana: { id: 'usr_a7e3c1d90b42', email: 'ana.moreno@example.com', name: 'Ana Moreno' },
  marco: { id: 'usr_5d81f0c3a9e6', email: 'marco.bellini@example.com', name: 'Marco Bellini' },
  sofia: { id: 'usr_c4f2b7e1d038', email: 'sofia.lindqvist@example.com', name: 'Sofia Lindqvist' },
});
const OTHER_STAFF = [
  { email: 'daniel.okafor@example.com', name: 'Daniel Okafor' },
  { email: 'priya.nair@example.com', name: 'Priya Nair' },
];

// The lapsed-learners split; a scenario chooses its own (scenarios/*.json `population`).
export const POPULATION = Object.freeze({ learners: 420, cohortA: 195, cohortB: 145, cohortC: 80 });
export const OFFICE_IP = '203.0.113.10';
export const CRAWLER_IPS = ['198.51.100.201', '198.51.100.202', '198.51.100.203', '198.51.100.204'];

/** Routes used for the "learners on lessons" metrics. */
export const LEARNING_ROUTES = Object.freeze([
  '/api/lessons/{lessonId}',
  '/api/lessons/{lessonId}/progress',
  '/api/courses/{courseId}/lessons',
]);
const SLOW_ROUTES = new Set([...LEARNING_ROUTES, '/api/lessons/{lessonId}/quiz']);

// Ana's lesson sessions: [day, lessonIndex, completes]
const ANA_LESSON_SCRIPT = [
  [-58, 0, false], [-55, 0, true], [-51, 1, false], [-48, 1, true],
  [-44, 2, false], [-40, 2, true], [-37, 3, false], [-33, 3, false],
];
const ANA_VISIT_DAYS = [-30, -27, -24, -22, -19, -16, -13, -10, -8, -5, -3, -1];

const STAFF_MESSAGES = [
  ['Your invoice copy', 'As requested, a copy of your latest receipt is available on the Subscription page.'],
  ['About the video player issue', 'Thanks for reporting the playback problem. It has been fixed; please let us know if you still see it.'],
  ['Certificate question', 'Course certificates are not available yet. Your completed lessons are saved on your dashboard.'],
  ['Account email change', 'Your account email has been updated as you asked.'],
  ['Quiz scoring question', 'We checked the quiz you mentioned. The scoring was correct; the explanation has been clarified.'],
  ['Team access question', 'LearnLoop plans are individual for now. Each member of your team needs their own subscription.'],
  ['Re: lesson content', 'Thanks for the correction in the lesson text. We have updated it.'],
  ['Payment method update', 'Your payment details are handled in the Subscription page. Nothing else is needed from you.'],
];

const iso = (ms) => new Date(ms).toISOString();

/**
 * `scenario` is a validated definition (src/scenarios.js) or a scenario id; the default
 * is lapsed-learners, whose output is byte-identical to the generator before scenarios
 * existed. Every parameter below that a scenario leaves null draws no random number,
 * so one scenario's choices never shift another's streams.
 */
export function simulate({ anchor, seed, scenario = undefined }) {
  const def = typeof scenario === 'object' && scenario ? scenario : getScenario(scenario);
  const P = def.parameters;
  const pop = { learners: 420, cohortA: P.population.regular, cohortB: P.population.lapsing, cohortC: P.population.rarelyActive };
  const anchorMs = Date.parse(`${anchor}T00:00:00.000Z`);
  if (Number.isNaN(anchorMs)) throw new Error(`invalid anchor date: ${anchor}`);
  const dayStart = (day) => anchorMs + day * DAY_MS;
  const windowStart = dayStart(-HISTORY_DAYS);

  // ---------------------------------------------------------------- ids
  const idRng = createRng(seed, 'ids');
  const usedIds = new Set(Object.values(PERSONAS).map((p) => p.id));
  const newId = (prefix) => {
    let id;
    do id = `${prefix}_${idRng.hex(12)}`; while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };

  // ---------------------------------------------------------------- catalog
  const catRng = createRng(seed, 'catalog');
  const courses = [];
  const lessons = [];
  const lessonsByCourse = new Map();
  for (const spec of COURSES) {
    const courseId = newId('crs');
    const mid = Math.floor((spec.lessons.length - 1) / 2);
    const courseLessons = spec.lessons.map(([title, duration], index) => ({
      id: newId('les'),
      course_id: courseId,
      position: index + 1,
      title,
      duration_min: duration,
      body_md: lessonBody(spec, title, index),
      quiz: index === mid ? buildQuiz(catRng, spec.quiz.slice(0, 3)) : index === spec.lessons.length - 1 ? buildQuiz(catRng, spec.quiz.slice(3, 6)) : null,
    }));
    const total = courseLessons.reduce((s, l) => s + l.duration_min, 0);
    courses.push({
      id: courseId,
      title: spec.title,
      category: spec.category,
      level: spec.level,
      summary: spec.summary,
      description: `${spec.summary} ${courseLessons.length} lessons, about ${Math.round(total / 6) / 10} hours in total, with two short quizzes to check your understanding.`,
      lesson_ids: courseLessons.map((l) => l.id),
      duration_min: total,
      published_at: iso(dayStart(-spec.publishedDaysAgo) + 15 * 3600_000),
      _popularity: spec.popularity,
      _key: spec.key,
    });
    lessons.push(...courseLessons);
    lessonsByCourse.set(courseId, courseLessons);
  }
  const courseByKey = new Map(courses.map((c) => [c._key, c]));
  const lessonById = new Map(lessons.map((l) => [l.id, l]));

  // ---------------------------------------------------------------- people
  const popRng = createRng(seed, 'people');
  const staff = [
    { ...PERSONAS.sofia, role: 'staff', created_at: iso(dayStart(-430) + 9 * 3600_000) },
    ...OTHER_STAFF.map((s, i) => ({ id: newId('usr'), ...s, role: 'staff', created_at: iso(dayStart(-400 + i * 90) + 9 * 3600_000) })),
  ];
  for (const s of staff) Object.assign(s, { ip: OFFICE_IP, ua: BROWSER_USER_AGENTS[i0(s)][0], edge: 'LHR61-P4', notifications: [], cachedVersion: null, isStaff: true });

  const namePairs = popRng.shuffle(FIRST_NAMES.flatMap((f) => LAST_NAMES.map((l) => [f, l])));
  const emails = new Set([PERSONAS.ana.email, PERSONAS.marco.email, ...staff.map((s) => s.email)]);
  const learners = [];
  const makeLearner = (base) => ({
    role: 'learner', ...base, enrolled: [], lessonState: new Map(), activity: new Map(), notifications: [],
    cachedVersion: null, quiz: [], cancelled: false,
  });
  learners.push(makeLearner({ ...PERSONAS.ana, persona: 'ana' }));
  learners.push(makeLearner({ ...PERSONAS.marco, persona: 'marco' }));
  for (const [first, last] of namePairs) {
    if (learners.length >= pop.learners) break;
    let email = `${first}.${last}@example.com`.toLowerCase();
    for (let n = 2; emails.has(email); n += 1) email = `${first}.${last}${n}@example.com`.toLowerCase();
    emails.add(email);
    learners.push(makeLearner({ id: newId('usr'), email, name: `${first} ${last}`, persona: null }));
  }

  // cohorts A, B and C
  const others = popRng.shuffle(learners.slice(2));
  const cohortA = [learners[1], ...others.slice(0, pop.cohortA - 1)];
  const cohortB = [learners[0], ...others.slice(pop.cohortA - 1, pop.cohortA + pop.cohortB - 2)];
  const cohortC = others.slice(pop.cohortA + pop.cohortB - 2);
  for (const u of cohortA) u.group = 'cohortA';
  for (const u of cohortB) u.group = 'cohortB';
  for (const u of cohortC) u.group = 'cohortC';

  // network identity: one stable IP per learner (a few share), one browser, one nearby edge
  const reserved = new Set([OFFICE_IP, ...CRAWLER_IPS]);
  const ipPool = popRng.shuffle(['192.0.2', '198.51.100', '203.0.113']
    .flatMap((net) => Array.from({ length: 254 }, (_, i) => `${net}.${i + 1}`))
    .filter((ip) => !reserved.has(ip)));
  learners.forEach((u, i) => {
    u.ip = ipPool[i];
    u.ua = popRng.weighted(BROWSER_USER_AGENTS)[0];
    u.edge = popRng.weighted(EDGE_LOCATIONS)[0];
  });
  const sharers = popRng.shuffle(learners.slice(2)).slice(0, 16);
  for (let i = 0; i < sharers.length; i += 2) {
    sharers[i + 1].ip = sharers[i].ip; // same household or office
    sharers[i + 1].edge = sharers[i].edge;
  }

  // behaviour parameters
  const behRng = createRng(seed, 'behaviour');
  for (const u of learners) {
    const r = behRng.next();
    u.lessonDaysPerWeek = 2 + 3 * r * r; // 2..5, mean ~3
    u.browsePerDay = u.group === 'cohortC' ? behRng.float(0.06, 0.18) : 0.04;
    u.laterVisitsPerDay = behRng.float(0.26, 0.46);
    u.subStartMs = dayStart(-behRng.int(61, 200)) + behRng.int(8 * 60, 22 * 60) * MIN_MS + behRng.int(0, 59_999);
  }
  // lapse: cohort B's last lesson days, spread evenly over the scenario's span
  if (P.lapse) {
    const span = P.lapse.lastLessonToDay - P.lapse.lastLessonFromDay + 1;
    const lastLessonOrder = behRng.shuffle(cohortB.slice(1));
    lastLessonOrder.forEach((u, i) => {
      u.lastLessonDay = P.lapse.lastLessonFromDay + Math.floor((i * span) / lastLessonOrder.length);
      u.stopDay = u.lastLessonDay;
    });
  }
  learners[0].lastLessonDay = -33; // Ana's script, in every scenario

  // outage: who gives up on lessons after it (decided up front, from its own stream)
  const outage = P.outage;
  const inOutage = (day) => !!outage && day >= outage.fromDay && day <= outage.toDay;
  const lost = [];
  if (outage) {
    const outRng = createRng(seed, 'outage');
    const candidates = outRng.shuffle([...cohortA.slice(1), ...cohortB.slice(1)]);
    lost.push(...candidates.slice(0, Math.round(candidates.length * outage.giveUpShare)));
    for (const u of lost) {
      u.lostAfterOutage = true;
      u.stopDay = outage.toDay;
    }
  }

  // cancellation schedule: [first day, last day, how many from cohort C, how many from cohort B]
  const cxRng = createRng(seed, 'cancellations');
  const pickDay = (from, to) => {
    const days = [];
    for (let d = from; d <= to; d += 1) days.push([d, WEEKDAY_FACTORS[new Date(dayStart(d)).getUTCDay()]]);
    return cxRng.weighted(days)[0];
  };
  // learners who stopped opening lessons (lapsed, or gave up after the outage) cancel
  // at least five days after they stopped
  const poolC = cxRng.shuffle(cohortC);
  const poolB = cxRng.shuffle(P.lapse ? cohortB.slice(1) : lost);
  for (const { fromDay: from, toDay: to, rarelyActive: fromC, stoppedLearning: fromB } of P.cancellations) {
    for (let i = 0; i < fromC; i += 1) poolC.pop().cancelDay = pickDay(from, to);
    for (let i = 0; i < fromB; i += 1) {
      const day = pickDay(from, to);
      const index = poolB.findIndex((u) => u.stopDay <= day - 5);
      if (index >= 0) poolB.splice(index, 1)[0].cancelDay = day;
    }
  }

  // ---------------------------------------------------------------- shared state helpers
  const notifications = [];
  const quizResults = [];
  const notify = (user, type, title, body, link, ms) => {
    const n = { id: newId('ntf'), user_id: user.id, type, title, body, link, created_at: iso(ms), read_at: null };
    notifications.push(n);
    user.notifications.push(n);
    return n;
  };
  const renewalAt = (periodEndMs) => {
    const floor = Math.floor(periodEndMs / DAY_MS) * DAY_MS;
    return periodEndMs <= floor + 10 * MIN_MS ? floor + 10 * MIN_MS : floor + DAY_MS + 10 * MIN_MS;
  };
  const receiptBody = (sub) => `Your monthly plan is paid until ${sub.current_period_end.slice(0, 10)}.`;

  const enrol = (u, course, ms) => {
    u.enrolled.push({ id: newId('enr'), user_id: u.id, course_id: course.id, enrolled_at: iso(ms) });
    if (!u.activity.has(course.id)) u.activity.set(course.id, null);
  };
  const touch = (u, lesson, status, ms) => {
    const at = iso(ms);
    let rec = u.lessonState.get(lesson.id);
    if (!rec) {
      rec = { user_id: u.id, course_id: lesson.course_id, lesson_id: lesson.id, status: 'started', started_at: at, completed_at: null };
      u.lessonState.set(lesson.id, rec);
    }
    if (status === 'completed' && rec.status !== 'completed') {
      rec.status = 'completed';
      rec.completed_at = at;
    }
    const prev = u.activity.get(lesson.course_id);
    if (!prev || prev < at) u.activity.set(lesson.course_id, at);
  };
  const nextLesson = (u, courseId) => lessonsByCourse.get(courseId).find((l) => u.lessonState.get(l.id)?.status !== 'completed') ?? null;
  const currentCourse = (u) => {
    const open = u.enrolled.map((e) => e.course_id).filter((id) => nextLesson(u, id));
    if (open.length === 0) return null;
    return open.sort((a, b) => (u.activity.get(b) ?? '').localeCompare(u.activity.get(a) ?? ''))[0];
  };
  const chooseNewCourse = (rng, u, ms) => {
    const taken = new Set(u.enrolled.map((e) => e.course_id));
    const options = courses.filter((c) => !taken.has(c.id) && Date.parse(c.published_at) < ms);
    return options.length ? rng.weighted(options, (c) => c._popularity) : null;
  };
  const quizScore = (rng) => rng.weighted([[100, 5], [67, 4], [33, 1.5], [0, 0.5]])[0];

  // ---------------------------------------------------------------- history before the window (no logs)
  const preRng = createRng(seed, 'before-window');
  const subscriptions = [];
  for (const u of learners) {
    u.created_at = iso(u.subStartMs - preRng.int(2, 50) * MIN_MS);
    const sub = {
      id: newId('sub'), user_id: u.id, plan: 'monthly', price_usd: 19, status: 'active',
      started_at: iso(u.subStartMs), current_period_start: iso(u.subStartMs),
      current_period_end: addMonths(new Date(u.subStartMs), 1).toISOString(), cancelled_at: null,
    };
    u.sub = sub;
    subscriptions.push(sub);
    notify(u, 'welcome', 'Welcome to LearnLoop', 'Your subscription is active. Pick a course from the catalog to get started.', '/courses', u.subStartMs + 400);
    notify(u, 'payment_receipt', 'Payment received', receiptBody(sub), '/subscription', u.subStartMs + 900);
    u.nextRenewal = renewalAt(Date.parse(sub.current_period_end));
    while (u.nextRenewal < windowStart) {
      renewSilently(u, u.nextRenewal);
    }
  }
  function renewSilently(u, at) {
    advancePeriod(u.sub);
    notify(u, 'payment_receipt', 'Payment received', receiptBody(u.sub), '/subscription', at + 300);
    u.nextRenewal = renewalAt(Date.parse(u.sub.current_period_end));
  }
  function advancePeriod(sub) {
    sub.current_period_start = sub.current_period_end;
    sub.current_period_end = addMonths(new Date(sub.current_period_end), 1).toISOString();
  }

  // new course announcements before the window
  for (const course of courses.filter((c) => dayStart(-120) <= Date.parse(c.published_at))) {
    const ms = Date.parse(course.published_at) + 5 * MIN_MS;
    for (const u of learners.filter((x) => x.subStartMs < ms)) {
      notify(u, 'new_course_published', `New course: ${course.title}`, `"${course.title}" is now available in the catalog.`, `/courses/${course.id}`, ms);
    }
  }

  // learning progress before the window
  for (const u of learners) {
    const preDays = (windowStart - u.subStartMs) / DAY_MS;
    if (u.persona === 'ana') {
      enrol(u, courseByKey.get('cloud'), dayStart(-64) + 19 * 3600_000);
      continue;
    }
    if (u.persona === 'marco') {
      const sql = courseByKey.get('sql');
      const serverless = courseByKey.get('serverless');
      enrol(u, sql, u.subStartMs + 3600_000);
      enrol(u, serverless, dayStart(-70) + 18 * 3600_000);
      const [a, b] = lessonsByCourse.get(sql.id);
      touch(u, a, 'completed', dayStart(-80) + 19 * 3600_000);
      touch(u, b, 'completed', dayStart(-74) + 19 * 3600_000);
      touch(u, lessonsByCourse.get(serverless.id)[0], 'completed', dayStart(-66) + 20 * 3600_000);
      continue;
    }
    const firstEnrol = u.subStartMs + preRng.int(10, 48 * 60) * MIN_MS;
    if (firstEnrol >= windowStart - DAY_MS) continue;
    enrol(u, chooseNewCourse(preRng, u, firstEnrol), firstEnrol);
    const rate = u.group === 'cohortC' ? preRng.float(0, 0.12) : preRng.float(0.12, 0.35);
    const count = Math.round(preDays * rate);
    const times = Array.from({ length: count }, () => preRng.int(firstEnrol + 2 * 3600_000, windowStart - 2 * DAY_MS)).sort((x, y) => x - y);
    for (const ms of times) {
      let courseId = currentCourse(u);
      if (!courseId) {
        const next = chooseNewCourse(preRng, u, ms);
        if (!next) break;
        enrol(u, next, ms - preRng.int(5, 60) * MIN_MS);
        courseId = next.id;
      }
      const lesson = nextLesson(u, courseId);
      touch(u, lesson, 'started', ms - lesson.duration_min * MIN_MS);
      touch(u, lesson, 'completed', ms);
      if (lesson.quiz && preRng.chance(0.8)) {
        quizResults.push({ id: newId('qzr'), user_id: u.id, lesson_id: lesson.id, score: quizScore(preRng), correct: null, total: 3, submitted_at: iso(ms + 2 * MIN_MS) });
      }
    }
    if (u.group !== 'cohortC' && times.length && preRng.chance(0.4)) {
      const courseId = currentCourse(u);
      if (courseId) touch(u, nextLesson(u, courseId), 'started', times.at(-1) + preRng.int(1, 3) * DAY_MS);
    }
  }
  // reading of notifications created before the window
  for (const u of learners) {
    for (const n of u.notifications) {
      const created = Date.parse(n.created_at);
      const readsIt = u.group === 'cohortC' ? preRng.chance(0.6) : preRng.chance(0.95);
      const delay = (u.group === 'cohortC' ? preRng.float(0.5, 12) : preRng.float(0.05, 4)) * DAY_MS;
      if (readsIt && created + delay < windowStart) n.read_at = iso(created + delay);
    }
  }
  for (const q of quizResults) q.correct = Math.round((q.score / 100) * 3);

  // ---------------------------------------------------------------- releases
  const relRng = createRng(seed, 'releases');
  const versions = [];
  let releaseDay = -66;
  while (releaseDay < 0) {
    const ms = dayStart(releaseDay) + relRng.int(13 * 60, 16 * 60) * MIN_MS;
    versions.push({ fromMs: ms, version: relRng.hex(7), js: `index-${relRng.chars(8)}.js`, css: `index-${relRng.chars(8)}.css` });
    let gap = relRng.int(10, 14);
    while ([0, 6].includes(new Date(dayStart(releaseDay + gap)).getUTCDay())) gap -= 1;
    releaseDay += gap;
  }
  const versionAt = (ms) => {
    let current = versions[0];
    for (const v of versions) if (v.fromMs <= ms) current = v;
    return current;
  };
  // slowdown: starts with the first release on or after the scenario's day
  const slowRelease = P.slowdown ? versions.find((v) => v.fromMs >= dayStart(P.slowdown.fromReleaseOnOrAfterDay)) ?? null : null;
  if (P.slowdown && !slowRelease) throw new Error(`scenario ${def.id}: no release on or after day ${P.slowdown.fromReleaseOnOrAfterDay}`);

  // ---------------------------------------------------------------- the 60 days
  const simRng = createRng(seed, 'sessions');
  const netRng = createRng(seed, 'network');
  const requests = [];
  const systemEvents = [];
  const latencyNoise = new Map();
  const staffMessagesByDay = new Map();
  for (let week = 0; week * 7 < HISTORY_DAYS; week += 1) {
    const first = -HISTORY_DAYS + week * 7;
    const last = Math.min(first + 6, -1);
    const span = last - first + 1;
    const count = Math.round(simRng.weighted([[1, 15], [2, 25], [3, 25], [4, 20], [5, 10], [6, 5]])[0] * (span / 7));
    for (let i = 0; i < count; i += 1) {
      const days = [];
      for (let d = first; d <= last; d += 1) {
        const dow = new Date(dayStart(d)).getUTCDay();
        days.push([d, dow === 0 || dow === 6 ? 0.1 : 1]);
      }
      const d = simRng.weighted(days)[0];
      staffMessagesByDay.set(d, (staffMessagesByDay.get(d) ?? 0) + 1);
    }
  }
  let flagDay = -51;
  while ([0, 6].includes(new Date(dayStart(flagDay)).getUTCDay())) flagDay += 1;

  const routeLatency = (day, route, ts) => {
    const key = `${day}:${SLOW_ROUTES.has(route) ? 'slow' : 'fast'}`;
    if (!latencyNoise.has(key)) latencyNoise.set(key, 1 + Math.max(-0.06, Math.min(0.06, 0.025 * netRng.normal())));
    if (slowRelease && SLOW_ROUTES.has(route) && ts >= slowRelease.fromMs) {
      return Math.max(4, Math.round(netRng.lognormal(P.slowdown.lessonMedianMs * latencyNoise.get(key), P.slowdown.spread)));
    }
    const median = (SLOW_ROUTES.has(route) ? 72 : 36) * latencyNoise.get(key);
    return Math.max(4, Math.round(netRng.lognormal(median, 0.3)));
  };

  for (let day = -HISTORY_DAYS; day <= -1; day += 1) {
    const start = dayStart(day);
    const dow = new Date(start).getUTCDay();
    const factor = WEEKDAY_FACTORS[dow];
    const weekend = dow === 0 || dow === 6;

    // renewals: the daily billing job at 00:10 UTC
    const jobRequestId = simRng.uuid();
    const jobTraceId = simRng.hex(32);
    let jobOffset = 0;
    for (const u of learners) {
      if (u.sub.status !== 'active' || u.nextRenewal >= start + DAY_MS) continue;
      const at = u.nextRenewal + 150 + jobOffset * 37;
      jobOffset += 1;
      advancePeriod(u.sub);
      const n = notify(u, 'payment_receipt', 'Payment received', receiptBody(u.sub), '/subscription', at + 8);
      const base = { service: 'billing', requestId: jobRequestId, traceId: jobTraceId, userId: u.id, actorType: 'system' };
      systemEvents.push({ ...base, ts: at, event: 'subscription_renewed', entityType: 'subscription', entityId: u.sub.id });
      systemEvents.push({ ...base, ts: at + 8, event: 'notification_created', entityType: 'notification', entityId: n.id });
      systemEvents.push({ ...base, ts: at + 61, event: 'email_sent', entityType: 'email', entityId: `eml_${simRng.hex(12)}` });
      u.nextRenewal = renewalAt(Date.parse(u.sub.current_period_end));
    }

    // who visits today, and why
    const plans = [];
    for (const u of learners) {
      if (u.cancelled) continue;
      if (u.cancelDay === day) {
        plans.push({ user: u, type: 'cancel' });
        continue;
      }
      if (u.persona === 'ana') {
        const script = ANA_LESSON_SCRIPT.find(([d]) => d === day);
        if (script) plans.push({ user: u, type: 'lesson', script: { index: script[1], completes: script[2] } });
        else if (ANA_VISIT_DAYS.includes(day)) plans.push({ user: u, type: 'browse', readsAll: true });
        continue;
      }
      if (u.persona === 'marco' && day === -1) {
        plans.push({ user: u, type: 'lesson' });
        continue;
      }
      if (u.group === 'cohortC') {
        if (simRng.chance(u.browsePerDay * factor)) plans.push({ user: u, type: 'browse' });
        continue;
      }
      if (u.group === 'cohortB' && day === u.lastLessonDay) {
        plans.push({ user: u, type: 'lesson' });
        continue;
      }
      if (u.group === 'cohortB' && day > u.lastLessonDay) {
        if (simRng.chance(u.laterVisitsPerDay * factor)) plans.push({ user: u, type: 'browse' });
        continue;
      }
      if (u.lostAfterOutage && day > outage.toDay) {
        if (simRng.chance(u.laterVisitsPerDay * factor)) plans.push({ user: u, type: 'browse' });
        continue;
      }
      if (simRng.chance((u.lessonDaysPerWeek / 7) * factor)) plans.push({ user: u, type: 'lesson' });
      else if (simRng.chance(u.browsePerDay * factor)) plans.push({ user: u, type: 'browse' });
    }
    const messages = staffMessagesByDay.get(day) ?? 0;
    for (const s of staff) {
      const isSofia = s.id === PERSONAS.sofia.id;
      const visits = weekend ? simRng.chance(0.08) : simRng.chance(isSofia ? 0.75 : 0.55);
      if (visits || (isSofia && day === flagDay)) plans.push({ user: s, type: 'staff', messages: 0, flagChange: isSofia && day === flagDay });
    }
    if (messages > 0) {
      const staffPlans = plans.filter((p) => p.type === 'staff');
      if (staffPlans.length === 0) {
        const p = { user: simRng.pick(staff), type: 'staff', messages: 0 };
        plans.push(p);
        staffPlans.push(p);
      }
      for (let i = 0; i < messages; i += 1) simRng.pick(staffPlans).messages += 1;
    }

    // catalog browsing decided up front so every hour can be covered
    for (const p of plans) {
      if (p.type === 'lesson') p.catalog = simRng.chance(0.5);
      else if (p.type === 'browse' || p.type === 'cancel') p.catalog = simRng.chance(0.56);
      else p.catalog = false;
    }

    // start times: learners follow the hourly curve and every hour gets at least
    // one learner session; staff work office hours
    const learnerPlans = plans.filter((p) => p.type !== 'staff');
    const hours = learnerPlans.map(() => simRng.weighted(HOURLY_WEIGHTS.map((w, h) => [h, w]))[0]);
    for (let h = 0; h < 24; h += 1) {
      if (hours.includes(h)) continue;
      const counts = Array.from({ length: 24 }, (_, x) => hours.filter((y) => y === x).length);
      const busiest = counts.indexOf(Math.max(...counts));
      hours[hours.indexOf(busiest)] = h;
    }
    learnerPlans.forEach((p, i) => {
      p.startMs = start + hours[i] * 3600_000 + simRng.int(0, 3_599_999);
      if (p.startMs > start + DAY_MS - 30 * MIN_MS) p.startMs = start + DAY_MS - 30 * MIN_MS - simRng.int(0, 5 * MIN_MS);
      if (p.startMs < start + 15 * MIN_MS && p.user.persona) p.startMs = start + 15 * MIN_MS + simRng.int(0, 30 * MIN_MS);
    });
    for (const p of plans.filter((x) => x.type === 'staff')) {
      p.startMs = start + simRng.int(8 * 60, 16 * 60) * MIN_MS + simRng.int(0, 59_999);
    }
    for (let h = 0; h < 24; h += 1) {
      const inHour = learnerPlans.filter((p) => Math.floor((p.startMs - start) / 3600_000) === h);
      const early = inHour.find((p) => p.catalog && (p.startMs - start) % 3600_000 < 40 * MIN_MS);
      if (!early && inHour.length) {
        inHour[0].catalog = true;
        inHour[0].startMs = Math.max(start + h * 3600_000 + simRng.int(0, 20 * MIN_MS), inHour[0].user.persona ? start + 15 * MIN_MS : 0);
      }
    }
    plans.sort((a, b) => a.startMs - b.startMs);

    const dayRequests = [];
    for (const p of plans) runSession(p, day, dayRequests);

    // a well-known crawler on public pages, about 1% of requests
    const crawlerCount = Math.round(dayRequests.length * 0.0102);
    for (let i = 0; i < crawlerCount; i += 1) {
      const [path, type, bytes] = netRng.weighted([
        [['/', 'text/html', 1290], 35], [['/robots.txt', 'text/plain', 412], 20], [['/courses', 'text/html', 1290], 25],
        [['/login', 'text/html', 1290], 15], [['/favicon.svg', 'image/svg+xml', 690], 5],
      ])[0];
      dayRequests.push({
        kind: 'static', ts: start + netRng.int(0, DAY_MS - 1), path, method: 'GET', status: 200, contentType: type,
        bytesOut: bytes + netRng.int(0, 40), resultType: netRng.chance(0.7) ? 'Hit' : 'RefreshHit', referer: '-',
        ua: 'crawler', ip: netRng.pick(CRAWLER_IPS), edge: 'IAD89-P1', latencyMs: netRng.int(1, 6), crawler: true,
      });
    }
    requests.push(...dayRequests);
  }

  // ---------------------------------------------------------------- one visit
  function runSession(plan, day, out) {
    const u = plan.user;
    const rng = simRng;
    let now = plan.startMs;
    const version = versionAt(now);
    const session = { id: null, page: '/' };
    const base = { ua: u.ua, ip: u.ip, edge: u.edge };

    const api = (service, method, route, path, { status = 200, events = [] } = {}) => {
      const latencyMs = routeLatency(day, route, now);
      const req = {
        kind: 'api', ts: now, service, method, route, path, status, latencyMs, ...base,
        userId: session.id ? u.id : null, sessionId: session.id, referer: session.page,
        version: version.version, requestId: `${rng.chars(15)}=`, traceId: rng.hex(32), events: [],
      };
      events.forEach((e, i) => req.events.push({ ...e, ts: now + Math.round(latencyMs * 0.6) + i }));
      out.push(req);
      now += latencyMs + rng.int(20, 250);
      return req;
    };
    const think = (minS, maxS) => { now += rng.int(minS * 1000, maxS * 1000); };
    const actor = u.isStaff ? 'staff' : 'learner';
    const ev = (event, extra = {}) => ({ event, actorType: actor, ...extra });

    // first page load: index.html plus assets the browser has not cached
    const fresh = u.cachedVersion !== version.version || rng.chance(0.12);
    const staticReq = (path, contentType, bytesOut, resultType) => {
      out.push({ kind: 'static', ts: now, path, method: 'GET', status: 200, contentType, bytesOut, resultType, referer: path === '/' ? '-' : '/', latencyMs: rng.int(1, 9), ...base });
      now += rng.int(15, 120);
    };
    staticReq('/', 'text/html', 1290 + rng.int(0, 30), rng.chance(0.8) ? 'RefreshHit' : 'Miss');
    if (fresh) {
      const justReleased = now - version.fromMs < 3600_000;
      staticReq(`/assets/${version.js}`, 'application/javascript', 68_400 + rng.int(0, 900), justReleased && rng.chance(0.5) ? 'Miss' : 'Hit');
      staticReq(`/assets/${version.css}`, 'text/css', 3_650 + rng.int(0, 120), justReleased && rng.chance(0.5) ? 'Miss' : 'Hit');
      if (rng.chance(0.6)) staticReq('/favicon.svg', 'image/svg+xml', 690, 'Hit');
      u.cachedVersion = version.version;
    }

    api('identity', 'GET', '/api/me', '/api/me', { status: 401 });
    session.page = '/login';
    think(4, 25);
    if (rng.chance(0.03)) {
      api('identity', 'POST', '/api/auth/login', '/api/auth/login', { status: 401, events: [{ event: 'sign_in_failed', outcome: 'failed', errorType: 'invalid_credentials', actorType: 'learner' }] });
      think(4, 12);
    }
    session.id = `ses_${rng.hex(16)}`;
    api('identity', 'POST', '/api/auth/login', '/api/auth/login', { events: [ev('user_signed_in')] });

    let pollStart;
    if (u.isStaff) {
      session.page = '/admin';
      api('admin', 'GET', '/api/admin/learners', '/api/admin/learners');
      pollStart = now;
      api('notifications', 'GET', '/api/me/notifications/unread-count', '/api/me/notifications/unread-count');
      if (plan.flagChange || rng.chance(0.2)) api('admin', 'GET', '/api/admin/flags', '/api/admin/flags');
      if (plan.flagChange) {
        think(5, 20);
        api('admin', 'PUT', '/api/admin/flags/{flagKey}', '/api/admin/flags/new_catalog_filters', { events: [ev('feature_flag_changed', { entityType: 'feature_flag', entityId: 'new_catalog_filters' })] });
      }
      for (let i = 0; i < plan.messages; i += 1) {
        think(60, 300);
        const eligible = learners.filter((x) => !x.cancelled && !x.persona);
        const to = rng.pick(eligible);
        const [title, body] = rng.pick(STAFF_MESSAGES);
        const req = api('admin', 'POST', '/api/admin/learners/{userId}/message', `/api/admin/learners/${to.id}/message`);
        const createdAt = req.ts + Math.round(req.latencyMs * 0.4);
        const n = notify(to, 'staff_message', title, body, '/notifications', createdAt);
        req.events.push(
          { event: 'notification_created', entityType: 'notification', entityId: n.id, actorType: 'system', ts: createdAt },
          { event: 'staff_message_sent', entityType: 'notification', entityId: n.id, actorType: 'staff', ts: createdAt + 1 },
          { event: 'email_sent', entityType: 'email', entityId: `eml_${rng.hex(12)}`, actorType: 'system', ts: req.ts + Math.round(req.latencyMs * 0.85) },
        );
      }
      think(30, 180);
    } else {
      session.page = '/';
      api('learning', 'GET', '/api/me/progress', '/api/me/progress', { events: [ev('progress_viewed')] });
      api('billing', 'GET', '/api/me/subscription', '/api/me/subscription');
      pollStart = now;
      api('notifications', 'GET', '/api/me/notifications/unread-count', '/api/me/notifications/unread-count');
      readNotifications(plan, u, () => now, api, think, rng);

      if (plan.type === 'lesson') {
        think(3, 15);
        if (plan.catalog) browseCatalog(u, api, think, session, rng);
        const visits = plan.script ? 1 : rng.chance(0.3) ? 2 : 1;
        for (let i = 0; i < visits; i += 1) {
          if (!lessonVisit(plan, u, api, think, session, rng, day)) break;
        }
      } else {
        think(5, 30);
        if (plan.catalog) browseCatalog(u, api, think, session, rng);
        if (plan.type === 'cancel' || rng.chance(0.25)) {
          think(3, 15);
          session.page = '/subscription';
          api('billing', 'GET', '/api/me/subscription', '/api/me/subscription');
        }
        if (plan.type === 'cancel') {
          think(10, 45);
          api('billing', 'POST', '/api/me/subscription/cancel', '/api/me/subscription/cancel', { events: [ev('subscription_cancelled', { entityType: 'subscription', entityId: u.sub.id })] });
          u.sub.status = 'cancelled';
          u.sub.cancelled_at = iso(out.at(-1).events[0].ts);
          u.cancelled = true;
        }
        think(10, 60);
      }
    }
    // the bell polls the unread count every 30 seconds while the page is open
    const signsOut = rng.chance(u.isStaff ? 0.3 : 0.25);
    const end = now + rng.int(5_000, 40_000);
    for (let t = pollStart + 30_000; t < end; t += 30_000) {
      now = t;
      const failed = rng.chance(0.0004);
      const req = api('notifications', 'GET', '/api/me/notifications/unread-count', '/api/me/notifications/unread-count', { status: failed ? 500 : 200 });
      if (failed) req.logError = 'InternalError';
    }
    now = end;
    if (signsOut) api('identity', 'POST', '/api/auth/logout', '/api/auth/logout', { events: [ev('user_signed_out')] });
  }

  function readNotifications(plan, u, clock, api, think, rng) {
    const unread = u.notifications.filter((n) => !n.read_at && Date.parse(n.created_at) < clock())
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (unread.length === 0) return;
    const opensBell = plan.readsAll || rng.chance(u.group === 'cohortA' ? 0.55 : 0.7);
    if (!opensBell) return;
    think(2, 10);
    api('notifications', 'GET', '/api/me/notifications', '/api/me/notifications');
    for (const n of plan.readsAll ? unread : unread.slice(0, 5)) {
      if (!plan.readsAll && !rng.chance(0.8)) continue;
      think(2, 8);
      const req = api('notifications', 'POST', '/api/me/notifications/{notificationId}/read', `/api/me/notifications/${n.id}/read`, {
        events: [{ event: 'notification_opened', entityType: 'notification', entityId: n.id, actorType: 'learner' }],
      });
      n.read_at = iso(req.events[0].ts);
    }
  }

  function browseCatalog(u, api, think, session, rng) {
    session.page = '/courses';
    api('catalog', 'GET', '/api/courses', '/api/courses', { events: [{ event: 'catalog_viewed', actorType: 'learner' }] });
    const opens = rng.int(0, 2);
    for (let i = 0; i < opens; i += 1) {
      think(5, 25);
      const own = u.enrolled.length && rng.chance(0.5);
      const ownId = own ? rng.pick(u.enrolled).course_id : null;
      const course = own ? courses.find((c) => c.id === ownId) : rng.weighted(courses, (c) => c._popularity);
      session.page = `/courses/${course.id}`;
      api('catalog', 'GET', '/api/courses/{courseId}', `/api/courses/${course.id}`, { events: [{ event: 'course_opened', entityType: 'course', entityId: course.id, actorType: 'learner' }] });
    }
  }

  // Returns false when the visit failed (outage) and the learner gives up for today.
  function lessonVisit(plan, u, api, think, session, rng, day) {
    let lesson;
    let completes;
    if (plan.script) {
      lesson = lessonsByCourse.get(courseByKey.get('cloud').id)[plan.script.index];
      completes = plan.script.completes;
    } else {
      let courseId = currentCourse(u);
      if (!courseId && u.persona !== 'marco') {
        const course = chooseNewCourse(rng, u, plan.startMs);
        if (course) {
          session.page = '/courses';
          api('catalog', 'GET', '/api/courses', '/api/courses', { events: [{ event: 'catalog_viewed', actorType: 'learner' }] });
          think(5, 20);
          session.page = `/courses/${course.id}`;
          api('catalog', 'GET', '/api/courses/{courseId}', `/api/courses/${course.id}`, { events: [{ event: 'course_opened', entityType: 'course', entityId: course.id, actorType: 'learner' }] });
          think(5, 30);
          const req = api('catalog', 'POST', '/api/courses/{courseId}/enrol', `/api/courses/${course.id}/enrol`, { events: [{ event: 'course_enrolled', entityType: 'course', entityId: course.id, actorType: 'learner' }] });
          enrol(u, course, req.events[0].ts);
          courseId = course.id;
        }
      }
      if (!courseId) courseId = u.enrolled.at(-1).course_id;
      lesson = nextLesson(u, courseId) ?? lessonsByCourse.get(courseId).at(-1);
      const wasStarted = u.lessonState.get(lesson.id)?.status === 'started';
      completes = rng.chance(wasStarted ? 0.8 : 0.62);
      if (u.persona === 'marco') {
        const isLast = lesson.position === lessonsByCourse.get(courseId).length;
        completes = !isLast && rng.chance(0.3);
      }
    }
    think(1, 4);
    session.page = `/lessons/${lesson.id}`;
    if (inOutage(day) && rng.chance(outage.failureShare)) {
      // the lesson page fails; the learner reloads a few times, then gives up
      const fail = (route, path) => { api('learning', 'GET', route, path, { status: 500 }).logError = 'InternalError'; };
      fail('/api/lessons/{lessonId}', `/api/lessons/${lesson.id}`);
      fail('/api/courses/{courseId}/lessons', `/api/courses/${lesson.course_id}/lessons`);
      const retries = rng.int(outage.retriesMin, outage.retriesMax);
      for (let i = 0; i < retries; i += 1) {
        think(3, 20);
        fail('/api/lessons/{lessonId}', `/api/lessons/${lesson.id}`);
      }
      think(5, 30);
      return false;
    }
    api('learning', 'GET', '/api/lessons/{lessonId}', `/api/lessons/${lesson.id}`);
    api('learning', 'GET', '/api/courses/{courseId}/lessons', `/api/courses/${lesson.course_id}/lessons`);
    if (u.lessonState.get(lesson.id)?.status !== 'completed') {
      const req = api('learning', 'POST', '/api/lessons/{lessonId}/progress', `/api/lessons/${lesson.id}/progress`, {
        events: [{ event: 'lesson_started', entityType: 'lesson', entityId: lesson.id, actorType: 'learner', value: lesson.duration_min }],
      });
      touch(u, lesson, 'started', req.events[0].ts);
    } else {
      completes = false;
    }
    think(120, 300);
    if (!completes) return true;
    const req = api('learning', 'POST', '/api/lessons/{lessonId}/progress', `/api/lessons/${lesson.id}/progress`, {
      events: [{ event: 'lesson_completed', entityType: 'lesson', entityId: lesson.id, actorType: 'learner', value: lesson.duration_min }],
    });
    touch(u, lesson, 'completed', req.events[0].ts);
    if (lesson.quiz && rng.chance(0.8)) {
      think(40, 120);
      const score = quizScore(rng);
      const quizReq = api('learning', 'POST', '/api/lessons/{lessonId}/quiz', `/api/lessons/${lesson.id}/quiz`, {
        events: [{ event: 'quiz_submitted', entityType: 'lesson', entityId: lesson.id, actorType: 'learner', value: score }],
      });
      quizResults.push({ id: newId('qzr'), user_id: u.id, lesson_id: lesson.id, score, correct: Math.round((score / 100) * 3), total: 3, submitted_at: iso(quizReq.events[0].ts) });
    }
    return true;
  }

  // ---------------------------------------------------------------- end state
  const users = [...staff, ...learners]
    .map((u) => ({ id: u.id, email: u.email, name: u.name, role: u.role, created_at: u.created_at }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const progress = { lessons: [], courses: [] };
  for (const u of [...learners].sort((a, b) => a.id.localeCompare(b.id))) {
    progress.lessons.push(...[...u.lessonState.values()].sort((a, b) => a.started_at.localeCompare(b.started_at)));
    for (const e of u.enrolled) progress.courses.push({ user_id: u.id, course_id: e.course_id, last_activity_at: u.activity.get(e.course_id) ?? null });
  }
  const data = {
    users,
    courses: courses.map(({ _popularity, _key, ...c }) => c),
    lessons,
    enrolments: learners.flatMap((u) => u.enrolled).sort((a, b) => a.enrolled_at.localeCompare(b.enrolled_at)),
    progress,
    subscriptions: subscriptions.sort((a, b) => a.started_at.localeCompare(b.started_at)),
    notifications: notifications.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)),
    quiz_results: quizResults.sort((a, b) => a.submitted_at.localeCompare(b.submitted_at)),
  };

  requests.sort((a, b) => a.ts - b.ts);
  systemEvents.sort((a, b) => a.ts - b.ts);
  return {
    anchorMs, data, requests, systemEvents, versions, learners, staff, scenario: def,
    slowRelease: slowRelease ? { version: slowRelease.version, from: iso(slowRelease.fromMs) } : null,
    groups: {
      cohortA: cohortA.map((u) => u.id), cohortB: cohortB.map((u) => u.id), cohortC: cohortC.map((u) => u.id),
      lostAfterOutage: lost.map((u) => u.id),
    },
  };
}

function i0(staffMember) {
  return staffMember.email.length % 3;
}

function buildQuiz(rng, questions) {
  return {
    questions: questions.map(([prompt, options, answer], i) => {
      const order = rng.shuffle(options.map((_, k) => k));
      return { id: `q${i + 1}`, prompt, options: order.map((k) => options[k]), answer_index: order.indexOf(answer) };
    }),
  };
}

function lessonBody(course, title, index) {
  const n = course.lessons.length;
  return [
    `## ${title}`,
    '',
    `Lesson ${index + 1} of ${n} in *${course.title}*. ${course.summary}`,
    '',
    '### In this lesson',
    '',
    `- The core ideas behind ${title.replace(/[?.]$/, '').toLowerCase()}`,
    `- How this lesson connects to the rest of ${course.title}`,
    '- A short exercise to try on your own work',
    '',
    '### Key ideas',
    '',
    `Start with the video, then read the notes below. The examples build on the previous lesson${index === 0 ? ' (this is the first one, so no prior knowledge is assumed)' : ''}.`,
    '',
    `Keep a note of one situation from your own work where **${title.replace(/[?.]$/, '').toLowerCase()}** applies. You will use it in the exercise.`,
    '',
    '### Exercise',
    '',
    'Spend ten minutes applying the ideas to your own example. Write down what you tried and what you would change next time.',
  ].join('\n');
}
