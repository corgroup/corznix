import crypto from 'node:crypto';
import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { normalizeEmail } from '../../utils/normalize.js';
import { hashToken, toMysqlDateTime } from '../../utils/otpCrypto.js';
import {
  hashPassword,
  verifyPassword,
  dummyVerify,
  validateStaffPassword,
} from '../../utils/password.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { companyRepository } from '../company/repository.js';
import { companyService } from '../company/service.js';
import { defaultBrandId } from '../../utils/defaultBrand.js';
import { isValidRole, isValidPermission, resolvePermissions, STAFF_ROLES } from './permissions.js';
import { StaffUserRepository, StaffSessionRepository, StaffAuditRepository, StaffBrandAccessRepository } from './repositories.js';

// Roles an ADMIN actor may never create, grant, or manage — the role ceiling.
const ADMIN_CEILING_ROLES = new Set(['SUPER_ADMIN', 'ADMIN']);

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// A single generic authentication failure for every unsuccessful login
// reason (unknown email, wrong password, disabled account) — no
// account-existence or account-state leak (Wave 8A brief §26/§60).
function genericAuthFailure() {
  return new AppError('STAFF_AUTH_FAILED', 'Invalid email or password.', 401);
}

export class StaffAuthService {
  constructor({ staffUserRepository, staffSessionRepository, staffAuditRepository, staffBrandAccessRepository } = {}) {
    this.staffUsers = staffUserRepository || new StaffUserRepository();
    this.staffSessions = staffSessionRepository || new StaffSessionRepository();
    this.audit = staffAuditRepository || new StaffAuditRepository();
    this.brandAccess = staffBrandAccessRepository || new StaffBrandAccessRepository();
  }

  /** Safe, client-facing shape for a staff user. Never exposes password_hash. */
  toProfile(staff) {
    return {
      id: staff.id,
      email: staff.email,
      firstName: staff.first_name,
      lastName: staff.last_name,
      role: staff.role,
      status: staff.status,
      permissions: resolvePermissions(staff.role),
      mustChangePassword: Boolean(staff.must_change_password),
      lastLoginAt: staff.last_login_at ? new Date(staff.last_login_at).toISOString() : null,
    };
  }

  /** Safe, client-facing shape for a brand row (accessible-brands / current-brand). */
  toBrandDto(brand) {
    if (!brand) return null;
    return {
      id: brand.id,
      slug: brand.slug,
      name: brand.display_name || brand.name,
      logoMediaId: brand.logo_media_id || null,
      iconSvg: brand.icon_svg || null,
      theme: brand.theme_json ? (typeof brand.theme_json === 'string' ? JSON.parse(brand.theme_json) : brand.theme_json) : null,
      storefrontUrl: brand.storefront_url || null,
      supportEmail: brand.support_email || null,
      isDefault: Boolean(brand.is_default),
      role: brand.access_role || null,
    };
  }

  // --- multi-company (implementation/multi-company/DESIGN.md) — Phase 2 ---

  /** Every brand a staff member may act on, each carrying their per-company role. */
  async accessibleBrandsForStaff(staff) {
    const rows = await this.brandAccess.accessibleBrandsForStaff(staff.id, staff.role);
    return rows.map((row) => this.toBrandDto(row));
  }

  /**
   * Resolve the session's current company: `session.current_brand_id` if it
   * is still one of the staff member's accessible brands, else the brand
   * marked `is_default`, else the first accessible brand, else null (zero
   * accessible brands — a staff member with no grants and not SUPER_ADMIN).
   */
  async currentBrandForSession(staff, session, accessibleBrands = null) {
    const accessible = accessibleBrands || (await this.accessibleBrandsForStaff(staff));
    if (!accessible.length) return null;
    const bySession = session?.current_brand_id
      ? accessible.find((b) => b.id === session.current_brand_id)
      : null;
    return bySession || accessible.find((b) => b.isDefault) || accessible[0];
  }

  /**
   * The company switcher. A SUPER_ADMIN may switch to any active brand; any
   * other staff member only to a brand they hold an explicit
   * `staff_brand_access` grant for — 403 BRAND_ACCESS_DENIED otherwise
   * (deny by default, never inferred).
   */
  async switchBrand({ staff, session, brandId }) {
    const accessible = await this.accessibleBrandsForStaff(staff);
    const target = accessible.find((b) => b.id === brandId);
    if (!target) {
      throw new AppError('BRAND_ACCESS_DENIED', 'You do not have access to this company.', 403);
    }
    await this.staffSessions.setCurrentBrand(session.id, brandId);
    return { currentBrand: target, accessibleBrands: accessible };
  }

