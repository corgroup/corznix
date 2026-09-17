import { env } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { ndrService } from './ndrService.js';

const log = logger('ndr-poll-worker');

// Phase 2 · Slice 18 — polls SUBMITTED / UNKNOWN NDR actions for their carrier
// resolution (GET /api/cmu/get_bulk_upl). No-op in MOCK mode is not needed —
// there is simply nothing to poll until a real NDR action is submitted.
export function startNdrPollWorker() {
  if (env.NDR_POLL_ENABLED === false) return () => {};
  const timer = setInterval(
    () => ndrService.runDuePoll().catch((error) => log.error('tick_failed', { code: error?.code || error?.message || 'FAILED' })),
    env.NDR_POLL_INTERVAL_MS,
  );
  timer.unref();
  return () => clearInterval(timer);
}
