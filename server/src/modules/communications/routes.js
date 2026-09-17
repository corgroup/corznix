import { Router } from 'express';
import { communicationService } from './service.js';

// Provider delivery webhooks. Unauthenticated (each provider adapter verifies
// its own signature); the payload is never trusted directly — the adapter
// normalizes it and the state transition is monotonic + deduped.
const router = Router();

router.post('/webhooks/:providerCode', async (req, res, next) => {
  try {
    const result = await communicationService.handleWebhook({
      providerCode: String(req.params.providerCode || '').toUpperCase(),
      rawEvent: req.body ?? {},
    });
    res.json({ data: result });
  } catch (err) { next(err); }
});

export default router;
