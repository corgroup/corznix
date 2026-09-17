// Multi-company (DESIGN.md §5.3) — Phase 6 security pass. A generic guard
// for any `:id`-shaped admin route whose target row carries its own
// `brand_id`: looks the row up by id, and 404s (never 403 — don't leak
// existence, same rule as every other cross-brand check in this codebase)
// if it belongs to a different company than req.brandId. Deliberately a
// SEPARATE, always-applied check ahead of the route handler, rather than
// something threaded through each handler's own service calls — this is
// the single place that closes the gap for every route it's mounted on.
//
// Use it for whole families of `:id` routes that all resolve to the same
// underlying table (orders, shipments) instead of hand-auditing every
// handler individually — the mechanical, low-risk way to cover a large
// existing surface in one pass.
import { AppError } from '../utils/errors.js';
import { query } from '../database/connection/pool.js';

/**
 * `table`/`altColumn` must always be hardcoded literals from the
 * route-mounting code — never derived from request input — since they're
 * interpolated directly into the query.
 * @param {string} table - table to check (must have an `id` and `brand_id` column)
 * @param {string} [notFoundCode] - AppError code to throw on a miss/mismatch
 * @param {string} [notFoundMessage]
 * @param {string} [paramKey='id']
 * @param {string} [altColumn] - an alternate business-key column some
 *   routes accept in place of the UUID (e.g. order_number, ticket_number) —
 *   matched as `id = ? OR <altColumn> = ?`, same as the underlying repos.
 */
export function requireResourceBrand(table, { notFoundCode = 'NOT_FOUND', notFoundMessage = 'Not found.', paramKey = 'id', altColumn = null } = {}) {
  return async function requireResourceBrandMiddleware(req, _res, next) {
    try {
      if (!req.brandId) return next(); // no brand context resolved (e.g. SUPER_ADMIN legacy fallback) — nothing to check against
      const id = req.params?.[paramKey];
      if (!id) return next();
      const rows = altColumn
        ? await query(`SELECT brand_id FROM ${table} WHERE id = ? OR ${altColumn} = ? LIMIT 1`, [id, id])
        : await query(`SELECT brand_id FROM ${table} WHERE id = ? LIMIT 1`, [id]);
      if (!rows[0] || rows[0].brand_id !== req.brandId) {
        throw new AppError(notFoundCode, notFoundMessage, 404);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export default requireResourceBrand;
