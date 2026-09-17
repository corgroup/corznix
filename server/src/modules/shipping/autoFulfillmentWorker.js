import { env } from '../../config/index.js';
import { autoFulfillmentService } from './autoFulfillmentService.js';

// Phase 2 — resumes QUEUED shipment automation whose retry time has arrived
// (first-attempt failures, transient provider errors, "pickup not ready yet").
export function startAutoFulfillmentWorker() {
  if (env.SHIPMENT_AUTOMATION_ENABLED === false || env.SHIPMENT_AUTOMATION_MODE === 'MANUAL') return () => {};
  const timer = setInterval(
    () => autoFulfillmentService.runDueBatch({ batchSize: env.SHIPMENT_AUTOMATION_BATCH_SIZE })
      .catch((error) => console.error('[auto-fulfillment-worker]', { category: error?.code || 'FAILED' })),
    env.SHIPMENT_AUTOMATION_INTERVAL_MS,
  );
  timer.unref();
  return () => clearInterval(timer);
}
