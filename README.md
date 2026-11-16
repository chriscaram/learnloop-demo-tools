# learnloop-demo-tools

Generates the LearnLoop demo dataset: the mock state (`data/seed/*.json` in the LearnLoop repository) and 60 days of historical logs (CloudFront standard access logs and application logs). It also uploads both to a deployed LearnLoop stack.

This repository is kept separate from LearnLoop on purpose. The external analysis tool reads the LearnLoop code and logs, so the behaviour model behind the history lives here and is never visible to it. Do not copy anything from this repository into LearnLoop except the generated `data/seed/*.json`.

## Layout

```
scenarios/*.json   one file per scenario: what the simulated learners do (data, never code)
business-docs/     one quarterly business review per scenario (<scenario-id>.md), written as the business would
src/scenarios.js   loads and validates scenarios; canonical JSON, the SHA-256 fingerprint, plain-words reveal
src/model.js       behaviour model: population, cohorts, sessions, cancellations, renewals, releases, driven by a scenario
src/emit.js        request stream -> CloudFront W3C files (gzipped, one per hour) and JSON Lines app logs
src/generate.js    entry point and the statistics the tests (and the simulator page) read
src/content.js     course catalog, lesson titles, quizzes, names, user agents, edge locations
src/contract/      code copied from LearnLoop: pure logger builders + pseudonymisation, addMonths, completionPercent,
                   the support reply target (replyDueAt), and actions.js: the lines each cart/support request writes
src/cli.js         npm run seed
src/upload.js      npm run seed:upload (and the upload sets the simulator shares)
src/simulator/     npm run simulator: node:http server, SSE progress, actions, AWS and git layers, log-line sentences
simulator/         the page: index.html, app.js, styles.css (no libraries, no CDN)
test/              generator, scenario and simulator checks, plus contract checks against ../LearnLoop
```

`test/contract.test.js` compares the copies in `src/contract/` with the LearnLoop code, and runs the real LearnLoop handlers for every row of `src/contract/actions.js` (cart read/add/remove, enrol, support list/ask, staff queue/reply) to check the event lines, their order before the request line, entity types, actors and route templates the generator writes. It runs when the LearnLoop repository, with `node_modules` installed, is at `../LearnLoop` or at `$LEARNLOOP_REPO`, and is skipped otherwise. Run it after any change to the LearnLoop logger or to those routes.

## Usage

Clone this repository next to `LearnLoop` (or set `LEARNLOOP_REPO=/path/to/LearnLoop`). Then:

```bash
npm ci
npm test

# the salt must be the deployed one, so seeded and live user.id values match
SALT="$(aws secretsmanager get-secret-value --secret-id learnloop/prod/log-pseudonym-salt --query SecretString --output text)"
npm run seed -- --scenario lapsed-learners --anchor 2026-11-03 --salt "$SALT" --seed 42
npm run seed:upload
```

