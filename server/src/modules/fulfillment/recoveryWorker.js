import { env } from '../../config/index.js';
import { fulfillmentRepository } from './repository.js';
import { fulfillmentService } from './service.js';

/**
 * Wave 7A.1 — durable automatic recovery for Orders that committed but whose
 * post-commit initial-Fulfillment bootstrap did not run or failed (§5-§19).
 *
 * This is a thin, bounded loop over the same idempotent `ensureForOrder` used
 * by the post-commit hook and the manual backfill. It NEVER:
 *   - recreates an Order, payment attempt, or obligation;
 *   - re-runs a charge, reconsumes/releases inventory, or reprices anything;
 *   - mutates an Order financial/address snapshot;
 *   - calls a logistics provider or generates an AWB.
 *
 * Correctness under retries / concurrency / multiple backend instances comes
 * from the database (Order-row lock + `uk_fulfillments_initial_order`), not
 * from this process being a singleton. Duplicate discovery across cycles or
 * instances is harmless because `ensureForOrder` is idempotent.
 */
export async function recoverMissingFulfillmentsBatch({
  repository = fulfillmentRepository,
  service = fulfillmentService,
  batchSize = env.FULFILLMENT_RECOVERY_BATCH_SIZE,
} = {}) {
  const summary = { scanned: 0, eligible: 0, created: 0, reused: 0, blocked: 0, errors: 0, details: [] };
  const rows = await repository.ordersMissingFulfillment(batchSize);
  summary.scanned = rows.length;
  summary.eligible = rows.length;

  for (const row of rows) {
    try {
      // A concurrent worker / instance / the post-commit hook may create it
      // between the scan and here — ensureForOrder returns the existing row.
      const existed = Boolean(await repository.initialFulfillment(null, row.id));
      const fulfillment = await service.ensureForOrder(row.id);
      if (existed) summary.reused += 1; else summary.created += 1;
      if (fulfillment.readinessStatus === 'BLOCKED') summary.blocked += 1;
    } catch (error) {
      summary.errors += 1;
      // Safe error code + orderId + timestamp only — never address / payment /
      // provider detail (§12). One failing Order must not stop the loop (§19).
      summary.details.push({ orderId: row.id, error: error.code || 'FAILED', at: new Date().toISOString() });
    }
  }

  console.log(JSON.stringify({
    scope: 'fulfillment', event: 'recovery_cycle',
    scanned: summary.scanned, eligible: summary.eligible, created: summary.created,
    reused: summary.reused, blocked: summary.blocked, errors: summary.errors,
  }));
  return summary;
}

/**
 * Registered from server startup alongside the inventory-expiry and
 * order-finalization workers. Returns a stop function that clears the timer
 * for graceful shutdown / tests. The timer is `unref`'d so it never keeps the
 * process alive on its own.
 */
export function startFulfillmentRecoveryWorker() {
  if (!env.FULFILLMENT_RECOVERY_WORKER_ENABLED) return () => {};
  const timer = setInterval(() => {
    recoverMissingFulfillmentsBatch().catch((error) =>
      console.error(JSON.stringify({ scope: 'fulfillment', event: 'recovery_cycle_failed', category: error.code || 'FAILED' })),
    );
  }, env.FULFILLMENT_RECOVERY_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
