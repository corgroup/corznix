import { z } from 'zod';
import { isValidSlug } from '../../utils/slug.js';

// Reuses the exact status vocabulary the catalog schema's CHECK constraints
// already enforce (products/product_variants/skus all: DRAFT/ACTIVE/ARCHIVED).
export const CATALOG_STATUS = ['DRAFT', 'ACTIVE', 'ARCHIVED'];

const slug = z.string().trim().min(1).max(180).refine(isValidSlug, {
  message: 'Slug must be lowercase alphanumeric words separated by single hyphens.',
});
const priceMinor = z.number().int().nonnegative().max(100_000_000); // ₹10,00,000 ceiling
// Canonical shipping units are integers (grams / millimetres). The CMS does
// any kg/cm display conversion and submits integers — the backend contract
// is unambiguous and cannot drift (Wave 8B §18/§30/§31).
const dimensionMm = z.number().int().positive().max(5000);
const weightGrams = z.number().int().positive().max(200_000);

export const listQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(CATALOG_STATUS).optional(),
  // COMPLETE/INCOMPLETE = full package metadata (weight + box). RATE_READY /
  // NOT_RATE_READY = whether checkout can quote a real rate (weight resolvable
  // from the product default or every active SKU) — the same rule as
  // getProduct.shipping.rateReady and productFacets().shipping.
  shipping: z.enum(['COMPLETE', 'INCOMPLETE', 'RATE_READY', 'NOT_RATE_READY']).optional(),
  categoryId: z.string().uuid().optional(),
  collectionId: z.string().uuid().optional(),
  // Additive list facets (product-module redesign, Phase 3):
  //  - sizeGuide: filter on products.size_guide_id presence
  //  - productType: exact match on the free-text products.product_type label
  sizeGuide: z.enum(['assigned', 'unassigned']).optional(),
  productType: z.string().trim().min(1).max(60).optional(),
  // `name_desc` is the only new sort mode. Price sorting is intentionally NOT
  // offered — pricing is SKU-level and a product-level price sort would need an
  // invented aggregation rule (product-module redesign scope decision).
  sort: z.enum(['updated', 'created', 'name', 'name_desc']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const createProductSchema = z.object({
  name: z.string().trim().min(1).max(200),
  productType: z.string().trim().min(1).max(60),
  productTypeCodeId: z.string().uuid().nullish(), // Phase 1B — canonical SKU identity
  fitCodeId: z.string().uuid().nullish(),
  slug: slug.optional(), // derived from name when omitted
  shortDescription: z.string().trim().max(500).nullish(),
  description: z.string().trim().max(20_000).nullish(),
  brand: z.string().trim().min(1).max(100).optional(),
  categoryId: z.string().uuid().nullish(),
  fit: z.string().trim().max(60).nullish(),
  sizeGuideId: z.string().uuid().nullish(),
  collectionIds: z.array(z.string().uuid()).max(50).optional(),
  seoTitle: z.string().trim().max(200).nullish(),
  seoDescription: z.string().trim().max(500).nullish(),
  // The price shown before a size is chosen. Null = fall back to the cheapest
  // active SKU, which is what the storefront has always derived.
  displayPriceMinor: z.coerce.number().int().min(0).max(100_000_000).nullish(),
  // Structured specifications. `fabric`/`gsm` are first-class (filterable,
  // and the PDP has a dedicated row for each); `specifications` carries the
  // open-ended reusable extras. Sending [] clears them.
  fabric: z.string().trim().max(120).nullish(),
  gsm: z.coerce.number().int().min(10).max(2000).nullish(),
  seoKeywords: z.string().trim().max(500).nullish(),
  specifications: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(300),
  })).max(30).optional(),
});

