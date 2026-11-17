# Signal specification: q4-three-signals

What each stage of the staged scenario `q4-three-signals` puts into LearnLoop's logs and starting state, where in the LearnLoop code it comes from, the numbers it produces, which Governance Agent capability and detector each case lives in, and, for case 3, what a detector would have to read to see it. This file belongs to `learnloop-demo-tools` and is never copied into LearnLoop.

## 0. Conventions

- **Days** are counted from the start date (the anchor, day 0). The history covers days −60 … −1. The Governance Agent reads two 30-day windows: **earlier = days −59 … −30** (read once, when the application is onboarded) and **recent = days −29 … 0** (read again at every "Get usage telemetry"; day 0 holds no history).
- **Numbers** are seed 42. "15 Nov" is the anchor 2026-11-15; a range `a … b` covers start dates on all seven weekdays (2026-11-15 … 2026-11-21). They are what `src/generate.js` `computeStats()` reports (`capabilities`, `carts`, `compliance`), and what the tests assert with margin.
- **People on a route** = distinct client IPs per route template (the CloudFront actor key the agent uses), per window. A route with no request in a window has no baseline there (it is unmeasured, not a 100% drop).
- **Capabilities.** One LearnLoop service directory = one code component = one capability for the agent's `declared_in_code` route rule. The names in the console's screenshots: `services/learning` = "Course delivery and learner progress", `services/catalog` = "Course catalog and discovery", `services/admin` = "Platform administration", `services/notifications` = "Learner notification delivery". A re-derivation may name them differently; go by the routes they hold.
- **Stages.** Stage 3 is the whole scenario, byte for byte. Stages 1 and 2 leave out recent traffic of what a later stage reveals (by route, or by a named activity) and the matching state; the earlier window is final from stage 1 (definition: `scenarios/q4-three-signals.json` `staged_reveal`; mechanics: `src/generate.js` `stageWithhold`/`stageState`, `src/emit.js`).

| Stage | Adds | Left out of the logs from day −29 on | Left out of the starting state |
|---|---|---|---|
| 1 | case 1, lessons | `POST /api/courses/{courseId}/enrol`, `POST /api/me/cart/items`, `DELETE /api/me/cart/items/{courseId}`; the activity `training_follow_up_surge` | `carts.json` empty; the surge's reminders not in `notifications.json` |
| 2 | case 2, the checkout | the activity `training_follow_up_surge` | the surge's reminders not in `notifications.json` |
| 3 | case 3, required training | nothing | nothing |

## 1. What every stage has (the baseline)

420 paying learners (340 open lessons, 80 rarely come), 3 staff (Sofia Lindqvist, Daniel Okafor, Priya Nair, all from the office address `203.0.113.10`), 12 courses, a release every 10–14 days, about 1% crawler traffic on public pages. Health flat: server errors ≤ 0.05% per capability per window, p95 ≈ 105–131 ms on lesson routes, 55–63 ms elsewhere.

**Help and support is an ordinary feature** (it was the third case before): about 3 questions a week (`GET`/`POST /api/me/support-requests`, event `support_request_created`), answered by staff on weekdays a median of 3 hours later (`GET /api/admin/support-requests`, `POST /api/admin/support-requests/{requestId}/reply`, events `notification_created`, `support_reply_sent`; a `support_reply` notification). 15 Nov: 15 questions in the earlier window, 4 in the recent one, none open at the start date. 13 … 17 people on `/api/me/support-requests` per window, far under any bar. Code: `services/notifications/src/services/support.js`, `services/admin/src/services/support.js`; state `data/seed/support_requests.json`. Present in every stage.

## 2. Stage 1 — case 1: learners stop continuing their course

**What changes.** 145 of the active learners open their last lesson between days −45 and −31 and never open a lesson again; they keep signing in every few days (dashboard, progress, catalog). Ana Moreno is one of them (last lesson day −33).

**Where it is in LearnLoop.**

