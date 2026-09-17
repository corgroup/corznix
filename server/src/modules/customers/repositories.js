// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/modules/customers/repositories.js (Wave 5).
// Logic unchanged; `query()` return-shape and `uuid` -> `randomUUID()`
// adapted the same way as every other salvaged repository this migration
// has touched (see modules/auth/repositories.js's banner comment).
import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { toMysqlDateTime } from '../../utils/otpCrypto.js';

export class CustomerRepository {
  // Multi-company (DESIGN.md §7.1) — Phase 4. brandId is required: a
  // customer always belongs to exactly one company, resolved upstream from
  // the storefront's own host (resolveStorefrontBrand), never guessed here.
  async create({ firstName = null, lastName = null, brandId }) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to create a customer.', 500);
    const id = randomUUID();
    await query(
      `INSERT INTO customers (id, brand_id, first_name, last_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PENDING_PROFILE', NOW(), NOW())`,
      [id, brandId, firstName, lastName]
    );
    return this.findById(id);
  }

  async findById(id) {
    const rows = await query('SELECT * FROM customers WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async update(id, updates) {
    const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
    if (entries.length === 0) return this.findById(id);

    const sets = entries.map(([key]) => `${key} = ?`).join(', ');
    const values = entries.map(([, value]) => value);
    values.push(id);

    await query(`UPDATE customers SET ${sets}, updated_at = NOW() WHERE id = ?`, values);
    return this.findById(id);
  }

  /**
   * CMS customer list. Search matches name or a normalized contact value.
   * PII (contact values) is masked by the service for list contexts (§24).
   */
  async adminList({ search = null, status = null, limit = 50, offset = 0, brandId = null } = {}) {
    const where = [];
    const params = [];
    if (brandId) { where.push('c.brand_id = ?'); params.push(brandId); }
    if (status) { where.push('c.status = ?'); params.push(status); }
    if (search) {
      const like = `%${String(search).trim().toLowerCase()}%`;
      where.push(`(LOWER(CONCAT_WS(' ', c.first_name, c.last_name)) LIKE ?
        OR EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.customer_id = c.id AND LOWER(cc.normalized_value) LIKE ?))`);
      params.push(like, like);
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT c.id, c.first_name, c.last_name, c.status, c.created_at,
              (SELECT normalized_value FROM customer_contacts cc WHERE cc.customer_id = c.id AND cc.contact_type = 'EMAIL' AND cc.is_verified = 1 LIMIT 1) AS verified_email,
              (SELECT normalized_value FROM customer_contacts cc WHERE cc.customer_id = c.id AND cc.contact_type = 'PHONE' AND cc.is_verified = 1 LIMIT 1) AS verified_phone,
              (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) AS order_count
         FROM customers c
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY c.created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, params);
  }
}

export class CustomerNoteRepository {
  async add({ customerId, authorStaffId, body }) {
    const id = randomUUID();
    await query(
      "INSERT INTO customer_notes (id, customer_id, author_staff_id, visibility, body) VALUES (?, ?, ?, 'INTERNAL', ?)",
      [id, customerId, authorStaffId || null, body]);
    return id;
  }

  forCustomer(customerId) {
    return query(
      `SELECT n.id, n.body, n.created_at, s.email AS author_email
         FROM customer_notes n LEFT JOIN staff_users s ON s.id = n.author_staff_id
        WHERE n.customer_id = ? ORDER BY n.created_at DESC`, [customerId]);
  }
}

export class CustomerStatusChangeRepository {
  async add({ customerId, fromStatus, toStatus, reason, changedByStaffId }) {
    const id = randomUUID();
    await query(
      'INSERT INTO customer_status_changes (id, customer_id, from_status, to_status, reason, changed_by_staff_id) VALUES (?, ?, ?, ?, ?, ?)',
      [id, customerId, fromStatus, toStatus, reason || null, changedByStaffId || null]);
    return id;
  }

  forCustomer(customerId) {
    return query(
      `SELECT c.from_status, c.to_status, c.reason, c.created_at, s.email AS changed_by_email
         FROM customer_status_changes c LEFT JOIN staff_users s ON s.id = c.changed_by_staff_id
        WHERE c.customer_id = ? ORDER BY c.created_at DESC`, [customerId]);
  }
}

