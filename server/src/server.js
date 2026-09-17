import { createApp } from './app.js';
import { env } from './config/index.js';
import { pool } from './database/connection/pool.js';
import { logger } from './utils/logger.js';
import { startInventoryExpiryWorker } from './modules/inventory/expiryWorker.js';
import { startOrderFinalizationWorker } from './modules/orders/finalizationWorker.js';
import { startFulfillmentRecoveryWorker } from './modules/fulfillment/recoveryWorker.js';
import { startCommunicationWorker } from './modules/communications/service.js';
import { startAutoFulfillmentWorker } from './modules/shipping/autoFulfillmentWorker.js';
import { startTrackPullWorker } from './modules/logistics/trackPullWorker.js';
import { startNdrPollWorker } from './modules/logistics/ndrPollWorker.js';
import { startAbandonedCartWorker } from './modules/abandonedCart/worker.js';
import { startMarketingCampaignWorker } from './modules/marketingCampaigns/worker.js';
import { startInstagramWorker } from './modules/instagram/worker.js';
import { startPlatformOperations } from './modules/platform/bootstrap.js';
import { registerLogisticsWebhooks } from './modules/logistics/bootstrap.js';

const log = logger('server');
const app = createApp();

const server = app.listen(env.PORT, () => {
  log.info('listening', { url: `http://localhost:${env.PORT}`, env: env.NODE_ENV });
  // WP-01 — registers the logistics Scan Push verifier/parser/applier on the
  // unified provider webhook inbox. Not a worker (no interval, nothing to
  // stop on shutdown) — just wiring, done once, before any webhook can land.
  registerLogisticsWebhooks();
  const stops = [
    startInventoryExpiryWorker(),
    startOrderFinalizationWorker(),
    startFulfillmentRecoveryWorker(),
    startCommunicationWorker(),
    startAutoFulfillmentWorker(),
    startTrackPullWorker(),
    startNdrPollWorker(),
    startAbandonedCartWorker(),
    startMarketingCampaignWorker(),
    startInstagramWorker(),
    startPlatformOperations(),
  ];

  // Wave 8J-4 — graceful shutdown. Stop claiming new work, stop accepting new
  // connections, let in-flight requests drain, then close the DB pool. A hard
  // ceiling guarantees the process actually exits.
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown_begin', { signal });
    const force = setTimeout(() => { log.error('shutdown_forced'); process.exit(1); }, Number(env.SHUTDOWN_TIMEOUT_MS) || 10_000);
    force.unref?.();
    for (const stop of stops) { try { stop?.(); } catch { /* best effort */ } }
    server.close(async () => {
      try { await pool.end(); } catch { /* best effort */ }
      log.info('shutdown_complete', { signal });
      process.exit(0);
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => shutdown(signal));

  // Test hook (verify:hardening) — Windows cannot deliver a real SIGTERM to a
  // child, so this exercises the exact same drain → close → pool.end → exit
  // path on a short timer. No effect unless SHUTDOWN_SELFTEST is set.
  if (process.env.SHUTDOWN_SELFTEST === '1') setTimeout(() => shutdown('SELFTEST'), 600);
});

export { server };
