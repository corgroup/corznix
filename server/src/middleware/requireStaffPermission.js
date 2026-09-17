// Backend RBAC enforcement. Must run after authenticateStaff AND
// resolveBrandContext (mounted globally ahead of every /admin route — see
// modules/staff/routes.js). A missing permission is 403 (authenticated but
// not allowed), never 404 (Wave 8A brief §14/§57).
//
// Multi-company (DESIGN.md §5.2/§8, Phase 5) — "staff_brand_access.role +
// overrides" is now the source of truth, not the flat global
// `req.staff.permissions` a pre-Phase-5 build used: the SAME staff member
// can hold a different role (and different permission_overrides_json) per
// company, and that must actually take effect for the company they're
// currently in, not their role in some other company. `req.brandScope` is
// null only when resolveBrandContext found ZERO accessible brands for this
// staff member (a real gap it already logs) — deny-by-default there, never
// fall back to the old global list, which would silently ignore
// company-scoping entirely.
import { AppError } from '../utils/errors.js';
import { securityEvent } from '../utils/securityLog.js';
import { resolveEffectivePermissions } from '../modules/staff/permissions.js';

export function requireStaffPermission(permission) {
  return function requireStaffPermissionMiddleware(req, _res, next) {
    if (!req.staff) {
      return next(new AppError('AUTH_REQUIRED', 'Staff authentication required.', 401));
    }
    const permissions = req.brandScope
      ? resolveEffectivePermissions(req.brandScope.role, req.brandScope.permissionOverrides)
      : [];
    if (!permissions.includes(permission)) {
      securityEvent('unauthorized_admin_action', req, { requiredPermission: permission });
      return next(new AppError('PERMISSION_DENIED', 'You do not have permission to perform this action.', 403));
    }
    return next();
  };
}

export default requireStaffPermission;