  // --- provisioning (CLI bootstrap + future SUPER_ADMIN-gated management) ---

  async createStaffUser({ email, password, firstName, lastName, role, actor = null, mustChangePassword = false }) {
    const normalized = normalizeEmail(email);
    if (!EMAIL_SHAPE.test(normalized)) {
      throw new AppError('VALIDATION_ERROR', 'Enter a valid email address.', 400);
    }
    if (!isValidRole(role)) {
      throw new AppError('VALIDATION_ERROR', `Role must be one of: ${['SUPER_ADMIN', 'ADMIN', 'CATALOG_MANAGER', 'OPERATIONS', 'SUPPORT', 'VIEWER'].join(', ')}.`, 400);
    }

    // An ADMIN actor may create ordinary staff only — never another ADMIN or a SUPER_ADMIN.
    if (actor?.role === 'ADMIN' && ADMIN_CEILING_ROLES.has(role)) {
      throw new AppError('ROLE_CEILING_EXCEEDED', 'An ADMIN cannot create ADMIN or SUPER_ADMIN accounts.', 403);
    }
    // Governance: one active SUPER_ADMIN (the company owner). SUPER_ADMIN can
    // only be minted while none exists — the bootstrap window.
    if (role === 'SUPER_ADMIN') {
      const activeSuperAdmins = await this.staffUsers.countActiveByRole('SUPER_ADMIN');
      if (activeSuperAdmins > 0 || await companyService.hasOwner()) {
        throw new AppError('SUPER_ADMIN_EXISTS', 'A company owner (SUPER_ADMIN) already exists. There can only be one.', 409);
      }
    }

    const policy = validateStaffPassword(password);
    if (!policy.ok) {
      throw new AppError('WEAK_PASSWORD', policy.message, 400);
    }
    const first = String(firstName || '').trim();
    const last = String(lastName || '').trim();
    if (!first || !last) {
      throw new AppError('VALIDATION_ERROR', 'First and last name are required.', 400);
    }

    const existing = await this.staffUsers.findByEmailNormalized(normalized);
    if (existing) {
      throw new AppError('STAFF_EMAIL_EXISTS', 'A staff account with this email already exists.', 409);
    }

    const created = await this.staffUsers.create({
      email: String(email).trim(),
      emailNormalized: normalized,
      passwordHash: hashPassword(password),
      // Provisioned accounts get a temporary password and must set their own
      // on first login (the SUPER_ADMIN bootstrap owner is exempt — they chose
      // their password at `staff:create` time and there is no one above them).
      mustChangePassword: role === 'SUPER_ADMIN' ? false : mustChangePassword,
      firstName: first,
      lastName: last,
      role,
    });

    // Bootstrap: the first SUPER_ADMIN becomes the company owner.
    if (role === 'SUPER_ADMIN' && !(await companyService.hasOwner())) {
      const ownerBrandId = await defaultBrandId();
      await withTransaction((connection) => companyRepository.setOwner(connection, ownerBrandId, created.id));
    }

    // Multi-company (DESIGN.md §3.2) — SUPER_ADMIN needs no grant (implicit
    // access to every brand). Everyone else gets an explicit grant to the
    // default brand on creation, matching their staff_users.role, so
    // provisioning a new staff member keeps working exactly like it did
    // before multi-company existed — real per-company assignment is a
    // Phase 6 UI concern (staff_brand_access.grant is already there for it),
    // not something CLI/API provisioning should have to know about yet.
    // `grantedBy` is deliberately null here (a system default, not a
    // deliberate human grant) — NOT `actor?.id`, which some callers
    // (role-ceiling tests, scripted actors) set to an id with no matching
    // staff_users row; `granted_by` FK-references that table, and this
    // grant must never fail (leaving the new staff member with no access
    // at all) just because the creating actor wasn't a real persisted row.
    if (role !== 'SUPER_ADMIN') {
      const defaultBrandId = await this.brandAccess.defaultBrand();
      if (defaultBrandId) {
        await this.brandAccess.grant({ staffUserId: created.id, brandId: defaultBrandId, role, grantedBy: null });
      }
    }
    return created;
  }

