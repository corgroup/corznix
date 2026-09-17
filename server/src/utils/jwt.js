// ADAPTED_SOURCE_TO_TARGET from corcotton-store/server/src/utils/jwt.js
// (Wave 5). Logic unchanged — a minimal, dependency-free HS256 JWT
// implementation (no `jsonwebtoken` package added) that this wave's
// security review confirmed does the right things: real HMAC signature
// verification (timing-safe), issuer/audience/expiry/algorithm checks, and
// only ever carries the minimal claims an access token needs (customerId,
// sessionId) — never a full customer profile (migration brief §32).
import crypto from 'node:crypto';
import { env } from '../config/index.js';

function toBase64Url(value) {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64').toString('utf8');
}

function timingSafeEqual(a, b) {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(String(a || ''));
  const right = Buffer.isBuffer(b) ? b : Buffer.from(String(b || ''));
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function signJwt(payload, secret = env.JWT_SECRET) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const signingInput = `${toBase64Url(JSON.stringify(header))}.${toBase64Url(JSON.stringify(payload))}`;
  const signature = crypto.createHmac('sha256', secret).update(signingInput).digest();
  return `${signingInput}.${toBase64Url(signature)}`;
}

export function verifyJwt(token, secret = env.JWT_SECRET) {
  const rawToken = String(token || '');
  if (!rawToken || rawToken.split('.').length !== 3) {
    throw new Error('Invalid JWT token.');
  }

  const [headerSegment, payloadSegment, signatureSegment] = rawToken.split('.');
  const signingInput = `${headerSegment}.${payloadSegment}`;
  const expectedSignature = crypto.createHmac('sha256', secret).update(signingInput).digest();
  const actualSignature = Buffer.from(signatureSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  if (!timingSafeEqual(expectedSignature, actualSignature)) {
    throw new Error('JWT signature mismatch.');
  }

  const header = JSON.parse(fromBase64Url(headerSegment));
  const payload = JSON.parse(fromBase64Url(payloadSegment));

  if ((header.alg || '').toUpperCase() !== 'HS256') {
    throw new Error('Unsupported JWT algorithm.');
  }
  if (payload.iss !== env.JWT_ISSUER) {
    throw new Error('JWT issuer mismatch.');
  }
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(env.JWT_AUDIENCE)) {
    throw new Error('JWT audience mismatch.');
  }
  if (Number(payload.exp || 0) < Math.floor(Date.now() / 1000)) {
    throw new Error('JWT expired.');
  }

  return payload;
}

/** Short-lived access token — carries only `sub` (customerId) + `sid` (sessionId), never profile data. */
export function createAccessToken({ customerId, sessionId }) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: customerId,
    sid: sessionId,
    type: 'access',
    iss: env.JWT_ISSUER,
    aud: env.JWT_AUDIENCE,
    iat: now,
    exp: now + Number(env.JWT_ACCESS_TTL_SECONDS),
  });
}
