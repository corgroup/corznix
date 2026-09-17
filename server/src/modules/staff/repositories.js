// Data access for the staff/admin identity domain. Same conventions as
// modules/customers/repositories.js — `query()` returns rows directly,
// ids are `crypto.randomUUID()`, timestamps are SQL NOW() (UTC pool).
import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

export class StaffUserRepository {
  async create({ email, emailNormalized, passwordHash, firstName, lastName, role, mustChangePassword = false }) {
    const id = randomUUID();
    try {
      await query(
        `INSERT INTO staff_users
           (id, email, email_normalized, password_hash, must_change_password, first_name, last_name, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(), NOW())`,
        [id, email, emailNormalized, passwordHash, mustChangePassword ? 1 : 0, firstName, lastName, role]
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        throw new AppError('STAFF_EMAIL_EXISTS', 'A staff account with this email already exists.', 409);
      }
      throw err;
    }
    return this.findById(id);
  }

  async findById(id) {
    const rows = await query('SELECT * FROM staff_users WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findByEmailNormalized(emailNormalized) {
    const rows = await query('SELECT * FROM staff_users WHERE email_normalized = ? LIMIT 1', [emailNormalized]);
    return rows[0] || null;
  }

  async markLoggedIn(id) {
    await query('UPDATE staff_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = ?', [id]);
  }

  async setPasswordHash(id, passwordHash, { clearMustChange = true } = {}) {
    await query(
      `UPDATE staff_users SET password_hash = ?${clearMustChange ? ', must_change_password = 0' : ''}, updated_at = NOW() WHERE id = ?`,
      [passwordHash, id],
    );
    return this.findById(id);
  }

  async setStatus(id, status) {
    await query('UPDATE staff_users SET status = ?, updated_at = NOW() WHERE id = ?', [status, id]);
    return this.findById(id);
  }

  async setMustChangePassword(id, value) {
    await query('UPDATE staff_users SET must_change_password = ?, updated_at = NOW() WHERE id = ?', [value ? 1 : 0, id]);
    return this.findById(id);
  }

  async setRole(id, role) {
    await query('UPDATE staff_users SET role = ?, updated_at = NOW() WHERE id = ?', [role, id]);
    return this.findById(id);
  }

  async list() {
    return query(
      `SELECT id, email, first_name, last_name, role, status, last_login_at, created_at
         FROM staff_users ORDER BY created_at ASC`
    );
  }

  async countActiveByRole(role) {
    const rows = await query(
      "SELECT COUNT(*) AS n FROM staff_users WHERE role = ? AND status = 'ACTIVE'",
      [role]
    );
    return Number(rows[0]?.n || 0);
  }
}

export class StaffWarehouseAssignmentRepository {
  async assign(staffUserId, warehouseId) {
    try {
      await query(
        'INSERT INTO staff_warehouse_assignments (id, staff_user_id, warehouse_id) VALUES (?, ?, ?)',
        [randomUUID(), staffUserId, warehouseId],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return; // already assigned — idempotent
      throw err;
    }
  }

  async unassign(staffUserId, warehouseId) {
    const result = await query(
      'DELETE FROM staff_warehouse_assignments WHERE staff_user_id = ? AND warehouse_id = ?',
      [staffUserId, warehouseId],
    );
    return result.affectedRows > 0;
  }

  /** Warehouse ids a staff member is scoped to (empty = unscoped in the data sense). */
  async warehouseIdsForStaff(staffUserId) {
    const rows = await query(
      'SELECT warehouse_id FROM staff_warehouse_assignments WHERE staff_user_id = ?',
      [staffUserId],
    );
    return rows.map((row) => row.warehouse_id);
  }

  async listForStaff(staffUserId) {
    return query(
      `SELECT swa.warehouse_id, w.code, w.name, w.status
         FROM staff_warehouse_assignments swa
         JOIN warehouses w ON w.id = swa.warehouse_id
        WHERE swa.staff_user_id = ?
        ORDER BY w.priority, w.name`,
      [staffUserId],
    );
  }

  async staffForWarehouse(warehouseId) {
    return query(
      `SELECT su.id, su.email, su.first_name, su.last_name, su.role, su.status
         FROM staff_warehouse_assignments swa
         JOIN staff_users su ON su.id = swa.staff_user_id
        WHERE swa.warehouse_id = ?
        ORDER BY su.created_at`,
      [warehouseId],
    );
  }
}

export class StaffSessionRepository {
  async create({ staffUserId, tokenHash, expiresAt, ipAddress, userAgent }) {
    const id = randomUUID();
    await query(
      `INSERT INTO staff_sessions
         (id, staff_user_id, token_hash, status, created_at, expires_at, last_seen_at, ip_address, user_agent)
       VALUES (?, ?, ?, 'ACTIVE', NOW(), ?, NOW(), ?, ?)`,
      [id, staffUserId, tokenHash, expiresAt, ipAddress || null, (userAgent || '').slice(0, 512) || null]
    );
    return this.findById(id);
  }

