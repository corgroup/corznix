// Phase 1B — the single authoritative canonical-SKU generator + validator.
//
//   COR-[PRODUCT_TYPE]-[FIT]-[COLOR]-[DESIGN_CODE]-[SIZE]
//   e.g. COR-TS-O-BLK-ARI-M
//
// Pure — no DB, no I/O. The service layer resolves component ids to codes,
// checks uniqueness, and persists; this file only encodes the formula and the
// segment rules. The frontend may import the same rules for a live preview,
// but the create/update mutation ALWAYS regenerates server-side.
//
// There is NO style/product/sequence segment (brief §3), and design codes are
// NEVER auto-numbered (brief §5).

export const BRAND_CODE = 'COR';
export const SEGMENT_SEP = '-';
// skus.sku is VARCHAR(64). Fixed overhead for a maximal canonical SKU:
//   "COR-" (4) + type(≤8) + "-" + fit(≤8) + "-" + color(≤8) + "-" + "-" + size(≤4)
//   = 4 + 8 + 1 + 8 + 1 + 8 + 1 + 1 + 4 = 36  ->  64 - 36 = 28 head-room.
// With the approved reference set (type ≤2, fit ≤3, colour ≤3, size ≤2) the
// real ceiling is far higher; 45 is the CHECK-constraint bound on
// product_variants.design_code and the safe, documented maximum.
export const DESIGN_CODE_MAX = 45;
export const SKU_MAX = 64;

// Approved size rules, keyed by product-type size_family.
// Phase 2 (2026-09-03): the business confirmed the apparel size run is
// XS – XXXL (was S–XL; XS / XXL / XXXL were previously parked as
// NEEDS_SIZE_POLICY_DECISION). Codes are stored verbatim on skus.size.
export const SIZE_RULES = Object.freeze({
  APPAREL: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
  JEANS: ['28', '30', '32', '34', '36'],
});

export function normalizeCode(value) {
  return String(value ?? '').trim().toUpperCase();
}

// A generic uppercase code segment (type / fit / colour / size). No separators.
const SEGMENT_RE = /^[A-Z0-9]+$/;

export function validateDesignCode(raw) {
  const c = normalizeCode(raw);
  if (!c) return { ok: false, code: 'MISSING_DESIGN_CODE', message: 'Enter a design code.' };
  if (/[\s]/.test(c)) return { ok: false, code: 'DESIGN_CODE_INVALID', message: 'Design code cannot contain spaces.' };
  if (c.includes(SEGMENT_SEP) || c.includes('_')) {
    return { ok: false, code: 'DESIGN_CODE_INVALID', message: 'Design code cannot contain hyphens or underscores — it is one SKU segment.' };
  }
  if (!SEGMENT_RE.test(c)) {
    return { ok: false, code: 'DESIGN_CODE_INVALID', message: 'Design code can contain uppercase letters and numbers only.' };
  }
  if (c.length > DESIGN_CODE_MAX) {
    return { ok: false, code: 'DESIGN_CODE_TOO_LONG', message: `Design code must be ${DESIGN_CODE_MAX} characters or fewer.` };
  }
  return { ok: true, value: c };
}

export function sizeCodeStatus(sizeFamily, sizeCode) {
  const allowed = SIZE_RULES[sizeFamily] || [];
  return allowed.includes(normalizeCode(sizeCode)) ? 'APPROVED' : 'NEEDS_SIZE_POLICY_DECISION';
}

/**
 * Build the canonical SKU from already-resolved component codes.
 * Returns { ok, sku, parts } or { ok:false, errors:[{code,message,field}] }.
 * A missing / invalid input never yields a partial SKU (brief §15).
 */
export function generateSku({ productTypeCode, fitCode, colorCode, designCode, sizeCode, sizeFamily } = {}) {
  const errors = [];
  const pt = normalizeCode(productTypeCode);
  const fit = normalizeCode(fitCode);
  const col = normalizeCode(colorCode);
  const size = normalizeCode(sizeCode);

  if (!pt) errors.push({ code: 'MISSING_PRODUCT_TYPE', field: 'productType', message: 'Choose a product type.' });
  else if (!SEGMENT_RE.test(pt)) errors.push({ code: 'PRODUCT_TYPE_INVALID', field: 'productType', message: 'The product-type code is not valid.' });

  if (!fit) errors.push({ code: 'MISSING_FIT', field: 'fit', message: 'Choose a fit.' });
  else if (!SEGMENT_RE.test(fit)) errors.push({ code: 'FIT_INVALID', field: 'fit', message: 'The fit code is not valid.' });

  if (!col) errors.push({ code: 'MISSING_COLOR', field: 'color', message: 'Choose a colour before generating this SKU.' });
  else if (!SEGMENT_RE.test(col)) errors.push({ code: 'COLOR_INVALID', field: 'color', message: 'The colour code is not valid.' });

  const dc = validateDesignCode(designCode);
  if (!dc.ok) errors.push({ ...dc, field: 'designCode' });

  if (!size) errors.push({ code: 'MISSING_SIZE', field: 'size', message: 'Choose a size.' });
  else if (!SEGMENT_RE.test(size)) errors.push({ code: 'SIZE_INVALID', field: 'size', message: 'The size code is not valid.' });
  else if (sizeFamily && sizeCodeStatus(sizeFamily, size) !== 'APPROVED') {
    errors.push({ code: 'SIZE_NOT_APPROVED', field: 'size', message: `Size ${size} does not yet have an approved canonical SKU rule.` });
  }

  if (errors.length) return { ok: false, errors };

  const parts = [BRAND_CODE, pt, fit, col, dc.value, size];
  const sku = parts.join(SEGMENT_SEP);
  if (sku.length > SKU_MAX) {
    return { ok: false, errors: [{ code: 'SKU_TOO_LONG', field: 'designCode', message: 'The generated SKU is too long — shorten the design code.' }] };
  }
  return { ok: true, sku, parts: { brand: BRAND_CODE, productType: pt, fit, color: col, design: dc.value, size } };
}
