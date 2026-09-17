// Multi-company (DESIGN.md §4.1) — Phase 4. Several repositories (comms
// templates/broadcasts, promotions, segments, newsletter, consent,
// store-credit, support, staff notifications) are called from deep,
// system-triggered paths (background workers, lifecycle notification
// emit() call sites across ~15 order/shipment events, admin CLI scripts)
// that have no request/brandId in scope at all. Rather than threading an
// explicit brandId through every one of those call chains — a much larger
// change with the same "single-company behaviour unaffected" outcome as
// just defaulting — these repos accept an OPTIONAL brandId and fall back
// to the `is_default` brand (Cor-Cotton today) here, exactly the same
// safe-default principle Phase 2's resolveBrandContext already uses when
// no explicit brand is resolvable. Callers that DO have a real brandId in
// scope (admin routes, the storefront) should still pass it explicitly —
// this is a fallback, not a replacement for real scoping.
import { query } from '../database/connection/pool.js';

let cachedId = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

export async function defaultBrandId() {
  const now = Date.now();
  if (cachedId && now - cachedAt < CACHE_TTL_MS) return cachedId;
  const rows = await query("SELECT id FROM brands WHERE is_default = 1 LIMIT 1");
  cachedId = rows[0]?.id || null;
  cachedAt = now;
  return cachedId;
}

/** Exported for tests/verify scripts that need the next call to see fresh data. */
export function _invalidateDefaultBrandCache() {
  cachedId = null;
}

export async function resolveBrandId(explicit) {
  return explicit || (await defaultBrandId());
}
