import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

// Statuses that still "hold" a physical unit against the ordered quantity —
// anything not rejected / cancelled / expired (§17, §19). A unit released by
// one of these terminal-negative states becomes eligible again.
const RELEASING_STATUSES = ['REJECTED', 'CANCELLED', 'EXPIRED'];

export class ReturnsRepository {
  // ---- policy ----------------------------------------------------------
  policy(connection = null) {
    return exec(connection, 'SELECT * FROM return_policy WHERE id = 1 LIMIT 1').then((r) => r[0] || null);
  }

  // ---- orders / items -------------------------------------------------
  /** The caller's own order, row-locked to serialize concurrent request creation (§20). */
  lockOwnedOrder(connection, customerId, idOrNumber) {
    return exec(connection,
      'SELECT * FROM orders WHERE customer_id = ? AND (id = ? OR order_number = ?) LIMIT 1 FOR UPDATE',
      [customerId, idOrNumber, idOrNumber]).then((r) => r[0] || null);
  }

  ownedOrder(customerId, idOrNumber) {
    return query(
      'SELECT * FROM orders WHERE customer_id = ? AND (id = ? OR order_number = ?) LIMIT 1',
      [customerId, idOrNumber, idOrNumber]).then((r) => r[0] || null);
  }

  /**
   * Per-order-item accounting for eligibility (§17). Returns one row per
   * order item with: ordered quantity, the quantity already held by a
   * non-releasing return/exchange request, the authoritative package delivery
   * timestamp, and the owning fulfillment.
   */
  itemAccounting(connection, orderId) {
    return exec(connection,
      `SELECT
         oi.id                        AS order_item_id,
         oi.sku_id,
         oi.product_id,
         oi.variant_id,
         oi.sku,
         oi.product_name,
         oi.selected_size,
         oi.selected_color,
         oi.quantity                  AS ordered_quantity,
         oi.unit_price_minor,
         COALESCE(held.qty, 0)        AS held_quantity,
         dlv.fulfillment_id,
         dlv.delivered_at
       FROM order_items oi
       LEFT JOIN (
         SELECT rri.order_item_id, SUM(rri.quantity) AS qty
           FROM return_request_items rri
           JOIN return_requests rr ON rr.id = rri.return_request_id
          WHERE rr.status NOT IN (${RELEASING_STATUSES.map(() => '?').join(',')})
          GROUP BY rri.order_item_id
       ) held ON held.order_item_id = oi.id
       LEFT JOIN (
         SELECT fi.order_item_id,
                MAX(s.delivered_at) AS delivered_at,
                SUBSTRING_INDEX(GROUP_CONCAT(f.id ORDER BY s.delivered_at DESC), ',', 1) AS fulfillment_id
           FROM fulfillment_items fi
           JOIN fulfillments f ON f.id = fi.fulfillment_id
           LEFT JOIN shipments s ON s.fulfillment_id = f.id
          GROUP BY fi.order_item_id
       ) dlv ON dlv.order_item_id = oi.id
       WHERE oi.order_id = ?
       ORDER BY oi.created_at`,
      [...RELEASING_STATUSES, orderId]);
  }