export const updateProductSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  slug: slug.optional(),
  productType: z.string().trim().min(1).max(60).optional(),
  productTypeCodeId: z.string().uuid().nullish(),
  fitCodeId: z.string().uuid().nullish(),
  shortDescription: z.string().trim().max(500).nullish(),
  description: z.string().trim().max(20_000).nullish(),
  brand: z.string().trim().min(1).max(100).optional(),
  categoryId: z.string().uuid().nullish(),
  fit: z.string().trim().max(60).nullish(),
  sizeGuideId: z.string().uuid().nullish(),
  collectionIds: z.array(z.string().uuid()).max(50).optional(),
  seoTitle: z.string().trim().max(200).nullish(),
  seoDescription: z.string().trim().max(500).nullish(),
  // The price shown before a size is chosen. Null = fall back to the cheapest
  // active SKU, which is what the storefront has always derived.
  displayPriceMinor: z.coerce.number().int().min(0).max(100_000_000).nullish(),
  // Structured specifications. `fabric`/`gsm` are first-class (filterable,
  // and the PDP has a dedicated row for each); `specifications` carries the
  // open-ended reusable extras. Sending [] clears them.
  fabric: z.string().trim().max(120).nullish(),
  gsm: z.coerce.number().int().min(10).max(2000).nullish(),
  seoKeywords: z.string().trim().max(500).nullish(),
  specifications: z.array(z.object({
    label: z.string().trim().min(1).max(80),
    value: z.string().trim().min(1).max(300),
  })).max(30).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'No fields to update.' });

export const setStatusSchema = z.object({
  status: z.enum(CATALOG_STATUS),
});

// Bulk status change for the Products list. Each id is applied through the
// same per-product setProductStatus authority (audited, publishes stamp
// published_at); the response is per-id so a partial failure is visible.
export const bulkStatusSchema = z.object({
  ids: z.array(z.string().trim().min(1).max(64)).min(1).max(100),
  status: z.enum(CATALOG_STATUS),
});

// Phase 1B — a design code is one SKU segment: uppercase A–Z / 0–9 only, no
// separators. Normalised (trim + uppercase) before this check.
const designCode = z.string().trim().max(45).nullish();

export const createVariantSchema = z.object({
  colorName: z.string().trim().min(1).max(60),
  colorHex: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/, 'colorHex must be a 6-digit hex value.').nullish(),
  colorCodeId: z.string().uuid().nullish(),
  designName: z.string().trim().max(120).nullish(),
  designCode,
  badge: z.string().trim().max(40).nullish(),
  status: z.enum(CATALOG_STATUS).optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
});

