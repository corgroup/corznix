import { randomUUID } from 'node:crypto';
import { processDue } from './outboxService.js';

// Wave 8I-4 — the outbox drain loop. One `setInterval`, mirroring the other
// CORCOTTON workers (inventory expiry, order finalization, communications).
// `PLATFORM_OUTBOX_WORKER_ENABLED=false` disables it (verification scripts set
// this so they can drive the outbox deterministically).

export function startOutboxWorker({ intervalMs = 5000, batch = 10 } = {}) {
  if (process.env.PLATFORM_OUTBOX_WORKER_ENABLED === 'false') return () => {};
  const workerId = `outbox-${process.pid}-${randomUUID().slice(0, 8)}`;
  let running = false;
  let stopped = false;

  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try { await processDue({ workerId, batch }); }
    catch (err) { console.error('[outbox-worker] tick failed:', err?.message || err); }
    finally { running = false; }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  // Graceful shutdown (§62) — stop claiming; an in-flight tick finishes on its
  // own and releases its rows.
  return () => { stopped = true; clearInterval(timer); };
}