  async resetPassword({ email, newPassword, actor = null, requestId = null, ip = null }) {
    const normalized = normalizeEmail(email);
    const staff = normalized ? await this.staffUsers.findByEmailNormalized(normalized) : null;
    if (!staff) throw new AppError('NOT_FOUND', 'No staff account with that email.', 404);
    // Same role ceiling as create/status/role — an ADMIN actor may reset an
    // ordinary staff member's password, never an ADMIN or SUPER_ADMIN's.
    if (actor?.role === 'ADMIN' && ADMIN_CEILING_ROLES.has(staff.role)) {
      throw new AppError('ROLE_CEILING_EXCEEDED', 'An ADMIN cannot reset an ADMIN or SUPER_ADMIN account’s password.', 403);
    }

    const policy = validateStaffPassword(newPassword);
    if (!policy.ok) throw new AppError('WEAK_PASSWORD', policy.message, 400);

    // An administrative reset installs a temporary password — the staff member
    // must set their own on next login. The SUPER_ADMIN owner is exempt (there
    // is no one above them; they run the CLI themselves).
    const forceChange = staff.role !== 'SUPER_ADMIN';
    await this.staffUsers.setPasswordHash(staff.id, hashPassword(newPassword), { clearMustChange: !forceChange });
    if (forceChange) await this.staffUsers.setMustChangePassword(staff.id, true);
    // A password change invalidates every existing session for that account.
    await this.staffSessions.revokeAllForStaff(staff.id);
    await this.audit.log({
      staffUserId: staff.id,
      actorEmail: actor?.email || staff.email,
      action: 'STAFF_PASSWORD_RESET',
      resourceType: 'staff_user',
      resourceId: staff.id,
      requestId,
      ipAddress: ip,
    });
    return this.staffUsers.findById(staff.id);
  }

  /**
   * A staff member setting their OWN password — the first-login forced-change
   * flow, and any voluntary change. Verifies the current password, enforces
   * the policy + "different from current", clears must_change_password, and
   * rotates every session (a fresh one is issued for the caller).
   */
  async changeOwnPassword({ staffId, currentPassword, newPassword, ip = null, userAgent = null, requestId = null }) {
    const staff = await this.staffUsers.findById(staffId);
    if (!staff || staff.status !== 'ACTIVE') throw new AppError('AUTH_REQUIRED', 'Your staff session is no longer valid.', 401);

    if (!verifyPassword(String(currentPassword || ''), staff.password_hash)) {
      await this.safeAuditFailure({ staffUserId: staff.id, actorEmail: staff.email, reason: 'BAD_CURRENT_PASSWORD', ip, requestId });
      throw new AppError('CURRENT_PASSWORD_INCORRECT', 'Your current password is incorrect.', 400);
    }
    const policy = validateStaffPassword(newPassword);
    if (!policy.ok) throw new AppError('WEAK_PASSWORD', policy.message, 400);
    if (verifyPassword(String(newPassword), staff.password_hash)) {
      throw new AppError('PASSWORD_UNCHANGED', 'Choose a new password that is different from your current one.', 400);
    }

    await this.staffUsers.setPasswordHash(staff.id, hashPassword(String(newPassword)), { clearMustChange: true });
    await this.staffSessions.revokeAllForStaff(staff.id);
    await this.audit.log({
      staffUserId: staff.id, actorEmail: staff.email, action: 'STAFF_PASSWORD_CHANGED',
      resourceType: 'staff_user', resourceId: staff.id, requestId, ipAddress: ip,
    });
    const { token } = await this.issueSession(await this.staffUsers.findById(staff.id), { ip, userAgent });
    return { token, staff: this.toProfile(await this.staffUsers.findById(staff.id)) };
  }

  async setStatus({ staffUserId, status, actor, requestId, ip }) {
    if (!['ACTIVE', 'DISABLED'].includes(status)) {
      throw new AppError('VALIDATION_ERROR', 'Status must be ACTIVE or DISABLED.', 400);
    }
    const staff = await this.staffUsers.findById(staffUserId);
    if (!staff) throw new AppError('NOT_FOUND', 'Staff user not found.', 404);

    if (status === 'DISABLED' && await companyService.isOwner(staffUserId)) {
      throw new AppError('OWNER_MODIFICATION_FORBIDDEN', 'The company owner account cannot be disabled through staff management.', 403);
    }
    if (actor?.role === 'ADMIN' && ADMIN_CEILING_ROLES.has(staff.role)) {
      throw new AppError('ROLE_CEILING_EXCEEDED', 'An ADMIN cannot manage ADMIN or SUPER_ADMIN accounts.', 403);
    }

    const updated = await this.staffUsers.setStatus(staffUserId, status);
    if (status === 'DISABLED') {
      // A disabled account must lose access immediately, not at token
      // expiry — kill every live session now (Wave 8A brief §12/§23).
      await this.staffSessions.revokeAllForStaff(staffUserId);
      await this.audit.log({
        staffUserId,
        actorEmail: actor?.email || null,
        action: 'STAFF_ACCOUNT_DISABLED',
        resourceType: 'staff_user',
        resourceId: staffUserId,
        requestId,
        ipAddress: ip,
      });
    }
    return updated;
  }