| Kind | What | LearnLoop file |
|---|---|---|
| routes | `GET /api/lessons/{lessonId}`, `GET /api/courses/{courseId}/lessons`, `POST /api/lessons/{lessonId}/progress`, `POST /api/lessons/{lessonId}/quiz`; `GET /api/me/progress` (every sign-in) | `services/learning/src/routes.js` |
| events | `lesson_started`, `lesson_completed` (entity `lesson`, value = minutes), `quiz_submitted` (value = score), `progress_viewed` | `services/learning/src/services/progress.js`, `quiz.js`; names in `packages/shared/src/logger.js` `EVENT_NAMES` |
| state | `progress.json`: `lessons[]` (`user_id`, `course_id`, `lesson_id`, `status`, `started_at`, `completed_at`), `courses[]` (`last_activity_at`) | `services/learning/src/repositories/progress.js` |

**Numbers** (earlier → recent; the same in all three stages, byte for byte):

| Route | 15 Nov | All seven start weekdays |
|---|---|---|
| `GET /api/lessons/{lessonId}` | 334 → 193 (−42.2%) | 334 → 193 (−42.2%) |
| `GET /api/courses/{courseId}/lessons` | 334 → 193 (−42.2%) | 334 → 193 (−42.2%) |
| `POST /api/lessons/{lessonId}/progress` | 334 → 177 (−47.0%) | 334 → 177 … 184 (−44.9 … −47.0%) |
| `POST /api/lessons/{lessonId}/quiz` | 317 → 165 (−47.9%) | 315 … 320 → 165 … 178 (−43.8 … −47.9%) |
| `GET /api/me/progress` (capability max) | 409 → 392 (−4.2%) | −3.7 … −4.4% |

**Detector that fires.** **NBF-USAGE-ACTOR_INACTIVITY** on the learning capability (`packages/modules/new-evolution-opportunity/drift/detectors.js` `detectActorInactivity`, `actorDropVerdict`; `drift/constants.js` `ACTOR_INACTIVITY_DROP_PCT = 33`, `MIN_INACTIVITY_ACTORS = 200`, `MIN_ACTOR_WINDOW_DAYS = 7`, `MAX_ACTOR_WINDOW_LENGTH_RATIO = 1.5`, `MIN_TREND_DAYS = 14`). The capability-level max barely moves, so the route-level fallback names the lesson route with the most earlier users; drop 42.2% on every start weekday. The same run also gives **NBF-DRIFT-GOAL_TREND_NEGATIVE** on the learning goal (−41.9 … −46.8%, `TREND_NEGATIVE_PCT = 10`). Health flat, so `incident_or_outage` is ruled out, not confirmed. Agentic-eligible (`approach/eligibility.js`: `inactivity_churn`): a lesson reminder from `progress.json`.

## 3. Stage 2 — case 2: courses left in the cart

**What changes.** From days −40 … −30, 12% of the learners stop completing the checkout (their courses stay in the cart); the learners who stopped opening lessons keep saving courses in the cart and never check out. Marco Bellini has Python for Data Work (day −16) and Data Visualization Fundamentals (day −9) in his cart and left the checkout page on day −9.

**Where it is in LearnLoop.**

| Kind | What | LearnLoop file |
|---|---|---|
| routes | `GET /api/me/cart` (every sign-in), `POST /api/me/cart/items`, `DELETE /api/me/cart/items/{courseId}`, `POST /api/courses/{courseId}/enrol`, `GET /api/courses`, `GET /api/courses/{courseId}` | `services/catalog/src/routes.js` |
| events | `cart_item_added`, `cart_item_removed` (entity `course`), `course_enrolled` (enrolling also takes the course out of the cart, no event) | `services/catalog/src/services/cart.js`, `enrolment.js` |
| state | `carts.json` (`user_id`, `items[]` with `course_id`, `added_at`), `enrolments.json` | `services/catalog/src/repositories/carts.js`, `enrolments.js` |

