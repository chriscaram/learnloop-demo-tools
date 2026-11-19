// The simulator's password check at the edge, dependency-free so the root test suite can run
// it (test/cloud.test.js) without the CDK installed. The CloudFront Function holds only the
// SHA-256 of the expected Authorization header; the password lives in Secrets Manager.
import { createHash } from 'node:crypto';

export const BASIC_AUTH_REALM = 'Telemetry Activity Simulator';

/** The expected Authorization header's SHA-256: all the CloudFront Function holds. */
export function authHashOf(username, password) {
  return createHash('sha256').update(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`).digest('hex');
}

/** The CloudFront Function (cloudfront-js-2.0): a request goes through only with the expected header. */
export function basicAuthFunctionCode(authHash) {
  if (!/^[0-9a-f]{64}$/.test(authHash ?? '')) throw new Error('context authHash must be the hex SHA-256 of the expected Authorization header (npm run cloud -- deploy sets it)');
  return `import crypto from 'crypto';
async function handler(event) {
  var h = event.request.headers.authorization;
  if (h && crypto.createHash('sha256').update(h.value).digest('hex') === '${authHash}') return event.request;
  return { statusCode: 401, statusDescription: 'Unauthorized',
    headers: { 'www-authenticate': { value: 'Basic realm="${BASIC_AUTH_REALM}", charset="UTF-8"' }, 'cache-control': { value: 'no-store' } } };
}`;
}