  async changeRole({ staffUserId, role, actor, requestId, ip }) {
    if (!isValidRole(role)) throw new AppError('VALIDATION_ERROR', 'Invalid role.', 400);
    const staff = await this.staffUsers.findById(staffUserId);
    if (!staff) throw new AppError('NOT_FOUND', 'Staff user not found.', 404);
    const previousRole = staff.role;

    // No promotion path to SUPER_ADMIN — ownership transfer is a dedicated,
    // owner-authorised flow, not an ordinary role change.
    if (role === 'SUPER_ADMIN' && previousRole !== 'SUPER_ADMIN') {
      throw new AppError('SUPER_ADMIN_ROLE_LOCKED', 'SUPER_ADMIN cannot be granted through role management.', 403);
    }
    // The company owner's role is immutable here (can't be demoted away).
    if (previousRole === 'SUPER_ADMIN' && role !== 'SUPER_ADMIN' && await companyService.isOwner(staffUserId)) {
      throw new AppError('OWNER_MODIFICATION_FORBIDDEN', 'The company owner cannot be demoted through staff management.', 403);
    }
    // ADMIN actors cannot touch the ADMIN/SUPER_ADMIN tier at all.
    if (actor?.role === 'ADMIN' && (ADMIN_CEILING_ROLES.has(role) || ADMIN_CEILING_ROLES.has(previousRole))) {
      throw new AppError('ROLE_CEILING_EXCEEDED', 'An ADMIN cannot grant or change ADMIN / SUPER_ADMIN roles.', 403);
    }

    const updated = await this.staffUsers.setRole(staffUserId, role);
    await this.audit.log({
      staffUserId,
      actorEmail: actor?.email || null,
      action: 'STAFF_ROLE_CHANGED',
      resourceType: 'staff_user',
      resourceId: staffUserId,
      metadata: { from: previousRole, to: role },
      requestId,
      ipAddress: ip,
    });
    return updated;
  }

  async listStaff() {
    const rows = await this.staffUsers.list();
    return rows.map((row) => ({
      id: row.id,
      email: row.email,
      firstName: row.first_name,
      lastName: row.last_name,
      role: row.role,
      status: row.status,
      lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
      createdAt: new Date(row.created_at).toISOString(),
    }));
  }

  // --- multi-company: per-staff company access (DESIGN.md §6, Phase 6) ----
  // staff_brand_access.grant/revoke/accessibleBrandsForStaff have existed
  // since Phase 1/2 (the switcher already reads them) — this is the first
  // time granting/revoking is exposed at all, via the Settings > User
  // Management UI this phase builds.

  toBrandAccessDto(row) {
    return {
      brandId: row.id,
      brandSlug: row.slug,
      brandName: row.display_name || row.name,
      role: row.access_role,
      permissionOverrides: row.access_overrides
        ? (typeof row.access_overrides === 'string' ? JSON.parse(row.access_overrides) : row.access_overrides)
        : null,
      // SUPER_ADMIN's access is implicit (DESIGN.md §3.2) — never a real
      // staff_brand_access row, so there is nothing to revoke or edit.
      implicit: row.access_role === 'SUPER_ADMIN',
    };
  }

  /** Every company this staff member can act on, with their per-company role. */
  async listBrandAccess(staffUserId) {
    const staff = await this.staffUsers.findById(staffUserId);
    if (!staff) throw new AppError('NOT_FOUND', 'Staff user not found.', 404);
    const rows = await this.brandAccess.accessibleBrandsForStaff(staffUserId, staff.role);
    return rows.map((row) => this.toBrandAccessDto(row));
  }

