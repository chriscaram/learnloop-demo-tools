// Turns the simulated request stream into the two log formats:
//  - CloudFront standard access logs (W3C, tab separated, gzipped, one object per hour)
//  - application logs in the section-6 JSON Lines contract (one file per service per hour)
import { gzipSync } from 'node:zlib';
import {
  buildEventRecord, buildLogRecord, buildRequestRecord, pseudonymiseSession, pseudonymiseUser, serialize,
} from './contract/logger.js';
import { CRAWLER_USER_AGENT } from './content.js';
import { createRng } from './rng.js';

export const CLOUDFRONT_FIELDS = [
  'date', 'time', 'x-edge-location', 'sc-bytes', 'c-ip', 'cs-method', 'cs(Host)', 'cs-uri-stem', 'sc-status',
  'cs(Referer)', 'cs(User-Agent)', 'cs-uri-query', 'cs(Cookie)', 'x-edge-result-type', 'x-edge-request-id',
  'x-host-header', 'cs-protocol', 'cs-bytes', 'time-taken', 'x-forwarded-for', 'ssl-protocol', 'ssl-cipher',
  'x-edge-response-result-type', 'cs-protocol-version', 'fle-status', 'fle-encrypted-fields', 'c-port',
  'time-to-first-byte', 'x-edge-detailed-result-type', 'sc-content-type', 'sc-content-len', 'sc-range-start',
  'sc-range-end',
];
export const CLOUDFRONT_HEADER = `#Version: 1.0\n#Fields: ${CLOUDFRONT_FIELDS.join(' ')}\n`;

