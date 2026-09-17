import { z } from 'zod';
import catalogService from '../catalog/service.js';
import { AppError } from '../../utils/errors.js';

// Query-string values arrive as strings; zod coerces/validates them into the
// shape catalogService.listProducts expects. Kept here (not a shared
// validators/ folder) since this is the only consumer — see migration
// brief §9, "NEED FIRST, EXTRACT SECOND".
const listQuerySchema = z.object({
  category: z.string().trim().min(1).optional(),
  collection: z.string().trim().min(1).optional(),
  color: z.string().trim().min(1).optional(),
  size: z.string().trim().min(1).optional(),
  fit: z.string().trim().min(1).optional(),
  minPrice: z.coerce.number().int().nonnegative().optional(),
  maxPrice: z.coerce.number().int().nonnegative().optional(),
  sort: z.enum(['newest', 'featured', 'popular', 'price-asc', 'price-desc', 'manual']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
});

const filterQuerySchema = z.object({
  category: z.string().trim().min(1).optional(),
  collection: z.string().trim().min(1).optional(),
});

export async function listProducts(req, res, next) {
  try {
    const q = listQuerySchema.parse(req.query);
    const result = await catalogService.listProducts({
      categorySlug: q.category ?? null,
      collectionSlug: q.collection ?? null,
      color: q.color ?? null,
      size: q.size ?? null,
      fit: q.fit ?? null,
      minPrice: q.minPrice ?? null,
      maxPrice: q.maxPrice ?? null,
      sort: q.sort ?? 'newest',
      page: q.page ?? 1,
      limit: q.limit ?? 8,
    });
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
}

export async function getFilterOptions(req, res, next) {
  try {
    const q = filterQuerySchema.parse(req.query);
    const options = await catalogService.getFilterOptions({
      categorySlug: q.category ?? null,
      collectionSlug: q.collection ?? null,
    });
    res.json({ data: options });
  } catch (err) {
    next(err);
  }
}

// The storefront's existing product URLs (`/products/:id`) carry a
// per-color numeric id — that id is `product_variants.storefront_id`, not
// the product's own UUID (see database/migrations/002_catalog.sql's
// comment on that column). This endpoint is the one the frontend's
// `/products/:id` route actually calls.
export async function getProductByVariantId(req, res, next) {
  try {
    const storefrontId = Number(req.params.storefrontId);
    if (!Number.isInteger(storefrontId) || storefrontId <= 0) {
      throw new AppError('VALIDATION_ERROR', 'Product id must be a positive integer.', 400);
    }
    const product = await catalogService.getVariantByStorefrontId(storefrontId);
    res.json({ data: product });
  } catch (err) {
    next(err);
  }
}

export async function getProductBySlug(req, res, next) {
  try {
    const product = await catalogService.getProductBySlug(req.params.slug);
    res.json({ data: product });
  } catch (err) {
    next(err);
  }
}