**Numbers** (earlier → recent):

| Route | Stage 1 | Stages 2 and 3, 15 Nov | Stages 2 and 3, all seven start weekdays |
|---|---|---|---|
| `POST /api/courses/{courseId}/enrol` | 301 … 316 → no recent window | 311 → 157 (−49.5%) | 301 … 316 → 148 … 158 (−48.0 … −52.8%) |
| `POST /api/me/cart/items` | → no recent window | 326 → 287 (−12.0%) | −7.7 … −13.5% |
| `GET /api/me/cart` (capability max) | −3.6 … −4.4% | 410 → 393 (−4.1%) | −3.6 … −4.4% |
| learners with a waiting cart (`carts.json`) | 0 (withheld) | 143 | 139 … 155 |

**Detector that fires** (from stage 2). **NBF-USAGE-ACTOR_INACTIVITY** on the catalog capability, the enrol route named by the route-level fallback (same rule and constants as case 1); also NBF-DRIFT-GOAL_TREND_NEGATIVE on the purchases goal (−69.4 … −78.1%). In stage 1 the enrol and cart-write routes have one measured window (`too_few_measured_windows`), so nothing is raised. Agentic-eligible: a cart reminder from `carts.json`.

## 4. Stage 3 — case 3: required training falls behind

**What changes.** 235 of the learners are employees of three enterprise customers. Each customer requires two courses with deadlines. Many employees fall behind, concentrated in one team per customer; failed quiz attempts repeat; overdue courses accumulate. The three staff follow up by hand in their ordinary Admin visits: for each employee they open the employee's required training and send a reminder from one template, from 10 days before each deadline until 21 days after it, more often as the deadline comes closer. Over the last 30 days they send about three times as many reminders as before, and on-time completion does not improve. All cohorts are behavioural or organisational (account, team, manager); nothing about the person is generated.

| Account | Employees | Teams (behind in bold) | Required courses (assigned → due, days) |
|---|---:|---|---|
| Northwind Logistics | 95 | **Warehouse operations**, Customer service, Finance, Fleet planning | Cloud Foundations (−82 → −36), Infrastructure as Code (−30 → +6) |
| Helix Health Partners | 80 | **Patient services**, Clinical administration, People and culture | First-Time Manager (−66 → −22), Feedback and Difficult Conversations (−20 → +14) |
| Corvel Bank | 60 | **Retail branches**, Risk and compliance, Data office | SQL for Analysts (−56 → −12), Data Visualization Fundamentals (−10 → +30) |

### 4.1 Where it is in LearnLoop

**State (in every stage).**

