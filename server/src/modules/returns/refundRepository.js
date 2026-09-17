import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

// Data access for the refund state machine + partial credit notes. Reuses the
// existing payment_attempts / credit_notes / invoices authorities.
export class RefundRepository {
  byReturnRequest(connection, returnRequestId, { lock = false } = {}) {
    return exec(connection,
      `SELECT * FROM refund_attempts WHERE return_request_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [returnRequestId]).then((r) => r[0] || null);
  }

  /**
   * The refund a cancelled order already has, if any. Cancellation refunds
   * carry no return request, so they are keyed by the order and their origin —
   * and there is at most one, because the idempotency key is unique.
   */
  byOrderOrigin(connection, orderId, origin, { lock = false } = {}) {
    return exec(connection,
      `SELECT * FROM refund_attempts WHERE order_id = ? AND origin = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [orderId, origin]).then((r) => r[0] || null);
  }

  lockById(connection, id) {
    return exec(connection, 'SELECT * FROM refund_attempts WHERE id = ? LIMIT 1 FOR UPDATE', [id])
      .then((r) => r[0] || null);
  }

  /** The SUCCEEDED online payment that this order's refund must reverse (§89). */
  sourceOnlinePayment(connection, orderId) {
    return exec(connection,
      `SELECT pa.* FROM payment_attempts pa
         JOIN payment_obligations po ON po.id = pa.obligation_id
        WHERE po.order_id = ? AND po.obligation_type = 'ONLINE' AND pa.status = 'SUCCEEDED'
        ORDER BY pa.created_at DESC LIMIT 1`, [orderId]).then((r) => r[0] || null);
  }

  /**
   * Everything already committed against this order's refundable value (§88):
   * non-failed refund amounts + store-credit grants sourced from a return
   * resolution. Reserved-exchange value is deliberately excluded — it is not a
   * monetary refund.
   */
  /**
   * How much of the non-refundable COD advance earlier refunds already kept.
   * FAILED and BLOCKED attempts never withheld anything, so they are excluded
   * on the same rule as resolvedFinancialForOrder — otherwise a failed refund
   * would quietly eat the advance and the customer would lose it twice.
   */
  async withheldAdvanceForOrder(connection, orderId) {
    const [row] = await exec(connection,
      `SELECT COALESCE(SUM(non_refundable_withheld_minor), 0) AS total FROM refund_attempts
        WHERE order_id = ? AND status NOT IN ('FAILED','BLOCKED')`, [orderId]);
    return Number(row?.total || 0);
  }

  async resolvedFinancialForOrder(connection, orderId) {
    const [refunds] = await exec(connection,
      `SELECT COALESCE(SUM(amount_minor), 0) AS total FROM refund_attempts
        WHERE order_id = ? AND status NOT IN ('FAILED','BLOCKED')`, [orderId]);
    const [credits] = await exec(connection,
      `SELECT COALESCE(SUM(e.amount_minor), 0) AS total
         FROM store_credit_entries e
        WHERE e.source_type = 'RETURN_RESOLUTION'
          AND e.source_id IN (SELECT id FROM return_requests WHERE order_id = ?)`, [orderId]);
    return Number(refunds.total) + Number(credits.total);
  }

