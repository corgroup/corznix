// Warehouse-scoped authorization for the admin surface. Runs after
// authenticateStaff (+ usually requireStaffPermission).
//
// Model (deny-by-default):
//  - company-wide administrative roles (SUPER_ADMIN, ADMIN) see every
//    warehouse IN THEIR CURRENT COMPANY;
//  - every other role is scoped to its `staff_warehouse_assignments` rows —
//    and a staff member with NO assignments has NO warehouse-scoped access.
//    Assignments are the grant, not an opt-in restriction.
//
// Multi-company (DESIGN.md §5.3) — Phase 6 security pass. Before this fix,
// `all: true` meant "every warehouse in the whole install, no filter at
// all" — GLOBAL_WAREHOUSE_ROLES predates multi-company and conflated
// "company-wide" with "install-wide". Once a second company has its own
// warehouses (Phase 7), an ADMIN/SUPER_ADMIN scoped to Cor-Cotton would have
// seen and managed Cor-Znix's print stations/quarantine/transfers/inventory
// reports too, since every consumer of this helper trusted `scope.all` to
// mean "skip the warehouseIds check entirely". `warehouseIds` is now ALWAYS
// the caller's real, complete warehouse set (every warehouse in `brandId`
// for the global roles, same as before for everyone else) — `all` stays a
// display/UI-only signal ("no per-warehouse ASSIGNMENT restriction"), so
// every membership check should use `scope.warehouseIds.includes(id)`
// unconditionally rather than short-circuiting on `scope.all` first.
// `brandId` is optional only for the rare caller with no request context
// (falls back to the pre-fix, install-wide behaviour) — every real route
// has `req.brandId` available from `resolveBrandContext` and must pass it.
import { AppError } from '../utils/errors.js';
import { query } from '../database/connection/pool.js';
import { StaffWarehouseAssignmentRepository } from '../modules/staff/repositories.js';

const assignments = new StaffWarehouseAssignmentRepository();

// Roles whose authority is company-wide by design and therefore span every
// warehouse *in their current company* regardless of assignment rows.
export const GLOBAL_WAREHOUSE_ROLES = Object.freeze(new Set(['SUPER_ADMIN', 'ADMIN']));

/** @returns {Promise<{ all: boolean, warehouseIds: string[] }>} */
export async function warehouseScopeForStaff(staff, brandId = null) {
  if (!staff) return { all: false, warehouseIds: [] };
  if (GLOBAL_WAREHOUSE_ROLES.has(staff.role)) {
    if (!brandId) return { all: true, warehouseIds: [] }; // no brand context — legacy fallback, unchanged behaviour
    const rows = await query('SELECT id FROM warehouses WHERE brand_id = ?', [brandId]);
    return { all: true, warehouseIds: rows.map((r) => r.id) };
  }
  const warehouseIds = await assignments.warehouseIdsForStaff(staff.id);
  return { all: false, warehouseIds };
}

export async function staffCanAccessWarehouse(staff, warehouseId, brandId = null) {
  const scope = await warehouseScopeForStaff(staff, brandId);
  if (!brandId && scope.all) return true; // legacy fallback path only
  return scope.warehouseIds.includes(warehouseId);
}

/**
 * Guard a route whose target warehouse id is in params / body / query.
 * @param {string} [key='warehouseId']
 */
export function requireWarehouseAccess(key = 'warehouseId') {
  return async function requireWarehouseAccessMiddleware(req, _res, next) {
    try {
      if (!req.staff) throw new AppError('AUTH_REQUIRED', 'Staff authentication required.', 401);
      const warehouseId = req.params?.[key] || req.body?.[key] || req.query?.[key] || null;
      if (!warehouseId) throw new AppError('VALIDATION_ERROR', 'A warehouse id is required.', 400);
      if (!(await staffCanAccessWarehouse(req.staff, warehouseId, req.brandId))) {
        throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this warehouse.', 403);
      }
      req.warehouseScope = await warehouseScopeForStaff(req.staff, req.brandId);
      next();
    } catch (error) {
      next(error);
    }
  };
}

export default requireWarehouseAccess;
