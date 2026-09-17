// Normalized provider error (Provider Platform Migration, blueprint §26).
//
// Adapters translate every provider-native failure (HTTP status, SDK error,
// timeout, malformed response) into a `ProviderError` with a stable `code`
// BEFORE it leaves the adapter. Business/domain code never parses a provider
// error string; it either handles the stable code or converts it to a safe
// `AppError` for the frontend via `providerErrorToAppError`.

import { AppError } from '../../utils/errors.js';

/** Stable, provider-neutral failure codes. */
export const PROVIDER_ERROR_CODES = Object.freeze({
  RATE_LIMITED: 'RATE_LIMITED',
  PROVIDER_AUTH_FAILED: 'PROVIDER_AUTH_FAILED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_VALIDATION_FAILED: 'PROVIDER_VALIDATION_FAILED',
  PROVIDER_RESPONSE_INVALID: 'PROVIDER_RESPONSE_INVALID',
  PROVIDER_NOT_CONFIGURED: 'PROVIDER_NOT_CONFIGURED',
  PROVIDER_MISCONFIGURED: 'PROVIDER_MISCONFIGURED',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
});

const RETRYABLE_BY_DEFAULT = new Set([
  PROVIDER_ERROR_CODES.RATE_LIMITED,
  PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
  PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT,
]);

export class ProviderError extends Error {
  /**
   * @param {object} params
   * @param {string} params.code       one of PROVIDER_ERROR_CODES
   * @param {string} [params.message]  internal-facing message (never shown to a customer verbatim)
   * @param {string} [params.providerKey]
   * @param {string} [params.capability]
   * @param {boolean} [params.retryable]  defaults from the code
   * @param {unknown} [params.cause]      the original error (kept for logs, never serialized to a client)
   * @param {Record<string, unknown>} [params.meta]  small non-secret diagnostic bag
   */
  constructor({ code, message, providerKey = null, capability = null, retryable, cause, meta = {} }) {
    super(message || code || 'PROVIDER_ERROR');
    this.name = 'ProviderError';
    this.code = code || PROVIDER_ERROR_CODES.PROVIDER_ERROR;
    this.providerKey = providerKey;
    this.capability = capability;
    this.retryable = typeof retryable === 'boolean' ? retryable : RETRYABLE_BY_DEFAULT.has(this.code);
    this.cause = cause;
    this.meta = meta;
  }

  /** Safe to log — never includes `cause` internals or `meta` values that look secret. */
  toJSON() {
    return {
      name: this.name,
      code: this.code,
      providerKey: this.providerKey,
      capability: this.capability,
      retryable: this.retryable,
    };
  }
}

/** @returns {ProviderError} */
export function createProviderError(params) {
  return params instanceof ProviderError ? params : new ProviderError(params);
}

/**
 * Map an upstream HTTP status to a normalized code. Deliberately ignores the
 * response body — it can carry account/billing details that must not leak.
 */
export function providerErrorFromHttpStatus(status, { providerKey, capability, cause, meta } = {}) {
  const code = status === 429
    ? PROVIDER_ERROR_CODES.RATE_LIMITED
    : status === 401 || status === 403
      ? PROVIDER_ERROR_CODES.PROVIDER_AUTH_FAILED
      : status === 400 || status === 422
        ? PROVIDER_ERROR_CODES.PROVIDER_VALIDATION_FAILED
        : status >= 500
          ? PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE
          : PROVIDER_ERROR_CODES.PROVIDER_ERROR;
  return new ProviderError({ code, providerKey, capability, cause, meta: { ...meta, httpStatus: status } });
}

/**
 * Convert a normalized provider failure into the safe domain error the
 * frontend is allowed to see. Auth / config / validation detail is folded
 * into a generic "unavailable" — the customer never learns which provider
 * failed or why.
 * @returns {AppError}
 */
export function providerErrorToAppError(error) {
  const providerError = createProviderError(error);
  switch (providerError.code) {
    case PROVIDER_ERROR_CODES.RATE_LIMITED:
      return new AppError('PROVIDER_RATE_LIMITED', 'A required service is busy right now. Please try again shortly.', 503);
    case PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT:
    case PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE:
    case PROVIDER_ERROR_CODES.PROVIDER_AUTH_FAILED:
    case PROVIDER_ERROR_CODES.PROVIDER_NOT_CONFIGURED:
    case PROVIDER_ERROR_CODES.PROVIDER_MISCONFIGURED:
      return new AppError('PROVIDER_UNAVAILABLE', 'We could not complete that right now. Please try again shortly.', 503);
    default:
      return new AppError('PROVIDER_UNAVAILABLE', 'We could not complete that right now. Please try again shortly.', 502);
  }
}
