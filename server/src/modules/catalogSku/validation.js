import { z } from 'zod';

export const previewSchema = z.object({
  variantId: z.string().uuid(),
  sizeCode: z.string().trim().max(8).optional(),
});

// Canonical SKU create — the client sends the SIZE + commercial fields only.
// The final SKU string is generated + validated server-side (brief §14/§19).
export const createCanonicalSkuSchema = z.object({
  variantId: z.string().uuid(),
  size: z.string().trim().min(1).max(8),
  priceMinor: z.number().int().nonnegative().max(100_000_000),
  salePriceMinor: z.number().int().nonnegative().max(100_000_000).nullish(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
}).refine((b) => b.salePriceMinor == null || b.salePriceMinor <= b.priceMinor, {
  message: 'Sale price cannot exceed the regular price.', path: ['salePriceMinor'],
});

// Variant identity fields (colour code + design). Attached to a variant, not
// repeated per SKU (brief §13 — DESIGN_OWNER = VARIANT).
export const variantIdentitySchema = z.object({
  colorCodeId: z.string().uuid().nullish(),
  designName: z.string().trim().max(120).nullish(),
  designCode: z.string().trim().max(45).nullish(),
});

// Product identity fields (type + fit codes).
export const productIdentitySchema = z.object({
  productTypeCodeId: z.string().uuid().nullish(),
  fitCodeId: z.string().uuid().nullish(),
});

// Operator-created master codes. The `code` regexes mirror the DB CHECK
// constraints from migration 057 so a bad value fails with a clean 422 first.
// `label` is stored as-typed; `code` is upper-cased.
const codeLabel = z.string().trim().min(2).max(60);
export const createProductTypeCodeSchema = z.object({
  label: codeLabel,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,8}$/, 'Use 2–8 letters or digits.'),
  sizeFamily: z.enum(['APPAREL', 'JEANS']).default('APPAREL'),
});
export const createFitCodeSchema = z.object({
  label: codeLabel,
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{1,8}$/, 'Use 1–8 letters or digits.'),
});
