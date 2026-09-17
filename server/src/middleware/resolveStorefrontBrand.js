// Multi-company request scoping — storefront half (implementation/
// multi-company/DESIGN.md §5.1: "The customer storefront resolves brand
// from the host / storefront origin (`brands.storefront_url`), not a
// header"). Phase 4.
//
// Mirrors the admin side's `resolveBrandContext` (Phase 2) in spirit, but
// the resolution key is completely different: there is no staff session or
// `x-brand-id` header to trust from an anonymous storefront visitor — only
// the request's own Origin/Host tells you which company's site this is.
//
// Mounted globally on the /api/v1 router (skipping /admin and /platform,
// which resolve brand their own way or not at all) so req.brandId is
// available to every storefront-facing route from this phase forward.
//
// SAFE-DEFAULT, not blocking: an unrecognized/unmapped host (local dev,
// a host nobody has configured yet, Cor-Znix before it has a live
// storefront) falls back to the `is_default` brand — exactly the same
// "single-company behaviour is unaffected" guarantee every earlier phase
// made. There is no 403 here; an anonymous visitor with a genuinely wrong
// host has nothing to be denied *from* — the repos scoped in this phase
// simply return that brand's (empty, for Cor-Znix today) data.
import { query } from '../database/connection/pool.js';

let cachedBrands = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000; // brands change rarely; avoids a query per request without risking staleness for long

async function loadBrands() {
  const now = Date.now();
  if (cachedBrands && now - cachedAt < CACHE_TTL_MS) return cachedBrands;
  cachedBrands = await query('SELECT id, slug, storefront_url, is_default FROM brands WHERE status != \'ARCHIVED\'');
  cachedAt = now;
  return cachedBrands;
}

/** Exported for tests/verify scripts that mutate brands mid-run and need the next request to see it immediately. */
export function _invalidateBrandCache() {
  cachedBrands = null;
}

function hostFromOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return String(value).toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
  }
}

export async function resolveStorefrontBrand(req, _res, next) {
  try {
    // The admin/platform surfaces resolve brand their own way (staff
    // access grants, or not at all for webhooks) — never let this
    // storefront-only heuristic run there.
    if (req.path.startsWith('/admin') || req.path.startsWith('/platform')) return next();

    const brands = await loadBrands();
    const requestHost = hostFromOrigin(req.headers.origin) || hostFromOrigin(req.headers.host);

    const matched = requestHost
      ? brands.find((b) => b.storefront_url && hostFromOrigin(b.storefront_url) === requestHost)
      : null;

    const fallback = brands.find((b) => b.is_default) || brands[0] || null;
    const resolved = matched || fallback;

    req.brandId = resolved?.id || null;
    req.brand = resolved || null;

    next();
  } catch (err) {
    next(err);
  }
}

export default resolveStorefrontBrand;
