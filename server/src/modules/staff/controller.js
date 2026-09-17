import { z } from 'zod';
import { env } from '../../config/index.js';
import { staffAuthService } from './service.js';

function respond(res, data, status = 200) {
  return res.status(status).json({ data });
}

// Staff session cookie: HttpOnly, path-scoped to the admin API only (so it
// is never even sent to the storefront /api/v1/auth surface), Secure in
// production, SameSite=Lax (CMS and API are same-site). Name is distinct
// from the customer SESSION_COOKIE_NAME — no collision (Wave 8A brief §21).
function staffCookieOptions() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1/admin',
    maxAge: Number(env.STAFF_SESSION_TTL_HOURS) * 60 * 60 * 1000,
  };
}

function setStaffCookie(res, token) {
  res.cookie(env.STAFF_SESSION_COOKIE_NAME, token, staffCookieOptions());
}

function clearStaffCookie(res) {
  res.clearCookie(env.STAFF_SESSION_COOKIE_NAME, { path: '/api/v1/admin' });
}

const loginSchema = z.object({
  email: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(200),
});

export async function login(req, res, next) {
  try {
    const payload = loginSchema.parse(req.body);
    const result = await staffAuthService.login({
      email: payload.email,
      password: payload.password,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      requestId: req.id,
    });
    setStaffCookie(res, result.token);
    // Token travels only via the HttpOnly cookie — never in the JSON body.
    respond(res, { staff: result.staff });
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    await staffAuthService.logout({
      session: req.staffSession,
      staff: req.staff,
      ip: req.ip,
      requestId: req.id,
    });
    clearStaffCookie(res);
    respond(res, { loggedOut: true });
  } catch (err) {
    next(err);
  }
}

export async function me(req, res) {
  // Multi-company (DESIGN.md §6) — accessibleBrands/currentBrand come from
  // resolveBrandContext (mounted ahead of this route); req.brandId /
  // req.accessibleBrands are already resolved, so this is just a reshape,
  // no extra query.
  const accessibleBrands = (req.accessibleBrands || []).map((row) => staffAuthService.toBrandDto(row));
  const currentBrand = req.brand ? staffAuthService.toBrandDto(req.brand) : null;
  // A staff member with access to more than one company must explicitly
  // choose which one they're working in for THIS session before the CMS
  // shell renders — `resolveBrandContext` still resolves a best-effort
  // `req.brand` (falling back to the default brand) so backend scoping
  // always has a candidate, but that fallback must never stand in for an
  // actual choice at the UI layer. One accessible brand needs no choice.
  // Gated by COMPANY_SELECTION_REQUIRED (default off, see env.js) — right
  // now only Cor-Cotton has real content, so the forced prompt is pure
  // friction; the sidebar switcher stays available regardless.
  const companySelectionRequired = env.COMPANY_SELECTION_REQUIRED
    && accessibleBrands.length > 1 && !req.staffSession?.current_brand_id;
  respond(res, { staff: req.staff, accessibleBrands, currentBrand, companySelectionRequired });
}

const switchBrandSchema = z.object({
  brandId: z.string().trim().min(1),
});

export async function switchBrand(req, res, next) {
  try {
    const payload = switchBrandSchema.parse(req.body);
    const result = await staffAuthService.switchBrand({
      staff: req.staff,
      session: req.staffSession,
      brandId: payload.brandId,
    });
    respond(res, result);
  } catch (err) {
    next(err);
  }
}

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

// Authenticated: a staff member setting their own password (first-login forced
// change, or any voluntary change). Rotates the session — a fresh cookie is set.
export async function changePassword(req, res, next) {
  try {
    const payload = changePasswordSchema.parse(req.body);
    const result = await staffAuthService.changeOwnPassword({
      staffId: req.staff.id,
      currentPassword: payload.currentPassword,
      newPassword: payload.newPassword,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || '',
      requestId: req.id,
    });
    setStaffCookie(res, result.token);
    respond(res, { staff: result.staff });
  } catch (err) {
    next(err);
  }
}

export async function listStaff(req, res, next) {
  try {
    const staff = await staffAuthService.listStaff();
    respond(res, { staff });
  } catch (err) {
    next(err);
  }
}

// ---- User Management (Settings > User Management, Phase 6) --------------

const actorOf = (req) => ({ id: req.staff?.id, email: req.staff?.email, role: req.staff?.role });

const createStaffSchema = z.object({
  email: z.string().trim().min(1).max(255),
  password: z.string().min(1).max(200),
  firstName: z.string().trim().min(1).max(120),
  lastName: z.string().trim().min(1).max(120),
  role: z.string().trim().min(1),
});

export async function createStaff(req, res, next) {
  try {
    const payload = createStaffSchema.parse(req.body ?? {});
    const created = await staffAuthService.createStaffUser({
      ...payload, actor: actorOf(req), mustChangePassword: true,
    });
    respond(res, { staff: created }, 201);
  } catch (err) { next(err); }
}

const setStatusSchema = z.object({ status: z.enum(['ACTIVE', 'DISABLED']) });

export async function setStaffStatus(req, res, next) {
  try {
    const { status } = setStatusSchema.parse(req.body ?? {});
    const updated = await staffAuthService.setStatus({
      staffUserId: req.params.id, status, actor: actorOf(req), requestId: req.id, ip: req.ip,
    });
    respond(res, { staff: updated });
  } catch (err) { next(err); }
}

const changeRoleSchema = z.object({ role: z.string().trim().min(1) });

export async function changeStaffRole(req, res, next) {
  try {
    const { role } = changeRoleSchema.parse(req.body ?? {});
    const updated = await staffAuthService.changeRole({
      staffUserId: req.params.id, role, actor: actorOf(req), requestId: req.id, ip: req.ip,
    });
    respond(res, { staff: updated });
  } catch (err) { next(err); }
}

const resetPasswordSchema = z.object({
  email: z.string().trim().min(1).max(255),
  newPassword: z.string().min(1).max(200),
});

export async function resetStaffPassword(req, res, next) {
  try {
    const payload = resetPasswordSchema.parse(req.body ?? {});
    const updated = await staffAuthService.resetPassword({
      ...payload, actor: actorOf(req), requestId: req.id, ip: req.ip,
    });
    respond(res, { staff: updated });
  } catch (err) { next(err); }
}

export async function getStaffBrandAccess(req, res, next) {
  try {
    const access = await staffAuthService.listBrandAccess(req.params.id);
    respond(res, { access });
  } catch (err) { next(err); }
}

const grantBrandAccessSchema = z.object({
  role: z.string().trim().min(1),
  permissionOverrides: z.object({
    grant: z.array(z.string()).optional(),
    revoke: z.array(z.string()).optional(),
  }).nullable().optional(),
});

export async function grantStaffBrandAccess(req, res, next) {
  try {
    const payload = grantBrandAccessSchema.parse(req.body ?? {});
    const access = await staffAuthService.grantBrandAccess({
      staffUserId: req.params.id, brandId: req.params.brandId,
      role: payload.role, permissionOverrides: payload.permissionOverrides ?? null,
      actor: actorOf(req), requestId: req.id, ip: req.ip,
    });
    respond(res, { access });
  } catch (err) { next(err); }
}

export async function revokeStaffBrandAccess(req, res, next) {
  try {
    const result = await staffAuthService.revokeBrandAccess({
      staffUserId: req.params.id, brandId: req.params.brandId, actor: actorOf(req), requestId: req.id, ip: req.ip,
    });
    respond(res, result);
  } catch (err) { next(err); }
}
