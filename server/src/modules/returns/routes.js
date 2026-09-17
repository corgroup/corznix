import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import * as c from './controller.js';

// Customer-facing return / replacement / exchange surface (§27). Every route
// is scoped to the authenticated customer's own orders and requests —
// cross-customer access surfaces as a 404, never an existence leak (§28).
const router = Router();
router.use(authenticate);

router.get('/eligibility', c.getEligibility);
router.get('/orders/:orderId/eligibility', c.getEligibility);

router.get('/requests', c.listRequests);
router.post('/requests', c.createRequest);
router.get('/requests/:id', c.getRequest);
router.post('/requests/:id/cancel', c.cancelRequest);

// Different-style exchange: an opaque context token stands in for the
// exchange transaction — the raw id is never trusted from the client (§57).
router.get('/exchange/:token', c.getExchangeContext);
router.post('/exchange/:token/checkout', c.placeExchangeOrder);
router.post('/exchange-orders/:id/cancel', c.cancelExchangeOrder);

export default router;
