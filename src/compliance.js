// Enterprise accounts and their required training (scenario parameter `compliance`).
//
// Runs AFTER the 60 days have been simulated, as a pass over the finished world, and draws
// only from its own random streams ('compliance', 'compliance-ids'), so every request,
// lesson, enrolment and cart the other cases are read from is exactly what it is without
// it. It only ADDS requests (and moves a staff sign-out to after the work added before it):
//
//  - organizations and their employees: some of the learners, each in a team with a
//    manager (organisational facts only: account, team, manager; nothing about the person)
//  - training_assignments: each account's required courses, assigned on one day and due on
//    another; where each stands is derived from the employee's progress and quiz attempts
//    with the same rule as LearnLoop (contract/training.js), never stored
//  - quiz attempts on required courses: an employee who completed a quiz lesson of one
//    without taking its quiz takes it right after, and one who scores below the pass score
//    often takes it again at once (POST .../quiz, quiz_submitted), so failed attempts repeat
//  - the staff's manual follow-up: on weekdays, in their ordinary Admin visits (the learner
//    list is already loaded and filtered in the browser), staff open an employee's required
//    training (GET /api/admin/learners/{userId}/training) and send a reminder with the
//    existing staff message (POST .../message), from days before each due date until weeks
//    after it; the reminders repeat one template
//  - employees open some of those reminders on a later visit, and change nothing else
//
// From `followUp.surgeFromDay` on, each day keeps as many chases untagged as the same
// weekday four weeks earlier had; the rest are tagged FOLLOW_UP_SURGE (a staged reveal can
// leave the tagged requests out of the logs and their reminders out of the state).
import { trainingState } from './contract/training.js';
import { createRng } from './rng.js';

export const FOLLOW_UP_SURGE = 'training_follow_up_surge';
export const TRAINING_ROUTE = '/api/admin/learners/{userId}/training';
export const EMPLOYEE_PERSONA = Object.freeze({ email: 'lena.hoffmann@example.com', name: 'Lena Hoffmann' });
export const MANAGER_PERSONA = Object.freeze({ email: 'tobias.brandt@example.com', name: 'Tobias Brandt' });

const DAY_MS = 86_400_000;
const MIN_MS = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const shortDate = (ms) => new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The reminder staff send, from one template (the body says how far the employee is). */
export function reminderText({ firstName, organization, course, dueMs, percent, passScore, overdue, staffFirstName }) {
  const due = shortDate(dueMs);
  return overdue
    ? [`Overdue: "${course}" was due on ${due}`,
      `Hi ${firstName}, your required course "${course}" for ${organization} was due on ${due} and is not complete yet (${percent}% done). Please finish the remaining lessons and pass the quizzes with ${passScore}% or more as soon as you can. Thank you, ${staffFirstName} (LearnLoop team)`]
    : [`Reminder: complete "${course}" by ${due}`,
      `Hi ${firstName}, ${organization} asks you to complete the required course "${course}" by ${due}. You have done ${percent}% so far. Please finish the remaining lessons and pass the quizzes with ${passScore}% or more before the deadline. Thank you, ${staffFirstName} (LearnLoop team)`];
}

/**
 * ctx: { C (the compliance parameters), seed, anchorMs, learners, staff, courses, courseByKey,
 *        lessonsByCourse, quizResults, notifications, requests, versionAt, latencyNoise,
 *        usedIds, quizScore, officeIp }
 */
