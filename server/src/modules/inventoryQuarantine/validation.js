import { z } from 'zod';

export const listQuerySchema = z.object({
  status: z.enum(['OPEN', 'RESOLVED']).optional(),
  warehouseId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const disposeBodySchema = z.object({
  action: z.enum(['RELEASE', 'SCRAP']),
  quantity: z.number().int().min(1).max(1_000_000),
  note: z.string().trim().max(255).optional(),
});