| File | Fields | LearnLoop code |
|---|---|---|
| `data/seed/organizations.json` | `id` (`org_…`), `name`, `created_at` | `packages/shared/src/store.js` `DOMAINS`; `services/admin/src/repositories/organizations.js` |
| `data/seed/users.json` (employees only) | `organization_id`, `manager_id` (the manager's user id, same account; `null` for a manager), `department` (the team) | `services/admin/src/repositories/learners.js` |
| `data/seed/training_assignments.json` | `id` (`asg_…`), `organization_id`, `user_id`, `course_id`, `assigned_at`, `due_at` (end of the due day), `required_pass_score` (60) | `services/admin/src/repositories/trainingAssignments.js` |
| `data/seed/progress.json`, `quiz_results.json` | the employee's lesson records and every quiz attempt (a quiz can be taken again) | `services/learning/src/services/progress.js` `getCourseRecord` |
| `data/seed/notifications.json` | the reminders: `type: "staff_message"`, `title`, `body`, `link: "/notifications"`, `created_at`, `read_at` | `services/notifications/src/services/inbox.js` |

An assignment's status is **derived, never stored** (`services/admin/src/services/training.js` `trainingState`, copied in `src/contract/training.js` and compared by `test/contract.test.js`): **completed** once every lesson of the course is completed and every quiz in it has an attempt ≥ `required_pass_score` (`completedAt` = when the last of those happened; `completedOnTime` = `completedAt ≤ due_at`); otherwise **overdue** after `due_at`, **in_progress** with any lesson or quiz activity on the course, else **assigned**. "At risk" (used below, not a LearnLoop status) = not completed and due within 14 days after the start date.

**Routes and events.**

| Route | Who | Events | LearnLoop code |
|---|---|---|---|
| `GET /api/admin/learners` (`?organization=<id>` filters one account; each row carries `organization`, `department`, `managerName`) | staff, once per Admin visit | none | `services/admin/src/routes.js`, `services/learners.js` |
| `GET /api/admin/learners/{userId}/training` (new) | staff, per employee looked up | none (one request line) | `services/admin/src/services/training.js` `getLearnerTraining` |
| `POST /api/admin/learners/{userId}/message` | staff, per reminder | `notification_created` (system), `staff_message_sent` (staff, entity = the notification id), `email_sent` (system) | `services/admin/src/services/messages.js` |
| `POST /api/me/notifications/{notificationId}/read` (after `GET /api/me/notifications`) | employee opening a reminder | `notification_opened` | `services/notifications/src/services/inbox.js` |
| `POST /api/lessons/{lessonId}/quiz` | employee (re)taking a quiz | `quiz_submitted` (value = score) | `services/learning/src/services/quiz.js` |

Free text is never logged (`packages/shared/src/logger.js`): a reminder's title and body exist only in `notifications.json`; the logs carry the notification id.

### 4.2 Numbers

**State** (the same in all three stages; 15 Nov, range over seven start weekdays):

| Fact | 15 Nov | Range |
|---|---|---|
| employees / assignments | 235 / 470 | same |
| statuses at the start date | completed 242, assigned 148, in progress 11, overdue 69 | overdue 59 … 76 |
| on time, the three deadlines already past (−36, −22, −12) | 63.2%, 62.5%, 65.0% (149 of 235) | 53 … 74% each; never better at the last deadline than at the first by more than a few points |
| overdue share of the courses due by the start date, behind teams | Warehouse operations 66.7%, Patient services 78.6%, Retail branches 84.2% | 48 … 93% |
| the same, the other seven teams | 3.4 … 22.2% (11 of 158 overdue) | 0 … 22% |
| at risk (due within 14 days, not completed) | 120 (Northwind 68, Helix 52) | 120 … 136 |

**Logs** (earlier → recent window):

| Fact | Stages 1 and 2, all start weekdays | Stage 3, 15 Nov | Stage 3, all start weekdays |
|---|---|---|---|
| reminders (`staff_message_sent` with a template title) | 103 … 146 → 94 … 155 | 121 → 303 | 103 … 146 → 293 … 388 |
| reminders per weekday | 4.9 … 6.6 → 4.5 … 7.4 | 5.5 → 15.2 | 4.9 … 6.6 → 14.0 … 18.5 |
| training look-ups (`GET …/training`) | = reminders | 121 → 303 | 103 … 146 → 293 … 388 |
| employees looked up | 40 … 56 → 48 … 80 | 51 → 98 | 40 … 56 → 93 … 113 |
| most reminders by one staff member in one week | 26 … 45 → 25 … 50 | 36 → 63 | 26 … 45 → 42 … 66 |
| reminder titles / share of the most frequent title | 2 … 3 / 57 … 68% → 5 / 33 … 51% | 3 / 59.5% → 6 / 28.7% | → 6 / 23 … 33% |
| reminders opened | 38 … 64 → 23 … 58 | 47 → 95 | → 94 … 133 |
| reminders followed by a lesson on that course within 7 days | 18 … 46% → 14 … 25% | 31% → 23% | → 22 … 28% |
| staff learner-list loads (`GET /api/admin/learners`) | 39 … 49 → 36 … 45 | 44 → 37 | unchanged (the list is loaded once per visit) |
| employees' quiz attempts / below the pass score, required courses | 173 … 205 / 27 … 38 → 84 … 105 / 12 … 23 | 205 / 31 → 85 / 17 | same as stages 1 and 2 |
| distinct people on the staff routes | 1 → 1 (the office address) | 1 → 1 | 1 → 1 |

Reminders peak in the ten days before each deadline and the three weeks after it (the busiest days of the 60 are always within that span of a due date). Sofia sends the largest share (50 … 60%). In stages 1 and 2 the recent window holds the follow-up at its earlier level, day for day (each recent day keeps as many chases as the same weekday four weeks earlier); stage 3 adds the rest.

### 4.3 Which capability, and why no current detector fires

The staff side (`/api/admin/learners…`) is in the admin capability ("Platform administration"); the employees' learning is in the learning capability, where it is part of case 1's numbers; the reminders land in the notifications capability. `test/governance-agent.test.js` runs the agent's own `observationsForGoal` with a goal "95% of mandatory training completed on time across enterprise accounts" linked to the admin capability: **nothing is raised in any stage on any start weekday**, and stage 3 gives exactly stage 2's observations, fingerprints included. Why:

- **Every current rule reads route baselines only** (`platform/telemetry/ingestion.js`: per route requests, distinct client IPs, daily counts, error rates, latency). None reads a state document (`training_assignments.json`, `users.json` organisational fields, `quiz_results.json`), an event payload, or a notification's text.
- **ACTOR_INACTIVITY** needs ≥ 200 people in the earlier window; the staff routes have one (the office address). It also looks for falls; the staff's activity rises.
- **GOAL_TREND_NEGATIVE** needs a falling daily series; the follow-up rises in stage 3 and is held at its earlier level in stages 1 and 2. (A capability's daily series is the latest route row per day, the least busy route first. The follow-up runs inside the staff's ordinary Admin visits, whose learner-list load is present on almost every weekday and is less busy than the look-ups and reminders, so withholding the surge does not change the admin series. Withholding whole routes, or opening the learner list once per employee, made a false −13 … −38% trend on that goal in stages 1 and 2 on several start weekdays; that is why the case is withheld as an activity and the list is loaded once per visit, the way LearnLoop's Admin page works: it filters the list in the browser.)
- **USAGE/HIDDEN/UNDERUSED/JOURNEY/DEMAND_SHIFT** compare capability volumes and serving weights; nothing here moves those.
- **The employees' learning** is not withheld in any stage: it is case 1's traffic, and withholding it would change case 1's numbers. Linking the compliance goal to the learning capability would only repeat case 1's lesson finding under the compliance goal.

**What a compliance detector would have to read** (none of this exists in the agent today):

1. **State, joined by user:** `training_assignments.json` × `users.json` (`organization_id`, `department`, `manager_id`) × `progress.json` × `quiz_results.json`, with LearnLoop's `trainingState` rule. Per account, team and manager: courses due by now, overdue, completed on time, at risk (due within N days, not completed), and the on-time share per deadline over time. The case shows as: overdue share in the behind teams 48 … 93% against 0 … 22% elsewhere (the three behind teams, one per account, hold at least 60% of all overdue courses), 120 … 136 courses at risk, and an on-time share of 53 … 74% per deadline that does not improve, against a 95% goal. The assignments can be read in any stage; they are what the reminders are about.
2. **Application logs, per staff actor** (`user.id` is the pseudonymised staff id in `app-logs/service=admin/…`; CloudFront cannot separate the three staff, they share one address): per week, the count of `GET /api/admin/learners/{userId}/training` request lines and `staff_message_sent` events, the distinct employees looked up (the `{userId}` is in the CloudFront `cs-uri-stem`, not in the app-log route template), and the ratio of the recent window to the earlier one (≈ 1 in stages 1 and 2, 2.4 … 3.2 in stage 3). A look-up followed within minutes by a message to the same user, repeated tens of times a day by one person, is the manual process.
3. **Template repetition:** join `staff_message_sent` `entity.id` to `notifications.json` (`title`, `body`): 6 titles for 293 … 388 recent reminders, the bodies differing only in the name, the course, the date and the percentage.
4. **Timing against deadlines:** reminder counts per day relative to each assignment's `due_at` (peaks from −10 to +21 days).
5. **Trend despite effort:** reminders up about three times while the on-time share per deadline stays flat and only 22 … 28% of recent reminders are followed by any lesson activity on that course within 7 days (lesson events in the logs, or `progress.json`). Effort up, outcome flat, is the opportunity: a staff compliance view and an AI agent that follows up, reschedules, escalates to the manager and adapts the required training.

Protected or demographic attributes are not generated, not inferred, and not needed by any of the above.

## 5. Data a staff "AI-agent notifications" screen would read

What a future screen listing the messages an AI agent sent (and whether they worked) can read today, without a LearnLoop change:

| Data | Where | Notes |
|---|---|---|
| each notification: `id`, `user_id`, `type`, `title`, `body`, `link`, `created_at`, `read_at` | `notifications.json`; written by `createNotification` (`services/notifications/src/services/inbox.js`) | `read_at` is `null` until the learner opens it; `POST /api/me/notifications/{notificationId}/read` sets it once and logs `notification_opened` |
| `applied_by_agent: true` | the same record, written by the agent's own code when it creates a notification | not exposed by `toPublicNotification` (learners do not see it); `tools/ops/src/new-notifications.js` (`npm run notifications:since`) reports it |
| who it went to: organisation, team, manager | `users.json` (`organization_id`, `department`, `manager_id`), `organizations.json` | `GET /api/admin/learners?organization=<id>` gives the rows |
| what it was about | the assignment (`training_assignments.json`) and its derived status via `GET /api/admin/learners/{userId}/training` | the status before and after the message |
| the outcome | later lesson activity on the course: `lesson_started` / `lesson_completed` events after `created_at`, `progress.json` `last_activity_at`, and whether the assignment became completed (and on time) | a reminder with no later activity is the honest "did not work" |
| delivery | `email_sent` event (or a failed one) after the message, per notification | the email address is never logged |

## 6. Personas

| Login | Stage | What they show |
|---|---|---|
| `ana.moreno@example.com` | 1 | lapsed: 35% of Cloud Foundations, last lesson day −33, signs in afterwards; not an employee |
| `marco.bellini@example.com` | 2 | two courses waiting in his cart, checkout left on day −9; not an employee |
| `lena.hoffmann@example.com` | 3 | an employee in a behind team, still signing in and learning, overdue on a required course she has started (often with a failed quiz attempt), with several reminders (some unopened). Chosen after the simulation, so her account, team and course depend on the start date (15 Nov: Corvel Bank, Retail branches, SQL for Analysts at 90%, due 3 Nov, 5 reminders) |
| `tobias.brandt@example.com` | 3 | Lena's manager (her `manager_id`); his team holds several overdue courses |
| `sofia.lindqvist@example.com` | all | staff; sends most reminders; Admin → Learners → Training shows any employee's required courses |

Password `learnloop-demo` for every account.

## 7. Reproduce

```bash
npm test                                   # all checks below, offline
node --test test/scenarios.test.js         # case 3's signals with margin; cases 1–2 unchanged without the compliance pass
node --test test/staged-reveal.test.js     # per stage: what is left out, the surge only in stage 3
node --test test/governance-agent.test.js  # the agent's own detectors over each stage (needs ../governance-agent)
node --test test/contract.test.js          # the training route and status rule against LearnLoop (needs ../LearnLoop)
```

A note found on the way, not caused by this case: a goal linked to the notifications capability gets NBF-DRIFT-GOAL_TREND_NEGATIVE (−28 … −61%) on some start weekdays, in every stage, with or without the compliance pass. It comes from that capability's least busy routes (the per-day "latest row wins" series), not from a change in behaviour; no goal in the business review is linked there.
