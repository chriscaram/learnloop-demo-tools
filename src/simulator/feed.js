// Real generated log lines, translated into plain sentences for the simulator page.
//
// Nothing here invents an event: every sentence is built from one application-log
// event record (and the request record that carries the same request_id) or from one
// CloudFront access-log line, and the raw lines travel with the sentence so the
// audience can open them. Course and lesson names come from the generated catalog.
import { CLOUDFRONT_FIELDS } from '../emit.js';
import { createRng } from '../rng.js';

const DAY_MS = 86_400_000;

export function deviceOf(userAgent = '') {
  const ua = decodeURIComponent(String(userAgent));
  if (/Googlebot/i.test(ua)) return 'from a search-engine crawler';
  if (/iPhone/.test(ua)) return 'on an iPhone';
  if (/iPad/.test(ua)) return 'on an iPad';
  if (/Android/.test(ua)) return 'on an Android phone';
  if (/Windows/.test(ua)) return 'on a Windows computer';
  if (/Macintosh/.test(ua)) return 'on a Mac';
  if (/Linux/.test(ua)) return 'on a Linux computer';
  return 'in a browser';
}

const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${n} ms`);

/** Lookups over the generated catalog: lesson id -> "lesson 3 of 'SQL for Analysts'". */
export function catalogIndex(data) {
  const courses = new Map(data.courses.map((c) => [c.id, c]));
  const lessons = new Map(data.lessons.map((l) => [l.id, { ...l, course: courses.get(l.course_id) }]));
  return {
    lesson(id) {
      const l = lessons.get(id);
      return l ? `lesson ${l.position} of '${l.course?.title ?? 'a course'}'` : 'a lesson';
    },
    course(id) {
      const c = courses.get(id);
      return c ? `'${c.title}'` : 'a course';
    },
  };
}

function idIn(path, prefix) {
  return path?.match(new RegExp(`/(${prefix}_[0-9a-f]{12})`))?.[1] ?? null;
}

/** One sentence for an application-log event record, given its request record (or null). */
export function eventSentence(record, request, index) {
  const device = request ? ` ${deviceOf(request.user_agent)}` : '';
  const answered = request ? ` (the server answered in ${ms(request.latency_ms)})` : '';
  const id = record['entity.id'];
  switch (record.event) {
    case 'lesson_started': return `A learner started ${index.lesson(id)}${device}${answered}.`;
    case 'lesson_completed': return `A learner finished ${index.lesson(id)}${device}${answered}.`;
    case 'quiz_submitted': return `A learner scored ${record.value}% on the quiz in ${index.lesson(id)}${device}.`;
    case 'user_signed_in': return `A learner signed in${device}${answered}.`;
    case 'user_signed_out': return `A learner signed out${device}.`;
    case 'sign_in_failed': return `Someone typed a wrong password${device}.`;
    case 'course_enrolled': return `A learner enrolled in ${index.course(id)}${device}.`;
    case 'course_opened': return `A learner looked at the course ${index.course(id)}${device}.`;
    case 'catalog_viewed': return `A learner browsed the course catalog${device}.`;
    case 'progress_viewed': return `A learner looked at their progress page${device}${answered}.`;
    case 'subscription_cancelled': return `A learner cancelled their subscription${device}.`;
    case 'subscription_renewed': return 'The nightly billing job renewed a monthly subscription.';
    case 'notification_opened': return `A learner opened a notification${device}.`;
    case 'staff_message_sent': return 'A member of staff sent a learner a personal message.';
    case 'feature_flag_changed': return 'A member of staff switched a feature on or off.';
    default: return `The application recorded '${record.event}'.`;
  }
}

/** One sentence for an application-log request record that failed on the server. */
export function failedRequestSentence(request) {
  const phrase = ROUTE_PHRASES[request['http.route']] ?? `use ${request['http.route']}`;
  return `A learner's browser tried to ${phrase} ${deviceOf(request.user_agent)}, and the server failed with error ${request['http.status_code']} after ${ms(request.latency_ms)}.`;
}

const ROUTE_PHRASES = Object.freeze({
  '/api/me': 'check who is signed in',
  '/api/auth/login': 'sign in',
  '/api/auth/logout': 'sign out',
  '/api/me/progress': "load the learner's progress page",
  '/api/me/subscription': 'load the subscription page',
  '/api/me/subscription/cancel': 'cancel a subscription',
  '/api/me/notifications/unread-count': 'check for new notifications',
  '/api/me/notifications': 'open the notifications',
  '/api/me/notifications/{notificationId}/read': 'mark a notification as read',
  '/api/courses': 'load the course catalog',
  '/api/courses/{courseId}': 'open a course page',
  '/api/courses/{courseId}/enrol': 'enrol in a course',
  '/api/courses/{courseId}/lessons': "load a course's lesson list",
  '/api/lessons/{lessonId}': 'open a lesson',
  '/api/lessons/{lessonId}/progress': 'save lesson progress',
  '/api/lessons/{lessonId}/quiz': 'submit a quiz',
  '/api/admin/learners': 'open the staff list of learners',
  '/api/admin/flags': 'open the feature switches',
  '/api/admin/flags/{flagKey}': 'change a feature switch',
  '/api/admin/learners/{userId}/message': 'send a learner a message',
});