  async findById(id) {
    const rows = await query('SELECT * FROM staff_sessions WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findActiveByTokenHash(tokenHash) {
    const rows = await query(
      "SELECT * FROM staff_sessions WHERE token_hash = ? AND status = 'ACTIVE' LIMIT 1",
      [tokenHash]
    );
    return rows[0] || null;
  }

  async touch(id) {
    await query('UPDATE staff_sessions SET last_seen_at = NOW() WHERE id = ?', [id]);
  }

  async expire(id) {
    await query("UPDATE staff_sessions SET status = 'EXPIRED', revoked_at = NOW() WHERE id = ? AND status = 'ACTIVE'", [id]);
  }

  async revoke(id) {
    await query("UPDATE staff_sessions SET status = 'REVOKED', revoked_at = NOW() WHERE id = ? AND status = 'ACTIVE'", [id]);
  }

  async revokeAllForStaff(staffUserId) {
    await query(
      "UPDATE staff_sessions SET status = 'REVOKED', revoked_at = NOW() WHERE staff_user_id = ? AND status = 'ACTIVE'",
      [staffUserId]
    );
  }

  // Multi-company Phase 2 — the switcher's write path.
  async setCurrentBrand(id, brandId) {
    await query('UPDATE staff_sessions SET current_brand_id = ? WHERE id = ?', [brandId, id]);
  }
}

// Multi-company CMS (DESIGN.md §3.2) — per-staff, per-company access grants.
// SUPER_ADMIN carries no rows here by design: implicit access to every
// active brand, never inferred from a row's absence for anyone else.
export class StaffBrandAccessRepository {
  /**
   * The brands a staff member may act on, each carrying their effective
   * per-company role (`access_role`). SUPER_ADMIN sees every active brand
   * with SUPER_ADMIN as the access role; everyone else sees only brands
   * they hold an explicit `staff_brand_access` grant for.
   */
  async accessibleBrandsForStaff(staffUserId, role) {
    if (role === 'SUPER_ADMIN') {
      return query(
        `SELECT b.id, b.slug, b.name, b.display_name, b.logo_media_id, b.icon_svg,
                b.theme_json, b.storefront_url, b.support_email, b.is_default,
                'SUPER_ADMIN' AS access_role, NULL AS access_overrides
           FROM brands b
          WHERE b.status = 'active'
          ORDER BY b.is_default DESC, b.display_name`
      );
    }
    return query(
      `SELECT b.id, b.slug, b.name, b.display_name, b.logo_media_id, b.icon_svg,
              b.theme_json, b.storefront_url, b.support_email, b.is_default,
              sba.role AS access_role, sba.permission_overrides_json AS access_overrides
         FROM staff_brand_access sba
         JOIN brands b ON b.id = sba.brand_id
        WHERE sba.staff_user_id = ? AND b.status = 'active'
        ORDER BY b.is_default DESC, b.display_name`,
      [staffUserId]
    );
  }

  /** The brand marked `is_default` — the one every new non-SUPER_ADMIN staff
   * account is granted access to on creation (see service.js's
   * `createStaffUser`), so provisioning a staff member keeps working exactly
   * as it did pre-multi-company until Phase 6's real per-company assignment
   * UI exists. */
  async defaultBrand() {
    const rows = await query("SELECT id FROM brands WHERE is_default = 1 AND status = 'active' LIMIT 1");
    return rows[0]?.id || null;
  }

  async findAccess(staffUserId, brandId) {
    const rows = await query(
      'SELECT * FROM staff_brand_access WHERE staff_user_id = ? AND brand_id = ? LIMIT 1',
      [staffUserId, brandId]
    );
    return rows[0] || null;
  }

