import { env } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { marketingCampaignService } from './service.js';

const log = logger('marketing-campaigns');

/**
 * Drains launched campaigns and starts scheduled ones.
 *
 * Without this, nothing ever called runDue(): on production a launched
 * campaign sat in SENDING with its whole audience PENDING until a staff
 * member pressed "Process queue now", and a scheduled campaign could never
 * start by itself (2026-09-17).
 *
 * One batch per campaign per tick, so a large audience is spread across ticks
 * rather than fired in one burst. A tick that is still running when the next
 * one is due is skipped, not stacked: batches are claimed UPDATE-first so an
 * overlap could not double-send, but it would still pile work onto the
 * provider and the database for no gain.
 */
export function startMarketingCampaignWorker({ intervalMs = env.MARKETING_CAMPAIGN_INTERVAL_MS } = {}) {
  if (!env.MARKETING_CAMPAIGN_WORKER_ENABLED) return () => {};
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    marketingCampaignService.runDue()
      .then((s) => {
        if (s.queued || s.suppressed || s.failed || s.finished) {
          log.info('campaign_tick', s);
        }
      })
      .catch((error) => log.error('campaign_tick_failed', { error: error.message }))
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
