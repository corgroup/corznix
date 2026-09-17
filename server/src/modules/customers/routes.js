import { Router } from 'express';
import { z } from 'zod';
import * as customersController from './controller.js';
import { authenticate } from '../../middleware/authenticate.js';
import { otpVerifyLimiter } from '../../middleware/authRateLimit.js';
import { customerPreferencesService } from './preferencesService.js';

const preferenceBody = z.object({
  channel: z.enum(['EMAIL', 'WHATSAPP']),
  purpose: z.enum(['MARKETING', 'NEWSLETTER']),
  granted: z.boolean(),
  // Where the customer made the decision. Without it every consent this route
  // records is stamped ACCOUNT_SETTINGS, including the one taken at checkout —
  // which then cannot be told apart from a change made on the account page.
  // Constrained to the sources the consent ledger's own CHECK constraint
  // allows, so a caller cannot invent one.
  source: z.enum(['ACCOUNT_SETTINGS', 'CHECKOUT']).optional(),
});

// Real customers module (Wave 5 — see docs/MIGRATION.md). Replaces the
// `createStubRouter('customers')` placeholder. Every route operates on
// `req.customer` (set by `authenticate`) — never a client-supplied
// customerId (migration brief §60).
const router = Router();

router.get('/me', authenticate, customersController.getMe);
router.patch('/me', authenticate, customersController.updateMe);
router.post('/me/contacts/:type/verification/request', authenticate, customersController.requestContactVerification);
router.post('/me/contacts/:type/verification/confirm', authenticate, otpVerifyLimiter, customersController.confirmContactVerification);

// Marketing preferences (Wave 8G-2) — never affects authentication (§9/§44).
router.get('/me/preferences', authenticate, async (req, res, next) => {
  try { res.json({ data: await customerPreferencesService.get(req.customer.id) }); } catch (err) { next(err); }
});
router.patch('/me/preferences', authenticate, async (req, res, next) => {
  try {
    const body = preferenceBody.parse(req.body ?? {});
    res.json({ data: await customerPreferencesService.set({ customerId: req.customer.id, ...body }) });
  } catch (err) { next(err); }
});

export default router;