export function runCompliance(ctx) {
  const { C, seed, anchorMs, learners, staff, courseByKey, lessonsByCourse, quizResults, notifications, requests } = ctx;
  const rng = createRng(seed, 'compliance');
  const idRng = createRng(seed, 'compliance-ids');
  const newId = (prefix) => {
    let id;
    do id = `${prefix}_${idRng.hex(12)}`; while (ctx.usedIds.has(id));
    ctx.usedIds.add(id);
    return id;
  };
  const dayStart = (day) => anchorMs + day * DAY_MS;
  const dayOf = (ms) => Math.floor((ms - anchorMs) / DAY_MS);
  const pass = C.requiredPassScore;

  // ------------------------------------------------------------ accounts and their employees
  // Employees are learners enrolled in their account's first required course (the account
  // signed them up for it), never a scripted persona and never one who cancels: an
  // enterprise seat is not cancelled by the employee.
  const taken = new Set();
  const organizations = [];
  const employees = [];
  for (const spec of C.organizations) {
    const org = { id: newId('org'), name: spec.name, created_at: iso(dayStart(Math.min(...spec.courses.map((c) => c.assignedDay)) - 30) + 9 * 3600_000) };
    organizations.push(org);
    const first = courseByKey.get(spec.courses[0].course);
    const candidates = rng.shuffle(learners.filter((u) => !u.persona && !u.cancelDay && !taken.has(u.id)
      && u.enrolled.some((e) => e.course_id === first.id)));
    for (const u of candidates.slice(0, spec.employees)) {
      taken.add(u.id);
      u.organizationId = org.id;
      u.org = { org, spec };
      employees.push(u);
    }
  }
  const byId = new Map([...learners, ...staff].map((u) => [u.id, u]));

  // ------------------------------------------------------------ assignments
  const assignments = [];
  for (const u of employees) {
    for (const c of u.org.spec.courses) {
      const course = courseByKey.get(c.course);
      assignments.push({
        id: newId('asg'), organization_id: u.organizationId, user_id: u.id, course_id: course.id,
        assigned_at: iso(dayStart(c.assignedDay) + 8 * 3600_000), due_at: iso(dayStart(c.dueDay + 1) - 1000), required_pass_score: pass,
        _user: u, _course: course,
      });
    }
  }
  const assignedCourses = new Map();
  for (const a of assignments) {
    if (!assignedCourses.has(a.user_id)) assignedCourses.set(a.user_id, new Set());
    assignedCourses.get(a.user_id).add(a.course_id);
  }

  // ------------------------------------------------------------ failed quiz attempts repeat
  // The quiz requests, to put a retake in the same visit.
  const quizRequest = new Map();
  for (const r of requests) {
    if (r.kind === 'api' && r.route === '/api/lessons/{lessonId}/quiz' && r.events.length) quizRequest.set(`${r.userId}|${r.events[0].ts}`, r);
  }
  const lessonCourse = new Map([...lessonsByCourse].flatMap(([courseId, lessons]) => lessons.map((l) => [l.id, courseId])));
  const added = [];
  const quizRequestFor = (userId, lessonId, at, score) => {
    const latencyMs = Math.max(4, Math.round(rng.lognormal(72 * (ctx.latencyNoise.get(`${dayOf(at)}:slow`) ?? 1), 0.3)));
    return {
      ts: at - Math.round(latencyMs * 0.6), latencyMs, requestId: `${rng.chars(15)}=`, traceId: rng.hex(32),
      events: [{ event: 'quiz_submitted', entityType: 'lesson', entityId: lessonId, actorType: 'learner', value: score, ts: at }],
    };
  };
  // A required course's quizzes count, so an employee who completed a quiz lesson of one
  // without taking its quiz takes it right after (in the same visit, when it is in the logs).
  const completionRequest = new Map();
  for (const r of requests) {
    if (r.kind === 'api' && r.route === '/api/lessons/{lessonId}/progress') {
      for (const e of r.events) if (e.event === 'lesson_completed') completionRequest.set(`${r.userId}|${e.entityId}|${e.ts}`, r);
    }
  }
  const attempted = new Set(quizResults.map((q) => `${q.user_id}|${q.lesson_id}`));
  for (const u of [...employees].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const courseId of [...assignedCourses.get(u.id)].sort()) {
      for (const lesson of lessonsByCourse.get(courseId)) {
        const rec = u.lessonState.get(lesson.id);
        if (!lesson.quiz || rec?.status !== 'completed' || attempted.has(`${u.id}|${lesson.id}`)) continue;
        const at = Date.parse(rec.completed_at) + rng.int(40, 120) * 1000;
        const score = ctx.quizScore(rng);
        const result = { id: newId('qzr'), user_id: u.id, lesson_id: lesson.id, score, correct: Math.round((score / 100) * 3), total: 3, submitted_at: iso(at) };
        quizResults.push(result);
        added.push(result);
        const lessonReq = completionRequest.get(`${u.id}|${lesson.id}|${Date.parse(rec.completed_at)}`);
        if (lessonReq) {
          const req = { ...lessonReq, route: '/api/lessons/{lessonId}/quiz', path: `/api/lessons/${lesson.id}/quiz`, ...quizRequestFor(u.id, lesson.id, at, score) };
          requests.push(req);
          quizRequest.set(`${u.id}|${at}`, req);
        }
      }
    }
  }
  const firstAttempts = quizResults.filter((q) => assignedCourses.get(q.user_id)?.has(lessonCourse.get(q.lesson_id)))
    .sort((a, b) => a.submitted_at.localeCompare(b.submitted_at) || a.id.localeCompare(b.id));
  const passedLesson = new Set();
  const retries = [];
  for (const q of firstAttempts) {
    const key = `${q.user_id}|${q.lesson_id}`;
    if (passedLesson.has(key)) continue;
    if (q.score >= pass) { passedLesson.add(key); continue; }
    passedLesson.add(key); // later attempts of the same quiz are this one's retakes
    let at = Date.parse(q.submitted_at);
    const original = quizRequest.get(`${q.user_id}|${at}`);
    for (let i = 0; i < C.quizRetry.maxRetries && rng.chance(C.quizRetry.share); i += 1) {
      at += rng.int(60, 240) * 1000;
      const score = ctx.quizScore(rng);
      const result = { id: newId('qzr'), user_id: q.user_id, lesson_id: q.lesson_id, score, correct: Math.round((score / 100) * 3), total: 3, submitted_at: iso(at) };
      retries.push(result);
      if (original) requests.push({ ...original, ...quizRequestFor(q.user_id, q.lesson_id, at, score) });
      if (score >= pass) break;
    }
  }
  quizResults.push(...retries);
  added.push(...retries);

  // ------------------------------------------------------------ where each assignment stands
  const quizByUser = new Map();
  for (const q of quizResults) {
    if (!quizByUser.has(q.user_id)) quizByUser.set(q.user_id, []);
    quizByUser.get(q.user_id).push(q);
  }
  const recordOf = (a) => {
    const lessons = lessonsByCourse.get(a.course_id);
    const ids = new Set(lessons.map((l) => l.id));
    return {
      lessons: lessons.map((l) => ({ id: l.id, duration_min: l.duration_min, hasQuiz: Boolean(l.quiz) })),
      progress: [...a._user.lessonState.values()].filter((p) => p.course_id === a.course_id),
      quizResults: (quizByUser.get(a.user_id) ?? []).filter((q) => ids.has(q.lesson_id)),
    };
  };
  const atAnchor = new Date(anchorMs);
  for (const a of assignments) {
    a._record = recordOf(a);
    a._final = trainingState(a, a._record, atAnchor);
  }
  // progress as it stood at a moment (records and attempts up to then), for the reminder text
  const stateAt = (a, ms) => {
    const cut = iso(ms);
    const r = a._record;
    const progress = r.progress.filter((p) => p.started_at <= cut).map((p) => (p.completed_at && p.completed_at > cut ? { ...p, status: 'started', completed_at: null } : p));
    return trainingState(a, { ...r, progress, quizResults: r.quizResults.filter((q) => q.submitted_at <= cut) }, new Date(ms));
  };

  // ------------------------------------------------------------ teams and managers
  // Behind is a fact about people, not a team's label: an employee who has not completed
  // the account's first required course on time (or has not reached its due date and has
  // not started) goes to a team marked behind with probability behindShare, everyone else
  // with the complementary share spread over the teams. Each team's manager is one of its
  // employees who did complete on time where there is one.
  for (const spec of C.organizations) {
    const org = organizations[C.organizations.indexOf(spec)];
    const behind = spec.teams.filter((t) => t.behind);
    const onTrack = spec.teams.filter((t) => !t.behind);
    const firstId = courseByKey.get(spec.courses[0].course).id;
    const people = new Map(spec.teams.map((t) => [t.name, []]));
    const members = employees.filter((u) => u.organizationId === org.id);
    const lateOnFirst = (u) => !assignments.find((a) => a._user === u && a.course_id === firstId)._final.completedOnTime;
    for (const u of members) {
      const slow = lateOnFirst(u);
      const toBehind = slow ? rng.chance(C.behindShare) : rng.chance((1 - C.behindShare) * (behind.length / spec.teams.length));
      people.get(rng.pick(toBehind ? behind : onTrack).name).push(u);
    }
    for (const [team, list] of people) {
      if (!list.length) continue;
      const manager = list.find((u) => !lateOnFirst(u) && u.group === 'cohortA') ?? list.find((u) => u.group === 'cohortA') ?? list[0];
      for (const u of list) {
        u.department = team;
        u.managerId = u === manager ? null : manager.id;
        u.org.teamBehind = spec.teams.find((t) => t.name === team).behind;
      }
    }
  }

  // ------------------------------------------------------------ the staff's follow-up
  // Who is chased on which weekday: not completed yet, due within daysBefore (more often
  // as the date comes closer) or overdue by at most daysAfter, at most every minGapDays.
  const F = C.followUp;
  const chases = [];
  const lastChase = new Map();
  for (let day = -60; day <= -1; day += 1) {
    const start = dayStart(day);
    const dow = new Date(start).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    for (const a of assignments) {
      if (Date.parse(a.assigned_at) > start) continue;
      if (a._final.completedAt && Date.parse(a._final.completedAt) <= start) continue;
      if (day - (lastChase.get(a.id) ?? -Infinity) < F.minGapDays) continue;
      const toDue = (Date.parse(a.due_at) - start) / DAY_MS;
      let p = 0;
      if (toDue > 0 && toDue <= F.daysBefore) p = F.chasePerDay * (1 + F.rampBoost * (1 - toDue / F.daysBefore));
      else if (toDue <= 0 && toDue > -F.daysAfter) p = F.overduePerDay;
      if (p > 0 && rng.chance(p)) {
        lastChase.set(a.id, day);
        chases.push({ day, a, staff: rng.weighted(staff.map((s, i) => [s, F.staffWeights[i] ?? 0]))[0] });
      }
    }
  }

  // ------------------------------------------------------------ the demo personas
  // Lena: an employee in a team that is behind, still signing in, overdue on a required
  // course she has started, ideally with failed quiz attempts and several reminders (the
  // chases are planned by then; only their text needs her name). Tobias: her manager.
  let lena = null;
  if (C.personas) {
    const overdueStarted = (u) => assignments.filter((a) => a._user === u && a._final.status === 'overdue' && a._final.percent > 0);
    const chased = (u) => chases.filter((c) => c.a._user === u).length;
    const pool = employees.filter((u) => u.org.teamBehind && u.group === 'cohortA' && u.managerId).sort((a, b) => a.id.localeCompare(b.id));
    lena = pool.find((u) => chased(u) >= 3 && overdueStarted(u).some((a) => a._final.failedQuizAttempts > 0))
      ?? pool.find((u) => chased(u) >= 3 && overdueStarted(u).length)
      ?? pool.find((u) => overdueStarted(u).length) ?? pool.find((u) => assignments.some((a) => a._user === u && a._final.status === 'overdue'));
    if (!lena) throw new Error('compliance: no employee fits the overdue persona');
    const manager = byId.get(lena.managerId);
    for (const [u, p] of [[lena, EMPLOYEE_PERSONA], [manager, MANAGER_PERSONA]]) {
      if ([...learners, ...staff].some((x) => x !== u && (x.email === p.email || x.name === p.name))) throw new Error(`compliance: persona ${p.name} collides with a generated user`);
      Object.assign(u, p);
      u.compliancePersona = u === lena ? 'employee' : 'manager';
    }
  }

  // From surgeFromDay on, each day keeps untagged as many chases as the same weekday four
  // weeks earlier had (the follow-up as it was, day by day, peaks included); the rest of
  // the day's chases are the surge.
  const perWeekday = (from, to) => {
    let days = 0;
    for (let d = from; d <= to; d += 1) if (![0, 6].includes(new Date(dayStart(d)).getUTCDay())) days += 1;
    return chases.filter((c) => c.day >= from && c.day <= to).length / Math.max(1, days);
  };
  const earlierRate = perWeekday(-59, F.surgeFromDay - 1);
  const recentRate = perWeekday(F.surgeFromDay, -1);
  for (let day = F.surgeFromDay; day <= -1; day += 1) {
    const quota = chases.filter((c) => c.day === day - 28).length;
    rng.shuffle(chases.filter((c) => c.day === day)).forEach((c, i) => { if (i >= quota) c.activity = FOLLOW_UP_SURGE; });
  }
  const surgeShare = chases.filter((c) => c.activity).length / Math.max(1, chases.filter((c) => c.day >= F.surgeFromDay).length);

  // The follow-up happens in the staff's ordinary Admin visits: the learner list is already
  // loaded (the Admin page filters it in the browser), so for each employee they search the
  // list, open Training (GET .../training) and send the reminder (POST .../message), then
  // the next one. A chase goes to the planned staff member's first visit that day, else to
  // another visit that day, else it does not happen. The visit's sign-out, if any, moves to
  // after the follow-up; the bell keeps polling while the page is open.
  const staffIds = new Set(staff.map((s) => s.id));
  const visits = new Map(); // sessionId -> { staff, day, lastMs, logout }
  for (const r of requests) {
    if (r.kind !== 'api' || !staffIds.has(r.userId) || !r.sessionId) continue;
    let v = visits.get(r.sessionId);
    if (!v) visits.set(r.sessionId, (v = { sessionId: r.sessionId, staff: byId.get(r.userId), day: dayOf(r.ts), firstMs: r.ts, lastMs: 0, logout: null, version: r.version }));
    if (r.route === '/api/auth/logout') v.logout = r;
    else v.lastMs = Math.max(v.lastMs, r.ts + r.latencyMs);
    v.firstMs = Math.min(v.firstMs, r.ts);
  }
  const visitsByDay = new Map();
  for (const v of [...visits.values()].sort((a, b) => a.firstMs - b.firstMs)) {
    if (!visitsByDay.has(v.day)) visitsByDay.set(v.day, []);
    visitsByDay.get(v.day).push(v);
  }
  const workload = new Map(); // sessionId -> chases
  for (const c of chases) {
    const today = visitsByDay.get(c.day) ?? [];
    const visit = today.find((v) => v.staff === c.staff) ?? (today.length ? rng.pick(today) : null);
    if (!visit) { c.dropped = true; continue; }
    c.staff = visit.staff;
    if (!workload.has(visit.sessionId)) workload.set(visit.sessionId, []);
    workload.get(visit.sessionId).push(c);
  }

  const activityNotifications = new Map([[FOLLOW_UP_SURGE, new Set()]]);
  const reminders = [];
  for (const [sessionId, list] of workload) runFollowUp(visits.get(sessionId), [...list.filter((c) => !c.activity), ...list.filter((c) => c.activity)]);

  function runFollowUp(visit, list) {
    const s = visit.staff;
    let now = visit.lastMs + rng.int(10, 40) * 1000;
    let tag = {};
    const base = { ua: s.ua, ip: s.ip, edge: s.edge };
    const api = (service, method, route, path) => {
      const latencyMs = Math.max(4, Math.round(rng.lognormal(36 * (ctx.latencyNoise.get(`${visit.day}:fast`) ?? 1), 0.3)));
      const req = {
        kind: 'api', ts: now, service, method, route, path, status: 200, latencyMs, ...base, userId: s.id, sessionId: visit.sessionId,
        referer: '/admin', version: visit.version, requestId: `${rng.chars(15)}=`, traceId: rng.hex(32), events: [], ...tag,
      };
      requests.push(req);
      now += latencyMs + rng.int(20, 250);
      return req;
    };
    let nextPoll = now + rng.int(5, 30) * 1000;
    const think = (minS, maxS) => {
      const until = now + rng.int(minS * 1000, maxS * 1000);
      while (nextPoll < until) {
        now = nextPoll;
        api('notifications', 'GET', '/api/me/notifications/unread-count', '/api/me/notifications/unread-count');
        nextPoll += 30_000;
      }
      now = Math.max(now, until);
    };
    for (const c of list) {
      const { a } = c;
      const u = a._user;
      tag = c.activity ? { activity: c.activity } : {};
      think(15, 60); // search the list for the next employee
      api('admin', 'GET', TRAINING_ROUTE, `/api/admin/learners/${u.id}/training`);
      think(30, 150);
      const state = stateAt(a, now);
      const overdue = now > Date.parse(a.due_at);
      const [title, body] = reminderText({
        firstName: u.name.split(' ')[0], organization: u.org.org.name, course: a._course.title, dueMs: Date.parse(a.due_at),
        percent: state.percent, passScore: pass, overdue, staffFirstName: s.name.split(' ')[0],
      });
      const req = api('admin', 'POST', '/api/admin/learners/{userId}/message', `/api/admin/learners/${u.id}/message`);
      const createdAt = req.ts + Math.round(req.latencyMs * 0.4);
      const n = { id: newId('ntf'), user_id: u.id, type: 'staff_message', title, body, link: '/notifications', created_at: iso(createdAt), read_at: null };
      notifications.push(n);
      u.notifications.push(n);
      req.events.push(
        { event: 'notification_created', entityType: 'notification', entityId: n.id, actorType: 'system', ts: createdAt },
        { event: 'staff_message_sent', entityType: 'notification', entityId: n.id, actorType: 'staff', ts: createdAt + 1 },
        { event: 'email_sent', entityType: 'email', entityId: `eml_${rng.hex(12)}`, actorType: 'system', ts: req.ts + Math.round(req.latencyMs * 0.85) },
      );
      if (c.activity) activityNotifications.get(c.activity).add(n.id);
      reminders.push({ n, a, staff: s, day: c.day, overdue, activity: c.activity, ms: createdAt });
    }
    think(5, 30);
    if (visit.logout) {
      const shift = now - visit.logout.ts;
      if (shift > 0) {
        visit.logout.ts += shift;
        for (const e of visit.logout.events) e.ts += shift;
      }
    }
  }

  // ------------------------------------------------------------ employees open some reminders
  // On their next visit at least 30 minutes later (if any before the start date): the bell
  // list, then the reminder. Nothing else about the visit changes.
  const visitsByUser = new Map();
  for (const r of requests) {
    if (r.kind !== 'api' || r.route !== '/api/me/notifications/unread-count' || !r.userId || !r.sessionId) continue;
    if (!visitsByUser.has(r.userId)) visitsByUser.set(r.userId, new Map());
    const visits = visitsByUser.get(r.userId);
    if (!visits.has(r.sessionId) || visits.get(r.sessionId).ts > r.ts) visits.set(r.sessionId, r);
  }
  const firstOfVisit = new Map([...visitsByUser].map(([u, m]) => [u, [...m.values()].sort((x, y) => x.ts - y.ts)]));
  for (const rem of reminders.sort((x, y) => x.ms - y.ms)) {
    if (!rng.chance(F.readShare)) continue;
    const visit = (firstOfVisit.get(rem.n.user_id) ?? []).find((r) => r.ts > rem.ms + 30 * MIN_MS);
    if (!visit) continue;
    const u = rem.a._user;
    const tag = rem.activity ? { activity: rem.activity } : {};
    const common = { kind: 'api', service: 'notifications', status: 200, ua: u.ua, ip: u.ip, edge: u.edge, userId: u.id, sessionId: visit.sessionId, referer: '/', version: visit.version, ...tag };
    const t1 = visit.ts + rng.int(3, 10) * 1000;
    requests.push({ ...common, ts: t1, method: 'GET', route: '/api/me/notifications', path: '/api/me/notifications', latencyMs: Math.max(4, Math.round(rng.lognormal(36, 0.3))), requestId: `${rng.chars(15)}=`, traceId: rng.hex(32), events: [] });
    const t2 = t1 + rng.int(3, 12) * 1000;
    const latencyMs = Math.max(4, Math.round(rng.lognormal(36, 0.3)));
    const readAt = t2 + Math.round(latencyMs * 0.6);
    requests.push({
      ...common, ts: t2, method: 'POST', route: '/api/me/notifications/{notificationId}/read', path: `/api/me/notifications/${rem.n.id}/read`, latencyMs,
      requestId: `${rng.chars(15)}=`, traceId: rng.hex(32),
      events: [{ event: 'notification_opened', entityType: 'notification', entityId: rem.n.id, actorType: 'learner', ts: readAt }],
    });
    rem.n.read_at = iso(readAt);
    rem.readMs = readAt;
  }

  return {
    organizations,
    assignments: assignments.map(({ _user, _course, _record, _final, ...a }) => a)
      .sort((x, y) => x.organization_id.localeCompare(y.organization_id) || x.user_id.localeCompare(y.user_id) || x.due_at.localeCompare(y.due_at)),
    activityNotifications,
    view: { employees, assignments, reminders, chases, addedQuizResults: added, surgeShare, earlierRate, recentRate, lena },
  };
}
