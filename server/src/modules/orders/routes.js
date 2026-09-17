import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { orderFinalizationService } from './service.js';
import { getCustomerInvoice } from '../documents/controller.js';
import { orderCancellationService } from '../orderOps/cancellationService.js';
import { AppError } from '../../utils/errors.js';

const router = Router();
router.use(authenticate);
// Customers only ever see their own invoice (internal docs are 403 by design).
// The param is :orderId because that is what getCustomerInvoice reads — named
// :id here, every request reached the handler with an undefined order id and
// the ownership lookup threw, so Download Invoice answered 500 in production.
router.get('/:orderId/invoice', getCustomerInvoice);
router.get('/', async (req,res,next)=>{try{res.json({data:await orderFinalizationService.listOwned(req.customer.id)});}catch(error){next(error);}});
router.get('/:id', async (req,res,next)=>{try{res.json({data:await orderFinalizationService.getOwned(req.customer.id,req.params.id)});}catch(error){next(error);}});
// Provider-neutral forward-fulfillment read model, scoped to the caller's own
// Order (§45/§46). Read-only: there is no fulfill/ship/book mutation route (§47).
router.get('/:id/fulfillment', async (req,res,next)=>{try{res.json({data:await orderFinalizationService.getOwnedFulfillment(req.customer.id,req.params.id)});}catch(error){next(error);}});

// The customer cancels their own order, while nothing has shipped. Until now
// the storefront's "Cancel order" only opened a support ticket, so a customer
// could not cancel at all and nothing credited them.
//
// Ownership first: someone else's order id must look exactly like one that
// does not exist. The eligibility rules, the inventory restore, the fulfilment
// and shipment cancellation are the SAME cascade staff use — what differs is
// where the money goes, and that is the customer's choice: store credit, which
// is instant, or back to the method they paid with, which the gateway takes a
// few days over. Only those two are accepted; anything else is a 400 rather
// than a silent default that sends money somewhere they did not ask for.
const CUSTOMER_REFUND_DESTINATIONS = new Set(['STORE_CREDIT', 'ORIGINAL_PAYMENT']);
router.post('/:id/cancel', async (req, res, next) => {
  try {
    const refundTo = String(req.body?.refundTo || 'ORIGINAL_PAYMENT').toUpperCase();
    if (!CUSTOMER_REFUND_DESTINATIONS.has(refundTo)) {
      throw new AppError('VALIDATION_ERROR', 'Choose where the refund should go: store credit or the original payment method.', 400);
    }
    const order = await orderFinalizationService.getOwned(req.customer.id, req.params.id);
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 255) : null;
    const outcome = await orderCancellationService.cancel(order.id, {
      reason: reason || 'Cancelled by the customer',
      refundTo,
      actor: { customerId: req.customer.id, ip: req.ip, requestId: req.id },
    });
    res.json({ data: outcome });
  } catch (error) { next(error); }
});

export default router;
