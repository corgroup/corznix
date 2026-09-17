import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) => (connection
  ? (await connection.execute(sql, params))[0]
  : query(sql, params));

// WP-12 / GAP-INV-03 — data access for inventory_quarantine (migration 055).
export class InventoryQuarantineRepository {
  // brand_id derived from the warehouse — decision §7.3.
  async create(connection, { warehouseId, skuId, quantity, reason, sourceType = 'RETURN_QC_FAIL', sourceRef = null, createdByStaffId = null }) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO inventory_quarantine
         (id, brand_id, warehouse_id, sku_id, quantity, reason, source_type, source_ref, created_by_staff_id)
       VALUES (?, (SELECT brand_id FROM warehouses WHERE id = ?), ?, ?, ?, ?, ?, ?, ?)`,
      [id, warehouseId, warehouseId, skuId, quantity, reason ?? null, sourceType, sourceRef, createdByStaffId]);
    return this.findById(id, connection);
  }

  async findById(id, connection = null, { lock = false } = {}) {
    const rows = await exec(connection,
      `SELECT q.*, s.sku, w.name AS warehouse_name
         FROM inventory_quarantine q
         JOIN skus s ON s.id = q.sku_id
         JOIN warehouses w ON w.id = q.warehouse_id
        WHERE q.id = ?${lock ? ' FOR UPDATE' : ''}`,
      [id]);
    return rows[0] || null;
  }

  async applyDisposition(connection, id, { releasedDelta = 0, scrappedDelta = 0 }) {
    // MySQL evaluates SET expressions left-to-right, so the status / resolved_at
    // clauses below see the already-incremented counters.
    await exec(connection,
      `UPDATE inventory_quarantine
          SET quantity_released = quantity_released + ?,
              quantity_scrapped = quantity_scrapped + ?,
              status = CASE WHEN quantity_released + quantity_scrapped >= quantity THEN 'RESOLVED' ELSE 'OPEN' END,
              resolved_at = CASE WHEN quantity_released + quantity_scrapped >= quantity THEN COALESCE(resolved_at, NOW(3)) ELSE NULL END
        WHERE id = ?`,
      [releasedDelta, scrappedDelta, id]);
    return this.findById(id, connection);
  }

  async bySource(sourceType, sourceRef, connection = null) {
    return exec(connection,
      `SELECT id FROM inventory_quarantine WHERE source_type = ? AND source_ref = ?`,
      [sourceType, sourceRef]);
  }

  #where({ status, warehouseId, skuId }) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('q.status = ?'); params.push(status); }
    if (warehouseId) { clauses.push('q.warehouse_id = ?'); params.push(warehouseId); }
    if (skuId) { clauses.push('q.sku_id = ?'); params.push(skuId); }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  async list({ status, warehouseId, warehouseIds, skuId, limit = 50, offset = 0 }) {
    const base = this.#where({ status, warehouseId, skuId });
    let { sql } = base;
    const params = [...base.params];
    if (Array.isArray(warehouseIds)) {
      if (warehouseIds.length === 0) return [];
      const ph = warehouseIds.map(() => '?').join(',');
      sql = sql ? `${sql} AND q.warehouse_id IN (${ph})` : `WHERE q.warehouse_id IN (${ph})`;
      params.push(...warehouseIds);
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT q.*, s.sku, w.name AS warehouse_name,
              p.name AS product_name, v.color_name
         FROM inventory_quarantine q
         JOIN skus s ON s.id = q.sku_id
         JOIN warehouses w ON w.id = q.warehouse_id
         LEFT JOIN product_variants v ON v.id = s.variant_id
         LEFT JOIN products p ON p.id = v.product_id
         ${sql}
        ORDER BY q.status = 'OPEN' DESC, q.created_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params);
  }

  async count({ status, warehouseId, warehouseIds, skuId }) {
    const base = this.#where({ status, warehouseId, skuId });
    let { sql } = base;
    const params = [...base.params];
    if (Array.isArray(warehouseIds)) {
      if (warehouseIds.length === 0) return 0;
      const ph = warehouseIds.map(() => '?').join(',');
      sql = sql ? `${sql} AND q.warehouse_id IN (${ph})` : `WHERE q.warehouse_id IN (${ph})`;
      params.push(...warehouseIds);
    }
    const rows = await query(`SELECT COUNT(*) AS n FROM inventory_quarantine q ${sql}`, params);
    return Number(rows[0]?.n || 0);
  }

  /** Sum of still-quarantined units per (warehouse, sku) — used by the drift check. */
  async openRemainingByWarehouseSku() {
    return query(
      `SELECT warehouse_id, sku_id,
              SUM(quantity - quantity_released - quantity_scrapped) AS remaining
         FROM inventory_quarantine
        WHERE status = 'OPEN'
        GROUP BY warehouse_id, sku_id
        HAVING remaining <> 0`);
  }
}

export const inventoryQuarantineRepository = new InventoryQuarantineRepository();
