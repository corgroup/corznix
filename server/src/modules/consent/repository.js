import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

export class ConsentRepository {
  async insertRecord(connection, r) {
    const id = randomUUID();
    const brandId = await resolveBrandId(r.brandId);
    await exec(connection,
      `INSERT INTO consent_records
        (id, brand_id, contact_key, channel, purpose, action, source, customer_id, subscriber_id,
         notice_version, proof_ref, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, brandId, r.contactKey, r.channel, r.purpose, r.action, r.source, r.customerId || null, r.subscriberId || null,
        r.noticeVersion || null, r.proofRef || null, r.metadata ? JSON.stringify(r.metadata) : null,
        r.occurredAt || new Date()]);
    const [row] = await exec(connection, 'SELECT seq FROM consent_records WHERE id = ?', [id]);
    return { id, seq: Number(row.seq) };
  }

  /** Deterministic latest-wins upsert — the higher seq always wins (§35). */
  upsertState(connection, { contactKey, channel, purpose, customerId, action, seq }) {
    return exec(connection,
      `INSERT INTO consent_state (id, contact_key, channel, purpose, customer_id, effective_action, source_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         effective_action = IF(new.source_seq > consent_state.source_seq, new.effective_action, consent_state.effective_action),
         customer_id = COALESCE(new.customer_id, consent_state.customer_id),
         source_seq = GREATEST(consent_state.source_seq, new.source_seq)`,
      [randomUUID(), contactKey, channel, purpose, customerId || null, action, seq]);
  }

  state(connection, { contactKey, channel, purpose }) {
    return exec(connection,
      'SELECT * FROM consent_state WHERE contact_key = ? AND channel = ? AND purpose = ? LIMIT 1',
      [contactKey, channel, purpose]).then((r) => r[0] || null);
  }

  /**
   * Has this person ever decided about MARKETING on this channel — for this
   * address, or for any address recorded against their account? Any ledger
   * row counts, GRANTED or REVOKED.
   */
  async hasMarketingDecision({ customerId, contactKey, channel }) {
    const rows = await query(
      `SELECT 1 FROM consent_records
        WHERE channel = ? AND purpose = 'MARKETING' AND (contact_key = ? OR customer_id = ?)
        LIMIT 1`, [channel, contactKey, customerId]);
    return rows.length > 0;
  }

  statesForKeys(keys) {
    if (!keys.length) return Promise.resolve([]);
    return query(
      `SELECT * FROM consent_state WHERE contact_key IN (${keys.map(() => '?').join(',')})`, keys);
  }

  history({ contactKey = null, customerId = null, limit = 100 } = {}) {
    const where = [];
    const params = [];
    if (contactKey) { where.push('contact_key = ?'); params.push(contactKey); }
    if (customerId) { where.push('customer_id = ?'); params.push(customerId); }
    const safe = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return query(
      `SELECT seq, contact_key, channel, purpose, action, source, notice_version, occurred_at, created_at
         FROM consent_records ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY seq DESC LIMIT ${safe}`, params);
  }

  linkCustomerToState(contactKey, customerId) {
    return query('UPDATE consent_state SET customer_id = ? WHERE contact_key = ? AND customer_id IS NULL', [customerId, contactKey]);
  }

  // ---- marketing suppression -----------------------------------------
  activeSuppression(connection, { contactKey, channel, reason = null }) {
    const params = [contactKey, channel];
    let filter = '';
    if (reason) { filter = ' AND reason = ?'; params.push(reason); }
    return exec(connection,
      `SELECT * FROM marketing_suppressions WHERE contact_key = ? AND channel = ? AND released_at IS NULL${filter} LIMIT 1`,
      params).then((r) => r[0] || null);
  }

  async addSuppression(connection, s) {
    const id = randomUUID();
    const brandId = await resolveBrandId(s.brandId);
    await exec(connection,
      `INSERT INTO marketing_suppressions (id, brand_id, contact_key, channel, reason, source_seq, notes, created_by_staff_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, brandId, s.contactKey, s.channel, s.reason, s.sourceSeq || null, s.notes || null, s.createdByStaffId || null]);
    return id;
  }

  releaseSuppressions(connection, { contactKey, channel, reason = null, staffId = null }) {
    const params = [staffId, contactKey, channel];
    let filter = '';
    if (reason) { filter = ' AND reason = ?'; params.push(reason); }
    return exec(connection,
      `UPDATE marketing_suppressions SET released_at = NOW(3), released_by_staff_id = ?
        WHERE contact_key = ? AND channel = ? AND released_at IS NULL${filter}`, params);
  }

  suppressionsForKey(contactKey) {
    return query(
      'SELECT channel, reason, notes, released_at, created_at FROM marketing_suppressions WHERE contact_key = ? ORDER BY created_at DESC',
      [contactKey]);
  }
}

export const consentRepository = new ConsentRepository();
