import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

export class SegmentRepository {
  // ---- segments ---------------------------------------------------------
  async list({ status = null, brandId = null } = {}) {
    const resolvedBrandId = await resolveBrandId(brandId);
    const where = ['s.brand_id = ?'];
    const params = [resolvedBrandId];
    if (status) { where.push('s.status = ?'); params.push(status); }
    return query(
      `SELECT s.id, s.segment_key, s.name, s.description, s.status, s.created_at, s.updated_at,
              r.id AS revision_id, r.revision, r.match_mode, r.definition_json
         FROM customer_segments s
         LEFT JOIN customer_segment_revisions r ON r.id = s.current_revision_id
         WHERE ${where.join(' AND ')}
        ORDER BY s.created_at DESC`, params);
  }

  byId(connection, id) {
    return exec(connection,
      `SELECT s.*, r.revision, r.match_mode, r.definition_json
         FROM customer_segments s
         LEFT JOIN customer_segment_revisions r ON r.id = s.current_revision_id
        WHERE s.id = ? LIMIT 1`, [id]).then((rows) => rows[0] || null);
  }

  async byKey(key, brandId = null) {
    const resolvedBrandId = await resolveBrandId(brandId);
    return query('SELECT id FROM customer_segments WHERE segment_key = ? AND brand_id = ? LIMIT 1', [key, resolvedBrandId]).then((r) => r[0] || null);
  }

  async insertSegment(connection, { segmentKey, name, description, staffId, brandId = null }) {
    const id = randomUUID();
    const resolvedBrandId = await resolveBrandId(brandId);
    await exec(connection,
      `INSERT INTO customer_segments (id, brand_id, segment_key, name, description, created_by_staff_id)
       VALUES (?, ?, ?, ?, ?, ?)`, [id, resolvedBrandId, segmentKey, name, description || null, staffId || null]);
    return id;
  }

  updateSegment(connection, id, fields) {
    const cols = Object.keys(fields);
    if (!cols.length) return Promise.resolve();
    return exec(connection,
      `UPDATE customer_segments SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = NOW(3) WHERE id = ?`,
      [...cols.map((c) => fields[c]), id]);
  }

  // ---- revisions -------------------------------------------------------
  nextRevisionNumber(connection, segmentId) {
    return exec(connection,
      'SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM customer_segment_revisions WHERE segment_id = ?',
      [segmentId]).then((r) => Number(r[0].next));
  }

  async insertRevision(connection, { segmentId, revision, matchMode, definition, staffId }) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO customer_segment_revisions (id, segment_id, revision, match_mode, definition_json, created_by_staff_id)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), ?)`,
      [id, segmentId, revision, matchMode, JSON.stringify(definition), staffId || null]);
    return id;
  }

  revisionById(connection, id) {
    return exec(connection, 'SELECT * FROM customer_segment_revisions WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);
  }

  revisionsForSegment(segmentId) {
    return query(
      `SELECT r.id, r.revision, r.match_mode, r.definition_json, r.created_at,
              su.email AS created_by_email
         FROM customer_segment_revisions r
         LEFT JOIN staff_users su ON su.id = r.created_by_staff_id
        WHERE r.segment_id = ? ORDER BY r.revision DESC`, [segmentId]);
  }

  // ---- dynamic evaluation (compiled, parameterized) -------------------
  countMatching(compiled) {
    return query(compiled.selectCount, compiled.params).then((r) => Number(r[0].n));
  }

  sampleMatching(compiled, limit) {
    const safe = Math.min(Math.max(Number(limit) || 20, 1), 50);
    return query(
      `SELECT c.id, c.first_name, c.last_name, c.status, c.created_at
         FROM customers c WHERE ${compiled.where}
        ORDER BY c.created_at DESC LIMIT ${safe}`, compiled.params);
  }

  idsMatching(compiled) {
    return query(compiled.selectIds, compiled.params).then((rows) => rows.map((r) => r.id));
  }

  matchesCustomer(compiled, customerId) {
    return query(
      `SELECT 1 FROM customers c WHERE c.id = ? AND (${compiled.where}) LIMIT 1`,
      [customerId, ...compiled.params]).then((r) => r.length > 0);
  }

  // ---- snapshots ------------------------------------------------------
  async insertSnapshot(connection, { segmentId, revisionId, reason, customerIds, staffId }) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO customer_segment_snapshots (id, segment_id, revision_id, reason, member_count, created_by_staff_id)
       VALUES (?, ?, ?, ?, ?, ?)`, [id, segmentId, revisionId, reason, customerIds.length, staffId || null]);
    // Chunked multi-row insert of members.
    for (let i = 0; i < customerIds.length; i += 500) {
      const chunk = customerIds.slice(i, i + 500);
      await exec(connection,
        `INSERT INTO customer_segment_snapshot_members (snapshot_id, customer_id) VALUES ${chunk.map(() => '(?, ?)').join(', ')}`,
        chunk.flatMap((cid) => [id, cid]));
    }
    return id;
  }

  snapshotsForSegment(segmentId) {
    return query(
      `SELECT sn.id, sn.revision_id, r.revision, sn.reason, sn.member_count, sn.created_at,
              su.email AS created_by_email
         FROM customer_segment_snapshots sn
         JOIN customer_segment_revisions r ON r.id = sn.revision_id
         LEFT JOIN staff_users su ON su.id = sn.created_by_staff_id
        WHERE sn.segment_id = ? ORDER BY sn.created_at DESC`, [segmentId]);
  }

  snapshotMemberIds(snapshotId) {
    return query('SELECT customer_id FROM customer_segment_snapshot_members WHERE snapshot_id = ?', [snapshotId])
      .then((rows) => rows.map((r) => r.customer_id));
  }

  // ---- consent intersection (audience resolution, §91) ---------------
  /**
   * For a set of candidate customer ids, the endpoints that are GRANTED for
   * (channel, purpose) and not currently suppressed. This is the exact
   * send-eligibility gate — membership alone is never marketable.
   */
  marketableEndpoints(customerIds, { channel, purpose }) {
    if (!customerIds.length) return Promise.resolve([]);
    const placeholders = customerIds.map(() => '?').join(', ');
    return query(
      `SELECT cs.customer_id, cs.contact_key
         FROM consent_state cs
        WHERE cs.customer_id IN (${placeholders})
          AND cs.channel = ? AND cs.purpose = ? AND cs.effective_action = 'GRANTED'
          AND NOT EXISTS (
            SELECT 1 FROM marketing_suppressions ms
             WHERE ms.contact_key = cs.contact_key AND ms.channel = cs.channel AND ms.released_at IS NULL)`,
      [...customerIds, channel, purpose]);
  }

  /** Which ACTIVE segments a customer currently matches (for the CMS customer view). */
  async segmentsForCustomer(customerId, compileFn) {
    const rows = await query(
      `SELECT s.id, s.segment_key, s.name, r.match_mode, r.definition_json
         FROM customer_segments s
         JOIN customer_segment_revisions r ON r.id = s.current_revision_id
        WHERE s.status = 'ACTIVE'`);
    const out = [];
    for (const row of rows) {
      const def = typeof row.definition_json === 'string' ? JSON.parse(row.definition_json) : row.definition_json;
      try {
        const compiled = compileFn({ match: row.match_mode, conditions: def.conditions });
        // eslint-disable-next-line no-await-in-loop
        if (await this.matchesCustomer(compiled, customerId)) {
          out.push({ id: row.id, key: row.segment_key, name: row.name });
        }
      } catch { /* a since-invalidated rule is simply skipped here */ }
    }
    return out;
  }
}

export const segmentRepository = new SegmentRepository();