/** CloudFront writes the user agent percent-encoded (spaces as %20). */
export function encodeUserAgent(ua) {
  return ua.replace(/[\s"%\\<>^`{|}\x00-\x1f\x7f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}

const API_BYTES = {
  '/api/me': 310,
  '/api/auth/login': 640,
  '/api/auth/logout': 360,
  '/api/me/progress': 1450,
  '/api/me/subscription': 560,
  '/api/me/notifications/unread-count': 300,
  '/api/me/notifications': 2100,
  '/api/me/notifications/{notificationId}/read': 520,
  '/api/courses': 4300,
  '/api/courses/{courseId}': 2400,
  '/api/courses/{courseId}/enrol': 380,
  '/api/courses/{courseId}/lessons': 1700,
  '/api/lessons/{lessonId}': 3900,
  '/api/lessons/{lessonId}/progress': 420,
  '/api/lessons/{lessonId}/quiz': 610,
  '/api/me/subscription/cancel': 590,
  '/api/admin/learners': 41_000,
  '/api/admin/flags': 420,
  '/api/admin/flags/{flagKey}': 380,
  '/api/admin/learners/{userId}/message': 400,
  '/api/me/cart': 1500,
  '/api/me/cart/items': 1500,
  '/api/me/cart/items/{courseId}': 900,
  '/api/me/support-requests': 1800,
  '/api/admin/support-requests': 5200,
  '/api/admin/support-requests/{requestId}/reply': 900,
};

const pad = (n, w = 2) => String(n).padStart(w, '0');
const hourKey = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}`;
};

/**
 * `withhold` ({ routes: Set of "METHOD /route", fromMs }, a stage of a staged reveal):
 * the lines of those requests stamped at or after `fromMs` are left out. Every random
 * draw is still made, in the same order, and every hour keeps its CloudFront object
 * (header only, if nothing in it is left), so all other lines, and every object key,
 * are byte for byte what the same generation writes without `withhold`.
 */
export function emitLogs(sim, { salt, seed, distributionId, distributionDomain, environment = 'prod', withhold = null }) {
  const rng = createRng(seed, 'emit');
  const userPseudo = new Map();
  const sessionPseudo = new Map();
  const pu = (id) => {
    if (!userPseudo.has(id)) userPseudo.set(id, pseudonymiseUser(salt, id));
    return userPseudo.get(id);
  };
  const ps = (id) => {
    if (!sessionPseudo.has(id)) sessionPseudo.set(id, pseudonymiseSession(salt, id));
    return sessionPseudo.get(id);
  };
  const versionAt = (ms) => {
    let current = sim.versions[0];
    for (const v of sim.versions) if (v.fromMs <= ms) current = v;
    return current.version;
  };

  const appLines = new Map(); // `${service}|${hourKey}` -> [ [ms, line] ]
  const pushApp = (service, ms, record) => {
    const key = `${service}|${hourKey(ms)}`;
    if (!appLines.has(key)) appLines.set(key, []);
    appLines.get(key).push([ms, serialize(record)]);
  };
  const common = (service, ms, req) => ({
    timestamp: new Date(ms).toISOString(),
    service,
    version: versionAt(ms),
    environment,
    traceId: req.traceId,
    requestId: req.requestId,
  });

  const cfLines = new Map(); // hourKey -> [ [ms, line] ]
  const host = distributionDomain;

  for (const req of sim.requests) {
    const held = !!withhold && req.kind === 'api' && withhold.routes.has(`${req.method} ${req.route}`);
    const kept = (ms) => !held || ms < withhold.fromMs;
    let edgeMs;
    let bytesOut;
    let contentType;
    let resultType;
    if (req.kind === 'api') {
      const uPseudo = req.userId ? pu(req.userId) : undefined;
      const sPseudo = req.sessionId ? ps(req.sessionId) : undefined;
      for (const e of req.events) {
        const actorIsUser = e.actorType !== 'system' || req.userId;
        if (kept(e.ts)) pushApp(req.service, e.ts, buildEventRecord({
          ...common(req.service, e.ts, req),
          userPseudoId: actorIsUser ? uPseudo : undefined,
          sessionPseudoId: actorIsUser ? sPseudo : undefined,
          event: e.event, entityType: e.entityType, entityId: e.entityId, outcome: e.outcome,
          errorType: e.errorType, actorType: e.actorType, value: e.value,
        }));
      }
      const done = req.ts + req.latencyMs;
      if (req.logError && kept(done - 1)) {
        pushApp(req.service, done - 1, buildLogRecord({ ...common(req.service, done - 1, req), level: 'error', message: 'unhandled error', errorType: req.logError }));
      }
      if (kept(done)) pushApp(req.service, done, buildRequestRecord({
        ...common(req.service, done, req),
        method: req.method, route: req.route, statusCode: req.status, latencyMs: req.latencyMs,
        userPseudoId: uPseudo, sessionPseudoId: sPseudo, userAgent: req.ua,
      }));
      edgeMs = rng.int(6, 28);
      bytesOut = req.status === 401 ? 290 : req.status >= 500 ? 280 : (API_BYTES[req.route] ?? 500) + rng.int(-40, 120);
      contentType = 'application/json';
      resultType = req.status >= 500 ? 'Error' : 'Miss';
    } else {
      edgeMs = req.resultType === 'Hit' ? 0 : rng.int(8, 40);
      bytesOut = req.bytesOut;
      contentType = req.contentType;
      resultType = req.resultType;
    }

    const totalMs = req.latencyMs + edgeMs;
    const finished = req.ts + totalMs;
    const d = new Date(finished);
    const ua = req.crawler ? CRAWLER_USER_AGENT : req.ua;
    const referer = req.referer === '-' ? '-' : `https://${host}${req.referer}`;
    const csBytes = (req.method === 'GET' ? 380 : 520) + (req.sessionId ? 230 : 0) + rng.int(0, 160);
    const ttfb = Math.max(0.001, (totalMs - rng.int(0, 2)) / 1000);
    const fields = [
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
      `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`,
      req.edge,
      String(bytesOut + 210),
      req.ip,
      req.method,
      host,
      req.path,
      String(req.status),
      referer,
      encodeUserAgent(ua),
      '-',
      '-',
      resultType,
      `${rng.chars(54)}==`.replace(/[^A-Za-z0-9=]/g, '_'),
      host,
      'https',
      String(csBytes),
      (Math.max(totalMs, 1) / 1000).toFixed(3),
      '-',
      'TLSv1.3',
      'TLS_AES_128_GCM_SHA256',
      resultType,
      'HTTP/2.0',
      '-',
      '-',
      String(rng.int(1024, 65535)),
      ttfb.toFixed(3),
      resultType,
      contentType,
      String(bytesOut),
      '-',
      '-',
    ];
    const key = hourKey(finished);
    if (!cfLines.has(key)) cfLines.set(key, []);
    if (kept(finished)) cfLines.get(key).push([finished, fields.join('\t')]);
  }

  for (const e of sim.systemEvents) {
    pushApp(e.service, e.ts, buildEventRecord({
      ...common(e.service, e.ts, e),
      userPseudoId: pu(e.userId),
      event: e.event, entityType: e.entityType, entityId: e.entityId, actorType: e.actorType,
    }));
  }

  const appLogs = new Map();
  for (const key of [...appLines.keys()].sort()) {
    const [service, hour] = key.split('|');
    const date = hour.slice(0, 10);
    const lines = appLines.get(key).sort((a, b) => a[0] - b[0]).map(([, line]) => line);
    appLogs.set(`app-logs/service=${service}/dt=${date}/${service}-${date}-${hour.slice(11)}.log`, `${lines.join('\n')}\n`);
  }

  const cloudfront = new Map();
  for (const key of [...cfLines.keys()].sort()) {
    const lines = cfLines.get(key).sort((a, b) => a[0] - b[0]).map(([, line]) => line);
    const unique = rng.upper(8);
    cloudfront.set(`cloudfront/${distributionId}.${key}.${unique}.gz`, gzipSync(Buffer.from(CLOUDFRONT_HEADER + lines.join('\n') + '\n'), { level: 9 }));
  }
  return { appLogs, cloudfront, userPseudo };
}
