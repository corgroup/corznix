import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import * as controller from './controller.js';

const router = Router();
router.use(authenticate);
router.get('/current', controller.current);
router.post('/', controller.create);
router.get('/:id', controller.get);
router.patch('/:id/address', controller.address);
router.post('/:id/serviceability', controller.serviceability);
router.post('/:id/shipping-quote/refresh', controller.refreshShippingQuote);
router.patch('/:id/shipping-method', controller.shipping);
router.post('/:id/payment-eligibility', controller.paymentEligibility);
router.patch('/:id/payment-mode', controller.paymentMode);
router.post('/:id/payment-session', controller.paymentSession);
router.post('/:id/payment/razorpay/verify', controller.razorpayVerify);
router.get('/:id/payment-status', controller.paymentStatus);
router.post('/:id/payment-status/reconcile', controller.reconcilePayment);
router.post('/:id/place-order', controller.placeOrder);
router.post('/:id/coupon', controller.applyCoupon);
// Store credit the customer chooses to put towards this order. GET so the
// payment step can show what is available before anything is applied.
router.get('/:id/store-credit', controller.storeCreditAvailability);
router.post('/:id/store-credit', controller.applyStoreCredit);
router.delete('/:id/store-credit', controller.removeStoreCredit);
router.delete('/:id/coupon', controller.removeCoupon);
router.post('/:id/revalidate', controller.revalidate);
router.post('/:id/keep-alive', controller.keepAlive);
router.post('/:id/renew', controller.renew);
router.post('/:id/cancel', controller.cancel);
export default router;
