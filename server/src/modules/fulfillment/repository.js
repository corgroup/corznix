import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? await connection.execute(sql, params) : [await query(sql, params)])[0];
const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

/**
 * Data access for the Wave 7A fulfillment foundation. Every write path is
 * connection-aware so callers can compose it inside a single transaction.
 * This repository never touches inventory, payment, or pricing tables.
 */
export class FulfillmentRepository {
  /** Locks the Order row — the concurrency gate for ensureForOrder. */
  async lockOrder(connection, orderId) {
    const rows = await exec(connection, 'SELECT * FROM orders WHERE id=? LIMIT 1 FOR UPDATE', [orderId]);
    return rows[0] || null;
  }

  async orderByOwner(customerId, idOrNumber) {
    const rows = await query(
      'SELECT * FROM orders WHERE customer_id=? AND (id=? OR order_number=?) LIMIT 1',
      [customerId, idOrNumber, idOrNumber],
    );
    return rows[0] || null;
  }

  orderItems(connection, orderId) {
    return exec(connection, 'SELECT * FROM order_items WHERE order_id=? ORDER BY created_at,id', [orderId]);
  }

  async initialFulfillment(connection, orderId) {
    const rows = await exec(
      connection,
      "SELECT * FROM fulfillments WHERE order_id=? AND fulfillment_type='INITIAL' ORDER BY sequence LIMIT 1",
      [orderId],
    );
    return rows[0] || null;
  }

  /** All INITIAL fulfillments for an order — one per origin warehouse. */
  initialFulfillments(connection, orderId) {
    return exec(
      connection,
      "SELECT * FROM fulfillments WHERE order_id=? AND fulfillment_type='INITIAL' ORDER BY sequence",
      [orderId],
    );
  }

