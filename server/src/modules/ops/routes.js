import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { query } from '../../database/connection/pool.js';
import { snapshot } from '../../utils/metrics.js';

// Wave 8J-1 — operational metrics for CMS/on-call. Staff-gated, never leaks
// config or secrets: in-process counters/latency + a handful of live backlog
// gauges pulled straight from the operational tables.
const router = Router();

router.get('/ops/metrics', requireStaffPermission(PERMISSIONS.CMS_ACCESS), async (req, res, next) => {
  try {
    const [outbox, recon, webhooks] = await Promise.all([
      query("SELECT status, COUNT(*) n FROM platform_outbox GROUP BY status"),
      query("SELECT COUNT(*) n FROM reconciliation_exceptions WHERE status NOT IN ('RESOLVED')"),
      query("SELECT COUNT(*) n FROM provider_webhook_inbox WHERE processing_status = 'FAILED'"),
    ]);
    const outboxByStatus = Object.fromEntries(outbox.map((r) => [r.status, Number(r.n)]));
    res.json({
      data: {
        ...snapshot(),
        gauges: {
          outbox_pending: (outboxByStatus.PENDING || 0) + (outboxByStatus.FAILED || 0),
          outbox_dead: outboxByStatus.DEAD || 0,
          outbox_reconciliation_required: outboxByStatus.RECONCILIATION_REQUIRED || 0,
          reconciliation_open: Number(recon[0].n),
          webhook_failed: Number(webhooks[0].n),
        },
      },
    });
  } catch (err) { next(err); }
});

export default router;
