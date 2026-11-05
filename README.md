# learnloop-demo-tools

Generates the LearnLoop demo dataset: the mock state (`data/seed/*.json` in the LearnLoop repository) and 60 days of historical logs (CloudFront standard access logs and application logs). It also uploads both to a deployed LearnLoop stack.

This repository is kept separate from LearnLoop on purpose. The external analysis tool reads the LearnLoop code and logs, so the behaviour model behind the history lives here and is never visible to it. Do not copy anything from this repository into LearnLoop except the generated `data/seed/*.json`.

## Layout

```
src/model.js       behaviour model: population, cohorts, sessions, cancellations, renewals, releases
src/emit.js        request stream -> CloudFront W3C files (gzipped, one per hour) and JSON Lines app logs
src/generate.js    entry point and the statistics the tests check
src/content.js     course catalog, lesson titles, quizzes, names, user agents, edge locations
src/contract/      code copied from LearnLoop: pure logger builders + pseudonymisation, addMonths, completionPercent
src/cli.js         npm run seed
src/upload.js      npm run seed:upload
test/              generator checks, plus contract checks against ../LearnLoop
```

`test/contract.test.js` compares the copies in `src/contract/` with the LearnLoop code. It runs when the LearnLoop repository, with `node_modules` installed, is at `../LearnLoop` or at `$LEARNLOOP_REPO`, and is skipped otherwise. Run it after any change to the LearnLoop logger.

## Usage

Clone this repository next to `LearnLoop` (or set `LEARNLOOP_REPO=/path/to/LearnLoop`). Then:

```bash
npm ci
npm test

# the salt must be the deployed one, so seeded and live user.id values match
SALT="$(aws secretsmanager get-secret-value --secret-id learnloop/prod/log-pseudonym-salt --query SecretString --output text)"
npm run seed -- --anchor 2026-11-03 --salt "$SALT" --seed 42
npm run seed:upload
```

`npm run seed` is deterministic: the same arguments produce byte-identical output. It writes:

- `<LearnLoop>/data/seed/*.json` (override with `--data-dir`). Commit these in the LearnLoop repository.
- `out/cloudfront/<distribution-id>.<YYYY-MM-DD-HH>.<unique>.gz`, one file per hour for days −60 … −1.
- `out/app-logs/service=<service>/dt=<date>/<service>-<date>-<HH>.log`, written only for hours that have traffic.
- `out/manifest.json` (the arguments, salt included) and `out/stats.json`. The `out/` directory is git-ignored.

`npm run seed:upload` reads the `LearnLoopProd` stack outputs and checks that the salt matches the `LogPseudonymSaltSecretName` secret. It regenerates the CloudFront files with the real `DistributionId` and `DistributionDomainName`, then uploads to these targets:

| What | Bucket (stack output) | Key |
|---|---|---|
| state | `StateBucketName` | `state/<domain>.json` |
| application logs | `AppLogsBucketName` | `app-logs/service=…/dt=…/…log` |
| CloudFront logs | `AccessLogsBucketName` | `<CloudFrontLogPrefix><distribution-id>.<YYYY-MM-DD-HH>.<unique>.gz` |

The upload refuses to run if any CloudFront key would fall outside `CloudFrontLogPrefix` (`cloudfront/`), which is the prefix the distribution's standard logging writes to.

## The history

Days −60 … −1 before the anchor date, with no missing hour:

- 420 learners (all with monthly subscriptions started 61–200 days before the anchor) and 3 staff.
- Cohort A (195 learners) opens lessons 2–5 days a week throughout.
- Cohort B (145 learners) does the same until a last-lesson day spread evenly over days −45 … −31. After that they keep signing in every few days, looking at the dashboard, catalog and progress, but never open a lesson again. Their `progress.courses[].last_activity_at` equals their last `lesson_started` / `lesson_completed`.
- Cohort C (80 learners) signs in rarely and never opens lessons in the window.
- Distinct learners on the learning routes: about 340 in days −60 … −31 and about 195 in days −30 … −1. Sign-ins, dashboard, catalog and `/api/me/progress` fall about 10%.
- Cancellations run at about 4 a week in the first month and about 11 a week in the last two weeks, mostly from cohorts B and C. Cancelled learners send no traffic afterwards.
- Renewals happen daily at 00:10 UTC (`actor_type: system`). Staff send about 3 messages a week, unevenly.
- Health stays flat: 5xx below 0.3% per route per day, p95 about 120 ms on lesson routes and about 60 ms elsewhere, and a release every 10–14 days.
- About 1% of requests come from Googlebot, on public pages only. Each learner has one stable IP from the documentation ranges.

## Demo personas

| Login | Id | Role | Behaviour |
|---|---|---|---|
| `ana.moreno@example.com` | `usr_a7e3c1d90b42` | learner (cohort B) | Enrolled only in Cloud Foundations, at 35% (3 of 8 lessons, weighted by duration). Last lesson activity on day −33. Signs in every few days afterwards and has no unread notifications. |
| `marco.bellini@example.com` | `usr_5d81f0c3a9e6` | learner (cohort A) | Enrolled in SQL for Analysts and Serverless Applications. Last lesson on day −1. |
| `sofia.lindqvist@example.com` | `usr_c4f2b7e1d038` | staff | Signs in on most weekdays. Turned on `new_catalog_filters` on day −51 (or the next weekday). |
| `daniel.okafor@example.com`, `priya.nair@example.com` | generated | staff | Sign in on some weekdays and send some of the staff messages. |

The password for every account is `learnloop-demo`.
