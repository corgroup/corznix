import { z } from 'zod';

export const publicShippingOptionsSchema = z.object({
  postalCode: z.string().trim().regex(/^\d{6}$/),
  context: z.object({ type: z.literal('PRODUCT'), skuId: z.string().uuid().optional(), quantity: z.number().int().positive().max(20).optional() }).strict().default({ type: 'PRODUCT' }),
}).strict();

// Phase 2 · Slice 4 — PDP "check delivery".
export const checkDeliverySchema = z.object({
  postalCode: z.string().trim().regex(/^\d{6}$/),
  skuId: z.string().uuid().optional(),
  quantity: z.number().int().positive().max(20).optional(),
}).strict();