  #assertValidOverrides(overrides) {
    if (overrides == null) return;
    if (typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new AppError('VALIDATION_ERROR', 'permissionOverrides must be an object with grant/revoke arrays.', 400);
    }
    for (const key of ['grant', 'revoke']) {
      const list = overrides[key];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((p) => typeof p !== 'string' || !isValidPermission(p))) {
        throw new AppError('VALIDATION_ERROR', `permissionOverrides.${key} must be an array of known permission strings.`, 400);
      }
    }
  }

  /** Grant (or update) a staff member's role + optional permission overrides for one company. */
  async grantBrandAccess({ staffUserId, brandId, role, permissionOverrides = null, actor = null, requestId = null, ip = null }) {
    const staff = await this.staffUsers.findById(staffUserId);
    if (!staff) throw new AppError('NOT_FOUND', 'Staff user not found.', 404);
    if (staff.role === 'SUPER_ADMIN') {
      throw new AppError('SUPER_ADMIN_IMPLICIT_ACCESS', 'SUPER_ADMIN already has access to every company — no explicit grant is needed or possible.', 409);
    }
    if (!STAFF_ROLES.includes(role) || role === 'SUPER_ADMIN') {
      throw new AppError('VALIDATION_ERROR', `role must be one of: ${STAFF_ROLES.filter((r) => r !== 'SUPER_ADMIN').join(', ')}.`, 400);
    }
    if (actor?.role === 'ADMIN' && ADMIN_CEILING_ROLES.has(role)) {
      throw new AppError('ROLE_CEILING_EXCEEDED', 'An ADMIN cannot grant ADMIN-tier company access.', 403);
    }
    this.#assertValidOverrides(permissionOverrides);

    const before = await this.brandAccess.findAccess(staffUserId, brandId);
    const result = await this.brandAccess.grant({ staffUserId, brandId, role, grantedBy: actor?.id || null, permissionOverrides });
    await this.audit.log({
      staffUserId, actorEmail: actor?.email || null,
      action: before ? 'STAFF_BRAND_ACCESS_UPDATED' : 'STAFF_BRAND_ACCESS_GRANTED',
      resourceType: 'staff_brand_access', resourceId: `${staffUserId}:${brandId}`,
      metadata: { brandId, role, permissionOverrides }, requestId, ipAddress: ip,
    });
    return result;
  }

  /** Revoke a staff member's access to one company. */
  async revokeBrandAccess({ staffUserId, brandId, actor = null, requestId = null, ip = null }) {
    const staff = await this.staffUsers.findById(staffUserId);
    if (!staff) throw new AppError('NOT_FOUND', 'Staff user not found.', 404);
    if (staff.role === 'SUPER_ADMIN') {
      throw new AppError('SUPER_ADMIN_IMPLICIT_ACCESS', 'SUPER_ADMIN access is implicit and cannot be revoked per-company.', 409);
    }
    if (actor?.role === 'ADMIN' && ADMIN_CEILING_ROLES.has(staff.role)) {
      throw new AppError('ROLE_CEILING_EXCEEDED', 'An ADMIN cannot manage ADMIN or SUPER_ADMIN accounts.', 403);
    }
    const removed = await this.brandAccess.revoke(staffUserId, brandId);
    if (!removed) throw new AppError('NOT_FOUND', 'This staff member has no access grant for that company.', 404);
    await this.audit.log({
      staffUserId, actorEmail: actor?.email || null, action: 'STAFF_BRAND_ACCESS_REVOKED',
      resourceType: 'staff_brand_access', resourceId: `${staffUserId}:${brandId}`, requestId, ipAddress: ip,
    });
    return { revoked: true };
  }

  // --- authentication ------------------------------------------------------

  async login({ email, password, ip, userAgent, requestId }) {
    const normalized = normalizeEmail(email);
    const staff = normalized ? await this.staffUsers.findByEmailNormalized(normalized) : null;

    if (!staff) {
      // Equalise timing against the "found" path, then fail generically.
      dummyVerify(String(password || ''));
      await this.safeAuditFailure({ actorEmail: normalized, reason: 'UNKNOWN_EMAIL', ip, requestId });
      throw genericAuthFailure();
    }

    const passwordOk = verifyPassword(String(password || ''), staff.password_hash);
    if (!passwordOk) {
      await this.safeAuditFailure({
        staffUserId: staff.id,
        actorEmail: normalized,
        reason: 'BAD_PASSWORD',
        ip,
        requestId,
      });
      throw genericAuthFailure();
    }

    if (staff.status !== 'ACTIVE') {
      await this.safeAuditFailure({
        staffUserId: staff.id,
        actorEmail: normalized,
        reason: 'ACCOUNT_DISABLED',
        ip,
        requestId,
      });
      throw genericAuthFailure();
    }

    const { token } = await this.issueSession(staff, { ip, userAgent });
    await this.staffUsers.markLoggedIn(staff.id);
    await this.audit.log({
      staffUserId: staff.id,
      actorEmail: staff.email,
      action: 'STAFF_LOGIN_SUCCESS',
      resourceType: 'staff_session',
      metadata: { role: staff.role },
      ipAddress: ip,
      requestId,
    });

    const fresh = await this.staffUsers.findById(staff.id);
    return { token, staff: this.toProfile(fresh) };
  }

  async issueSession(staff, { ip, userAgent } = {}) {
    // Opaque, high-entropy, single value. Only its SHA-256 is stored; the
    // raw token lives only in the HttpOnly cookie.
    const token = crypto.randomBytes(48).toString('base64url');
    const ttlMs = Number(env.STAFF_SESSION_TTL_HOURS) * 60 * 60 * 1000;
    await this.staffSessions.create({
      staffUserId: staff.id,
      tokenHash: hashToken(token),
      expiresAt: toMysqlDateTime(new Date(Date.now() + ttlMs)),
      ipAddress: ip,
      userAgent,
    });
    return { token };
  }

  /**
   * Server-authoritative session validation, run on every /api/v1/admin/*
   * request. A raw cookie value alone is never trusted:
   *  - unknown / non-ACTIVE session          -> 401
   *  - past absolute expiry                   -> 401 (+ mark EXPIRED)
   *  - idle longer than the idle timeout      -> 401 (+ mark EXPIRED)
   *  - owning staff account not ACTIVE        -> 403 (+ revoke session)
   */
  async validateSession(rawToken, { ip, userAgent } = {}) {
    void ip;
    void userAgent;
    const token = String(rawToken || '');
    if (!token) throw new AppError('AUTH_REQUIRED', 'Staff authentication required.', 401);

    // token_hash carries a UNIQUE index — an exact-match lookup on the
    // SHA-256 of the presented token is the authority here.
    const session = await this.staffSessions.findActiveByTokenHash(hashToken(token));
    if (!session) {
      throw new AppError('AUTH_REQUIRED', 'Your staff session is no longer valid.', 401);
    }

    const now = Date.now();
    if (new Date(session.expires_at).getTime() <= now) {
      await this.staffSessions.expire(session.id);
      throw new AppError('SESSION_EXPIRED', 'Your staff session has expired.', 401);
    }

    const idleMs = Number(env.STAFF_SESSION_IDLE_TIMEOUT_MINUTES) * 60 * 1000;
    if (idleMs > 0 && now - new Date(session.last_seen_at).getTime() > idleMs) {
      await this.staffSessions.expire(session.id);
      throw new AppError('SESSION_EXPIRED', 'Your staff session has expired due to inactivity.', 401);
    }

    const staff = await this.staffUsers.findById(session.staff_user_id);
    if (!staff) {
      await this.staffSessions.revoke(session.id);
      throw new AppError('AUTH_REQUIRED', 'Your staff session is no longer valid.', 401);
    }
    if (staff.status !== 'ACTIVE') {
      await this.staffSessions.revoke(session.id);
      throw new AppError('STAFF_ACCOUNT_DISABLED', 'This staff account has been disabled.', 403);
    }

    await this.staffSessions.touch(session.id);
    return { staff: this.toProfile(staff), session };
  }

  async logout({ session, staff, ip, requestId }) {
    if (session?.id) {
      await this.staffSessions.revoke(session.id);
    }
    await this.audit.log({
      staffUserId: staff?.id || null,
      actorEmail: staff?.email || null,
      action: 'STAFF_LOGOUT',
      resourceType: 'staff_session',
      resourceId: session?.id || null,
      ipAddress: ip,
      requestId,
    });
  }

  async safeAuditFailure({ staffUserId = null, actorEmail = null, reason, ip, requestId }) {
    try {
      await this.audit.log({
        staffUserId,
        actorEmail,
        action: 'STAFF_LOGIN_FAILURE',
        resourceType: 'staff_session',
        metadata: { reason },
        ipAddress: ip,
        requestId,
      });
    } catch {
      // Auditing a failed login must never turn into a 500 on the login
      // path itself.
    }
  }
}

export const staffAuthService = new StaffAuthService();