  // brand_id derived from the order — same reasoning as credit_notes.
  async insert(connection, r) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO refund_attempts
        (id, brand_id, refund_number, return_request_id, origin, order_id, customer_id, source_payment_attempt_id,
         provider_code, method, amount_minor, non_refundable_withheld_minor, currency, status, idempotency_key, request_hash, failure_code)
       VALUES (?, (SELECT brand_id FROM orders WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, r.orderId, r.refundNumber, r.returnRequestId || null, r.origin || 'RETURN', r.orderId, r.customerId, r.sourcePaymentAttemptId || null,
        r.providerCode || null, r.method, r.amountMinor, r.nonRefundableWithheldMinor || 0, r.currency, r.status, r.idempotencyKey, r.requestHash,
        r.failureCode || null]);
    return exec(connection, 'SELECT * FROM refund_attempts WHERE id = ?', [id]).then((rows) => rows[0]);
  }

  update(connection, id, fields) {
    const sets = ['updated_at = NOW(3)'];
    const params = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); params.push(v); }
    params.push(id);
    return exec(connection, `UPDATE refund_attempts SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  // ---- partial credit notes -----------------------------------------
  invoiceByOrder(connection, orderId) {
    return exec(connection, 'SELECT * FROM invoices WHERE order_id = ? LIMIT 1', [orderId]).then((r) => r[0] || null);
  }

  invoiceItems(connection, invoiceId) {
    return exec(connection, 'SELECT * FROM invoice_items WHERE invoice_id = ?', [invoiceId]);
  }

  orderItemsByIds(connection, ids) {
    if (!ids.length) return Promise.resolve([]);
    return exec(connection,
      `SELECT id, sku, sku_id, product_name FROM order_items WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  }

  creditNoteByReturnRequest(connection, returnRequestId) {
    return exec(connection, 'SELECT * FROM credit_notes WHERE return_request_id = ? LIMIT 1', [returnRequestId])
      .then((r) => r[0] || null);
  }

  // Multi-company (DESIGN.md §9 risk: "Invoice numbering / GST identity
  // bleeds") — same counter row (brand_id, 'CREDIT_NOTE') documents/
  // repository.js's nextNumber uses, so full and partial credit notes
  // share ONE sequence per company rather than two independent ones (a
  // pre-existing inconsistency: this generator never had a year segment
  // like the other one — left as-is, only the brand scoping is this
  // phase's job). Prefix derived from the brand's own order_prefix
  // (migration 081), never a hardcoded "COR-".
  async nextCreditNoteNumber(connection, brandId) {
    const [brandRow] = await exec(connection, 'SELECT order_prefix FROM brands WHERE id = ?', [brandId]);
    const prefix = brandRow?.order_prefix || 'ORD';
    await exec(connection,
      'INSERT INTO document_counters (brand_id, name, value) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE value = value + 1',
      [brandId, 'CREDIT_NOTE']);
    const [row] = await exec(connection, 'SELECT value FROM document_counters WHERE brand_id = ? AND name = ?', [brandId, 'CREDIT_NOTE']);
    return `${prefix}-CN-${String(row.value).padStart(6, '0')}`;
  }

  async insertPartialCreditNote(connection, cn) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO credit_notes
        (id, brand_id, invoice_id, order_id, credit_note_type, return_request_id, credit_note_number,
         amount_minor, taxable_minor, indicative_tax_minor, reason, status, treatment_status)
       VALUES (?, (SELECT brand_id FROM orders WHERE id = ?), ?, ?, 'PARTIAL_RETURN', ?, ?, ?, ?, ?, ?, 'ISSUED', 'PENDING_CONFIGURATION')`,
      [id, cn.orderId, cn.invoiceId, cn.orderId, cn.returnRequestId, cn.creditNoteNumber,
        Number(cn.amountMinor), Number(cn.taxableMinor ?? 0), Number(cn.indicativeTaxMinor ?? 0), cn.reason ?? null]);
    for (const li of cn.items) {
      await exec(connection,
        `INSERT INTO credit_note_items
          (id, credit_note_id, order_item_id, sku, product_name, hsn_sac, quantity, unit_price_minor,
           returned_value_minor, indicative_tax_minor, invoice_item_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), id, li.orderItemId, li.sku, li.productName ?? li.sku, li.hsn ?? null, Number(li.quantity),
          Number(li.unitPriceMinor), Number(li.returnedValueMinor), Number(li.indicativeTaxMinor ?? 0), li.invoiceItemRef ?? null]);
    }
    return exec(connection, 'SELECT * FROM credit_notes WHERE id = ?', [id]).then((r) => r[0]);
  }
}

export const refundRepository = new RefundRepository();
