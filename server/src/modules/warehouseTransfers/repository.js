import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) => (connection
  ? (await connection.execute(sql, params))[0]
  : query(sql, params));

// WP-12 / GAP-INV-04 — data access for warehouse_transfers +
// warehouse_transfer_items (schema from migration 017, previously zero code).
export class WarehouseTransferRepository {
  // brand_id derived from the source warehouse — decision §7.3 means a
  // transfer only ever moves stock within one company's own warehouses.
  async create(connection, { sourceWarehouseId, destinationWarehouseId, note, createdByStaffId }) {
    const id = randomUUID();
    const number = `TRF-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${id.replaceAll('-', '').slice(0, 8).toUpperCase()}`;
    await exec(connection,
      `INSERT INTO warehouse_transfers
         (id, brand_id, transfer_number, source_warehouse_id, destination_warehouse_id, status, note, created_by_staff_id)
       VALUES (?, (SELECT brand_id FROM warehouses WHERE id = ?), ?, ?, ?, 'DRAFT', ?, ?)`,
      [id, sourceWarehouseId, number, sourceWarehouseId, destinationWarehouseId, note ?? null, createdByStaffId ?? null]);
    return this.findById(id, connection);
  }

  async addItem(connection, transferId, { skuId, quantity }) {
    await exec(connection,
      `INSERT INTO warehouse_transfer_items (id, transfer_id, sku_id, quantity) VALUES (?, ?, ?, ?)`,
      [randomUUID(), transferId, skuId, quantity]);
  }

  async findById(id, connection = null, { lock = false } = {}) {
    const rows = await exec(connection,
      `SELECT t.*, sw.name AS source_warehouse_name, dw.name AS destination_warehouse_name
         FROM warehouse_transfers t
         JOIN warehouses sw ON sw.id = t.source_warehouse_id
         JOIN warehouses dw ON dw.id = t.destination_warehouse_id
        WHERE t.id = ?${lock ? ' FOR UPDATE' : ''}`,
      [id]);
    return rows[0] || null;
  }

  async items(transferId, connection = null) {
    return exec(connection,
      `SELECT ti.*, s.sku
         FROM warehouse_transfer_items ti
         JOIN skus s ON s.id = ti.sku_id
        WHERE ti.transfer_id = ?
        ORDER BY s.sku`,
      [transferId]);
  }

  async setItemReceived(connection, itemId, quantityReceived) {
    await exec(connection,
      `UPDATE warehouse_transfer_items SET quantity_received = ? WHERE id = ?`,
      [quantityReceived, itemId]);
  }

  async markDispatched(connection, id) {
    await exec(connection,
      `UPDATE warehouse_transfers SET status = 'DISPATCHED', dispatched_at = NOW(3) WHERE id = ?`, [id]);
  }

  async markReceived(connection, id) {
    await exec(connection,
      `UPDATE warehouse_transfers SET status = 'RECEIVED', received_at = NOW(3) WHERE id = ?`, [id]);
  }

  async markCancelled(connection, id) {
    await exec(connection,
      `UPDATE warehouse_transfers SET status = 'CANCELLED', cancelled_at = NOW(3) WHERE id = ?`, [id]);
  }

  #where({ status, warehouseId }) {
    const clauses = [];
    const params = [];
    if (status) { clauses.push('t.status = ?'); params.push(status); }
    if (warehouseId) {
      clauses.push('(t.source_warehouse_id = ? OR t.destination_warehouse_id = ?)');
      params.push(warehouseId, warehouseId);
    }
    return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }

  async list({ status, warehouseId, warehouseIds, limit = 50, offset = 0 }) {
    const filter = this.#where({ status, warehouseId });
    let { sql } = filter;
    const params = [...filter.params];
    if (Array.isArray(warehouseIds)) {
      if (warehouseIds.length === 0) return [];
      const ph = warehouseIds.map(() => '?').join(',');
      sql = sql ? `${sql} AND ` : 'WHERE ';
      sql += `(t.source_warehouse_id IN (${ph}) OR t.destination_warehouse_id IN (${ph}))`;
      params.push(...warehouseIds, ...warehouseIds);
    }
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(offset) || 0, 0);
    return query(
      `SELECT t.*, sw.name AS source_warehouse_name, dw.name AS destination_warehouse_name,
              (SELECT COUNT(*) FROM warehouse_transfer_items ti WHERE ti.transfer_id = t.id) AS line_count,
              (SELECT COALESCE(SUM(ti.quantity), 0) FROM warehouse_transfer_items ti WHERE ti.transfer_id = t.id) AS unit_count
         FROM warehouse_transfers t
         JOIN warehouses sw ON sw.id = t.source_warehouse_id
         JOIN warehouses dw ON dw.id = t.destination_warehouse_id
         ${sql}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`,
      params);
  }

  async count({ status, warehouseId, warehouseIds }) {
    const filter = this.#where({ status, warehouseId });
    let { sql } = filter;
    const params = [...filter.params];
    if (Array.isArray(warehouseIds)) {
      if (warehouseIds.length === 0) return 0;
      const ph = warehouseIds.map(() => '?').join(',');
      sql = sql ? `${sql} AND ` : 'WHERE ';
      sql += `(t.source_warehouse_id IN (${ph}) OR t.destination_warehouse_id IN (${ph}))`;
      params.push(...warehouseIds, ...warehouseIds);
    }
    const rows = await query(`SELECT COUNT(*) AS n FROM warehouse_transfers t ${sql}`, params);
    return Number(rows[0]?.n || 0);
  }
}

export const warehouseTransferRepository = new WarehouseTransferRepository();