  // Not yet exposed through any route (Phase 6 / Settings + User Management
  // UI owns granting/revoking) — added now so Phase 2's switcher validation
  // and later phases share one data-access surface instead of each hand-
  // rolling the query.
  async grant({ staffUserId, brandId, role, grantedBy = null, permissionOverrides = null }) {
    await query(
      `INSERT INTO staff_brand_access (staff_user_id, brand_id, role, permission_overrides_json, granted_by, granted_at)
       VALUES (?, ?, ?, ?, ?, NOW(3))
       ON DUPLICATE KEY UPDATE role = VALUES(role), permission_overrides_json = VALUES(permission_overrides_json),
         granted_by = VALUES(granted_by), granted_at = NOW(3)`,
      [staffUserId, brandId, role, permissionOverrides === null ? null : JSON.stringify(permissionOverrides), grantedBy]
    );
    return this.findAccess(staffUserId, brandId);
  }

  async revoke(staffUserId, brandId) {
    const result = await query(
      'DELETE FROM staff_brand_access WHERE staff_user_id = ? AND brand_id = ?',
      [staffUserId, brandId]
    );
    return result.affectedRows > 0;
  }
}

export class StaffAuditRepository {
  /**
   * Append-only. Callers must pass only non-sensitive metadata — never a
   * password, token, or hash (Wave 8A brief §33/§67).
   */
  async log({
    staffUserId = null,
    actorEmail = null,
    action,
    resourceType = null,
    resourceId = null,
    metadata = null,
    ipAddress = null,
    requestId = null,
  }) {
    const id = randomUUID();
    await query(
      `INSERT INTO staff_audit_logs
         (id, staff_user_id, actor_email, action, resource_type, resource_id, metadata_json, ip_address, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        id,
        staffUserId,
        actorEmail ? String(actorEmail).slice(0, 255) : null,
        action,
        resourceType,
        resourceId ? String(resourceId).slice(0, 64) : null,
        metadata === null ? null : JSON.stringify(metadata),
        ipAddress ? String(ipAddress).slice(0, 64) : null,
        requestId ? String(requestId).slice(0, 120) : null,
      ]
    );
  }

  async listRecent(limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return query(
      `SELECT id, staff_user_id, actor_email, action, resource_type, resource_id, metadata_json, ip_address, created_at
         FROM staff_audit_logs ORDER BY created_at DESC LIMIT ${safeLimit}`
    );
  }

  // ---- WP-12 / GAP-ORD-06 — read-only audit-log viewer -----------------
  // Filters are all optional and AND together. `q` is a loose contains match
  // across action / resource id / actor email. `from`/`to` are ISO instants.
  #searchWhere({ action, resourceType, actorEmail, staffUserId, q, from, to }) {
    const clauses = [];
    const params = [];
    if (action) { clauses.push('l.action = ?'); params.push(action); }
    if (resourceType) { clauses.push('l.resource_type = ?'); params.push(resourceType); }
    if (actorEmail) { clauses.push('l.actor_email = ?'); params.push(actorEmail); }
    if (staffUserId) { clauses.push('l.staff_user_id = ?'); params.push(staffUserId); }
    if (from) { clauses.push('l.created_at >= ?'); params.push(from); }
    if (to) { clauses.push('l.created_at <= ?'); params.push(to); }
    if (q) {
      clauses.push('(l.action LIKE ? OR l.resource_id LIKE ? OR l.actor_email LIKE ?)');
      const like = `%${q}%`;
      params.push(like, like, like);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  async search(filter = {}) {
    const { sql, params } = this.#searchWhere(filter);
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    const offset = Math.max(Number(filter.offset) || 0, 0);
    return query(
      `SELECT l.id, l.staff_user_id, l.actor_email, l.action, l.resource_type, l.resource_id,
              l.metadata_json, l.ip_address, l.request_id, l.created_at,
              CONCAT_WS(' ', su.first_name, su.last_name) AS staff_name, su.email AS staff_email
         FROM staff_audit_logs l
         LEFT JOIN staff_users su ON su.id = l.staff_user_id
         ${sql}
        ORDER BY l.created_at DESC, l.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      params,
    );
  }

  async countSearch(filter = {}) {
    const { sql, params } = this.#searchWhere(filter);
    const rows = await query(`SELECT COUNT(*) AS n FROM staff_audit_logs l ${sql}`, params);
    return Number(rows[0]?.n || 0);
  }

  async facets() {
    const [actions, resourceTypes] = await Promise.all([
      query(`SELECT action AS value, COUNT(*) AS n FROM staff_audit_logs GROUP BY action ORDER BY action`),
      query(`SELECT resource_type AS value, COUNT(*) AS n FROM staff_audit_logs WHERE resource_type IS NOT NULL GROUP BY resource_type ORDER BY resource_type`),
    ]);
    return { actions, resourceTypes };
  }
}