export class CustomerContactRepository {
  // Keyed on (customer_id, contact_type) — the unique constraint's own
  // key — never on whether some other customer already holds this value,
  // which is a separate concern (see AuthService's identity-conflict
  // checks, not this repository's job).
  async upsert({ customerId, contactType, value, normalizedValue, source = 'PROFILE', verified = false }) {
    const existing = (await this.findForCustomer(customerId)).find((entry) => entry.contact_type === contactType) || null;

    if (existing) {
      await query(
        `UPDATE customer_contacts
         SET value = ?, normalized_value = ?, is_verified = ?, verified_at = ?, source = ?, updated_at = NOW()
         WHERE customer_id = ? AND contact_type = ?`,
        [value, normalizedValue, verified ? 1 : 0, verified ? toMysqlDateTime(new Date()) : null, source, customerId, contactType]
      );
      return (await this.findForCustomer(customerId)).find((entry) => entry.contact_type === contactType) || null;
    }

    const id = randomUUID();
    await query(
      `INSERT INTO customer_contacts (id, customer_id, contact_type, value, normalized_value, is_verified, verified_at, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, customerId, contactType, value, normalizedValue, verified ? 1 : 0, verified ? toMysqlDateTime(new Date()) : null, source]
    );
    return (await this.findForCustomer(customerId)).find((entry) => entry.id === id) || null;
  }

  async findForCustomer(customerId) {
    return query('SELECT * FROM customer_contacts WHERE customer_id = ?', [customerId]);
  }

  // Multi-company (DESIGN.md §7.1) — Phase 4. brandId is required:
  // customer_contacts has no brand_id column of its own (transitively
  // scoped via the parent customer, §4.2), so this joins to customers to
  // enforce "email/phone uniqueness stays per-brand" — the same contact
  // string is a genuinely different account on a different company.
  async findByTypeAndNormalized(contactType, normalizedValue, brandId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to look up a contact.', 500);
    return query(
      `SELECT cc.* FROM customer_contacts cc
         JOIN customers c ON c.id = cc.customer_id
        WHERE cc.contact_type = ? AND cc.normalized_value = ? AND c.brand_id = ?`,
      [contactType, normalizedValue, brandId]
    );
  }

  /**
   * Mark verified the one contact whose value a login code was just sent to
   * and correctly returned. Matched on the exact normalized value — never on
   * type alone — so proving control of one number can never verify another
   * number stored on the same account.
   */
  async markVerifiedByValue(customerId, contactType, normalizedValue, source) {
    const result = await query(
      `UPDATE customer_contacts SET is_verified = 1, verified_at = ?, source = ?, updated_at = NOW()
        WHERE customer_id = ? AND contact_type = ? AND normalized_value = ? AND is_verified = 0`,
      [toMysqlDateTime(new Date()), source, customerId, contactType, normalizedValue]
    );
    return result.affectedRows > 0;
  }

  async setVerified(customerId, contactType, source = 'CONTACT_VERIFICATION') {
    await query(
      `UPDATE customer_contacts SET is_verified = 1, verified_at = ?, source = ?, updated_at = NOW()
       WHERE customer_id = ? AND contact_type = ?`,
      [toMysqlDateTime(new Date()), source, customerId, contactType]
    );
    return (await this.findForCustomer(customerId)).find((entry) => entry.contact_type === contactType) || null;
  }
}

export class CustomerIdentityRepository {
  // Multi-company (DESIGN.md §7.1) — Phase 4. brandId is required and
  // denormalized onto the row directly (migration 080 — a gap DESIGN.md's
  // own table lists missed): the (provider, provider_subject) uniqueness
  // constraint itself needs brand_id in it, the same reasoning Phase 3 used
  // for product_variants — a plain JOIN through customer_id cannot fix a
  // UNIQUE KEY. Caller must always pass the SAME brandId as the customer
  // this identity belongs to.
  async create({ customerId, brandId, provider, providerSubject, verifiedAt = toMysqlDateTime(new Date()) }) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to create a customer identity.', 500);
    const id = randomUUID();
    try {
      await query(
        `INSERT INTO customer_identities (id, customer_id, brand_id, provider, provider_subject, verified_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [id, customerId, brandId, provider, providerSubject, verifiedAt]
      );
    } catch (err) {
      // The (brand_id, provider, provider_subject) unique constraint is the
      // final authority for concurrent identity claims — a losing
      // concurrent insert lands here.
      if (err.code === 'ER_DUP_ENTRY') {
        throw new AppError('IDENTITY_CONFLICT', 'This identity is already linked to another customer.', 409);
      }
      throw err;
    }
    return this.findByProviderSubject(provider, providerSubject, brandId);
  }

