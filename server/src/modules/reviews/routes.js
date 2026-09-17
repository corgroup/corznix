import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { reviewService } from './service.js';

// Product reviews — public read (PDP) + authenticated write. A customer may
// only review a DELIVERED order item that belongs to them; "verified purchase"
// is backend-computed and never client-asserted (§66). Reviews are created
// PENDING and only a moderator publishes them (§71/§75).
const router = Router();

const submitBody = z.object({
  orderItemId: z.string().trim().min(1),
  rating: z.number().int().min(1).max(5),
  title: z.string().trim().max(160).optional(),
  body: z.string().trim().min(3).max(5000),
});
const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).default({});

// ---- public storefront ------------------------------------------------
// Real published reviews for the homepage strip, which used to be three
// hardcoded invented testimonials. No reviews yet is a valid answer.
router.get('/featured', async (req, res, next) => {
  try {
    const limit = z.coerce.number().int().min(1).max(24).optional().parse(req.query?.limit);
    res.json({ data: await reviewService.featured({ limit, brandId: req.brandId }) });
  } catch (err) { next(err); }
});

// ---- public PDP -------------------------------------------------------
// Only PUBLISHED reviews + the materialized aggregate are ever exposed here.
router.get('/products/:productId', async (req, res, next) => {
  try {
    const { limit, offset } = listQuery.parse(req.query ?? {});
    res.json({ data: await reviewService.publicForProduct(req.params.productId, { limit, offset }) });
  } catch (err) { next(err); }
});

// ---- authenticated customer -----------------------------------------
router.get('/eligibility', authenticate, async (req, res, next) => {
  try {
    const productId = z.string().trim().min(1).parse(req.query?.productId);
    res.json({ data: await reviewService.eligibility({ customerId: req.customer.id, productId }) });
  } catch (err) { next(err); }
});

router.get('/mine', authenticate, async (req, res, next) => {
  try { res.json({ data: { reviews: await reviewService.myReviews(req.customer.id) } }); } catch (err) { next(err); }
});

router.post('/', authenticate, async (req, res, next) => {
  try {
    const body = submitBody.parse(req.body ?? {});
    res.status(201).json({ data: await reviewService.submit({ customerId: req.customer.id, ...body }) });
  } catch (err) { next(err); }
});

export default router;
