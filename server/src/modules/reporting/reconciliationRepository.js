import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

// Every row here belongs to exactly one company (migration 085). Reads are
// filtered and writes are matched on (brand_id, id) so a staff member cannot
// read, resolve or reopen another company's financial exception — transition()
// in particular is a WRITE reached by id from the URL, so a bare id lookup
// would have been an IDOR on a financial record.
//
// A missing brandId is a programming error, not an empty result: it throws, so
// a new caller cannot silently reintroduce a cross-company query.
const needBrand = (brandId) => {
  if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required for every reconciliation query.', 500);
  return brandId;
};

export const reconciliationRepository = {
  /** Idempotent on (brand_id, dedupe_key) — a re-scan of the same discrepancy touches one row. */
  async upsertException(e) {
    needBrand(e.brandId);
    const id = randomUUID();
    await query(
      `INSERT INTO reconciliation_exceptions
        (id, brand_id, exception_type, source_domain, reference_type, reference_id, expected_minor, actual_minor, currency, detail_json, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INR', CAST(? AS JSON), ?)
       AS new
       ON DUPLICATE KEY UPDATE
         expected_minor = new.expected_minor,
         actual_minor = new.actual_minor,
         detail_json = new.detail_json,
         last_detected_at = NOW(3),
         status = IF(reconciliation_exceptions.status = 'RESOLVED', 'REOPENED', reconciliation_exceptions.status)`,
      [id, e.brandId, e.exceptionType, e.sourceDomain, e.referenceType, e.referenceId,
        e.expectedMinor ?? null, e.actualMinor ?? null, JSON.stringify(e.detail ?? null), e.dedupeKey]);
    const [row] = await query(
      'SELECT id, status FROM reconciliation_exceptions WHERE brand_id = ? AND dedupe_key = ?', [e.brandId, e.dedupeKey]);
    return row;
  },

  list({ status, type, offset, limit, brandId }) {
    needBrand(brandId);
    const where = ['re.brand_id = ?'];
    const params = [brandId];
    // Qualified — staff_users also has a `status` column, so the LEFT JOIN
    // below makes an unqualified `status` ambiguous (INTERNAL_ERROR 500).
    if (status) { where.push('re.status = ?'); params.push(status); }
    if (type) { where.push('re.exception_type = ?'); params.push(type); }
    return query(
      `SELECT re.*, su.email AS assigned_email
         FROM reconciliation_exceptions re
         LEFT JOIN staff_users su ON su.id = re.assigned_staff_id
        WHERE ${where.join(' AND ')}
        ORDER BY re.status = 'RESOLVED', re.first_detected_at DESC
        LIMIT ${limit} OFFSET ${offset}`, params);
  },
  count({ status, type, brandId }) {
    needBrand(brandId);
    const where = ['brand_id = ?'];
    const params = [brandId];
    if (status) { where.push('status = ?'); params.push(status); }
    if (type) { where.push('exception_type = ?'); params.push(type); }
    return query(`SELECT COUNT(*) n FROM reconciliation_exceptions WHERE ${where.join(' AND ')}`, params).then((r) => Number(r[0].n));
  },
  byId(id, brandId) {
    needBrand(brandId);
    return query('SELECT * FROM reconciliation_exceptions WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]).then((r) => r[0] || null);
  },
  // Scoped through the parent exception: an event is only ever meaningful with
  // its exception, and this keeps the guarantee even if a future caller reaches
  // events() without going through byId() first.
  events(id, brandId) {
    needBrand(brandId);
    return query(
      `SELECT ev.event_type, ev.from_status, ev.to_status, ev.note, ev.created_at
         FROM reconciliation_events ev
         JOIN reconciliation_exceptions re ON re.id = ev.exception_id
        WHERE ev.exception_id = ? AND re.brand_id = ?
        ORDER BY ev.created_at`, [id, brandId]);
  },
  async transition(id, { toStatus, note, staffId, eventType, assignStaffId, brandId }) {
    needBrand(brandId);
    const current = await this.byId(id, brandId);
    if (!current) return null;
    await query(
      `UPDATE reconciliation_exceptions
          SET status = ?, resolution_note = COALESCE(?, resolution_note),
              assigned_staff_id = COALESCE(?, assigned_staff_id),
              resolved_at = IF(? = 'RESOLVED', NOW(3), NULL), updated_at = NOW(3)
        WHERE id = ? AND brand_id = ?`, [toStatus, note ?? null, assignStaffId ?? null, toStatus, id, brandId]);
    await query(
      `INSERT INTO reconciliation_events (id, exception_id, event_type, from_status, to_status, actor_staff_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), id, eventType, current.status, toStatus, staffId ?? null, note ?? null]);
    return this.byId(id, brandId);
  },

  settlementImportByHash(hash, brandId) {
    needBrand(brandId);
    return query('SELECT * FROM provider_settlement_imports WHERE file_hash = ? AND brand_id = ? LIMIT 1', [hash, brandId]).then((r) => r[0] || null);
  },
  async insertSettlementImport(i) {
    needBrand(i.brandId);
    const id = randomUUID();
    await query(
      `INSERT INTO provider_settlement_imports
        (id, brand_id, provider_code, kind, file_name, file_hash, row_count, matched_count, exception_count, imported_by_staff_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, i.brandId, i.providerCode, i.kind, i.fileName, i.fileHash, i.rowCount, i.matchedCount, i.exceptionCount, i.staffId ?? null]);
    return id;
  },
  // payment_attempts has no brand of its own — reached through its obligation's
  // order. Without this a settlement file uploaded by one company could match,
  // and then be reconciled against, another company's payment.
  matchPayment(reference, brandId) {
    needBrand(brandId);
    return query(
      `SELECT pa.id, pa.amount_minor, pa.status
         FROM payment_attempts pa
         JOIN payment_obligations po ON po.id = pa.obligation_id
         JOIN orders o ON o.id = po.order_id
        WHERE (pa.provider_payment_id = ? OR pa.merchant_reference = ?) AND o.brand_id = ?
        LIMIT 1`, [reference, reference, brandId]).then((r) => r[0] || null);
  },
  matchRefund(reference, brandId) {
    needBrand(brandId);
    return query(
      `SELECT id, amount_minor, status FROM refund_attempts
        WHERE (provider_refund_id = ? OR refund_number = ?) AND brand_id = ?
        LIMIT 1`, [reference, reference, brandId]).then((r) => r[0] || null);
  },
};
