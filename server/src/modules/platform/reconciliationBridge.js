import { reconciliationRepository } from '../reporting/reconciliationRepository.js';

// Wave 8I-5 §70 — a provider operation whose outcome is UNKNOWN (an ambiguous
// timeout after the request was transmitted) does NOT get blindly retried.
// It is handed to the EXISTING Wave 8H reconciliation authority. No second
// reconciliation system (§121) — this only raises/associates an exception.

/**
 * @param {{brandId:string, capability:string, providerKey:string, operation:string,
 *   resourceType?:string, resourceId?:string, correlationId:string, detail?:object}} ctx
 */
export async function raiseProviderUnknown(ctx) {
  if (!ctx.brandId) throw new Error('raiseProviderUnknown: brandId is required');
  const referenceType = ctx.resourceType || 'provider_operation';
  const referenceId = String(ctx.resourceId || ctx.correlationId).slice(0, 64);
  const dedupeKey = `provider:${ctx.capability}:${ctx.providerKey}:${ctx.operation}:${referenceId}`.slice(0, 200);
  return reconciliationRepository.upsertException({
    brandId: ctx.brandId,
    exceptionType: 'PROVIDER_RESULT_UNKNOWN',
    sourceDomain: 'provider',
    referenceType: referenceType.slice(0, 32),
    referenceId,
    dedupeKey,
    detail: {
      capability: ctx.capability, providerKey: ctx.providerKey, operation: ctx.operation,
      correlationId: ctx.correlationId, note: 'provider response unknown — manual reconciliation required',
      ...(ctx.detail || {}),
    },
  });
}
