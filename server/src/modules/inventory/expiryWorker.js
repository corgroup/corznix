import { env } from '../../config/index.js';
import { inventoryService } from './service.js';
import { reservationRepository } from './repository.js';
import { logger } from '../../utils/logger.js';

const log = logger('inventory-expiry');

/**
 * Expire every reservation whose hold has run out.
 *
 * Each row is isolated. `expiredIds` returns the batch oldest-first, so before
 * this a single un-expirable reservation was permanently first in the queue and
 * its throw aborted the whole loop — every 30 seconds, forever. Nothing behind
 * it was ever expired, so the stock those reservations held stayed reserved and
 * unsellable, and every abandoned checkout piled up behind the same poison row.
 * It never self-healed and the only signal was a data-integrity invariant that
 * CI runs non-blocking.
 *
 * A row can legitimately refuse: `changeReserved` will not drive `reserved`
 * negative, so if an inventory row has drifted the release is correctly denied.
 * That is a real condition needing a human, not something to retry silently —
 * hence the reservation id and error code are logged, and the count is
 * returned so it can be surfaced rather than swallowed.
 */
export async function expireReservationBatch() {
  const rows = await reservationRepository.expiredIds(env.INVENTORY_RESERVATION_EXPIRY_BATCH_SIZE);
  let expired = 0;
  const failures = [];
  for (const row of rows) {
    try {
      const result = await inventoryService.expireReservation(row.id);
      if (result.status === 'EXPIRED') expired += 1;
    } catch (error) {
      failures.push({ reservationId: row.id, code: error?.code || 'FAILED' });
    }
  }
  if (failures.length) {
    log.error('reservation_expiry_failed', {
      failed: failures.length,
      expired,
      // Bounded: one stuck row logged every 30s must not become the log volume.
      sample: failures.slice(0, 5),
    });
  }
  return { expired, failed: failures.length };
}

export function startInventoryExpiryWorker() {
  if (!env.INVENTORY_RESERVATION_EXPIRY_WORKER_ENABLED) return () => {};
  const timer = setInterval(() => {
    expireReservationBatch().catch((error) => log.error('reservation_expiry_batch_crashed', { category: error?.code || 'FAILED' }));
  }, env.INVENTORY_RESERVATION_EXPIRY_INTERVAL_MS);
  timer.unref();
  return () => clearInterval(timer);
}
