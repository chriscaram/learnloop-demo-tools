// Copied from the LearnLoop repository, packages/shared/src/logger.js (the pure
// part: event list, pseudonymisation, sanitisers and record builders). The
// seeded logs must be byte-compatible with what the services write, so keep
// this in sync; test/contract.test.js compares the two when ../LearnLoop exists.
import { createHmac } from 'node:crypto';

export const EVENT_NAMES = Object.freeze([
  'user_signed_in',
  'user_signed_out',
  'sign_in_failed',
  'catalog_viewed',
  'course_opened',
  'course_enrolled',
  'lesson_started',
  'lesson_completed',
  'quiz_submitted',
  'progress_viewed',
  'checkout_started',
  'subscription_started',
  'subscription_renewed',
  'subscription_cancelled',
  'notification_created',
  'notification_opened',
  'email_sent',
  'staff_message_sent',
  'feature_flag_changed',
]);
const EVENT_SET = new Set(EVENT_NAMES);
const ACTOR_TYPES = new Set(['learner', 'staff', 'system']);
const LEVELS = new Set(['info', 'warn', 'error']);

// ---------------------------------------------------------------------------
// Pseudonymisation

export function pseudonymise(salt, id, prefix) {
  if (!salt) throw new Error('pseudonymisation salt is required');
  return `${prefix}_${createHmac('sha256', salt).update(String(id)).digest('hex').slice(0, 16)}`;
}
export const pseudonymiseUser = (salt, userId) => pseudonymise(salt, userId, 'u');
export const pseudonymiseSession = (salt, sessionId) => pseudonymise(salt, sessionId, 's');

// ---------------------------------------------------------------------------
// Sanitisers

const EMAIL_RE = /[^\s@"]+@[^\s@"]+\.[^\s@"]+/;
const JWT_RE = /eyJ[\w-]+\.[\w-]+\.[\w-]*/;
const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/;
const OPAQUE_ID_RE = /^[a-z]{2,4}_[0-9a-f]{12}$/;
const FLAG_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const ERROR_TYPE_RE = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const REDACTED = '[redacted]';

/** Route templates only: drop any query string or fragment. */
export function sanitizeRoute(route) {
  if (typeof route !== 'string' || route === '') return 'unmatched';
  return route.split(/[?#]/)[0];
}

function safeText(value, max = 200) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/[\r\n\t]+/g, ' ').slice(0, max);
  if (EMAIL_RE.test(text) || JWT_RE.test(text) || IPV4_RE.test(text) || text.includes('?')) {
    return REDACTED;
  }
  return text;
}

function safeEntityId(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return OPAQUE_ID_RE.test(text) || FLAG_KEY_RE.test(text) ? text : REDACTED;
}

function safeUserAgent(value) {
  if (!value) return '-';
  const text = String(value).replace(/[\r\n\t]+/g, ' ').slice(0, 512);
  return EMAIL_RE.test(text) || JWT_RE.test(text) ? REDACTED : text;
}

function safeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function levelFor(level, fallback) {
  return LEVELS.has(level) ? level : fallback;
}

// ---------------------------------------------------------------------------
// Pure record builders (field order is part of the contract)

function base({ timestamp, level, kind, service, version, environment }) {
  return {
    timestamp,
    level,
    kind,
    'service.name': service,
    'service.version': version,
    'deployment.environment': environment,
  };
}

export function requestLevel(statusCode) {
  if (statusCode >= 500) return 'error';
  if (statusCode >= 400) return 'warn';
  return 'info';
}

/**
 * @param {object} f
 * @param {string} f.timestamp ISO-8601 UTC with milliseconds
 * @param {string} [f.userPseudoId] already pseudonymised (u_...)
 * @param {string} [f.sessionPseudoId] already pseudonymised (s_...)
 */
export function buildRequestRecord(f) {
  const route = sanitizeRoute(f.route);
  const method = String(f.method ?? 'GET').toUpperCase();
  const status = Number(f.statusCode);
  const record = base({ ...f, kind: 'request', level: levelFor(f.level, requestLevel(status)) });
  record['http.method'] = method;
  record['http.route'] = route;
  record['http.status_code'] = status;
  record.latency_ms = Math.max(0, Math.round(Number(f.latencyMs) || 0));
  record.request_id = safeText(f.requestId, 64) ?? '-';
  record.trace_id = f.traceId;
  if (f.userPseudoId) record['user.id'] = f.userPseudoId;
  if (f.sessionPseudoId) record['session.id'] = f.sessionPseudoId;
  record.user_agent = safeUserAgent(f.userAgent);
  record.message = `${method} ${route} ${status}`;
  return record;
}

export function buildEventRecord(f) {
  if (!EVENT_SET.has(f.event)) throw new TypeError(`unknown business event: ${f.event}`);
  const outcome = f.outcome === 'failed' ? 'failed' : 'ok';
  const actor = ACTOR_TYPES.has(f.actorType) ? f.actorType : 'system';
  const record = base({ ...f, kind: 'event', level: levelFor(f.level, outcome === 'failed' ? 'warn' : 'info') });
  record.trace_id = f.traceId;
  record.request_id = safeText(f.requestId, 64) ?? '-';
  if (f.userPseudoId) record['user.id'] = f.userPseudoId;
  if (f.sessionPseudoId) record['session.id'] = f.sessionPseudoId;
  record.event = f.event;
  if (f.entityType) record['entity.type'] = safeEntityId(f.entityType);
  if (f.entityId) record['entity.id'] = safeEntityId(f.entityId);
  record.outcome = outcome;
  if (outcome === 'failed') {
    record['error.type'] = ERROR_TYPE_RE.test(String(f.errorType ?? '')) ? f.errorType : 'unknown';
  }
  record.actor_type = actor;
  const value = safeNumber(f.value);
  if (value !== undefined) record.value = value;
  record.message = f.event;
  return record;
}

export function buildLogRecord(f) {
  const record = base({ ...f, kind: 'log', level: levelFor(f.level, 'info') });
  record.trace_id = f.traceId;
  record.request_id = safeText(f.requestId, 64) ?? '-';
  if (f.errorType) {
    record['error.type'] = ERROR_TYPE_RE.test(String(f.errorType)) ? f.errorType : 'unknown';
  }
  record.message = safeText(f.message) ?? '-';
  return record;
}

/** One record, one line. JSON.stringify escapes any newline inside values. */
export function serialize(record) {
  return JSON.stringify(record);
}