  async findByProviderSubject(provider, providerSubject, brandId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to look up a customer identity.', 500);
    const rows = await query(
      'SELECT * FROM customer_identities WHERE provider = ? AND provider_subject = ? AND brand_id = ? LIMIT 1',
      [provider, providerSubject, brandId]
    );
    return rows[0] || null;
  }

  async findByCustomer(customerId) {
    return query('SELECT * FROM customer_identities WHERE customer_id = ?', [customerId]);
  }
}

export class AuthSessionRepository {
  // expires_at is the session's absolute deadline, set once here by MySQL
  // (expiresInSeconds from now) and never extended by a refresh.
  async create({ id = randomUUID(), customerId, tokenHash, status = 'ACTIVE', expiresInSeconds, userAgent, ipAddress }) {
    await query(
      `INSERT INTO auth_sessions (id, customer_id, token_hash, status, created_at, expires_at, last_seen_at, user_agent, ip_address)
       VALUES (?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? SECOND), NOW(), ?, ?)`,
      [id, customerId, tokenHash, status, Number(expiresInSeconds), userAgent || null, ipAddress || null]
    );
    return this.findById(id);
  }

  async findById(id) {
    const rows = await query('SELECT * FROM auth_sessions WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  // The row plus its ages as MySQL computes them (see auth/sessionPolicy.js).
  async findWithAge(id) {
    const rows = await query(
      `SELECT *,
              TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds,
              TIMESTAMPDIFF(SECOND, COALESCE(last_seen_at, created_at), NOW()) AS idle_seconds,
              TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS seconds_to_expiry,
              (expires_at <= NOW()) AS past_expiry
         FROM auth_sessions WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  async expire(id) {
    await query("UPDATE auth_sessions SET status = 'EXPIRED' WHERE id = ? AND status = 'ACTIVE'", [id]);
  }

  // Marks activity for the idle timeout, at most once per interval per session.
  async touchIfStale(id, intervalSeconds) {
    await query(
      'UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = ? AND status = \'ACTIVE\' AND (last_seen_at IS NULL OR last_seen_at < NOW() - INTERVAL ? SECOND)',
      [id, Number(intervalSeconds)]
    );
  }

  async revoke(id) {
    await query("UPDATE auth_sessions SET status = 'REVOKED', last_seen_at = NOW() WHERE id = ?", [id]);
    return this.findById(id);
  }

  activeForCustomer(customerId) {
    return query("SELECT id, created_at, last_seen_at, expires_at FROM auth_sessions WHERE customer_id = ? AND status = 'ACTIVE' ORDER BY last_seen_at DESC", [customerId]);
  }

  async revokeAllForCustomer(customerId) {
    const result = await query("UPDATE auth_sessions SET status = 'REVOKED', last_seen_at = NOW() WHERE customer_id = ? AND status = 'ACTIVE'", [customerId]);
    return result.affectedRows ?? 0;
  }

  async touch(id) {
    await query('UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = ?', [id]);
  }
}

export class IdentityLinkRepository {
  async create({ candidateCustomerId, incomingProvider, incomingProviderSubject, incomingVerifiedContact, proofChannel, expiresAt }) {
    const id = randomUUID();
    await query(
      `INSERT INTO identity_link_requests (id, candidate_customer_id, incoming_provider, incoming_provider_subject, incoming_verified_contact, proof_channel, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, NOW())`,
      [id, candidateCustomerId, incomingProvider, incomingProviderSubject, incomingVerifiedContact, proofChannel, expiresAt]
    );
    return this.findById(id);
  }

  async findById(id) {
    const rows = await query('SELECT * FROM identity_link_requests WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }
}

export class AuditRepository {
  async log({ customerId = null, eventType, eventCode = null, metadata = {}, requestId = null }) {
    const id = randomUUID();
    // request_id is VARCHAR(120) — truncate defensively so an oversized
    // value never crashes an otherwise-successful operation.
    const safeRequestId = requestId === null ? null : String(requestId).slice(0, 120);
    await query(
      `INSERT INTO audit_logs (id, customer_id, event_type, event_code, metadata, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [id, customerId, eventType, eventCode, JSON.stringify(metadata), safeRequestId]
    );
  }
}
