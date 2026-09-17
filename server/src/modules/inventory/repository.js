import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';

const exec = async (connection, sql, params = []) => connection
  ? (await connection.execute(sql, params))[0]
  : query(sql, params);

// Balance-of-record, warehouse-scoped: the single inventory authority,
// keyed by (warehouse_id, sku_id). `available` is always on_hand - reserved
// and is never stored.
export class InventoryRepository {
  /**
   * @param {Array<{warehouseId:string, skuId:string}>} pairs
   */
  findByWarehouseSkus(pairs, connection = null, { lock = false } = {}) {
    if (!pairs.length) return [];
    const where = pairs.map(() => '(i.warehouse_id = ? AND i.sku_id = ?)').join(' OR ');
    const params = pairs.flatMap((p) => [p.warehouseId, p.skuId]);
    return exec(connection,
      `SELECT i.*, s.sku FROM inventory i JOIN skus s ON s.id = i.sku_id
       WHERE ${where} ORDER BY i.warehouse_id, i.sku_id${lock ? ' FOR UPDATE' : ''}`,
      params);
  }

  /** Per-warehouse rows for a set of SKUs (read-only, cross-warehouse view). */
  findForSkuIds(skuIds, connection = null) {
    if (!skuIds.length) return [];
    const placeholders = skuIds.map(() => '?').join(',');
    return exec(connection,
      `SELECT i.*, s.sku FROM inventory i JOIN skus s ON s.id = i.sku_id
       WHERE i.sku_id IN (${placeholders}) ORDER BY i.sku_id, i.warehouse_id`, skuIds);
  }

  /** Rows for a whole warehouse (CMS warehouse-inventory view). */
  findForWarehouse(warehouseId, { skuIds = null } = {}) {
    const params = [warehouseId];
    let filter = '';
    if (skuIds && skuIds.length) {
      filter = ` AND i.sku_id IN (${skuIds.map(() => '?').join(',')})`;
      params.push(...skuIds);
    }
    return query(
      `SELECT i.*, s.sku, s.size, v.color_name, p.name AS product_name, v.product_id
         FROM inventory i
         JOIN skus s ON s.id = i.sku_id
         JOIN product_variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE i.warehouse_id = ?${filter}
        ORDER BY p.name, v.color_name, s.size`, params);
  }

  // ---- WP-12: standalone Inventory CMS read surface -------------------

