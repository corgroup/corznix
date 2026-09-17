import { fulfillmentRepository } from './repository.js';
import { fulfillmentService } from './service.js';

/**
 * Idempotent backfill / recovery for existing Orders that have no initial
 * Fulfillment yet (§39, §62). Running it twice is a no-op on the second pass.
 *
 * Guarantees (§40): never recreates Orders, never touches payments or the
 * financial snapshot, never decrements inventory, never calls a provider,
 * never generates an AWB. It is a thin loop over the same idempotent
 * ensureForOrder used by the post-commit hook.
 */
export async function backfillFulfillments({
  repository = fulfillmentRepository,
  service = fulfillmentService,
  limit = 500,
} = {}) {
  const summary = { eligible: 0, created: 0, reused: 0, blocked: 0, errors: 0, details: [] };
  const rows = await repository.ordersMissingFulfillment(limit);
  summary.eligible = rows.length;

  for (const row of rows) {
    try {
      const before = await repository.initialFulfillment(null, row.id);
      const fulfillment = await service.ensureForOrder(row.id);
      if (before) summary.reused += 1;
      else summary.created += 1;
      if (fulfillment.readinessStatus === 'BLOCKED') summary.blocked += 1;
      summary.details.push({ orderId: row.id, fulfillmentId: fulfillment.id, readinessStatus: fulfillment.readinessStatus, blockReason: fulfillment.blockReason });
    } catch (error) {
      summary.errors += 1;
      summary.details.push({ orderId: row.id, error: error.code || 'FAILED' });
    }
  }
  return summary;
}
