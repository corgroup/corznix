// Encryption for customer payout destinations (COD refund bank accounts).
//
// A bank account number is the one field in refund_payout_details that is both
// reusable by an attacker and never needed for display — CMS and customer
// surfaces show `account_number_last4` instead. So it is encrypted at rest
// with AES-256-GCM, which is authenticated: a tampered ciphertext fails to
// decrypt rather than returning altered digits.
//
// FAIL CLOSED. If PAYOUT_ENCRYPTION_KEY is missing or malformed, bank payout
// details are REFUSED rather than written in plaintext. Losing a refund
// submission is recoverable; a plaintext account-number table is not.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/index.js';
import { AppError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32;

let cachedKey;

/**
 * The key is 32 bytes supplied as 64 hex characters or base64. Validated once
 * and cached — a wrong length must fail immediately and identically every
 * time, not intermittently deep inside a refund transaction.
 */
function payoutKey() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = String(env.PAYOUT_ENCRYPTION_KEY ?? '').trim();
  if (!raw) { cachedKey = null; return cachedKey; }
  let buf;
  if (/^[0-9a-f]{64}$/i.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; }
  }
  cachedKey = buf && buf.length === KEY_BYTES ? buf : null;
  return cachedKey;
}

/** True when bank payout details can be accepted at all. */
export function payoutEncryptionAvailable() {
  return payoutKey() !== null;
}

/**
 * @param {string} plaintext account number, digits only
 * @returns {string} `iv:tag:ciphertext`, all base64
 */
export function encryptPayoutSecret(plaintext) {
  const key = payoutKey();
  if (!key) {
    throw new AppError(
      'PAYOUT_ENCRYPTION_UNAVAILABLE',
      'Bank refunds are temporarily unavailable. Please choose UPI, or contact support.',
      503,
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/**
 * Only the payout operator path should ever call this. Never call it to build
 * a customer-facing response or a log line.
 * @param {string} stored value produced by encryptPayoutSecret
 */
export function decryptPayoutSecret(stored) {
  const key = payoutKey();
  if (!key) throw new AppError('PAYOUT_ENCRYPTION_UNAVAILABLE', 'Payout details cannot be read.', 503);
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 3) throw new AppError('PAYOUT_DETAIL_CORRUPT', 'Stored payout details are unreadable.', 500);
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/** Last four digits, for display. Never derived from the ciphertext. */
export function last4(accountNumber) {
  const digits = String(accountNumber ?? '').replace(/[^0-9]/g, '');
  return digits.slice(-4);
}
