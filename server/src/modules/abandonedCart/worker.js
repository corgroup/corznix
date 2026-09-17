import { env } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { abandonedCartService } from './service.js';

const log = logger('abandoned-cart');

/**
 * Periodic scan for abandoned carts. Mirrors the other background workers:
 * returns a stop() function, unref'd timer, never lets an error escape.
 * Per-campaign enable/disable is in the CMS — this only gates the whole
 * scanner. A tick with no ACTIVE campaign is a cheap no-op.
 */
export function startAbandonedCartWorker({ intervalMs = env.ABANDONED_CART_INTERVAL_MS } = {}) {
  if (!env.ABANDONED_CART_WORKER_ENABLED || process.env.ABANDONED_CART_WORKER_ENABLED === 'false') {
    return () => {};
  }
  const tick = () => {
    abandonedCartService.runOnce()
      .then((s) => { if (s.reminded) log.info('swept', { campaigns: s.campaigns, reminded: s.reminded, scanned: s.scanned }); })
      .catch((error) => log.error('sweep_failed', { error: error.message }));
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
