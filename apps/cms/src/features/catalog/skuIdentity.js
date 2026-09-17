import { useEffect, useState } from 'react';
import { adminApi } from '../../api/adminApi.js';

// Phase 1B — client mirror of the backend SKU generator (server is still the
// authority; this only drives the live preview in Product Studio).
export const BRAND_CODE = 'COR';
export const DESIGN_CODE_RE = /^[A-Z0-9]+$/;
export const DESIGN_CODE_MAX = 45;

export function normalizeDesignCode(raw) {
  return String(raw ?? '').trim().toUpperCase();
}

export function designCodeError(raw) {
  const c = normalizeDesignCode(raw);
  if (!c) return null; // empty is "not yet", not an error, in the editor
  if (/\s/.test(c)) return 'Design code cannot contain spaces.';
  if (c.includes('-') || c.includes('_')) return 'Design code cannot contain hyphens or underscores.';
  if (!DESIGN_CODE_RE.test(c)) return 'Design code can contain uppercase letters and numbers only.';
  if (c.length > DESIGN_CODE_MAX) return `Design code must be ${DESIGN_CODE_MAX} characters or fewer.`;
  return null;
}

// Returns { sku } or { missing: [labels] }.
export function previewSku({ productTypeCode, fitCode, colorCode, designCode, sizeCode }) {
  const missing = [];
  if (!productTypeCode) missing.push('product type');
  if (!fitCode) missing.push('fit');
  if (!colorCode) missing.push('colour');
  const dc = normalizeDesignCode(designCode);
  if (!dc || designCodeError(designCode)) missing.push('design code');
  if (!sizeCode) missing.push('size');
  if (missing.length) return { missing };
  return { sku: [BRAND_CODE, productTypeCode, fitCode, colorCode, dc, String(sizeCode).toUpperCase()].join('-') };
}

// Fetch of the canonical option lists. `reload()` re-fetches (e.g. after an
// operator creates a new type/fit code).
export function useSkuOptions() {
  const [state, setState] = useState({ status: 'loading', data: null });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    adminApi.catalog.skuOptions().then(
      (d) => { if (live) setState({ status: 'ready', data: d }); },
      () => { if (live) setState({ status: 'error', data: null }); },
    );
    return () => { live = false; };
  }, [nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}

export function sizeFamilyFor(options, productTypeCodeId) {
  const t = (options?.productTypes || []).find((x) => x.id === productTypeCodeId);
  return t?.sizeFamily || null;
}
export function allowedSizes(options, sizeFamily) {
  return (options?.sizeRules || {})[sizeFamily] || [];
}