/** A raw path back to its route template, for the phrase table. */
export function routeOf(path) {
  return String(path ?? '')
    .replace(/\/usr_[0-9a-f]{12}/, '/{userId}').replace(/\/crs_[0-9a-f]{12}/, '/{courseId}')
    .replace(/\/les_[0-9a-f]{12}/, '/{lessonId}').replace(/\/ntf_[0-9a-f]{12}/, '/{notificationId}')
    .replace(/^\/api\/admin\/flags\/[a-z_]+$/, '/api/admin/flags/{flagKey}');
}

/** One sentence for an application-log request record. */
export function requestSentence(request) {
  const status = request['http.status_code'];
  if (status >= 500) return failedRequestSentence(request);
  const phrase = ROUTE_PHRASES[request['http.route']] ?? `call ${request['http.route']}`;
  const note = status === 401 ? ' (not signed in yet, so the answer was "please sign in")' : '';
  return `A browser asked the app to ${phrase}; it answered with status ${status} in ${ms(request.latency_ms)}${note}.`;
}

/** One sentence for a CloudFront access-log line (tab-separated W3C fields). */
export function cloudfrontSentence(line, index) {
  const cols = line.split('\t');
  const f = Object.fromEntries(CLOUDFRONT_FIELDS.map((name, i) => [name, cols[i]]));
  const path = f['cs-uri-stem'] ?? '';
  const seconds = Number(f['time-taken']);
  const took = Number.isFinite(seconds) ? ms(Math.round(seconds * 1000)) : 'an unknown time';
  let what;
  if (path === '/' || path === '/login' || path === '/courses') what = `loaded the page ${path}`;
  else if (path.startsWith('/assets/')) what = 'downloaded the application code';
  else if (path === '/robots.txt' || path === '/favicon.svg') what = `fetched ${path}`;
  else {
    const phrase = ROUTE_PHRASES[routeOf(path)];
    const lesson = idIn(path, 'les');
    const course = idIn(path, 'crs');
    const about = lesson ? ` (${index.lesson(lesson)})` : course ? ` (${index.course(course)})` : '';
    what = phrase ? `asked the app to ${phrase}${about}` : `called ${f['cs-method']} ${path}`;
  }
  const who = /Googlebot/i.test(f['cs(User-Agent)'] ?? '') ? 'A search-engine crawler' : 'A visitor';
  return `${who} ${who.startsWith('A search') ? '' : `${deviceOf(f['cs(User-Agent)'])} `}${what}: status ${f['sc-status']}, ${took}, served from the ${f['x-edge-location']?.slice(0, 3) ?? ''} edge location.`.replace(/\s+/g, ' ');
}

const MIN_FAILURES_TO_FEATURE = 5;
const FEED_PRIORITY = ['subscription_cancelled', 'lesson_started', 'lesson_completed', 'user_signed_in', 'quiz_submitted',
  'course_enrolled', 'progress_viewed', 'catalog_viewed', 'notification_opened', 'staff_message_sent', 'subscription_renewed'];

/**
 * A handful of real lines per simulated day, chosen deterministically, as feed items
 * { day, ts, sentence, raw: [lines] }. Failed requests (an outage) are always sampled
 * when the day has any, so the feed shows what the chart shows.
 */
export function buildFeed({ appLogs, data, anchorMs, seed = 42, perDay = 6 }) {
  const index = catalogIndex(data);
  const rng = createRng(seed, 'simulator-feed');
  const byDay = new Map();
  for (const [key, body] of appLogs) {
    const date = key.match(/dt=(\d{4}-\d{2}-\d{2})/)?.[1];
    if (!date) continue;
    const day = Math.round((Date.parse(`${date}T00:00:00Z`) - anchorMs) / DAY_MS);
    const lines = String(body).trimEnd().split('\n');
    const requests = new Map();
    const records = lines.map((line) => ({ line, record: JSON.parse(line) }));
    for (const r of records) if (r.record.kind === 'request') requests.set(r.record.request_id, r);
    const bucket = byDay.get(day) ?? { events: new Map(), failed: [] };
    for (const r of records) {
      if (r.record.kind === 'event' && FEED_PRIORITY.includes(r.record.event)) {
        const list = bucket.events.get(r.record.event) ?? [];
        list.push({ ...r, request: requests.get(r.record.request_id) ?? null });
        bucket.events.set(r.record.event, list);
      } else if (r.record.kind === 'request' && r.record['http.status_code'] >= 500) {
        bucket.failed.push(r);
      }
    }
    byDay.set(day, bucket);
  }
  const feed = new Map();
  for (const day of [...byDay.keys()].sort((a, b) => a - b)) {
    const bucket = byDay.get(day);
    const items = [];
    // a day with a real run of failures (an outage) always shows one; the odd failed
    // background poll does not deserve the headline
    if (bucket.failed.length >= MIN_FAILURES_TO_FEATURE) {
      const pick = bucket.failed[Math.floor(rng.next() * bucket.failed.length)];
      items.push({ ts: pick.record.timestamp, sentence: failedRequestSentence(pick.record), raw: [pick.line], failed: true });
    }
    for (const name of FEED_PRIORITY) {
      if (items.length >= perDay) break;
      const list = bucket.events.get(name);
      if (!list?.length) continue;
      const pick = list[Math.floor(rng.next() * list.length)];
      items.push({
        ts: pick.record.timestamp,
        sentence: eventSentence(pick.record, pick.request?.record ?? null, index),
        raw: [pick.line, ...(pick.request ? [pick.request.line] : [])],
      });
    }
    items.sort((a, b) => a.ts.localeCompare(b.ts));
    feed.set(day, items);
  }
  return feed;
}
