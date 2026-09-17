import { z } from 'zod';

export const addCartItemSchema = z.object({
  storefrontId: z.coerce.number().int().positive(),
  size: z.string().trim().min(1).max(20),
  quantity: z.number().int().min(1).max(99),
}).strict();

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(1).max(99),
}).strict();

export const lineIdSchema = z.string().uuid();
