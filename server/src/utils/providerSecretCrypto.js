// Encryption for provider credentials that the server itself has to keep and
// renew — today only the Instagram access token (it expires every 60 days and
// is renewed by the server, so it cannot live in the environment like the
// other provider secrets).
//
// Same construction as utils/payoutCrypto.js: AES-256-GCM, authenticated, so a
// tampered ciphertext fails to decrypt instead of yielding a different token.
// A separate key (PROVIDER_SECRET_ENCRYPTION_KEY) keeps a leak of one key from
// exposing the other kind of secret.
//
// FAIL CLOSED. Without a valid key a credential is refused, never stored in the
// clear, and a stored one cannot be read.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/index.js';
import { AppError } from './errors.js';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

let cachedKey;

/** 32 bytes as 64 hex characters or base64; validated once and cached. */
function secretKey() {
  if (cachedKey !== undefined) return cachedKey;
  const raw = String(env.PROVIDER_SECRET_ENCRYPTION_KEY ?? '').trim();
  if (!raw) { cachedKey = null; return cachedKey; }
  let buf;
  if (/^[0-9a-f]{64}$/i.test(raw)) buf = Buffer.from(raw, 'hex');
  else {
    try { buf = Buffer.from(raw, 'base64'); } catch { buf = null; }
  }
  cachedKey = buf && buf.length === KEY_BYTES ? buf : null;
  return cachedKey;
}

/** True when a provider credential can be stored and read at all. */
export function providerSecretEncryptionAvailable() {
  return secretKey() !== null;
}

const unavailable = () => new AppError(
  'PROVIDER_SECRET_ENCRYPTION_UNAVAILABLE',
  'The server has no encryption key for provider credentials (PROVIDER_SECRET_ENCRYPTION_KEY), so it cannot store this connection.',
  503,
);

/** @returns {string} `iv:tag:ciphertext`, all base64 */
export function encryptProviderSecret(plaintext) {
  const key = secretKey();
  if (!key) throw unavailable();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}

/** Only the provider call path may use this. Never for a response or a log line. */
export function decryptProviderSecret(stored) {
  const key = secretKey();
  if (!key) throw unavailable();
  const parts = String(stored ?? '').split(':');
  if (parts.length !== 3) throw new AppError('PROVIDER_SECRET_CORRUPT', 'A stored provider credential is unreadable.', 500);
  const [iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64'));
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    // Altered ciphertext, a malformed IV/tag, or a different key: GCM refuses
    // it, and the caller gets one stable error — never Node's crypto internals.
    throw new AppError('PROVIDER_SECRET_CORRUPT', 'A stored provider credential is unreadable (altered, or encrypted with a different key). Reconnect the account.', 500);
  }
}

/** Test hook: forget the cached key after changing the environment. */
export function _resetProviderSecretKey() { cachedKey = undefined; }
