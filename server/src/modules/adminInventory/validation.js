import { z } from 'zod';

export const listQuerySchema = z.object({
  q: z.string().trim().max(120).optional(),
  warehouseId: z.string().uuid().optional(),
  lowStockOnly: z.preprocess((v) => v === 'true' || v === true, z.boolean()).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const thresholdBodySchema = z.object({
  // null clears the threshold (no low-stock flag for this row).
  threshold: z.union([z.coerce.number().int().min(0).max(1_000_000), z.null()]),
});
