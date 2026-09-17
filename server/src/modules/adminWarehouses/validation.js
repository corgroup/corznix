import { z } from 'zod';

const code = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]{1,31}$/, 'Code must be 2–32 chars: letters, digits and hyphens.');
const optionalText = (max) => z.string().trim().max(max).optional().or(z.literal('').transform(() => undefined));

export const listQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

export const createWarehouseSchema = z.object({
  code,
  name: z.string().trim().min(1).max(160),
  addressLine1: optionalText(255),
  addressLine2: optionalText(255),
  city: optionalText(120),
  state: optionalText(120),
  postalCode: z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits.').optional().or(z.literal('').transform(() => undefined)),
  country: z.string().trim().length(2).toUpperCase().optional(),
  contactName: optionalText(160),
  // Accepted in whatever shape an operator types it; the service canonicalises
  // to +91XXXXXXXXXX and refuses anything that is not a real Indian mobile,
  // so the length here is only an upper bound on the raw input.
  contactPhone: optionalText(20),
  contactPhoneAlt: optionalText(20),
  contactEmail: z.string().trim().email().max(255).optional().or(z.literal('').transform(() => undefined)),
  priority: z.coerce.number().int().min(0).max(100000).optional(),
});

export const updateWarehouseSchema = createWarehouseSchema.partial().extend({
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
});

export const setStatusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });

export const assignStaffSchema = z.object({ staffUserId: z.string().uuid() });

export const inventoryQuerySchema = z.object({
  skuId: z.string().uuid().optional(),
});

export const adjustInventorySchema = z.object({
  skuId: z.string().uuid(),
  delta: z.number().int().refine((value) => value !== 0, 'Delta must be non-zero.'),
  reason: z.string().trim().min(1).max(500),
});

// Phase 2 §35 — carrier pickup-location mapping. The identifier must match the
// provider's registered warehouse name EXACTLY (case + spaces), so it is stored
// verbatim — no trim beyond the outer whitespace, no case normalisation.
export const providerLocationSchema = z.object({
  // 'link' records an identifier that already exists in the carrier panel;
  // 'register' actually creates it at the carrier first. 'link' stays the
  // default so existing callers are unchanged.
  mode: z.enum(['link', 'register']).optional().default('link'),
  identifier: z.string().min(1).max(160),
  returnIdentifier: z.string().min(1).max(160).nullish(),
  registeredAt: z.coerce.date().nullish(),
  // 'link' only. The operator states they read this exact name in the carrier's
  // panel — a weaker claim than an API registration, recorded separately so the
  // drift report can stop shouting without ever claiming the carrier confirmed.
  panelVerified: z.boolean().optional(),
  // How this warehouse's carrier pickup is raised. Without this the column was
  // unreachable: it defaulted to MANUAL_PANEL and nothing could ever change it,
  // so the API pickup path could not be selected at all.
  pickupMode: z.enum(['API', 'AUTO', 'MANUAL_PANEL']).optional(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  notes: optionalText(500),
});

export const allocationPreviewSchema = z.object({
  destinationPostalCode: z.string().trim().regex(/^\d{6}$/).optional(),
  items: z.array(z.object({
    skuId: z.string().uuid(),
    quantity: z.number().int().positive(),
  })).min(1),
});
