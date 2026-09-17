import { randomUUID } from 'node:crypto';
import { platformRepository as R } from './repository.js';
import { PROVIDER_ERROR_CODES } from '../../platform/shared/providerError.js';

// Observability log of OUTBOUND provider calls. Not a business authority —
// the domain attempt tables (payment_attempts, shipment_booking_attempts,
// communication_messages, …) stay authoritative (§65). This is an access log:
// capability / provider / operation / latency / normalized error / a
// correlation id linking request → resource → attempt → webhook (§69).

export function newCorrelationId(prefix = 'op') {
  return `${prefix}-${randomUUID().slice(0, 18)}`;
}

// A provider outcome, normalized. AMBIGUOUS = request left but the response is
// unknown — must NOT be blindly retried (§58/§102).
export const OUTCOME_CLASS = Object.freeze({
  SAFE_RETRY: 'SAFE_RETRY',
  NON_RETRYABLE: 'NON_RETRYABLE',
  AMBIGUOUS: 'AMBIGUOUS',
  SUCCESS: 'SUCCESS',
});

export function classifyProviderError(error) {
  const code = error?.code || PROVIDER_ERROR_CODES.PROVIDER_ERROR;
  if (code === PROVIDER_ERROR_CODES.PROVIDER_TIMEOUT || code === 'PROVIDER_RESULT_UNKNOWN') return OUTCOME_CLASS.AMBIGUOUS;
  if (code === PROVIDER_ERROR_CODES.RATE_LIMITED || code === PROVIDER_ERROR_CODES.PROVIDER_UNAVAILABLE) return OUTCOME_CLASS.SAFE_RETRY;
  if (code === PROVIDER_ERROR_CODES.PROVIDER_AUTH_FAILED
    || code === PROVIDER_ERROR_CODES.PROVIDER_VALIDATION_FAILED
    || code === PROVIDER_ERROR_CODES.PROVIDER_MISCONFIGURED
    || code === PROVIDER_ERROR_CODES.PROVIDER_NOT_CONFIGURED
    || code === PROVIDER_ERROR_CODES.PROVIDER_RESPONSE_INVALID) return OUTCOME_CLASS.NON_RETRYABLE;
  return OUTCOME_CLASS.SAFE_RETRY;
}

/** Record one attempt (best-effort — never throws into the caller). */
export async function recordProviderAttempt(a) {
  try {
    await R.insertAttempt({
      correlationId: a.correlationId || newCorrelationId(),
      capability: a.capability, providerKey: a.providerKey, operation: a.operation,
      resourceType: a.resourceType, resourceId: a.resourceId, attemptNumber: a.attemptNumber ?? 1,
      outcome: a.outcome, normalizedErrorCode: a.normalizedErrorCode ?? null, httpStatus: a.httpStatus ?? null,
      durationMs: a.durationMs ?? null, configVersion: a.configVersion ?? null, startedAt: a.startedAt ?? new Date(),
    });
  } catch { /* observability must never break the business path */ }
}

/**
 * Wrap a provider call so its latency + outcome are logged and it stays on
 * ONE provider for retries (§10 — the caller passes the already-resolved
 * providerKey; this never re-resolves).
 */
export async function withProviderAttempt({ capability, providerKey, operation, resourceType, resourceId, correlationId, attemptNumber, configVersion }, fn) {
  const startedAt = new Date();
  try {
    const result = await fn();
    await recordProviderAttempt({ capability, providerKey, operation, resourceType, resourceId, correlationId, attemptNumber, configVersion, outcome: OUTCOME_CLASS.SUCCESS === 'SUCCESS' ? 'SUCCESS' : 'SUCCESS', durationMs: Date.now() - startedAt.getTime(), startedAt });
    return result;
  } catch (error) {
    const cls = classifyProviderError(error);
    await recordProviderAttempt({
      capability, providerKey, operation, resourceType, resourceId, correlationId, attemptNumber, configVersion,
      outcome: cls === OUTCOME_CLASS.AMBIGUOUS ? 'UNKNOWN' : 'FAILURE',
      normalizedErrorCode: error?.code || null, httpStatus: error?.meta?.httpStatus ?? null,
      durationMs: Date.now() - startedAt.getTime(), startedAt,
    });
    throw error;
  }
}