  /**
   * The authoritative per-warehouse split for an order: the consumed
   * reservation's lines, grouped by warehouse. Empty when the reservation has
   * no itemised lines (legacy / synthetic reservations) — caller falls back to
   * the default warehouse.
   */
  async reservationWarehouseGroups(connection, reservationId) {
    const rows = await exec(
      connection,
      `SELECT ri.warehouse_id, ri.sku_id, ri.quantity, w.code, w.name, w.priority,
              w.address_line1, w.address_line2, w.city, w.state, w.postal_code, w.country,
              w.contact_name, w.contact_phone, w.contact_email
         FROM inventory_reservation_items ri
         JOIN warehouses w ON w.id = ri.warehouse_id
        WHERE ri.reservation_id = ?
        ORDER BY w.priority, ri.warehouse_id, ri.sku_id`,
      [reservationId],
    );
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.warehouse_id)) {
        groups.set(row.warehouse_id, {
          warehouseId: row.warehouse_id,
          warehouse: { id: row.warehouse_id, code: row.code, name: row.name, priority: row.priority, address_line1: row.address_line1, address_line2: row.address_line2, city: row.city, state: row.state, postal_code: row.postal_code, country: row.country, contact_name: row.contact_name, contact_phone: row.contact_phone, contact_email: row.contact_email },
          items: [],
        });
      }
      groups.get(row.warehouse_id).items.push({ skuId: row.sku_id, quantity: Number(row.quantity) });
    }
    return [...groups.values()];
  }

  async warehouseById(connection, warehouseId) {
    const rows = await exec(connection, 'SELECT * FROM warehouses WHERE id=? LIMIT 1', [warehouseId]);
    return rows[0] || null;
  }

  /**
   * Fallback origin when a reservation carries no warehouse-itemised lines:
   * the configured default warehouse (`is_default = 1`), else the highest-
   * priority warehouse. Never keyed off a warehouse code string.
   */
  async defaultWarehouse(connection) {
    const rows = await exec(connection, 'SELECT * FROM warehouses WHERE is_default = 1 LIMIT 1');
    return rows[0] || (await exec(connection, 'SELECT * FROM warehouses ORDER BY priority, id LIMIT 1'))[0] || null;
  }

  fulfillmentsForOrder(connection, orderId) {
    return exec(connection, 'SELECT * FROM fulfillments WHERE order_id=? ORDER BY sequence', [orderId]);
  }

  // ---- WP-11: standalone Fulfillment CMS surface -------------------
  #adminWhere({ status = null, warehouseIds = null, orderNumber = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('f.status = ?'); params.push(status); }
    if (warehouseIds && warehouseIds.length) {
      where.push(`f.warehouse_id IN (${warehouseIds.map(() => '?').join(',')})`);
      params.push(...warehouseIds);
    }
    if (orderNumber) { where.push('o.order_number LIKE ?'); params.push(`%${orderNumber}%`); }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  adminList({ status = null, warehouseIds = null, orderNumber = null, limit = 50, offset = 0 } = {}) {
    const { clause, params } = this.#adminWhere({ status, warehouseIds, orderNumber });
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT f.id, f.fulfillment_number, f.fulfillment_type, f.status, f.readiness_status, f.block_reason,
              f.warehouse_id, f.created_at, f.ready_at, f.fulfilled_at,
              o.id AS order_id, o.order_number, o.order_status, w.name AS warehouse_name,
              (SELECT COALESCE(SUM(fi.quantity), 0) FROM fulfillment_items fi WHERE fi.fulfillment_id = f.id) AS item_count,
              (SELECT COUNT(*) FROM shipments s WHERE s.fulfillment_id = f.id) AS shipment_count
         FROM fulfillments f
         JOIN orders o ON o.id = f.order_id
         JOIN warehouses w ON w.id = f.warehouse_id
        ${clause}
        ORDER BY f.created_at DESC LIMIT ${safeLimit} OFFSET ${safeOffset}`, params);
  }

  async countAdminList(filter = {}) {
    const { clause, params } = this.#adminWhere(filter);
    const rows = await query(`SELECT COUNT(*) AS n FROM fulfillments f JOIN orders o ON o.id = f.order_id ${clause}`, params);
    return Number(rows[0].n);
  }

  adminById(id) {
    return query(
      `SELECT f.*, o.order_number, o.order_status, w.name AS warehouse_name
         FROM fulfillments f
         JOIN orders o ON o.id = f.order_id
         JOIN warehouses w ON w.id = f.warehouse_id
        WHERE f.id = ? LIMIT 1`, [id]).then((r) => r[0] || null);
  }

  items(connection, fulfillmentId) {
    return exec(connection, 'SELECT * FROM fulfillment_items WHERE fulfillment_id=? ORDER BY created_at,id', [fulfillmentId]);
  }

  shipments(connection, fulfillmentId) {
    return exec(connection, 'SELECT * FROM shipments WHERE fulfillment_id=? ORDER BY sequence', [fulfillmentId]);
  }

  async nextSequence(connection, orderId) {
    const rows = await exec(connection, 'SELECT COALESCE(MAX(sequence),0)+1 AS next FROM fulfillments WHERE order_id=?', [orderId]);
    return Number(rows[0].next);
  }

  async insertFulfillment(connection, data) {
    const id = randomUUID();
    await exec(
      connection,
      `INSERT INTO fulfillments
        (id,brand_id,order_id,warehouse_id,fulfillment_number,fulfillment_type,sequence,status,readiness_status,block_reason,
         shipping_address_snapshot_json,shipping_method_snapshot_json,financial_snapshot_json,warehouse_snapshot_json,
         ready_at,cancelled_at)
       VALUES (?,(SELECT brand_id FROM orders WHERE id = ?),?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, data.orderId, data.orderId, data.warehouseId, data.fulfillmentNumber, data.fulfillmentType || 'INITIAL', data.sequence,
        data.status, data.readinessStatus, data.blockReason || null,
        JSON.stringify(data.shippingAddressSnapshot), JSON.stringify(data.shippingMethodSnapshot),
        JSON.stringify(data.financialSnapshot),
        data.warehouseSnapshot ? JSON.stringify(data.warehouseSnapshot) : null,
        data.readinessStatus === 'READY' ? new Date() : null,
        data.status === 'CANCELLED' ? new Date() : null,
      ],
    );
    return (await exec(connection, 'SELECT * FROM fulfillments WHERE id=?', [id]))[0];
  }

  async insertItems(connection, fulfillmentId, allocations) {
    for (const allocation of allocations) {
      await exec(
        connection,
        'INSERT INTO fulfillment_items (id,fulfillment_id,order_item_id,sku_id,quantity) VALUES (?,?,?,?,?)',
        [randomUUID(), fulfillmentId, allocation.orderItemId, allocation.skuId, allocation.quantity],
      );
    }
  }

  /**
   * Hard quantity invariant (§17): the summed non-cancelled allocation for any
   * OrderItem may never exceed the ordered quantity. Evaluated inside the
   * caller's transaction so a violation rolls the whole bootstrap back.
   */
  async assertAllocationWithinOrderedQuantity(connection, orderId) {
    const rows = await exec(
      connection,
      `SELECT oi.id AS order_item_id, oi.quantity AS ordered,
              COALESCE(SUM(fi.quantity),0) AS allocated
         FROM order_items oi
         LEFT JOIN fulfillment_items fi ON fi.order_item_id = oi.id
         LEFT JOIN fulfillments f ON f.id = fi.fulfillment_id AND f.status <> 'CANCELLED'
                AND f.return_request_id IS NULL
        WHERE oi.order_id = ?
        GROUP BY oi.id, oi.quantity
       HAVING allocated > ordered`,
      [orderId],
    );
    if (rows.length) {
      const detail = rows.map((row) => `${row.order_item_id}:${row.allocated}/${row.ordered}`).join(',');
      const error = new Error(`Fulfillment allocation exceeds ordered quantity (${detail}).`);
      error.code = 'FULFILLMENT_ALLOCATION_EXCEEDED';
      throw error;
    }
  }

  async insertShipment(connection, data) {
    const id = randomUUID();
    await exec(
      connection,
      `INSERT INTO shipments
        (id,brand_id,fulfillment_id,warehouse_id,shipment_number,sequence,status,booking_status,service_code,
         package_snapshot_json,cod_collection_minor,
         customer_shipping_charge_minor,actual_logistics_cost_minor,shipping_cost_source)
       VALUES (?,(SELECT brand_id FROM fulfillments WHERE id = ?),?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id, data.fulfillmentId, data.fulfillmentId, data.warehouseId, data.shipmentNumber, data.sequence || 1,
        data.status || 'DRAFT', data.bookingStatus || 'NOT_READY', data.serviceCode || null,
        data.packageSnapshot ? JSON.stringify(data.packageSnapshot) : null,
        data.codCollectionMinor,
        data.customerShippingChargeMinor ?? null,
        data.actualLogisticsCostMinor ?? null,
        data.shippingCostSource ?? null,
      ],
    );
    return (await exec(connection, 'SELECT * FROM shipments WHERE id=?', [id]))[0];
  }

  recordEvent(connection, fulfillmentId, event) {
    return exec(
      connection,
      'INSERT INTO fulfillment_events (id,fulfillment_id,event_type,from_status,to_status,detail_json) VALUES (?,?,?,?,?,?)',
      [
        randomUUID(), fulfillmentId, event.type, event.fromStatus || null, event.toStatus || null,
        event.detail ? JSON.stringify(event.detail) : null,
      ],
    );
  }

  events(fulfillmentId) {
    return query('SELECT * FROM fulfillment_events WHERE fulfillment_id=? ORDER BY created_at,id', [fulfillmentId]);
  }

  /** Bare status read for a single fulfilment id (WP-01 shipment bridge). */
  async statusById(connection, fulfillmentId) {
    const rows = await exec(connection, 'SELECT status FROM fulfillments WHERE id=? LIMIT 1', [fulfillmentId]);
    return rows[0]?.status ?? null;
  }

  /**
   * Completion check for the shipment -> fulfilment -> order bridge (WP-01):
   * counts this order's INITIAL fulfilments by status. The caller (not this
   * query) decides the completion rule — kept here only as a cheap single
   * read instead of re-fetching every fulfilment row.
   */
  async initialFulfillmentStatusCounts(connection, orderId) {
    const rows = await exec(
      connection,
      `SELECT status, COUNT(*) AS n FROM fulfillments
        WHERE order_id = ? AND fulfillment_type = 'INITIAL' GROUP BY status`,
      [orderId],
    );
    const counts = {};
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  updateFulfillmentStatus(connection, fulfillmentId, status, timestamps = {}) {
    const sets = ['status=?', 'updated_at=NOW(3)'];
    const params = [status];
    for (const [column, value] of Object.entries(timestamps)) {
      sets.push(`${column}=?`);
      params.push(value);
    }
    params.push(fulfillmentId);
    return exec(connection, `UPDATE fulfillments SET ${sets.join(',')} WHERE id=?`, params);
  }

  /**
   * Orders that have no INITIAL fulfillment yet — the backfill / recovery scan
   * (§39, §7A.1 §9). The anti-join is expressed as NOT EXISTS against
   * `uk_fulfillments_initial_order` (the generated-column unique index), so it
   * is an indexed lookup, never a table scan of `fulfillments`. Orders with no
   * fulfillable line items are excluded (§7A.1 §8); already-cancelled Orders
   * are still returned so recovery can record their CANCELLED fulfillment.
   */
  ordersMissingFulfillment(limit = 100) {
    return query(
      `SELECT o.id
         FROM orders o
        WHERE NOT EXISTS (SELECT 1 FROM fulfillments f WHERE f.order_id = o.id AND f.fulfillment_type = 'INITIAL')
          AND EXISTS (SELECT 1 FROM order_items oi WHERE oi.order_id = o.id AND oi.quantity > 0)
        ORDER BY o.placed_at
        LIMIT ?`,
      [Number(limit)],
    );
  }

  updateReadiness(connection, fulfillmentId, { readinessStatus, blockReason, readyAt = null }) {
    return exec(
      connection,
      'UPDATE fulfillments SET readiness_status=?, block_reason=?, ready_at=COALESCE(ready_at, ?), updated_at=NOW(3) WHERE id=?',
      [readinessStatus, blockReason || null, readyAt, fulfillmentId],
    );
  }

  updateShipmentDraft(connection, shipmentId, { bookingStatus, packageSnapshot }) {
    return exec(
      connection,
      "UPDATE shipments SET booking_status=?, package_snapshot_json=?, updated_at=NOW(3) WHERE id=? AND status='DRAFT'",
      [bookingStatus, packageSnapshot ? JSON.stringify(packageSnapshot) : null, shipmentId],
    );
  }

  cancelDraftShipments(connection, fulfillmentId) {
    return exec(
      connection,
      "UPDATE shipments SET status='CANCELLED', booking_status='CANCELLED', cancelled_at=NOW(3), updated_at=NOW(3) WHERE fulfillment_id=? AND status='DRAFT'",
      [fulfillmentId],
    );
  }

  parse = parse;
}

export const fulfillmentRepository = new FulfillmentRepository();