  orderById(id, connection = null) {
    return exec(connection, 'SELECT * FROM orders WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);
  }

  // ---- requests ------------------------------------------------------
  requestById(id, connection = null) {
    return exec(connection, 'SELECT * FROM return_requests WHERE id = ? OR request_number = ? LIMIT 1', [id, id])
      .then((r) => r[0] || null);
  }

  updateItemRestock(connection, itemId, { restockedQuantity, restockWarehouseId }) {
    return exec(connection,
      'UPDATE return_request_items SET restocked_quantity = ?, restock_warehouse_id = ? WHERE id = ?',
      [restockedQuantity, restockWarehouseId || null, itemId]);
  }

  /** The fulfillment that shipped a given order item (for reverse-shipment destination routing, §70). */
  fulfillmentForOrderItem(connection, orderItemId) {
    return exec(connection,
      `SELECT f.* FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id
        WHERE fi.order_item_id = ? AND f.return_request_id IS NULL
        ORDER BY f.sequence LIMIT 1`, [orderItemId]).then((r) => r[0] || null);
  }

  requestByIdempotencyKey(connection, key) {
    return exec(connection, 'SELECT * FROM return_requests WHERE idempotency_key = ? LIMIT 1', [key])
      .then((r) => r[0] || null);
  }

  ownedRequest(customerId, idOrNumber) {
    return query(
      'SELECT * FROM return_requests WHERE customer_id = ? AND (id = ? OR request_number = ?) LIMIT 1',
      [customerId, idOrNumber, idOrNumber]).then((r) => r[0] || null);
  }

  lockRequest(connection, requestId) {
    return exec(connection, 'SELECT * FROM return_requests WHERE id = ? LIMIT 1 FOR UPDATE', [requestId])
      .then((r) => r[0] || null);
  }

  requestItems(requestId, connection = null) {
    return exec(connection,
      'SELECT * FROM return_request_items WHERE return_request_id = ? ORDER BY created_at', [requestId]);
  }

  requestEvents(requestId, connection = null) {
    return exec(connection,
      `SELECT event_type, from_status, to_status, actor_type, detail_json, created_at
         FROM return_request_events WHERE return_request_id = ? ORDER BY created_at, id`, [requestId]);
  }

  // brand_id derived from the order — same reasoning as invoices/refunds.
  async insertRequest(connection, r) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO return_requests
        (id, brand_id, request_number, customer_id, order_id, request_type, status, reason_code, customer_note,
         eligibility_snapshot_json, pickup_address_snapshot_json, return_warehouse_id, idempotency_key, created_by)
       VALUES (?, (SELECT brand_id FROM orders WHERE id = ?), ?, ?, ?, ?, 'REQUESTED', ?, ?, ?, ?, ?, ?, ?)`,
      [id, r.orderId, r.requestNumber, r.customerId, r.orderId, r.requestType, r.reasonCode || null, r.customerNote || null,
        JSON.stringify(r.eligibilitySnapshot), r.pickupAddressSnapshot ? JSON.stringify(r.pickupAddressSnapshot) : null,
        r.returnWarehouseId || null, r.idempotencyKey || null, r.createdBy || 'CUSTOMER']);
    return exec(connection, 'SELECT * FROM return_requests WHERE id = ?', [id]).then((rows) => rows[0]);
  }

  async insertRequestItem(connection, requestId, item) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO return_request_items
        (id, return_request_id, order_item_id, fulfillment_id, sku_id, quantity, reason_code, item_note,
         unit_price_minor, eligible_value_minor, delivered_at, return_deadline,
         target_product_id, target_variant_id, target_sku_id, target_unit_price_minor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, requestId, item.orderItemId, item.fulfillmentId || null, item.skuId, item.quantity,
        item.reasonCode || null, item.itemNote || null, item.unitPriceMinor, item.eligibleValueMinor,
        item.deliveredAt || null, item.returnDeadline || null,
        item.targetProductId || null, item.targetVariantId || null, item.targetSkuId || null,
        item.targetUnitPriceMinor ?? null]);
    return id;
  }

  async recordEvent(connection, requestId, e) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO return_request_events
        (id, return_request_id, event_type, from_status, to_status, actor_type, actor_id, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, requestId, e.eventType, e.fromStatus || null, e.toStatus || null,
        e.actorType || 'SYSTEM', e.actorId || null, e.detail ? JSON.stringify(e.detail) : null]);
    return id;
  }

  updateRequest(connection, requestId, fields) {
    const sets = ['updated_at = NOW(3)'];
    const params = [];
    for (const [col, val] of Object.entries(fields)) { sets.push(`${col} = ?`); params.push(val); }
    params.push(requestId);
    return exec(connection, `UPDATE return_requests SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  setRequestStatus(connection, requestId, status, extra = {}) {
    const sets = ['status = ?', 'updated_at = NOW(3)'];
    const params = [status];
    for (const [col, val] of Object.entries(extra)) { sets.push(`${col} = ?`); params.push(val); }
    params.push(requestId);
    return exec(connection, `UPDATE return_requests SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  listOwned(customerId) {
    return query(
      `SELECT id, request_number, order_id, request_type, status, reason_code, requested_at, updated_at
         FROM return_requests WHERE customer_id = ? ORDER BY requested_at DESC`, [customerId]);
  }

  // ---- CMS inbox / detail --------------------------------------------
  adminList({ requestType = null, status = null, warehouseId = null, warehouseIds = null, qcPending = false, resolutionPending = false, limit = 50, offset = 0, brandId = null } = {}) {
    const where = [];
    const params = [];
    if (brandId) { where.push('rr.brand_id = ?'); params.push(brandId); }
    if (requestType) { where.push('rr.request_type = ?'); params.push(requestType); }
    if (status) { where.push('rr.status = ?'); params.push(status); }
    if (warehouseId) { where.push('rr.return_warehouse_id = ?'); params.push(warehouseId); }
    if (Array.isArray(warehouseIds)) {
      if (!warehouseIds.length) return Promise.resolve([]);
      where.push(`rr.return_warehouse_id IN (${warehouseIds.map(() => '?').join(',')})`);
      params.push(...warehouseIds);
    }
    if (qcPending) where.push("rr.status = 'RECEIVED'");
    if (resolutionPending) where.push("rr.status = 'RESOLUTION_PENDING'");
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT rr.id, rr.request_number, rr.customer_id, rr.order_id, o.order_number, rr.request_type,
              rr.status, rr.qc_result, rr.reason_code, rr.return_warehouse_id, rr.requested_at, rr.updated_at,
              CONCAT_WS(' ', c.first_name, c.last_name) AS customer_name,
              (SELECT COALESCE(SUM(quantity),0) FROM return_request_items WHERE return_request_id = rr.id) AS unit_count,
              rs.status AS reverse_status, ra.status AS refund_status, ra.method AS refund_method
         FROM return_requests rr
         JOIN orders o ON o.id = rr.order_id
         LEFT JOIN customers c ON c.id = rr.customer_id
         LEFT JOIN return_shipments rs ON rs.return_request_id = rr.id
         LEFT JOIN refund_attempts ra ON ra.return_request_id = rr.id
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY rr.requested_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, params);
  }

  listByCustomer(customerId) {
    return query(
      `SELECT id, request_number, order_id, request_type, status, qc_result, requested_at
         FROM return_requests WHERE customer_id = ? ORDER BY requested_at DESC`, [customerId]);
  }

  adminReverseShipment(returnRequestId) {
    return query('SELECT * FROM return_shipments WHERE return_request_id = ? LIMIT 1', [returnRequestId]).then((r) => r[0] || null);
  }

  adminReverseTimeline(returnRequestId) {
    return query(
      `SELECT e.normalized_status, e.occurred_at, e.location_text, e.applied
         FROM return_shipment_events e
         JOIN return_shipments s ON s.id = e.return_shipment_id
        WHERE s.return_request_id = ? AND e.applied = 1 ORDER BY e.occurred_at`, [returnRequestId]);
  }

  adminRefundAttempt(returnRequestId) {
    return query('SELECT * FROM refund_attempts WHERE return_request_id = ? LIMIT 1', [returnRequestId]).then((r) => r[0] || null);
  }

  adminCreditNote(returnRequestId) {
    return query('SELECT * FROM credit_notes WHERE return_request_id = ? LIMIT 1', [returnRequestId]).then((r) => r[0] || null);
  }

  adminReplacementFulfillment(returnRequestId) {
    return query('SELECT id, fulfillment_number, warehouse_id, status FROM fulfillments WHERE return_request_id = ? LIMIT 1', [returnRequestId]).then((r) => r[0] || null);
  }

  adminExchangeTransaction(returnRequestId) {
    return query('SELECT id, transaction_number, status, new_exchange_order_id, eligible_value_minor FROM exchange_transactions WHERE return_request_id = ? LIMIT 1', [returnRequestId]).then((r) => r[0] || null);
  }
}

export const returnsRepository = new ReturnsRepository();
export { RELEASING_STATUSES };
