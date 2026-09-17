// Multi-company request scoping (implementation/multi-company/DESIGN.md
// §5.1) — Phase 2. Mounted right after `authenticateStaff` on every
// /api/v1/admin/* route.
//
// BLOCKING MODE (current default as of Phase 6, env.BRAND_CONTEXT_ENFORCEMENT
// = 'BLOCKING') — every violation that used to be logged-and-allowed in
// Phases 2-5's advisory mode now actually 403s: a staff member with zero
// `staff_brand_access` grants, or whose current/header brand candidate isn't
// one they're granted, is refused before any handler runs. ADVISORY mode
// (log via securityEvent, let the request through) still exists behind the
// same env var for rollback per DESIGN.md §8's rollback note — a single env
// var flip, no code change, no redeploy of anything but config.
//
// req.brandId / req.brand / req.brandScope / req.accessibleBrands are
// computed and attached the same way in both modes so `/me` and the switcher
// always have real data; only whether a *missing* brand context is allowed
// to fall through differs.
//
// Step 4 of the design's pseudocode (an explicit brand id in the URL/body/
// query that disagrees with req.brandId -> 403 BRAND_MISMATCH) remains
// deliberately not implemented: confirmed by a full grep of server/src as of
// Phase 6 that no admin route reads a client-supplied brandId from
// body/query anywhere — every repository call site uses the server-derived
// req.brandId exclusively. There is nothing to compare against; this stays
// true until some future route changes that.
import { env } from '../config/index.js';
import { AppError } from '../utils/errors.js';
import { securityEvent } from '../utils/securityLog.js';
import { StaffBrandAccessRepository } from '../modules/staff/repositories.js';

const brandAccess = new StaffBrandAccessRepository();

function normalizeHeaderBrandId(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  return trimmed || null;
}

export async function resolveBrandContext(req, _res, next) {
  try {
    // Defensive only — authenticateStaff always runs first in routes.js.
    if (!req.staff) return next();

    const isSuperAdmin = req.staff.role === 'SUPER_ADMIN';
    const accessible = await brandAccess.accessibleBrandsForStaff(req.staff.id, req.staff.role);
    req.accessibleBrands = accessible;

    if (accessible.length === 0) {
      // Zero grants and not SUPER_ADMIN — deny by default (DESIGN.md §5.1
      // step 2). Blocking mode refuses the request outright; advisory mode
      // (rollback path) still logs and lets it through with a null context.
      securityEvent('brand_context_no_access', req, { role: req.staff.role });
      if (env.BRAND_CONTEXT_ENFORCEMENT === 'BLOCKING') {
        return next(new AppError('BRAND_ACCESS_DENIED', 'You do not have access to any company.', 403));
      }
      req.brandId = null;
      req.brand = null;
      req.brandScope = null;
      return next();
    }

    const headerBrandId = normalizeHeaderBrandId(req.headers['x-brand-id']);
    const sessionBrandId = req.staffSession?.current_brand_id || null;
    const defaultBrandId = accessible.find((b) => b.is_default)?.id || accessible[0].id;
    const candidateId = headerBrandId || sessionBrandId || defaultBrandId;

    const candidate = accessible.find((b) => b.id === candidateId) || null;
    const hasAccess = isSuperAdmin || Boolean(candidate);

    if (!hasAccess) {
      securityEvent('brand_access_denied', req, { candidateId, role: req.staff.role });
      if (env.BRAND_CONTEXT_ENFORCEMENT === 'BLOCKING') {
        return next(new AppError('BRAND_ACCESS_DENIED', 'You do not have access to this company.', 403));
      }
    }

    req.brandId = candidate?.id || candidateId || null;
    req.brand = candidate;
    // Multi-company (DESIGN.md §5.2, Phase 5) — requireStaffPermission
    // reads role + overrides from here, not req.staff.permissions, so a
    // company-specific grant (a different role, or a permission_overrides_json
    // entry) actually takes effect per-company rather than globally.
    req.brandScope = candidate ? {
      role: candidate.access_role,
      permissionOverrides: candidate.access_overrides
        ? (typeof candidate.access_overrides === 'string' ? JSON.parse(candidate.access_overrides) : candidate.access_overrides)
        : null,
    } : null;

    next();
  } catch (err) {
    next(err);
  }
}

export default resolveBrandContext;