export const updateVariantSchema = z.object({
  colorName: z.string().trim().min(1).max(60).optional(),
  colorHex: z.string().trim().regex(/^#?[0-9a-fA-F]{6}$/).nullish(),
  colorCodeId: z.string().uuid().nullish(),
  designName: z.string().trim().max(120).nullish(),
  designCode,
  badge: z.string().trim().max(40).nullish(),
  status: z.enum(CATALOG_STATUS).optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
}).refine((body) => Object.keys(body).length > 0, { message: 'No fields to update.' });

// Phase 1B — the client no longer supplies the SKU string. It picks the SIZE
// (+ commercial fields); the backend generates + validates the canonical SKU
// from the product/variant identity components.
export const createSkuSchema = z.object({
  variantId: z.string().uuid(),
  size: z.string().trim().min(1).max(8),
  priceMinor,
  salePriceMinor: priceMinor.nullish(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  status: z.enum(CATALOG_STATUS).optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  // Phase 2 §9 — optional per-SKU shipping weight override (grams). Null/omitted
  // ⇒ this SKU inherits the product-level default.
  weightGrams: weightGrams.nullish(),
}).refine((body) => body.salePriceMinor == null || body.salePriceMinor <= body.priceMinor, {
  message: 'Sale price cannot exceed the regular price.', path: ['salePriceMinor'],
});

// `sku` is intentionally NOT accepted — the SKU string is backend-owned. `size`
// on a CANONICAL sku regenerates the string (pre-operational only).
export const updateSkuSchema = z.object({
  size: z.string().trim().min(1).max(8).optional(),
  priceMinor: priceMinor.optional(),
  salePriceMinor: priceMinor.nullish(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  status: z.enum(CATALOG_STATUS).optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  // Phase 2 §9 — per-SKU weight override (grams); null clears it (inherit product default).
  weightGrams: weightGrams.nullish(),
}).refine((body) => Object.keys(body).length > 0, { message: 'No fields to update.' });

// Phase 2 §6/§7: weight_grams is REQUIRED — it is the checkout shipping-rate
// gate and must exist before a product is rate-ready. length/width/height are
// physical defaults and optional, but a partial box is meaningless to a
// carrier, so they come as a set (all three, or none). Final packed
// dimensions are confirmed at fulfilment (§26), not here.
export const shippingProfileSchema = z.object({
  weightGrams,
  lengthMm: dimensionMm.nullish(),
  widthMm: dimensionMm.nullish(),
  heightMm: dimensionMm.nullish(),
}).refine(
  (b) => {
    const set = [b.lengthMm, b.widthMm, b.heightMm].filter((v) => v != null).length;
    return set === 0 || set === 3;
  },
  { message: 'Provide all three dimensions (length, width, height) together, or leave them all blank.', path: ['lengthMm'] },
);

export const assignSizeGuideSchema = z.object({
  sizeGuideId: z.string().uuid().nullable(),
});

// ---- media mapping -------------------------------------------------------

export const mediaLibraryQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(96).optional(),
});

export const attachMediaSchema = z.object({
  mediaId: z.string().uuid(),
  variantId: z.string().uuid().nullish(),
  altText: z.string().trim().max(255).nullish(),
  isPrimary: z.boolean().optional(),
});

export const updateMediaMappingSchema = z.object({
  altText: z.string().trim().max(255).nullish(),
  isPrimary: z.literal(true).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update.' });

export const reorderMediaSchema = z.object({
  variantId: z.string().uuid().nullish(),
  orderedMappingIds: z.array(z.string().uuid()).min(1).max(60),
});

export const deleteAssetQuerySchema = z.object({
  force: z.coerce.boolean().optional(),
});

// ---- size guides --------------------------------------------------------

const measurementValues = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), z.number().finite().nullable());
const sizeGuideRow = z.object({
  size: z.string().trim().min(1).max(20),
  displayOrder: z.number().int().min(0).max(999),
  values: measurementValues.default({}),
  valuesCm: measurementValues.nullish(),
});
const columnKeys = z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).min(2).max(12);

export const createSizeGuideSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slug.optional(),
  title: z.string().trim().max(160).nullish(),
  description: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  unit: z.enum(['in', 'cm']),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  columns: columnKeys,
  rows: z.array(sizeGuideRow).min(1).max(40),
});

export const updateSizeGuideSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: slug.optional(),
  title: z.string().trim().max(160).nullish(),
  description: z.string().trim().max(500).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  unit: z.enum(['in', 'cm']).optional(),
  columns: columnKeys.optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update.' });

export const setSizeGuideRowsSchema = z.object({
  rows: z.array(sizeGuideRow).min(1).max(40),
});

export const setSizeGuideStatusSchema = z.object({
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']),
});

// ---- categories --------------------------------------------------------

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slug.optional(),
  description: z.string().trim().max(500).nullish(),
  parentId: z.string().uuid().nullish(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

export const updateCategorySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: slug.optional(),
  description: z.string().trim().max(500).nullish(),
  parentId: z.string().uuid().nullable().optional(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update.' });

export const setCategoryStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED']),
});

export const setProductCategoriesSchema = z.object({
  categories: z.array(z.object({
    categoryId: z.string().uuid(),
    isPrimary: z.boolean().optional(),
  })).max(20),
});

// ---- collections ------------------------------------------------------

export const createCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  slug: slug.optional(),
  description: z.string().trim().max(500).nullish(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});

export const updateCollectionSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: slug.optional(),
  description: z.string().trim().max(500).nullish(),
  displayOrder: z.number().int().min(0).max(9999).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: 'No fields to update.' });

export const setCollectionStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED']),
});

export const setCollectionMembersSchema = z.object({
  productIds: z.array(z.string().uuid()).max(500),
});

export const collectionMemberSchema = z.object({
  productId: z.string().uuid(),
});

export const reorderCollectionSchema = z.object({
  orderedProductIds: z.array(z.string().uuid()).min(1).max(500),
});
