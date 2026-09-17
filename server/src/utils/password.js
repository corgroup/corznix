// Staff password hashing — scrypt via Node's built-in `crypto` (no new
// dependency, consistent with this backend's hand-rolled jwt.js /
// otpCrypto.js approach). Customer auth is OTP-only and has no password;
// this is used exclusively by the staff/admin domain.
//
// Properties (Wave 8A brief §18):
//   - unique 16-byte random salt per hash
//   - computationally expensive KDF (scrypt, N=2^15)
//   - constant-time verification (crypto.timingSafeEqual)
//   - one-way; the stored string is self-describing so params can evolve
//   - never logged (callers must not log the plaintext or the hash)
import crypto from 'node:crypto';
import { env } from '../config/index.js';

// N must stay a power of two. 2^15 * 128 * r ≈ 32 MiB working memory, so
// scrypt's default maxmem is bumped to keep a comfortable margin.
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 64 * 1024 * 1024 };

/** @returns {string} self-describing hash: "scrypt$N$r$p$saltB64$hashB64" */
export function hashPassword(plaintext) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plaintext), salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

/** Constant-time verification. Returns false for any malformed stored value rather than throwing. */
export function verifyPassword(plaintext, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = crypto.scryptSync(String(plaintext), salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// A throwaway hash of a fixed string, verified against on the
// "email not found" login path so an unknown email costs the same wall
// time as a known one (defence against user-enumeration by timing).
const DUMMY_HASH = hashPassword('cor-group-staff-login-timing-equalizer');
export function dummyVerify(plaintext) {
  return verifyPassword(plaintext, DUMMY_HASH);
}

/**
 * Staff password policy — stronger than consumer friction rules, without
 * arbitrary "must contain a symbol" theatre (Wave 8A brief §19).
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function validateStaffPassword(plaintext) {
  const min = Number(env.STAFF_PASSWORD_MIN_LENGTH || 12);
  if (typeof plaintext !== 'string' || plaintext.length < min) {
    return { ok: false, message: `Password must be at least ${min} characters.` };
  }
  if (plaintext.length > 200) {
    return { ok: false, message: 'Password must be at most 200 characters.' };
  }
  if (plaintext !== plaintext.trim()) {
    return { ok: false, message: 'Password must not start or end with whitespace.' };
  }
  if (/^(.)\1+$/.test(plaintext)) {
    return { ok: false, message: 'Password must not be a single repeated character.' };
  }
  return { ok: true };
}
