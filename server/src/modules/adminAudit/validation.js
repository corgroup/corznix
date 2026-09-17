import { z } from 'zod';

// WP-12 / GAP-ORD-06 — audit-log viewer query contract. Everything optional;
// `q` is a loose contains match. Dates accept a plain `YYYY-MM-DD` (from the
// CMS date inputs) or a full ISO instant.
const isoish = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z?)?$/, 'expected YYYY-MM-DD or an ISO instant')
  .optional();

export const listQuerySchema = z.object({
  action: z.string().trim().max(64).optional(),
  resourceType: z.string().trim().max(64).optional(),
  actorEmail: z.string().trim().max(255).optional(),
  staffUserId: z.string().uuid().optional(),
  q: z.string().trim().max(120).optional(),
  from: isoish,
  to: isoish,
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
