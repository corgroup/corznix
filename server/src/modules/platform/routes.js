import { Router } from 'express';
import { webhookLimiter } from '../../middleware/authRateLimit.js';
import { webhookInboxService } from './webhookInboxService.js';

// Wave 8I-3 — the unified inbound-webhook ingress. Verifies + de-duplicates +
// normalizes + records, then hands the NORMALIZED event to the domain applier
// registered for that capability (none by default → recorded, no business
// effect). Existing domain webhook routes (e.g. /payments/webhooks/cashfree)
// are unchanged; a domain adopts this path by registering an applier.
const router = Router();

router.post('/webhooks/:capability/:providerKey', webhookLimiter, async (req, res, next) => {
  try {
    const result = await webhookInboxService.ingest({
      capability: req.params.capability,
      providerKey: req.params.providerKey,
      rawBody: req.rawBody ?? JSON.stringify(req.body ?? {}),
      headers: req.headers,
    });
    // Always 200 on a well-formed call so the provider does not hammer a
    // retry storm — the inbox row carries the real processing state. Some
    // providers (Delhivery Scan Push contract, provider request-pack §9)
    // check for exactly 200 rather than treating any 2xx as success, so this
    // is 200, not 202, even though the event is genuinely queued not applied
    // synchronously.
    res.status(result.status === 'REJECTED' ? 401 : 200).json({ data: { status: result.status } });
  } catch (err) { next(err); }
});

export default router;
