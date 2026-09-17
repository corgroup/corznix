import { z } from 'zod';
import catalogService from '../catalog/service.js';

// Search is product discovery over the Catalog domain, not a separate
// domain with its own repository — this controller is a thin HTTP layer
// over catalogService.searchProducts(), which reuses the exact same
// product row shape/enrichment as `GET /api/v1/products` (see
// modules/catalog/repositories.js's searchVariantRows comment). No
// competing product-query implementation exists.
const searchQuerySchema = z.object({
  q: z.string().trim().min(1, 'A search query is required.').max(200),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(48).optional(),
});

export async function search(req, res, next) {
  try {
    const q = searchQuerySchema.parse(req.query);
    const result = await catalogService.searchProducts({
      q: q.q,
      page: q.page ?? 1,
      limit: q.limit ?? 12,
    });
    res.json({ data: { query: q.q, ...result } });
  } catch (err) {
    next(err);
  }
}
