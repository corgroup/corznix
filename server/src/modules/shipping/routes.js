import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { options, checkDelivery } from './controller.js';

const router = Router();
const shippingQuoteLimiter = rateLimit({ windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false, message: { error: { code: 'RATE_LIMITED', message: 'Too many delivery checks. Please try again shortly.' } } });
router.post('/options', shippingQuoteLimiter, options);
router.post('/check-delivery', shippingQuoteLimiter, checkDelivery);
export default router;
