import { env } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { instagramService } from './service.js';

// Keeps every connected Instagram account fresh: renews the access token when
// Instagram allows it, then pulls the latest posts. One `setInterval`, the
// same shape as the other CORCOTTON workers.
//
// INSTAGRAM_WORKER_ENABLED=false turns it off (verification scripts do, so they
// can drive a sync deterministically). A failing account never stops the
// others; its error is recorded on its connection for the CMS to show.
const log = logger('instagram-worker');

export function startInstagramWorker({ intervalMs = env.INSTAGRAM_SYNC_INTERVAL_MS, firstRunDelayMs = 60_000 } = {}) {
  if (!env.INSTAGRAM_WORKER_ENABLED || process.env.INSTAGRAM_WORKER_ENABLED === 'false') return () => {};
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await instagramService.maintainAll();
      if (result.accounts) log.info('instagram_maintained', result);
    } catch (err) {
      log.error('instagram_tick_failed', { error: err?.message || String(err) });
    } finally {
      running = false;
    }
  };

  const first = setTimeout(tick, firstRunDelayMs);
  const timer = setInterval(tick, intervalMs);
  first.unref?.();
  timer.unref?.();
  return () => { stopped = true; clearTimeout(first); clearInterval(timer); };
}
