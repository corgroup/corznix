import { fulfillmentService } from './service.js';

/**
 * Post-commit fulfillment bootstrap.
 *
 * Called AFTER the Order finalization transaction has committed. It must never
 * throw: a bootstrap failure leaves the Order fully valid and is recovered
 * later by the backfill scan (scripts/backfill-fulfillments.js) or by the next
 * call to ensureForOrder. It never participates in the Order/payment/inventory
 * transaction.
 *
 * @param {string} orderId
 * @param {{ service?: object }} [deps]
 * @returns {Promise<{ ok: boolean, fulfillmentId?: string, error?: string }>}
 */
export async function bootstrapFulfillmentForOrder(orderId, { service = fulfillmentService } = {}) {
  try {
    const fulfillment = await service.ensureForOrder(orderId);
    console.log(JSON.stringify({
      scope: 'fulfillment', event: 'bootstrap_ok', orderId,
      fulfillmentId: fulfillment.id, readinessStatus: fulfillment.readinessStatus,
      blockReason: fulfillment.blockReason,
    }));
    return { ok: true, fulfillmentId: fulfillment.id };
  } catch (error) {
    console.error(JSON.stringify({
      scope: 'fulfillment', event: 'bootstrap_failed', orderId, category: error.code || 'FAILED',
    }));
    return { ok: false, error: error.code || 'FAILED' };
  }
}
