import { z } from 'zod';
import { TRANSFER_STATUS } from './transitions.js';

export const listQuerySchema = z.object({
  status: z.enum(TRANSFER_STATUS).optional(),
  warehouseId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const createBodySchema = z.object({
  sourceWarehouseId: z.string().uuid(),
  destinationWarehouseId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
  lines: z.array(z.object({
    skuId: z.string().uuid(),
    quantity: z.number().int().min(1).max(1_000_000),
  })).min(1).max(200),
});

export const receiveBodySchema = z.object({
  received: z.array(z.object({
    skuId: z.string().uuid(),
    quantityReceived: z.number().int().min(0).max(1_000_000),
  })).max(200).optional(),
});
