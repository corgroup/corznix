// Provider-call observability + logging conventions (Provider Platform
// Migration, blueprint §11/§41).
//
// One structured line per external call: capability, providerKey, operation,
// duration, outcome, normalized error code, correlationId. NEVER an OTP, API
// secret, token, full Authorization header, or payment credential — `redact`
// scrubs those keys from any object handed in.

import { createProviderError, ProviderError, PROVIDER_ERROR_CODES } from './providerError.js';

const SECRET_KEY_RE = /(otp|pass(word)?|secret|token|api[_-]?key|authorization|auth[_-]?token|credential|signature|pepper|cookie)/i;

/** Deep-copy `value`, replacing any secret-looking key's value with '***'. */
export function redact(value, seen = new WeakSet()) {
  if (Array.isArray(value)) return value.map((item) => redact(item, seen));
  if (value && typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const out = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = SECRET_KEY_RE.test(key) ? '***' : redact(inner, seen);
    }
    return out;
  }
  return value;
}

/**
 * @param {object} entry
 * @param {string} entry.capability
 * @param {string} entry.providerKey
 * @param {string} entry.operation
 * @param {'SUCCESS'|'ERROR'|'RETRYABLE_ERROR'} entry.outcome
 * @param {number} [entry.durationMs]
 * @param {string} [entry.errorCode]
 * @param {string} [entry.correlationId]
 * @param {(...args: unknown[]) => void} [logger]
 */
export function logProviderCall(entry, logger = console) {
  const parts = [
    `capability=${entry.capability}`,
    `provider=${entry.providerKey}`,
    `op=${entry.operation}`,
    `outcome=${entry.outcome}`,
  ];
  if (Number.isFinite(entry.durationMs)) parts.push(`durationMs=${entry.durationMs}`);
  if (entry.errorCode) parts.push(`errorCode=${entry.errorCode}`);
  if (entry.correlationId) parts.push(`correlationId=${entry.correlationId}`);
  const line = `[provider] ${parts.join(' ')}`;
  if (entry.outcome === 'SUCCESS') (logger.info || logger.log)?.call(logger, line);
  else (logger.warn || logger.log)?.call(logger, line);
}

/**
 * Time an adapter operation, log exactly one line, and guarantee that
 * whatever it throws leaves as a `ProviderError` (so callers only ever see
 * normalized codes).
 *
 * @template T
 * @param {{ capability: string, providerKey: string, operation: string, correlationId?: string }} meta
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withProviderCall(meta, fn, logger = console) {
  const started = Date.now();
  try {
    const result = await fn();
    logProviderCall({ ...meta, outcome: 'SUCCESS', durationMs: Date.now() - started }, logger);
    return result;
  } catch (error) {
    const providerError = error instanceof ProviderError
      ? error
      : createProviderError({
        code: PROVIDER_ERROR_CODES.PROVIDER_ERROR,
        capability: meta.capability,
        providerKey: meta.providerKey,
        cause: error,
      });
    logProviderCall({
      ...meta,
      outcome: providerError.retryable ? 'RETRYABLE_ERROR' : 'ERROR',
      durationMs: Date.now() - started,
      errorCode: providerError.code,
    }, logger);
    throw providerError;
  }
}
