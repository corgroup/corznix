// ADAPTED_SOURCE_TO_TARGET from corcotton-store/server/src/utils/crypto.js
// (Wave 5 — see docs/MIGRATION.md). Logic unchanged — this file passed
// this wave's security review as-is (real crypto.randomInt, HMAC-SHA256
// with a server-side pepper for OTPs, timing-safe comparison, opaque
// high-entropy refresh tokens). Only the `env` import path changed to
// match this target's own config module.
//
// Named `otpCrypto.js` (not `crypto.js`) to avoid shadowing Node's builtin
// `crypto` module by filename in this directory's import statements.
import crypto from 'node:crypto';
import { env } from '../config/index.js';

/** Cryptographically secure 4-digit code, zero-padded (e.g. "0042"). Never Math.random(). */
export function generateOtpCode() {
  return crypto.randomInt(0, 10000).toString().padStart(4, '0');
}

/**
 * HMAC-SHA256(pepper, `${challengeId}:${destination}:${otp}`). Keying on
 * the challenge's own id means a leaked hash cannot be replayed against a
 * different challenge, and the server-side pepper (never stored in the
 * database) means a full DB dump alone cannot be used to brute-force the
 * 10,000 possible 4-digit values offline.
 */
export function createOtpHash(otp, challengeId, destination) {
  const normalizedDestination = String(destination || '').trim();
  return crypto
    .createHmac('sha256', env.OTP_PEPPER)
    .update(`${challengeId}:${normalizedDestination}:${otp}`)
    .digest('hex');
}

/** Plain SHA-256 of an opaque, already-high-entropy (32-byte random) token — not a password hash, so no separate salt/work-factor is needed. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** 32 bytes of randomness, hex-encoded — the raw refresh-token secret half. */
export function randomToken() {
  return crypto.randomBytes(32).toString('hex');
}

/** Timing-safe hex-string comparison — never `===` on a secret/hash. */
export function safeCompare(a, b) {
  const left = Buffer.from(String(a ?? ''), 'hex');
  const right = Buffer.from(String(b ?? ''), 'hex');
  if (left.length !== right.length) {
    return false;
  }
  try {
    return crypto.timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** MySQL DATETIME(3)-compatible string ("YYYY-MM-DD HH:MM:SS.mmm"), UTC. */
export function toMysqlDateTime(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date);
  return value.toISOString().replace('T', ' ').replace('Z', '').slice(0, 23);
}
