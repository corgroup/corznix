import { env } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { providerHealthService } from './providerHealthService.js';

// Re-derives every provider's health on a timer. Health used to be computed
// only when someone pressed Recheck on Platform → Providers, so a provider
// could fail for hours with nobody told. A change staff must act on reaches
// the CMS bell as a SYSTEM notification (providerHealthService.recompute).
//
// Health reads recorded attempts only — no provider is called from here.
// PROVIDER_HEALTH_WORKER_ENABLED=false turns it off.
const log = logger('provider-health-worker');
const UNHEALTHY = new Set(['UNAVAILABLE', 'MISCONFIGURED', 'DEGRADED']);

export function startProviderHealthWorker({ intervalMs = env.PROVIDER_HEALTH_INTERVAL_MS, firstRunDelayMs = 60_000 } = {}) {
  if (!env.PROVIDER_HEALTH_WORKER_ENABLED || process.env.PROVIDER_HEALTH_WORKER_ENABLED === 'false') return () => {};
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const results = await providerHealthService.recomputeAll();
      const unhealthy = results.filter((r) => UNHEALTHY.has(r.status));
      if (unhealthy.length) {
        log.warn('providers_unhealthy', { providers: unhealthy.map((r) => `${r.capability}:${r.providerKey}=${r.status}`) });
      }
    } catch (err) {
      log.error('provider_health_tick_failed', { error: err?.message || String(err) });
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
