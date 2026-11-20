# learnloop-demo-tools

Generates the LearnLoop demo dataset: the mock state (`data/seed/*.json` in the LearnLoop repository) and 60 days of historical logs (CloudFront standard access logs and application logs). It also uploads both to a deployed LearnLoop stack.

This repository is kept separate from LearnLoop on purpose. The external analysis tool reads the LearnLoop code and logs, so the behaviour model behind the history lives here and is never visible to it. Do not copy anything from this repository into LearnLoop except the generated `data/seed/*.json`.

## Layout

```
scenarios/*.json   one file per scenario: what the simulated learners do (data, never code)
business-docs/     one quarterly business review per scenario (<scenario-id>.md), written as the business would
src/scenarios.js   loads and validates scenarios; canonical JSON, the SHA-256 fingerprint, plain-words reveal
src/model.js       behaviour model: population, cohorts, sessions, cancellations, renewals, releases, driven by a scenario
src/compliance.js  enterprise accounts, required training, quiz retakes and the staff's follow-up (scenario parameter `compliance`)
src/emit.js        request stream -> CloudFront W3C files (gzipped, one per hour) and JSON Lines app logs
src/generate.js    entry point and the statistics the tests (and the simulator page) read
src/content.js     course catalog, lesson titles, quizzes, names, user agents, edge locations
src/contract/      code copied from LearnLoop: pure logger builders + pseudonymisation, addMonths, completionPercent,
                   the support reply target (replyDueAt), the required-training status rule (trainingState),
                   and actions.js: the lines each cart/support/training request writes
src/cli.js         npm run seed
src/upload.js      npm run seed:upload (and the upload sets the simulator shares; uploadState merges a later stage into the live state)
src/merge.js       how a later stage adds to the live app state: per domain, by record key, never overwriting (pure)
src/stack.js       the two targets (Production = LearnLoopProd, Staging = LearnLoopStaging) and their stack outputs
src/simulator/     npm run simulator: node:http server, SSE progress, actions, AWS and git layers, log-line sentences
infra/             the simulator in AWS (npm run cloud): CDK stack, CloudFront password function, deploy/start/stop script; Dockerfile at the root
simulator/         the page: index.html, app.js, styles.css (no libraries, no CDN)
test/              generator, scenario, staged-reveal, merge and simulator checks, contract checks against ../LearnLoop,
                   and the staged reveal run through the Governance Agent's own detectors (../governance-agent)
docs/signal-spec.md  what each stage of q4-three-signals puts where, its numbers, and the detectors that see it (or not)
```

`test/contract.test.js` compares the copies in `src/contract/` with the LearnLoop code, reads a generated q4-three-signals state through LearnLoop's own training route and service, and runs the real LearnLoop handlers for every row of `src/contract/actions.js` (cart read/add/remove, enrol, support list/ask, staff queue/reply, training look-up, staff message, notification read, quiz) to check the event lines, their order before the request line, entity types, actors and route templates the generator writes. It runs when the LearnLoop repository, with `node_modules` installed, is at `../LearnLoop` or at `$LEARNLOOP_REPO`, and is skipped otherwise. Run it after any change to the LearnLoop logger or to those routes.

## Usage

Clone this repository next to `LearnLoop` (or set `LEARNLOOP_REPO=/path/to/LearnLoop`). Then:

```bash
npm ci
npm test

# the salt must be the deployed one, so seeded and live user.id values match
SALT="$(aws secretsmanager get-secret-value --secret-id learnloop/prod/log-pseudonym-salt --query SecretString --output text)"
npm run seed -- --scenario lapsed-learners --anchor 2026-11-03 --salt "$SALT" --seed 42
npm run seed:upload                              # LearnLoopProd
npm run seed:upload -- --stack LearnLoopStaging  # the staging deployment (generate with its own salt, the learnloop/staging/ secret)
```