  #searchWhere({ warehouseIds, q, lowStockOnly }) {
    const where = [];
    const params = [];
    if (warehouseIds && warehouseIds.length) {
      where.push(`i.warehouse_id IN (${warehouseIds.map(() => '?').join(',')})`);
      params.push(...warehouseIds);
    }
    if (q) {
      where.push('(s.sku LIKE ? OR p.name LIKE ?)');
      params.push(`%${q}%`, `%${q}%`);
    }
    if (lowStockOnly) {
      where.push('i.low_stock_threshold IS NOT NULL AND (i.on_hand - i.reserved) <= i.low_stock_threshold');
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  /** Cross-warehouse inventory list for the standalone Inventory page. */
  search({ warehouseIds = null, q = null, lowStockOnly = false, limit = 50, offset = 0 } = {}) {
    const { clause, params } = this.#searchWhere({ warehouseIds, q, lowStockOnly });
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT i.warehouse_id, i.sku_id, i.on_hand, i.reserved, i.non_sellable, i.low_stock_threshold,
              s.sku, s.size, v.color_name, p.name AS product_name, p.id AS product_id, w.name AS warehouse_name
         FROM inventory i
         JOIN skus s ON s.id = i.sku_id
         JOIN product_variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
         JOIN warehouses w ON w.id = i.warehouse_id
        ${clause}
        ORDER BY p.name, v.color_name, s.size, w.name
        LIMIT ${safeLimit} OFFSET ${safeOffset}`, params);
  }

  async countSearch({ warehouseIds = null, q = null, lowStockOnly = false } = {}) {
    const { clause, params } = this.#searchWhere({ warehouseIds, q, lowStockOnly });
    const rows = await query(
      `SELECT COUNT(*) AS n
         FROM inventory i
         JOIN skus s ON s.id = i.sku_id
         JOIN product_variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
        ${clause}`, params);
    return Number(rows[0].n);
  }

  /** One inventory row with product + threshold for the detail view. */
  oneWithProduct(warehouseId, skuId, connection = null) {
    return exec(connection,
      `SELECT i.*, s.sku, s.size, v.color_name, p.name AS product_name, p.id AS product_id, w.name AS warehouse_name
         FROM inventory i
         JOIN skus s ON s.id = i.sku_id
         JOIN product_variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
         JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.warehouse_id = ? AND i.sku_id = ? LIMIT 1`, [warehouseId, skuId]).then((r) => r[0] || null);
  }

  async updateLowStockThreshold(connection, warehouseId, skuId, threshold) {
    const result = await exec(connection,
      `UPDATE inventory SET low_stock_threshold = ?, updated_at = NOW(3)
        WHERE warehouse_id = ? AND sku_id = ?`, [threshold, warehouseId, skuId]);
    return result.affectedRows === 1;
  }

  // brand_id derived from the warehouse — decision §7.3 (warehouses are
  // strictly per-company), so an inventory row can never disagree with its
  // own warehouse's company.
  async ensureRow(connection, warehouseId, skuId) {
    await exec(connection,
      `INSERT INTO inventory (id, brand_id, warehouse_id, sku_id, on_hand, reserved, created_at, updated_at)
       VALUES (?, (SELECT brand_id FROM warehouses WHERE id = ?), ?, ?, 0, 0, NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE updated_at = updated_at`,
      [randomUUID(), warehouseId, warehouseId, skuId]);
  }

  async changeReserved(connection, warehouseId, skuId, delta) {
    const result = await exec(connection,
      `UPDATE inventory SET reserved = reserved + ?, updated_at = NOW(3)
       WHERE warehouse_id = ? AND sku_id = ? AND reserved + ? BETWEEN 0 AND on_hand`,
      [delta, warehouseId, skuId, delta]);
    return result.affectedRows === 1;
  }

  async consume(connection, warehouseId, skuId, quantity) {
    const result = await exec(connection,
      `UPDATE inventory SET on_hand = on_hand - ?, reserved = reserved - ?, updated_at = NOW(3)
       WHERE warehouse_id = ? AND sku_id = ? AND on_hand >= ? AND reserved >= ?`,
      [quantity, quantity, warehouseId, skuId, quantity, quantity]);
    return result.affectedRows === 1;
  }

  /** Absolute on-hand set (never below reserved). */
  async setOnHand(connection, warehouseId, skuId, onHand) {
    const result = await exec(connection,
      `UPDATE inventory SET on_hand = ?, updated_at = NOW(3)
       WHERE warehouse_id = ? AND sku_id = ? AND ? >= reserved`,
      [onHand, warehouseId, skuId, onHand]);
    return result.affectedRows === 1;
  }

  /** Signed on-hand delta for a manual adjustment. Never lets on_hand drop below reserved. */
  async adjustOnHand(connection, warehouseId, skuId, delta) {
    const result = await exec(connection,
      `UPDATE inventory SET on_hand = on_hand + ?, updated_at = NOW(3)
       WHERE warehouse_id = ? AND sku_id = ? AND on_hand + ? >= reserved AND on_hand + ? >= 0`,
      [delta, warehouseId, skuId, delta, delta]);
    return result.affectedRows === 1;
  }

  // ---- WP-12 / GAP-INV-03 — QC-FAIL quarantine (the non_sellable bucket) ----

  /** QC-FAIL units enter quarantine: non_sellable up. on_hand is untouched. */
  async addNonSellable(connection, warehouseId, skuId, quantity) {
    const result = await exec(connection,
      `UPDATE inventory SET non_sellable = non_sellable + ?, updated_at = NOW(3)
       WHERE warehouse_id = ? AND sku_id = ?`,
      [quantity, warehouseId, skuId]);
    return result.affectedRows === 1;
  }

  /** Release from quarantine back to sellable: non_sellable down, on_hand up. */
  async releaseNonSellable(connection, warehouseId, skuId, quantity) {
    const result = await exec(connection,
      `UPDATE inventory SET non_sellable = non_sellable - ?, on_hand = on_hand + ?, updated_at = NOW(3)
       WHERE warehouse_id = ? AND sku_id = ? AND non_sellable >= ?`,
      [quantity, quantity, warehouseId, skuId, quantity]);
    return result.affectedRows === 1;
  }

  /** Write off from quarantine: non_sellable down. on_hand is untouched. */
  async scrapNonSellable(connection, warehouseId, skuId, quantity) {
    const result = await exec(connection,
      `UPDATE inventory SET non_sellable = non_sellable - ?, updated_at = NOW(3)
       WHERE warehouse_id = ? AND sku_id = ? AND non_sellable >= ?`,
      [quantity, warehouseId, skuId, quantity]);
    return result.affectedRows === 1;
  }
}

export class ReservationRepository {
  /** SKU quantities a customer holds right now in live reservations. */
  heldByCustomer(customerId, skuIds, connection = null) {
    if (!customerId || !skuIds.length) return [];
    const placeholders = skuIds.map(() => '?').join(',');
    return exec(connection,
      `SELECT ri.sku_id, SUM(ri.quantity) AS quantity
         FROM inventory_reservation_items ri
         JOIN inventory_reservations ir ON ir.id = ri.reservation_id
        WHERE ir.customer_id = ? AND ir.status = 'RESERVED' AND ir.expires_at > NOW(3)
          AND ri.sku_id IN (${placeholders})
        GROUP BY ri.sku_id`, [customerId, ...skuIds]);
  }

  /**
   * Push a live hold's expiry out to now + ttl, never past created_at +
   * maxLifetime, and never earlier than it already is (a payment hold may be
   * longer). Returns the expiry that now stands, or null if the hold is gone.
   */
  async extend(connection, id, { ttlSeconds, maxLifetimeSeconds }) {
    await exec(connection,
      `UPDATE inventory_reservations
          SET expires_at = GREATEST(expires_at, LEAST(DATE_ADD(NOW(3), INTERVAL ? SECOND), DATE_ADD(created_at, INTERVAL ? SECOND))),
              updated_at = NOW(3)
        WHERE id = ? AND status = 'RESERVED' AND expires_at > NOW(3)`,
      [Number(ttlSeconds), Number(maxLifetimeSeconds), id]);
    const rows = await exec(connection,
      `SELECT expires_at FROM inventory_reservations WHERE id = ? AND status = 'RESERVED' AND expires_at > NOW(3) LIMIT 1`, [id]);
    return rows[0]?.expires_at || null;
  }

  async findByIdempotencyKey(key, connection = null, { lock = false } = {}) {
    const rows = await exec(connection,
      `SELECT * FROM inventory_reservations WHERE idempotency_key = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [key]);
    return rows[0] || null;
  }

  async findById(id, connection = null, { lock = false } = {}) {
    const rows = await exec(connection,
      `SELECT *, expires_at <= NOW(3) AS is_expired FROM inventory_reservations WHERE id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id]);
    return rows[0] || null;
  }

  // brand_id derived from the customer — same reasoning as carts/checkout.
  // Every real caller (checkout/service.js) always has a customerId; a
  // handful of low-level test fixtures reserve with no customer in the
  // loop at all, so a missing customerId falls back to the default brand
  // (same safe-default principle as utils/defaultBrand.js) rather than
  // inserting a NULL brand_id.
  async create(connection, { id, customerId, idempotencyKey, fingerprint, ttlSeconds }) {
    const customerBrand = customerId
      ? (await exec(connection, 'SELECT brand_id FROM customers WHERE id = ?', [customerId]))[0]?.brand_id
      : null;
    const brandId = await resolveBrandId(customerBrand);
    await exec(connection,
      `INSERT INTO inventory_reservations
       (id, brand_id, customer_id, idempotency_key, request_fingerprint, status, expires_at)
       VALUES (?, ?, ?, ?, ?, 'RESERVED', DATE_ADD(NOW(3), INTERVAL ? SECOND))`,
      [id, brandId, customerId, idempotencyKey, fingerprint, ttlSeconds]);
  }

  async addItems(connection, reservationId, items) {
    for (const item of items) {
      await exec(connection,
        'INSERT INTO inventory_reservation_items (id, reservation_id, warehouse_id, sku_id, quantity) VALUES (?, ?, ?, ?, ?)',
        [randomUUID(), reservationId, item.warehouseId, item.skuId, item.quantity]);
    }
  }

  items(reservationId, connection = null) {
    return exec(connection,
      `SELECT ri.warehouse_id, ri.sku_id, s.sku, ri.quantity FROM inventory_reservation_items ri
       JOIN skus s ON s.id = ri.sku_id WHERE ri.reservation_id = ? ORDER BY ri.warehouse_id, ri.sku_id`, [reservationId]);
  }

  async transition(connection, id, status) {
    const terminalColumn = status === 'CONSUMED' ? 'consumed_at' : 'released_at';
    await exec(connection,
      `UPDATE inventory_reservations SET status = ?, ${terminalColumn} = NOW(3), updated_at = NOW(3)
       WHERE id = ? AND status = 'RESERVED'`, [status, id]);
  }

  async expiredIds(limit) {
    return query(
      `SELECT id FROM inventory_reservations
       WHERE status = 'RESERVED' AND expires_at <= NOW(3)
       ORDER BY expires_at LIMIT ?`, [Number(limit)]);
  }

  /** Open (RESERVED) reservation lines touching one (warehouse, sku) — WP-12 detail view. */
  openForWarehouseSku(warehouseId, skuId) {
    return query(
      `SELECT r.id AS reservation_id, r.customer_id, r.expires_at, r.created_at, ri.quantity
         FROM inventory_reservation_items ri
         JOIN inventory_reservations r ON r.id = ri.reservation_id
        WHERE ri.warehouse_id = ? AND ri.sku_id = ? AND r.status = 'RESERVED'
        ORDER BY r.expires_at`, [warehouseId, skuId]);
  }
}

export class InventoryMovementRepository {
  record(connection, {
    warehouseId, skuId, type, quantity, referenceType = 'INVENTORY_RESERVATION',
    referenceId = null, reason = null, actorStaffId = null, balanceAfter = null,
  }) {
    return exec(connection,
      `INSERT INTO inventory_movements
       (id, sku_id, warehouse_id, movement_type, quantity_delta, reference_type, reference_id, reason, actor_staff_id, balance_after)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [randomUUID(), skuId, warehouseId, type, quantity, referenceType, referenceId, reason, actorStaffId, balanceAfter]);
  }

  /** Movement history for one (warehouse, sku), newest first, with the actor's email. */
  forWarehouseSku(warehouseId, skuId, limit = 50) {
    const safe = Math.min(Math.max(Number(limit) || 50, 1), 200);
    return query(
      `SELECT m.*, su.email AS actor_email
         FROM inventory_movements m
         LEFT JOIN staff_users su ON su.id = m.actor_staff_id
        WHERE m.warehouse_id = ? AND m.sku_id = ?
        ORDER BY m.created_at DESC, m.id DESC LIMIT ${safe}`, [warehouseId, skuId]);
  }
}

export const inventoryRepository = new InventoryRepository();
export const reservationRepository = new ReservationRepository();
export const inventoryMovementRepository = new InventoryMovementRepository();
