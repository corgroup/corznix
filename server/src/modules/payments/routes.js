import { Router } from 'express';
import { cashfreeWebhook, razorpayWebhook, paymentReturnStatus } from './controller.js';
import { authenticate } from '../../middleware/authenticate.js';

const router = Router();
router.post('/webhooks/cashfree', cashfreeWebhook);
router.post('/webhooks/razorpay', razorpayWebhook);
router.get('/attempts/:attemptId/status', authenticate, paymentReturnStatus);
export default router;