`--scenario` defaults to `lapsed-learners`; see [Scenarios](#scenarios). `--stage <n>` generates one stage of a staged scenario (`q4-three-signals`: stage 0, the history, then stages 1 to 3; see [Presenting the staged reveal](#presenting-the-staged-reveal)); without it, or with the last stage, the output is the whole scenario. The simulator page does all of this without a terminal: see [The Activity Simulator](#the-telemetry-activity-simulator).

`npm run seed` is deterministic: the same arguments produce byte-identical output. It writes:

- `<LearnLoop>/data/seed/*.json` (override with `--data-dir`), one per LearnLoop state domain, including `carts.json`, `support_requests.json`, `organizations.json` and `training_assignments.json` (the last two are `[]` for a scenario without enterprise accounts, so a load never leaves another scenario's accounts behind). Commit these in the LearnLoop repository.
- `out/cloudfront/<distribution-id>.<YYYY-MM-DD-HH>.<unique>.gz`, one file per hour for days −60 … −1.
- `out/app-logs/service=<service>/dt=<date>/<service>-<date>-<HH>.log`, written only for hours that have traffic.
- `out/manifest.json` (the scenario and the arguments, salt included) and `out/stats.json` (including `detectorWindows`, the numbers the Governance Agent's detectors compare, and a `daily` series). The `out/` directory is git-ignored.

`npm run seed:upload` reads the stack outputs of the target (`--stack`, default `LearnLoopProd`; `LearnLoopStaging` is the staging deployment, with the same output keys and its own salt secret) and checks that the salt matches that stack's `LogPseudonymSaltSecretName` secret; a stack that does not exist is reported by name. It regenerates the CloudFront files with the real `DistributionId` and `DistributionDomainName`, then uploads to these places:

| What | Bucket (stack output) | Key |
|---|---|---|
| state | `StateBucketName` | `state/<domain>.json` |
| application logs | `AppLogsBucketName` | `app-logs/service=…/dt=…/…log` |
| CloudFront logs | `AccessLogsBucketName` | `<CloudFrontLogPrefix><distribution-id>.<YYYY-MM-DD-HH>.<unique>.gz` |

The upload refuses to run if any CloudFront key would fall outside `CloudFrontLogPrefix` (`cloudfront/`), which is the prefix the distribution's standard logging writes to.

**The state documents: replaced, or added to.** A single load and stage 0 of a staged reveal replace `state/<domain>.json`, as a load always did. Stages 1 to 3 add to the live state instead (`src/merge.js`), because between two stages the app keeps running: the AI agents the presenter approved write their notifications (`applied_by_agent: true`), learners and the presenter mark notifications read, the presenter may check out a cart, and the merged agent code may create records of its own. The rule, the same for every domain:

| Domain | One record is | |
|---|---|---|
| `users`, `courses`, `lessons`, `enrolments`, `subscriptions`, `notifications`, `quiz_results`, `support_requests`, `organizations`, `training_assignments` | `id` | |
| `carts` | `user_id` (one cart per learner) | |
| `progress` | `lessons[]`: `user_id` + `course_id` + `lesson_id`; `courses[]`: `user_id` + `course_id` | |

- every live record is kept as it is, in its order (what the app or an AI agent wrote is never touched);
- a record the stage introduces (in the stage's state, not in the state of the stage loaded before, the *base*) and not live yet is added at the end;
- a record the live document holds with a different value is **never overwritten**: it is reported, as *changed in the app since the last load* (it differs from the base) or as *a change this stage would make* (the app still has it as loaded);
- a record of the base that is no longer live was removed in the app (Marco's checked-out cart, say): it stays removed, and is reported;
- a domain this tool does not generate is never touched; a live document that is not JSON, or not the expected shape, stops the upload before anything is written.

The base is recomputed from the same generation (the simulator's worker writes it to `<out>/merge-base/`), so "removed in the app" and "new in this stage" are told apart exactly. Every live document is read before the first write, a document is written only if the stage adds to it, and only over the version read (`If-Match` on its ETag, the way LearnLoop itself writes); if the app wrote it in between, it is read and merged again, at most twice in all. For `q4-three-signals` the only stage that changes the state is stage 3 (it adds the reminders of the follow-up surge to `notifications.json`); stages 1 and 2 add traffic only and write no state document. `seed:upload` merges the same way (base: the stage before; `--replace-state` replaces instead). Publishing to LearnLoop's main always commits the stage's **generated** state (`data/seed/`), never the merged live state.

## The history (lapsed-learners, the default scenario)

Days −60 … −1 before the anchor date, with no missing hour. Every scenario shares the population, catalog, personas, releases, crawler and network identity below; the cohort behaviour, cancellations, latency and errors are what a scenario changes.

- 420 learners (all with monthly subscriptions started 61–200 days before the anchor) and 3 staff.
- Cohort A (195 learners) opens lessons 2–5 days a week throughout.
- Cohort B (145 learners) does the same until a last-lesson day spread evenly over days −45 … −31. After that they keep signing in every few days, looking at the dashboard, catalog and progress, but never open a lesson again. Their `progress.courses[].last_activity_at` equals their last `lesson_started` / `lesson_completed`.
- Cohort C (80 learners) signs in rarely and never opens lessons in the window.
- Distinct learners on the learning routes: about 340 in days −60 … −31 and about 195 in days −30 … −1. Sign-ins, dashboard, catalog and `/api/me/progress` fall about 10%.
- Cancellations run at about 4 a week in the first month and about 11 a week in the last two weeks, mostly from cohorts B and C. Cancelled learners send no traffic afterwards.
- Renewals happen daily at 00:10 UTC (`actor_type: system`). Staff send about 3 messages a week, unevenly.
- Health stays flat: 5xx below 0.3% per route per day, p95 about 120 ms on lesson routes and about 60 ms elsewhere, and a release every 10–14 days.
- About 1% of requests come from Googlebot, on public pages only. Each learner has one stable IP from the documentation ranges.
- **No cart or support traffic.** lapsed-learners predates the server-side cart and the Help page and must stay byte-identical (the digest test), and any new request would change every CloudFront file after it (the emitter draws its random fields per request). So its `carts.json` and `support_requests.json` are empty (`[]`), and no cart or support line is written. Its scenario file has no `carts`/`support` parameters, so its fingerprint is unchanged too.

### Carts and support questions (every other scenario)

`carts` and `support` are optional scenario parameters, each drawn from its own random streams (`carts`, `support`, `sessions-extra`, `ids-extra`), so a scenario without them produces exactly what it produced before they existed. The baseline that `steady-state`, `slow-lessons`, `outage-drop` and `abandoned-carts` use:

- Every session loads the cart at sign-in (`GET /api/me/cart`, as the web app does).
- A learner who has finished every course they are enrolled in gets the next one through the cart: course page, `POST /api/me/cart/items` (`cart_item_added`), then (85%) the checkout: two `GET /api/me/subscription`, one `POST /api/courses/{courseId}/enrol` per course in the cart (`course_enrolled`; enrolling takes the course out of the server cart without an event), `GET /api/me/cart`. Otherwise the course stays in the cart and the learner reviews lessons of a course they already have. A few courses are also put in the cart for later, revisited, or removed (`DELETE …/items/{courseId}`, `cart_item_removed`). About 8 learners end with something in their cart.
- About 3 support questions a week (`GET` then `POST /api/me/support-requests`, `support_request_created`, entity `support_request`, topics billing / account / course_content / certificate / other). Staff answer from their Admin visits on weekdays in office hours (`GET /api/admin/support-requests`, `POST …/{requestId}/reply` with `notification_created` (system) then `support_reply_sent` (staff)); the reply is a `support_reply` inbox notification the learner later opens. Questions are answered the same day or the next morning.

Three more optional parameters, used only by `q4-three-signals` (so every other scenario's output is unchanged byte for byte; `test/scenarios.test.js` pins the digests of the five others):

- `visitRate` (`{ fromDay, toDay, fromShare, toShare }`): the learners' own visits (lessons and browsing; not the staff's work nor the personas' scripts) at `fromShare` of their usual rate on `fromDay`, changing in a straight line to `toShare` on `toDay`, and at their usual rate on every other day. `q4-three-signals` uses 0.74 → 1.33 over days −60 … −30 (learners back after the summer), so the goals' series the agent reads at onboarding (the earlier window alone) rise rather than fall (see [Presenting the staged reveal](#presenting-the-staged-reveal)).
- `carts.lapsedAddPerBrowseSession` (needs a lapse): learners who stopped opening lessons keep browsing and save a course in the cart on that share of their visits, and never complete the checkout.
- `compliance`: enterprise accounts whose employees must complete required courses by a deadline (`src/compliance.js`). It runs after the 60 days are simulated, from its own random streams, so it changes no request, lesson, enrolment or cart the other cases are read from; it only adds. Employees are learners enrolled in their account's first required course who never cancel; each account has teams, one of them marked behind, and a manager per team; the employees who did not complete the first course on time are mostly placed in the behind team. Organisational facts only (account, team, manager). A required course is completed when every lesson is completed and every quiz has an attempt at or above `requiredPassScore`, the rule LearnLoop's training view uses; employees on required courses take a quiz they skipped and often retake one they failed. On weekdays, in their ordinary Admin visits, the staff open each lagging employee's training (`GET /api/admin/learners/{userId}/training`) and send a reminder from one template (`POST /api/admin/learners/{userId}/message`), from `daysBefore` before each deadline to `daysAfter` after it, more often as it approaches; employees open some reminders on a later visit and change nothing else. From `followUp.surgeFromDay` on, the follow-up above the level of the same weekday four weeks earlier is tagged as the surge, which a staged reveal can leave out. Details and numbers: [`docs/signal-spec.md`](docs/signal-spec.md).

## Demo personas

| Login | Id | Role | Behaviour |
|---|---|---|---|
| `ana.moreno@example.com` | `usr_a7e3c1d90b42` | learner (cohort B) | Enrolled only in Cloud Foundations, at 35% (3 of 8 lessons, weighted by duration). Last lesson activity on day −33. Signs in every few days afterwards and has no unread notifications. |
| `marco.bellini@example.com` | `usr_5d81f0c3a9e6` | learner (cohort A) | Enrolled in SQL for Analysts and Serverless Applications. Last lesson on day −1. In `abandoned-carts` he has Python for Data Work (day −16) and Data Visualization Fundamentals (day −9) in his cart and left the checkout page on day −9 without completing it. |
| `lena.hoffmann@example.com` | generated | learner (employee) | Only in `q4-three-signals`. An employee of an enterprise account, in the team that is behind; still signs in and learns, but is overdue on a required course she has started (usually with a failed quiz attempt) and has had several reminders from the team, some unopened. Chosen after the simulation, so her account, team and course depend on the start date (15 November: Corvel Bank, Retail branches, SQL for Analysts at 90%, due 3 November, 5 reminders). Admin → Learners → Training shows it. |
| `tobias.brandt@example.com` | generated | learner (manager) | Only in `q4-three-signals`. Lena's manager (her `manager_id`), in the same team; his team holds several overdue courses. |
| `sofia.lindqvist@example.com` | `usr_c4f2b7e1d038` | staff | Signs in on most weekdays. Turned on `new_catalog_filters` on day −51 (or the next weekday). Answers most learner questions (Admin → Support requests); in `q4-three-signals` she sends most of the training reminders. |
| `daniel.okafor@example.com`, `priya.nair@example.com` | generated | staff | Sign in on some weekdays and send some of the staff messages. |

The password for every account is `learnloop-demo`.

In every scenario Ana keeps her script (35% of Cloud Foundations, last lesson on day −33, signing in afterwards), Marco has his last lesson on day −1 and Sofia turns on `new_catalog_filters`, so the demo walk-through works whichever scenario is loaded.

## Scenarios

A scenario is one JSON file in `scenarios/`: an id, a title and a two-to-three-sentence description for the audience, the finding the Governance Agent should raise in plain words, `status` (`verified` with `verified_against`: the Governance Agent files and the threshold the generated numbers cross, or `experimental` with a reason) and `parameters`. JSON and not a JS module on purpose: the generator only interprets numbers, so the whole definition can be sealed into a SHA-256 fingerprint before the demo and revealed verbatim afterwards, and what is revealed is provably everything the generator was told.

The thresholds were read from the Governance Agent's detector code (`~/code/governance-agent/packages/...`) and the generated numbers checked against them in `test/scenarios.test.js` (anchor 2026-11-15, seed 42; release days and weekly shapes move a little with the anchor's weekday, the margins of `slow-lessons`, `outage-drop` and `steady-state` were checked for start dates on all seven weekdays). The agent reads two 30-day windows: days −59 … −30 (the history read) and −29 … 0.

| id | What it simulates | Expected Governance Agent finding | Status |
|---|---|---|---|
| `lapsed-learners` (default) | About six weeks before the start date, 145 learners stop opening lessons over two weeks but keep signing in; cancellations climb. | **NBF-USAGE-ACTOR_INACTIVITY** on part of "Course delivery and learner progress": distinct users on the lesson routes 340 → 195 (−43%, threshold `ACTOR_INACTIVITY_DROP_PCT` = 33, earlier window ≥ `MIN_INACTIVITY_ACTORS` = 200); health flat, so `incident_or_outage` is ruled out. | verified (detector code, and raised live on app `app_f41fb3ab2e5e`) |
| `steady-state` | Nothing changes: same learners, same pace, healthy app, about 4 cancellations a week. | **No usage, drift or performance finding**: lesson users change < 1% (33), learning-route trend −2% (`TREND_FLAT_PCT` = 10), p95 ~120 ms (default budget p95 1000 ms / p99 2500 ms). Findings about the code itself are unaffected. | verified (detector code) |
| `slow-lessons` | The first release on or after day −50 (it lands between −50 and −37) makes lesson routes slow: median 1.3 s; learners keep learning. | **COP-PERF-LATENCY_BUDGET** on the lesson routes (`packages/modules/code-optimization/performance.js`): p95 ~2.0 s in the earlier window and ~2.3 s in the recent one, over budget in **both** windows with ~20,000 latency samples (`MIN_LATENCY_SAMPLES` = 100) and complete baselines (60% / 30 observations); no usage finding. COP-PERF-REGRESSION is not expected (the earlier window is already slow). | verified (detector code) |
| `abandoned-carts` | Learners keep putting their next course in the cart at the same pace, but from days −40 … −30 on, 40% of them stop completing the checkout; the courses stay in the cart and they review lessons they already have. | **NBF-USAGE-ACTOR_INACTIVITY** on part of the catalog/purchase capability: distinct client IPs on `POST /api/courses/{courseId}/enrol` 315 → 170 (−46%; 41–47% on all seven start weekdays; `ACTOR_INACTIVITY_DROP_PCT` = 33, earlier window ≥ `MIN_INACTIVITY_ACTORS` = 200), while `GET /api/me/cart` (−4%) and `POST /api/me/cart/items` (−4%) stay flat, so the route-level fallback names the enrol route; health flat, learning flat (progress/quiz routes about −15%, under 33). ACTOR_INACTIVITY is agentic-eligible (`approach/eligibility.js`); about 145 learners end with courses waiting in their cart. | verified (detector code) |
| `q4-three-signals` | After a busy September (learners' visits rise to 1.33 times their usual rate over days −60 … −30, `visitRate`), three changes in the same weeks, at the edge of the agent's two windows: 145 learners open their last lesson on day −31 or −30 and keep signing in, still browsing and saving courses in the cart; 12% of learners stop completing the checkout from days −29 … −26 (nobody removes a course from the cart); and 235 employees of three enterprise accounts fall behind on required courses with deadlines, concentrated in one team per account, while the three staff chase them by hand with about three times as many near-identical reminders in the last 30 days as before, and on-time completion does not improve. Help and support stay an ordinary feature. | **Two NBF-USAGE-ACTOR_INACTIVITY findings, one per capability** (distinct client IPs, days −59 … −30 against −29 … 0, ranges over all seven start weekdays): learning: `GET /api/lessons/{lessonId}` 334 → 193 (−42%), `POST …/progress` −42 … −43%; catalog: `POST /api/courses/{courseId}/enrol` 316…333 → 149…164 (−50 … −55%) while `POST /api/me/cart/items` moves −8 … −14%. Each capability's busiest route moves 3 … 4%, so the route-level fallback names exactly those routes; health flat; both agentic-eligible. **The compliance case is an NBF-USAGE-MANUAL_FOLLOW_UP finding** on the training goal (the application-log follow-up read and the state documents read; see `docs/signal-spec.md`): about 64% of the required courses due so far completed on time (15 November), 50 … 92% overdue in the behind teams against 0 … 17% elsewhere, reminders 90 … 135 → 295 … 369 (`docs/signal-spec.md`). The state ends with 144 … 150 learners with a waiting cart. | verified (detector code) |
| `outage-drop` | Days −32 … −24: 92% of lesson opens fail with a server error, learners retry 2–5 times; afterwards 56% of the active learners never open a lesson again; some cancel. | The honesty showcase. `incident_or_outage` is **confirmed** in both windows (server errors on the learning routes ~7–9% and ~28%, threshold `INCIDENT_ERROR_RATE_PCT` = 5), so **NBF-DRIFT-GOAL_TREND_NEGATIVE** (learning requests −34 to −39%, threshold 10%) is raised with the outage as its deterministic cause, and the **NBF-USAGE-ACTOR_INACTIVITY** candidate (progress route −43 to −48%) is withdrawn as `explained_by_confirmed_alternative` and listed in the detection report. | verified (detector code) |

Dropped, with the reason:

- `unused-feature` (NBF-USAGE-CAPABILITY_DEAD / CAPABILITY_UNDERUSED). DEAD needs zero volume over a 90-day window, and a capability's series only starts at its first observed request, so with 60 days of history any capability that was ever used has volume > 0, and one never used has no baseline at all (`measured: false`, which the structural engine reports as uninstrumented, not as dead). UNDERUSED compares a capability's share with the serving weight a confirmed goal declares for it, which comes from the goal linking, not from the activity.
- `enrolment-dropoff` (NBF-USAGE-JOURNEY_DROPOFF). A funnel exists only along `depends_on` edges between capabilities that the capability derivation (a model) draws, and retention is a ratio of whole-capability volumes; whether catalog browsing and enrolment are one capability or two, and whether the edge exists, is not something the activity decides.

### Presenting abandoned-carts

**abandoned-carts.** Load it as usual on a fresh Governance Agent application. Upload `business-docs/abandoned-carts.md` (the simulator's "Download the business review" button) and confirm the goals, in particular *Complete the purchases learners start* (at least 300 learners completing a checkout every 30 days). Check that this goal is linked to the capability the agent derived for the catalog, cart and enrolment (it holds `POST /api/courses/{courseId}/enrol`); if the derivation put enrolment somewhere else, link that capability on the goal. The finding follows the telemetry read like lapsed-learners'. Demo persona: **Marco Bellini** (`marco.bellini@example.com`, password `learnloop-demo`), an active learner with Python for Data Work (added day −16) and Data Visualization Fundamentals (added day −9) in his cart; he opened the checkout page on day −9 and left. The AI agent the finding proposes can read `carts` for the other ~145 learners.

### Presenting q4-three-signals

**q4-three-signals.** Load it as usual, or (the way the demo runs) the history first and then one case at a time: see [Presenting the staged reveal](#presenting-the-staged-reveal). Onboard LearnLoop as a **fresh** application in the Governance Agent (see the next section: an application that has read another scenario keeps that scenario's windows). Upload `business-docs/q4-three-signals.md` (the simulator's "Download the business review" button) and confirm its three goals. Then check, on each goal, that it is linked to the capability that holds its routes; if not, link it:

| Goal in the review | Link it to the capability that holds | Capability name before the cart and training code existed | Finding |
|---|---|---|---|
| *More learners actively progressing every week* | the lesson routes (`services/learning`: `/api/lessons/…`, `/api/courses/{courseId}/lessons`) | "Course delivery and learner progress" | fewer people on the lesson routes |
| *Complete the purchases learners start* | the cart and enrolment routes (`services/catalog`: `/api/me/cart…`, `POST /api/courses/{courseId}/enrol`) | "Course catalog and discovery" | fewer people completing the enrol step |
| *95% of mandatory training completed on time across our enterprise accounts* | the staff routes (`services/admin`: `/api/admin/learners`, `/api/admin/learners/{userId}/training`, `/api/admin/learners/{userId}/message`) | "Platform administration" | none today (see below) |

Go by which service's routes a capability holds; a re-derivation may name them differently. The detector looks only at the capabilities a confirmed goal is linked to (`detectActorInactivity` walks each goal's serving capabilities), so a capability no goal is linked to raises nothing. Do not link the training goal to the learning capability: it would only repeat the lesson finding under that goal. If the derivation puts two of the services in **one** capability it reports only the qualifying route with the most earlier users, and one of the two findings does not appear (split the capability, or read the detection report).

The findings follow the telemetry read like lapsed-learners'. The AI agent each one can lead to:

- **Lessons** — a lesson reminder for the learners who stopped (they still sign in; `progress.json` has their last lesson). Persona: **Ana Moreno**.
- **Cart** — a reminder to the 139 … 155 learners whose courses wait in `carts.json`. Persona: **Marco Bellini** (Python for Data Work and Data Visualization Fundamentals in his cart, checkout left on day −9).
- **Required training** — the manual follow-up finding (from stage 3 in the staged reveal): the staff's look-ups and near-identical reminders in the logs, the overdue assignments by account, team and manager in `training_assignments.json`, completion not improving. The opportunity: a staff compliance view and an AI agent that follows up, reschedules, escalates to the manager and adapts the training. Personas: **Lena Hoffmann** (overdue employee), **Tobias Brandt** (her manager), **Sofia Lindqvist** (Admin → Learners → Training, and the reminders she sends). Details: [`docs/signal-spec.md`](docs/signal-spec.md).

All passwords are `learnloop-demo`.

### Presenting the staged reveal

`q4-three-signals` can also be revealed **one case at a time on one Governance Agent application**: load the history (stage 0), onboard LearnLoop once, then each load adds a case, and the agent finds it beside the ones already found. The simulator page does this with one button per step (**Load the history — before onboarding**, then **Load stage N — adds case N**).

**Why the stages are built the way they are** (read from the Governance Agent code):

- "Get usage telemetry" (Settings → Connections → Usage telemetry; the button was called "Look for data now" before 15 November) runs source detection, then reads **days −29 … 0** again (`backend/src/cadence.js` `continueAfterTelemetryDetection`, window from `packages/platform/telemetry/runs.js` `telemetryWindow`). Only after the **first** read of an application does it also read **days −59 … −30** (`continueAfterTelemetryIngest`, `GA_TELEMETRY_HISTORY_WINDOWS` = 1): every later read finds that history already read (`history_already_read`). The first read is the one onboarding starts (LearnLoop's own API Gateway logs and CloudWatch metrics make it happen even with empty buckets). So the earlier window is read exactly once, at onboarding, and must be final by then: that is what stage 0 is for.
- The agent keeps the **highest** distinct-user count it has read for a window (`drift/usage.js` `actorWindowsOf`). A drop that a later stage wants to show must therefore never have had its recent window filled in by an earlier stage.
- A route with no request in a window gets **no baseline** for that window (`platform/telemetry/ingestion.js`: one baseline per route the read saw), so it has one measured window and the inactivity rule stands down (`too_few_measured_windows`); it is not read as a 100% drop.
- A goal's daily series is the latest route row per day over the days observed (`drift/decompose.js` `mergeDayMaps`, `drift/detectors.js` `goalUsage`; in practice each day's count of the capability's least busy route), split in half by `trendOf`. A day on which the source had data and the capability had none is an observed **zero** (`drift/usage.js` `sourceObservedDays`, `withZeroDays`), and route baselines that carry no capability still count as "the source had data".
- **The onboarding read runs before the capabilities exist** (seen live on 2026-11-19): its route baselines carry no capability (mapped 0%); the history read, after the derivation, maps every route. Until 19 November stage 0 kept the ordinary recent activity; that onboarding read then made every capability's days −29 … 0 observed zeros, and confirming the goals raised NBF-DRIFT-GOAL_TREND_NEGATIVE on the lesson and purchases goals (−97 … −100%; `test/governance-agent.test.js` reproduces it from the definition loaded that day, `test/fixtures/q4-three-signals-as-loaded-2026-11-19.json`). **So stage 0 now holds no recent traffic at all** (`"recent_traffic_withheld": "all"`), and the goals' series at onboarding is days −59 … −30 alone. For that window not to fall, the cases begin at its edge: the learners who stop open their last lesson on day −31 or −30 and the checkout change starts on days −29 … −26 (before, days −45 … −31 and −40 … −30, inside it), and the learners' visits rise through it (`visitRate`, 0.74 → 1.33 of their usual rate over days −60 … −30: back from the summer), so the lesson and purchases goals' series rise 23 … 43% there, against a −10% bar. The training goal's series is under the agent's volume floor (100).
- After each read the usage-and-drift look runs again (`telemetry.baselines.updated`, `drift/subscribe.js`, and on `intake.completed` once goals are confirmed). A finding already live for the same code and capability is not raised twice and is not closed by a later run (`structural/dedup.js`: `duplicate_live`).

So every stage carries the **final** traffic of days −60 … −30, from stage 0 on; stage 0 holds nothing after it (no line, no system event and no CloudFront object from day −29 on), and stages 1 and 2 withhold only **recent** traffic: the routes whose drop is a later case, or, for case 3, a named activity (`recent_activity_withheld: training_follow_up_surge`, the staff's follow-up above its earlier level). Stage 3 is `q4-three-signals` itself, byte for byte. The definition is in the scenario file (`staged_reveal.history_stage` and `staged_reveal.stages`), sealed with it; each stage has its own fingerprint (the stage, 0 to 3, is a fourth sealed input).

| Stage | Adds | Left out of the logs from day −29 on | Starting state | App state | Publishes by default |
|---|---|---|---|---|---|
| 0 | the history, before onboarding | everything (no recent traffic at all) | everything, **carts included**; the surge's reminders not in the notifications | replaced | no |
| 1 | case 1, lessons | `POST /api/courses/{courseId}/enrol`, `POST /api/me/cart/items`; the staff's training follow-up above its earlier level | the same as stage 0 | added to (nothing new) | no |
| 2 | case 2, the checkout | the staff's training follow-up above its earlier level | the same as stage 0 | added to (nothing new) | no |
| 3 | case 3, required training | nothing | the whole state | added to (the surge's reminders) | yes (Production only) |

**Carts are in the starting state from stage 0**, Marco Bellini's two courses included, so a waiting cart can be shown before stage 2. Only the recent cart and enrol **traffic** waits for stage 2: that is what the detector reads (the agent reads no cart document). The cart write routes are withheld with enrolment until stage 2 because the agent's goal-trend rule reads a capability's daily series route by route (later rows win), and with only enrolment withheld it saw a fall in the purchases goal. `GET /api/me/cart` and the course pages are in stages 1 to 3: they are the busiest routes of the catalog, so the capability-level count never moves and nothing about the store shows before its stage. Nobody removes a course from the cart (`removeShare: 0`): the remove route was so rare that the days it appeared made the purchases goal's series jump.

Case 3 is withheld as an activity, not by route, for the same rule: withholding the training and message routes (or all of the follow-up) made the staff's daily series fall in stages 1 and 2, a false goal-trend observation on the training goal on several start weekdays. So the recent window of stages 1 and 2 keeps the follow-up at its earlier level, day for day (each day as many reminders as the same weekday four weeks earlier), and stage 3 adds the rest, about twice as much again. The accounts, teams and assignments are part of LearnLoop's data model and are in the starting state from stage 0 (they are what the reminders are about, and they read the same in every stage); only the reminders of the withheld follow-up are left out of `notifications.json` until stage 3 adds them. The employees' learning is case 1's traffic.

`test/governance-agent.test.js` replays exactly this flow through the agent's own code, on start dates on all seven weekdays: the onboarding read over stage 0's logs (the current window, before the capabilities exist, so with no capability on its rows; then the history read, once, mapped), then one current-window read per later stage, with the reads merged the way the agent merges them (every baseline kept; distinct users per window the maximum across them; the earlier window only from the stage-0 read; the application-log follow-up read the same way), and LearnLoop's state documents read from the merged live state, with notifications written by AI agents between the stages in it. Three goals are linked one to one to the learning, catalog and admin capabilities.

**What appears after each read** (start dates on all seven weekdays, distinct client IPs, earlier → recent window):

| After | New finding | Numbers | Already there, unchanged |
|---|---|---|---|
| stage 0 (onboarding, goals confirmed) | none | no route has a recent window; the lesson and purchases goals' series (the earlier window alone) rise 23 … 43%; the training goal's series is under the volume floor | — |
| stage 1 | fewer people open lessons, "Course delivery and learner progress" (and the lesson goal's trend, −41 … −50%) | `GET /api/lessons/{lessonId}` 334 → 193 (−42%), progress route −42 … −43% | — |
| stage 2 | fewer people complete the enrol step, the catalog and purchase capability (and the purchases goal's trend, about −50%) | `POST /api/courses/{courseId}/enrol` 316 … 333 → 149 … 164 (−50 … −55%) | the lessons finding |
| stage 3 | the staff follow up by hand (NBF-USAGE-MANUAL_FOLLOW_UP on the training goal): three people pair a training look-up with a reminder, about three times as often as before (90 … 135 → 295 … 369 reminders), on-time completion flat, the overdue courses in three teams | see `docs/signal-spec.md` | the lessons and enrol findings, unchanged |

**The presenter, step by step** (the demo runs on one Governance Agent application, onboarded once):

1. **Before the demo.** In the Governance Agent, remove any LearnLoop application that has read another scenario or another run of this one. Download the business review once (the simulator's "Download the business review" button): it states all three goals.
2. **Stage 0, the history.** Simulator: **Load the history — before onboarding** (start date: today). It replaces the app's state. **Then onboard LearnLoop in the Governance Agent the same day**: connect usage telemetry (its first read also reads the history, once), upload the business review, confirm the three goals and check each goal's capability link (table in "Presenting q4-three-signals" above). **What appears:** no finding. Now show LearnLoop as it is, a learner's waiting cart included (Marco Bellini).
3. **Stage 1.** Simulator: **Load stage 1 — adds case 1** (the start date stays the one of stage 0). When it is done: **Settings → Connections → Usage telemetry → Get usage telemetry**, and wait for the look for opportunities to finish (a few minutes). **What appears:** the lessons finding. Approve it; the AI agent's pull request can be previewed in LearnLoop, where it writes notifications.
4. **Stage 2.** Simulator: **Load stage 2 — adds case 2**. It keeps the notifications the AI agent wrote and everything else the app holds, and adds what is new (nothing, for this stage). Then Get usage telemetry. **What appears:** the enrol finding, beside the lessons finding.
5. **Stage 3.** Simulator: **Load stage 3 — adds case 3** (on Production it also publishes the stage's generated starting state; the option is ticked by default for the last stage). It adds the surge's reminders to the live notifications. Then Get usage telemetry. **What appears:** the manual follow-up finding on the training goal, beside the other two. Show the case in LearnLoop: sign in as Sofia (Admin → Learners → Training for Lena Hoffmann), or as Lena (her reminders in Notifications).
6. **The envelope.** "Open the envelope" shows every stage, its fingerprint, and checks the loaded stage's fingerprint against the one shown before.

Rules that keep it working:

- **One start date for all stages, and onboard on the day of stage 0.** The page keeps the stage-0 start date for stages 1 to 3 and the server refuses another one, or a stage out of order (stage 2 before stage 1), or going back. Stages 1 to 3 may be read on a later day; the history window was fixed at onboarding.
- **Showing LearnLoop between stages is safe.** Each load starts with Clear, which deletes every object under `cloudfront/` and `app-logs/` in the buckets, the presenter's own visits among them, so the next read sees only the stage's activity, and the next stage's state merge keeps whatever those visits changed in the app (a cart checked out stays checked out). **After the last load, do not use LearnLoop until "Get usage telemetry" has finished**: nothing clears your visits before that read. (Clear does not touch LearnLoop's own API Gateway access logs in CloudWatch Logs, which the agent can also read: a page the presenter visited on seven or more days of the last 30, on a route a later stage reveals, could show there. Keep rehearsals on Staging.)
- **Wait for the load to finish before "Get usage telemetry".** Load clears the logs first; a read in the middle of an upload sees part of the stage (the max-merge protects the people counts, but the trend rules read the latest daily counts).
- **Findings about the goals themselves** (how a goal is measured, for example a goal with no measurable data source) come from the goals and the capability model, not from the traffic, so they are the same in every stage and in a single load. The stages only decide when each usage finding appears.
- **Start over** (on the page) loads the history (stage 0) again, with today's date, and replaces the app's state (what the AI agents wrote too). Afterwards remove the LearnLoop application in the Governance Agent and onboard it again: an application that has read a later stage keeps those recent counts forever and will never show these drops.
- **Publishing** (Production only). Upload already writes each stage's state to the state bucket LearnLoop reads. Publishing commits `data/seed/` (the stage's generated state, not the merged live one) to LearnLoop's main and pushes, which starts LearnLoop's deploy, whose "Preview reset" restores the state from main. So only the last stage publishes by default (main ends with the final state, and the demo has no deploy in the middle); the page has a per-load option to publish an earlier stage. The commit message names only the stage's fingerprint.
- **Production and Staging.** Run the whole flow on Staging (`LearnLoopStaging`) beforehand, then on Production. Each target has its own stack outputs, salt, buckets and stage progression (one record per target in `state/loaded.json`); a Staging load generates into `state/staging/` and never touches LearnLoop's repository. If the stack does not exist yet, every action says so and changes nothing.

### Before you load a different scenario

- **The Governance Agent keeps every telemetry window it has read.** Distinct users of a window are kept as the maximum across the baselines read for it, and day counts merge "latest wins", so loading a second scenario on the same Governance Agent application mixes the two (for example `lapsed-learners` after `steady-state` keeps 340 users in the recent window and the inactivity finding does not fire). For a clean demo of a different scenario, onboard LearnLoop as a new application in the Governance Agent (or remove the old one) after loading it.
- **Which window counts as "now".** The Governance Agent's history read writes the earlier window's baselines after the current one, and its health and latency checks read the newest baseline per route. `slow-lessons` and `outage-drop` are built so the condition holds in both windows, so the order does not matter.
- **One business review per scenario.** `business-docs/<scenario-id>.md` is the quarterly review to upload in the demo (the simulator's "Download the business review for this scenario" button serves it as `learnloop-q4-2026-business-review.md`, a name that does not give the scenario away). `lapsed-learners.md` is a copy of LearnLoop's `docs/business/q4-2026-business-review.md`; `abandoned-carts.md` states the goal its finding links to; `q4-three-signals.md` states the three goals of its three cases; `steady-state.md`, `slow-lessons.md` and `outage-drop.md` are neutral: their own figures, no claim about speed or outages, and all four goals. The figures are for a start date of 15 November 2026.
- **Late November.** The agent's calendar lists Black Friday / Cyber Monday (24 Nov – 2 Dec); with a start date in that range the market explanation cannot be ruled out, which lowers confidence but does not withdraw a finding.

## The Telemetry Activity Simulator

A local page for a live demo in front of a non-technical audience: the presenter picks a scenario (each card shows only its title and a description for the audience; the expected finding and the parameters stay sealed until the envelope is opened), downloads its business review, the page shows a sealed fingerprint of what the simulator is told, generates the activity day by day, shows where it lands in AWS, reads it back, and at the end opens the envelope and checks that the fingerprint still matches. No terminal, AWS console or file is needed during the demo.

```bash
npm ci
npm run simulator            # http://127.0.0.1:8790  (--port <n> or SIMULATOR_PORT to change)
```

It binds to 127.0.0.1 only, refuses requests whose Host is not 127.0.0.1/localhost, and runs with your own AWS credentials (the default chain; region `AWS_REGION`, default us-east-1) and your own git setup for the LearnLoop repository (`../LearnLoop` or `$LEARNLOOP_REPO`). Add `?pace=fast` to the address to skip the presentation pace when rehearsing.

**Load into: Production or Staging.** The choice at the top of the page (remembered in the browser) decides which LearnLoop deployment every action reads and writes: **Production** (`LearnLoopProd`) or **Staging** (`LearnLoopStaging`, the same output keys and its own salt secret under `learnloop/staging/`). Stack outputs, salt, buckets, the loaded-state record and the stage progression all follow it; the request carries only `target`, never a bucket. Publishing to LearnLoop's main is offered for Production only (the option is not shown for Staging, and the server refuses it). Staging generates into `state/staging/{seed,out}`, so a Staging load never touches the LearnLoop repository. If the chosen stack does not exist yet, every action stops before touching anything and says so.

Actions (each streamed to the page as Server-Sent Events, one at a time; a second one is refused while the first runs):

| Action | What it does | Confirmation |
|---|---|---|
| Clear | Deletes every object under `cloudfront/` in the access-logs bucket and `app-logs/` in the app-logs bucket (including any real log files written since, your own visits among them). Bucket names and the CloudFront prefix come from the chosen target's stack outputs, never from the request. | yes |
| Generate | Generates the chosen scenario for the start date (default today, UTC) with the deployed salt, read from Secrets Manager on the server (it never reaches the browser), and the real distribution id. Writes `data/seed/*.json` into the LearnLoop repository and the logs into `out/`, exactly like `npm run seed`. The page replays the 60 days over about 90 s; it says so, and how long the generator really took. | no |
| Upload | State documents, application logs and CloudFront files, with per-bucket counts. A single load and the history replace the state documents; a later stage reads the live ones and adds to them ([the merge rule](#usage)), one line per document on the page. Refuses if the files on disk are not the last generation, were made with another salt or distribution, or the loaded stage changed since Generate. | yes |
| Verify | Lists the three prefixes back (files, first and last day) against the generated counts and shows one random file as sentences and raw lines. | no |
| Publish the starting state | Production only. In the LearnLoop repository: refuses unless on `main` and nothing outside `data/seed/` is changed; `git add data/seed`, commit, push to `origin main`. Skipped when the files are unchanged. **Pushing to main also starts LearnLoop's production deploy** (its "Preview reset" workflow restores state from these files). | yes |
| Load this scenario | Clear → Generate → Upload → Verify → Publish, one confirmation. | yes |
| Load the history — before onboarding | For a staged scenario (`q4-three-signals`): stage 0, the same chain; replaces the app's state; never publishes by default. | yes |
| Load stage N — adds case N | The same chain for the next stage, adding to the live state. Publish runs only for the last stage (Production) unless "Also publish the starting state" is ticked for this load. Refused, before anything is touched, for a stage out of order, a different start date, or a stage before the one loaded on the chosen target. | yes |
| Start over | Load the history again (today's date), replacing the app's state. The confirmation says that the Governance Agent application must then be removed and onboarded again. | yes |

The commit message names the scenario by its sealed fingerprint (`Seed: load sealed scenario <first 12 hex> anchored on <date>`), not by its id: the agent reads the LearnLoop repository, and a commit titled `lapsed-learners` would tell it the answer. Set `SIMULATOR_COMMIT_SCENARIO_NAME=1` to put the id in the subject instead. The message ends with the `Co-Authored-By` line.

**Running it in AWS, from a browser.** The same simulator can run in the account, behind CloudFront and a password, so the presenter needs no terminal and no local credentials during the demo (`infra/`, stack `TelemetryActivitySimulator`, deployed from this repository only and tagged `Application=telemetry-activity-simulator`, never with LearnLoop's tag, so the Governance Agent neither reads nor scans it):

```bash
cd infra && npm ci && cd ..
npm run cloud -- deploy      # reads LearnLoopProd/LearnLoopStaging, creates the password, cdk deploy, builds the image in CodeBuild
npm run cloud -- start       # one Fargate task, about two minutes; prints the address
npm run cloud -- password    # the address, user `presenter` and the password (Secrets Manager telemetry-activity-simulator/password)
npm run cloud -- stop        # after the demo: nothing runs
npm run cloud -- status
```

CloudFront asks for the password before anything reaches the server (a CloudFront Function that holds only the SHA-256 of the expected header; `deploy --rotate-password` changes it). The load balancer is internal and reachable only through CloudFront's VPC origin; the task's role reads the LearnLoop stacks' outputs and pseudonym salts and reads, writes and deletes in their three buckets each, nothing else. `state/` and the seed folder live on EFS, so a restart keeps which stage is loaded where; the generated log files (`out/`, about 8,700 small files a generation, only a cache of it) live on the task's own disk, because written one by one to EFS they took about 90 s of a 105 s stage-0 generation (on the task's disk a stage generates in about 10 s, as on a laptop; after a restart, Load regenerates them). The task is 2 vCPU / 4 GB: the generator is one thread, the second vCPU keeps the server and the garbage collector off it, and 4 GB lift V8's heap limit well above the ~0.9 GB a generation holds. While it generates, the page says what the generator is doing (the simulated day, the share of requests written, the files saved) before the day-by-day replay. Differences from the local simulator: **Publish the starting state is not offered** (the page says so; publish from the local simulator, since a push to LearnLoop's main starts its production deploy and no git credential is kept in AWS), and the Production load generates the seed files into EFS instead of `../LearnLoop/data/seed`. A `deploy` leaves a stopped simulator stopped and rolls a running one onto the new task and image: the new task turns healthy before the old one is drained, so the page keeps answering, and the load balancer's stickiness keeps a browser on one task meanwhile; it refuses to start while an action runs and waits for one to finish before the last roll. `npm run cloud -- diff` shows what a deploy would change. Cost: the load balancer (about $16–18 a month) plus about $0.10 an hour while a task runs (2 vCPU / 4 GB on Fargate; about $72 a month if left running all the time).

**Rehearsal (dry run).** The toggle on the page (or `"dryRun": true`) runs the same steps with every write removed: the AWS and git layers' write methods are replaced by functions that throw. Clear lists what it would delete, Generate writes into `state/dry-run/` instead of LearnLoop, Upload counts what it would send and, for a later stage, reads the live state and shows what the merge would add, keep and leave alone, Verify reads the rehearsal folder back, Publish compares the files and says whether it would commit. Read-only calls (stack outputs, the salt, listings, the live state documents) still use your credentials; without them a rehearsal falls back to placeholders and says so.

Local state (git-ignored, `state/`): `loaded.json` (one record per target: which scenario, stage and start date are in AWS, when, by which action, whether the state was replaced or merged and the merge's counts, and whether the starting state was published; a file from before targets reads as Production's), `generated.json` and `last-run.json` (the last real generation's statistics, which the page's "Replay" button redraws, labelled as a replay) for Production, the same under `state/staging/` for Staging, and `state/dry-run/` for rehearsals.
