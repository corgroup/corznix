import { env } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { trackReconciliationService } from './trackReconciliation.js';

const log = logger('track-pull-worker');

// Phase 2 · Slice 13 — periodically reconciles in-flight booked shipments
// against the carrier (GET /api/v1/packages/json/), catching any Scan Push
// webhook Delhivery could not deliver. No-op in MOCK mode (runDueBatch skips
// provider_code = 'MOCK' rows) and when SHIPMENT_TRACK_PULL_ENABLED is false.
export function startTrackPullWorker() {
  if (env.SHIPMENT_TRACK_PULL_ENABLED === false) return () => {};
  const timer = setInterval(
    () => trackReconciliationService.runDueBatch()
      .catch((error) => log.error('tick_failed', { code: error?.code || error?.message || 'FAILED' })),
    env.SHIPMENT_TRACK_PULL_INTERVAL_MS,
  );
  timer.unref();
  return () => clearInterval(timer);
}