`--scenario` defaults to `lapsed-learners`; see [Scenarios](#scenarios). The simulator page does all of this without a terminal: see [The Activity Simulator](#the-activity-simulator).

`npm run seed` is deterministic: the same arguments produce byte-identical output. It writes:

- `<LearnLoop>/data/seed/*.json` (override with `--data-dir`), including `carts.json` and `support_requests.json`. Commit these in the LearnLoop repository.
- `out/cloudfront/<distribution-id>.<YYYY-MM-DD-HH>.<unique>.gz`, one file per hour for days −60 … −1.
- `out/app-logs/service=<service>/dt=<date>/<service>-<date>-<HH>.log`, written only for hours that have traffic.
- `out/manifest.json` (the scenario and the arguments, salt included) and `out/stats.json` (including `detectorWindows`, the numbers the Governance Agent's detectors compare, and a `daily` series). The `out/` directory is git-ignored.

`npm run seed:upload` reads the `LearnLoopProd` stack outputs and checks that the salt matches the `LogPseudonymSaltSecretName` secret. It regenerates the CloudFront files with the real `DistributionId` and `DistributionDomainName`, then uploads to these targets:

| What | Bucket (stack output) | Key |
|---|---|---|
| state | `StateBucketName` | `state/<domain>.json` |
| application logs | `AppLogsBucketName` | `app-logs/service=…/dt=…/…log` |
| CloudFront logs | `AccessLogsBucketName` | `<CloudFrontLogPrefix><distribution-id>.<YYYY-MM-DD-HH>.<unique>.gz` |

The upload refuses to run if any CloudFront key would fall outside `CloudFrontLogPrefix` (`cloudfront/`), which is the prefix the distribution's standard logging writes to.

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

Two more optional parameters, used only by `q4-three-signals` (so every other scenario's output is unchanged byte for byte, checked against the digests of all five at two start dates when they were added):

- `support.help`: learners also open the Help page without a question (`GET /api/me/support-requests`) on a share of their visits; a learner with an open question checks it; one who finds it unanswered after `giveUpAfterHours`, or a share of learners from a day spread over `giveUp`, gives up on Help (opens it rarely and asks nothing more). `persona: true` gives one regular learner the identity of Lena Hoffmann and her script (below). Drawn from its own stream (`help`).
- `carts.lapsedAddPerBrowseSession` (needs a lapse): learners who stopped opening lessons keep browsing and save a course in the cart on that share of their visits, and never complete the checkout.

## Demo personas

| Login | Id | Role | Behaviour |
|---|---|---|---|
| `ana.moreno@example.com` | `usr_a7e3c1d90b42` | learner (cohort B) | Enrolled only in Cloud Foundations, at 35% (3 of 8 lessons, weighted by duration). Last lesson activity on day −33. Signs in every few days afterwards and has no unread notifications. |
| `marco.bellini@example.com` | `usr_5d81f0c3a9e6` | learner (cohort A) | Enrolled in SQL for Analysts and Serverless Applications. Last lesson on day −1. In `abandoned-carts` he has Python for Data Work (day −16) and Data Visualization Fundamentals (day −9) in his cart and left the checkout page on day −9 without completing it. |
| `lena.hoffmann@example.com` | `usr_e19b6a4c7f20` | learner (cohort A) | Only in `q4-three-signals`. An active learner. Asked about an invoice on day −50 and was answered within hours; asked whether LearnLoop issues certificates of completion on day −12, checked Help on days −9, −5 and −2, and nobody has answered. |
| `sofia.lindqvist@example.com` | `usr_c4f2b7e1d038` | staff | Signs in on most weekdays. Turned on `new_catalog_filters` on day −51 (or the next weekday). Answers most learner questions (Admin → Support requests); in `q4-three-signals` her queue holds the open backlog. |
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
| `q4-three-signals` | Three changes in the same weeks: the `lapsed-learners` lapse (145 learners stop opening lessons over days −45 … −31 and keep signing in, still browsing and saving courses in the cart); 12% of learners stop completing the checkout from days −40 … −30; and from day −40 staff take up questions more and more slowly (a median of 3 hours, then 20 days by day −30) while 57% of the learners give up on Help over days −40 … −30, as does anyone who finds their own question unanswered after two days. | **Three NBF-USAGE-ACTOR_INACTIVITY findings, one per capability** (distinct client IPs, days −59 … −30 against −29 … 0, ranges over all seven start weekdays): learning: `GET /api/lessons/{lessonId}` 334 → 193 (−42%), `POST …/progress` −45 … −46%; catalog: `POST /api/courses/{courseId}/enrol` 298…311 → 145…160 (−46 … −53%) while `POST /api/me/cart/items` moves −3 … −15%; notifications: `/api/me/support-requests` 290…307 → 148…155 (−47 … −50%) while the bell and inbox routes move under 13%. Each capability's busiest route moves about 4%, so the route-level fallback names exactly those routes; no other service crosses the bars; health flat. All three are agentic-eligible; the state ends with 140 … 155 learners with a waiting cart and 22 … 38 open questions, almost all about certificates, billing or the account. | verified (detector code) |
| `outage-drop` | Days −32 … −24: 92% of lesson opens fail with a server error, learners retry 2–5 times; afterwards 56% of the active learners never open a lesson again; some cancel. | The honesty showcase. `incident_or_outage` is **confirmed** in both windows (server errors on the learning routes ~7–9% and ~28%, threshold `INCIDENT_ERROR_RATE_PCT` = 5), so **NBF-DRIFT-GOAL_TREND_NEGATIVE** (learning requests −34 to −39%, threshold 10%) is raised with the outage as its deterministic cause, and the **NBF-USAGE-ACTOR_INACTIVITY** candidate (progress route −43 to −48%) is withdrawn as `explained_by_confirmed_alternative` and listed in the detection report. | verified (detector code) |

Dropped, with the reason:

- `unused-feature` (NBF-USAGE-CAPABILITY_DEAD / CAPABILITY_UNDERUSED). DEAD needs zero volume over a 90-day window, and a capability's series only starts at its first observed request, so with 60 days of history any capability that was ever used has volume > 0, and one never used has no baseline at all (`measured: false`, which the structural engine reports as uninstrumented, not as dead). UNDERUSED compares a capability's share with the serving weight a confirmed goal declares for it, which comes from the goal linking, not from the activity.
- `enrolment-dropoff` (NBF-USAGE-JOURNEY_DROPOFF). A funnel exists only along `depends_on` edges between capabilities that the capability derivation (a model) draws, and retention is a ratio of whole-capability volumes; whether catalog browsing and enrolment are one capability or two, and whether the edge exists, is not something the activity decides.

### Presenting abandoned-carts

**abandoned-carts.** Load it as usual on a fresh Governance Agent application. Upload `business-docs/abandoned-carts.md` (the simulator's "Download the business review" button) and confirm the goals, in particular *Complete the purchases learners start* (at least 300 learners completing a checkout every 30 days). Check that this goal is linked to the capability the agent derived for the catalog, cart and enrolment (it holds `POST /api/courses/{courseId}/enrol`); if the derivation put enrolment somewhere else, link that capability on the goal. The finding follows the telemetry read like lapsed-learners'. Demo persona: **Marco Bellini** (`marco.bellini@example.com`, password `learnloop-demo`), an active learner with Python for Data Work (added day −16) and Data Visualization Fundamentals (added day −9) in his cart; he opened the checkout page on day −9 and left. The AI agent the finding proposes can read `carts` for the other ~145 learners.

### Presenting q4-three-signals

**q4-three-signals.** Load it as usual, then onboard LearnLoop as a **fresh** application in the Governance Agent (see the next section: an application that has read another scenario keeps that scenario's windows). Upload `business-docs/q4-three-signals.md` (the simulator's "Download the business review" button) and confirm its three goals. Then check, on each goal, that it is linked to the capability that holds its routes; if not, link it:

| Goal in the review | Link it to the capability that holds | Capability name before the cart and Help code existed | Finding |
|---|---|---|---|
| *More learners actively progressing every week* | the lesson routes (`services/learning`: `/api/lessons/…`, `/api/courses/{courseId}/lessons`) | "Course delivery and learner progress" | fewer people on the lesson routes |
| *Complete the purchases learners start* | the cart and enrolment routes (`services/catalog`: `/api/me/cart…`, `POST /api/courses/{courseId}/enrol`) | "Course catalog and discovery" | fewer people completing the enrol step |
| *Answer learner questions within one business day, and keep learners using Help* | the learner Help routes (`services/notifications`: `/api/me/support-requests`, beside the inbox routes) | "Learner notification delivery" | fewer people coming back to Help |

The cart and Help code is newer than the capability model in the console's screenshots, so after a re-derivation the names may differ (for example a catalog capability named for purchases, or a notifications capability named for support): go by which service's routes it holds. The staff side of Help (`/api/admin/support-requests…`) is declared in `services/admin` and lands in "Platform administration"; do not link the Help goal there only, because the staff are three people and cannot raise a finding about returning users. The detector looks only at the capabilities a confirmed goal is linked to (`detectActorInactivity` walks each goal's serving capabilities), so a capability no goal is linked to raises nothing. The other risk is the derivation putting two of the services in **one** capability: it then reports only the qualifying route with the most earlier users, and one of the three findings does not appear (split the capability, or read the detection report).

The findings follow the telemetry read like lapsed-learners'. The AI agent each one can lead to:

- **Lessons** — a lesson reminder for the learners who stopped (they still sign in; `progress.json` has their last lesson). Persona: **Ana Moreno**.
- **Cart** — a reminder to the 140 … 155 learners whose courses wait in `carts.json`. Persona: **Marco Bellini** (Python for Data Work and Data Visualization Fundamentals in his cart, checkout left on day −9).
- **Help** — draft answers to the open, repetitive questions in `support_requests.json` for the staff to check and send (the earlier answers to the same questions are in the same file, with the staff member who wrote them). Personas: **Lena Hoffmann** (her certificate question has been open since day −12) and **Sofia Lindqvist** (Admin → Support requests shows the open queue, the oldest from about a month ago).

All passwords are `learnloop-demo`.

### Before you load a different scenario

- **The Governance Agent keeps every telemetry window it has read.** Distinct users of a window are kept as the maximum across the baselines read for it, and day counts merge "latest wins", so loading a second scenario on the same Governance Agent application mixes the two (for example `lapsed-learners` after `steady-state` keeps 340 users in the recent window and the inactivity finding does not fire). For a clean demo of a different scenario, onboard LearnLoop as a new application in the Governance Agent (or remove the old one) after loading it.
- **Which window counts as "now".** The Governance Agent's history read writes the earlier window's baselines after the current one, and its health and latency checks read the newest baseline per route. `slow-lessons` and `outage-drop` are built so the condition holds in both windows, so the order does not matter.
- **One business review per scenario.** `business-docs/<scenario-id>.md` is the quarterly review to upload in the demo (the simulator's "Download the business review for this scenario" button serves it as `learnloop-q4-2026-business-review.md`, a name that does not give the scenario away). `lapsed-learners.md` is a copy of LearnLoop's `docs/business/q4-2026-business-review.md`; `abandoned-carts.md` states the goal its finding links to; `q4-three-signals.md` states the three goals its three findings link to; `steady-state.md`, `slow-lessons.md` and `outage-drop.md` are neutral: their own figures, no claim about speed or outages, and all four goals. The figures are for a start date of 15 November 2026.
- **Late November.** The agent's calendar lists Black Friday / Cyber Monday (24 Nov – 2 Dec); with a start date in that range the market explanation cannot be ruled out, which lowers confidence but does not withdraw a finding.

## The Activity Simulator

A local page for a live demo in front of a non-technical audience: the presenter picks a scenario (each card shows only its title and a description for the audience; the expected finding and the parameters stay sealed until the envelope is opened), downloads its business review, the page shows a sealed fingerprint of what the simulator is told, generates the activity day by day, shows where it lands in AWS, reads it back, and at the end opens the envelope and checks that the fingerprint still matches. No terminal, AWS console or file is needed during the demo.

```bash
npm ci
npm run simulator            # http://127.0.0.1:8790  (--port <n> or SIMULATOR_PORT to change)
```

It binds to 127.0.0.1 only, refuses requests whose Host is not 127.0.0.1/localhost, and runs with your own AWS credentials (the default chain; region `AWS_REGION`, default us-east-1) and your own git setup for the LearnLoop repository (`../LearnLoop` or `$LEARNLOOP_REPO`). Add `?pace=fast` to the address to skip the presentation pace when rehearsing.

Actions (each streamed to the page as Server-Sent Events, one at a time; a second one is refused while the first runs):

| Action | What it does | Confirmation |
|---|---|---|
| Clear | Deletes every object under `cloudfront/` in the access-logs bucket and `app-logs/` in the app-logs bucket (including any real log files written since). Bucket names and the CloudFront prefix come from the `LearnLoopProd` stack outputs, never from the request. | yes |
| Generate | Generates the chosen scenario for the start date (default today, UTC) with the deployed salt, read from Secrets Manager on the server (it never reaches the browser), and the real distribution id. Writes `data/seed/*.json` into the LearnLoop repository and the logs into `out/`, exactly like `npm run seed`. The page replays the 60 days over about 90 s; it says so, and how long the generator really took. | no |
| Upload | State documents, application logs and CloudFront files, with per-target counts. Refuses if the files on disk are not the last generation or were made with another salt or distribution. | yes |
| Verify | Lists the three prefixes back (files, first and last day) against the generated counts and shows one random file as sentences and raw lines. | no |
| Publish the starting state | In the LearnLoop repository: refuses unless on `main` and nothing outside `data/seed/` is changed; `git add data/seed`, commit, push to `origin main`. Skipped when the files are unchanged. **Pushing to main also starts LearnLoop's production deploy** (its "Preview reset" workflow restores state from these files). | yes |
| Load this scenario | Clear → Generate → Upload → Verify → Publish, one confirmation. | yes |

The commit message names the scenario by its sealed fingerprint (`Seed: load sealed scenario <first 12 hex> anchored on <date>`), not by its id: the agent reads the LearnLoop repository, and a commit titled `lapsed-learners` would tell it the answer. Set `SIMULATOR_COMMIT_SCENARIO_NAME=1` to put the id in the subject instead. The message ends with the `Co-Authored-By` line.

**Rehearsal (dry run).** The toggle on the page (or `"dryRun": true`) runs the same steps with every write removed: the AWS and git layers' write methods are replaced by functions that throw. Clear lists what it would delete, Generate writes into `state/dry-run/` instead of LearnLoop, Upload counts what it would send, Verify reads the rehearsal folder back, Publish compares the files and says whether it would commit. Read-only calls (stack outputs, the salt, listings) still use your credentials; without them a rehearsal falls back to placeholders and says so.

Local state (git-ignored, `state/`): `loaded.json` (which scenario and start date are in AWS, when, by which action, and whether the starting state was published), `generated.json`, and `last-run.json` (the last real generation's statistics, which the page's "Replay" button redraws, labelled as a replay).
