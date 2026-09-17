// Shared outbound HTTP helper for provider adapters (Provider Platform
// Migration, blueprint §32 "shared HTTP wrapper if genuinely useful").
//
// Every adapter today hand-rolls its own AbortController timeout + status
// mapping (see modules/shipping/providers/delhiveryAdapter.js,
// modules/payments/providers/cashfreeProvider.js, modules/auth/otpProviders.js).
// This centralizes the timeout + error normalization; the caller still owns
// URL building, auth headers (from secrets it reads itself), and response
// parsing. Opt-in — nothing is migrated onto it in Phase 2.

import {
  createProviderError,
  providerErrorFromHttpStatus,
  PROVIDER_ERROR_CODES,
} from './providerError.js';

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * @param {string} url
 * @param {RequestInit & {
 *   timeoutMs?: number,
 *   providerKey?: string,
 *   capability?: string,
 *   operation?: string,
 * }} [options]
 * @returns {Promise<Response>}  the raw Response for a 2xx/3xx; throws a
 *   ProviderError for a timeout, a network failure, or a non-ok status.
 */
export async function providerFetch(url, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    providerKey = null,
    capability = null,
    operation = null,
    signal: callerSignal,
    ...init
  } = options;

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    const timedOut = controller.signal.aborted && !callerSignal?.aborted;
    throw createProviderError({
      code: timedOut ? PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT : PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE,
      providerKey,
      capability,
      cause,
      meta: { operation },
    });
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener?.('abort', onAbort);
  }

  if (!response.ok) {
    throw providerErrorFromHttpStatus(response.status, { providerKey, capability, meta: { operation } });
  }
  return response;
}

/**
 * `providerFetch` + JSON parse. Throws `PROVIDER_RESPONSE_INVALID` when the
 * body is not valid JSON.
 * @returns {Promise<any>}
 */
export async function providerFetchJson(url, options = {}) {
  const response = await providerFetch(url, options);
  try {
    return await response.json();
  } catch (cause) {
    throw createProviderError({
      code: PROVIDER_ERROR_CODES.PROVIDER_RESPONSE_INVALID,
      providerKey: options.providerKey ?? null,
      capability: options.capability ?? null,
      cause,
      meta: { operation: options.operation ?? null },
    });
  }
}
