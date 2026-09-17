import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

// Phase 2 §35 — the carrier pickup-location mapping. Internal warehouse id +
// provider code -> the exact registered identifier the provider expects.
export class WarehouseProviderLocationRepository {
  async listForWarehouse(warehouseId) {
    return query(
      'SELECT * FROM warehouse_provider_locations WHERE warehouse_id = ? ORDER BY provider_code ASC',
      [warehouseId],
    );
  }

  async listForProvider(providerCode) {
    return query(
      'SELECT * FROM warehouse_provider_locations WHERE provider_code = ? ORDER BY warehouse_id ASC',
      [providerCode],
    );
  }

  async find(warehouseId, providerCode) {
    const rows = await query(
      'SELECT * FROM warehouse_provider_locations WHERE warehouse_id = ? AND provider_code = ? LIMIT 1',
      [warehouseId, providerCode],
    );
    return rows[0] || null;
  }

  /** Active identifier for (warehouse, provider), or null. */
  async activeIdentifier(warehouseId, providerCode) {
    const row = await this.find(warehouseId, providerCode);
    return row && row.status === 'ACTIVE' ? row : null;
  }

  async upsert(warehouseId, providerCode, { identifier, returnIdentifier = null, registeredAt = null, panelVerifiedAt = null, panelVerifiedBy = null, status = 'ACTIVE', notes = null, pickupMode = null }) {
    const existing = await this.find(warehouseId, providerCode);
    if (existing) {
      await query(
        `UPDATE warehouse_provider_locations
         SET provider_location_identifier = ?, provider_return_identifier = ?, registered_at = ?,
             panel_verified_at = ?, panel_verified_by = ?, status = ?, notes = ?,
             pickup_mode = COALESCE(?, pickup_mode), updated_at = NOW(3)
         WHERE id = ?`,
        [identifier, returnIdentifier, registeredAt, panelVerifiedAt, panelVerifiedBy, status, notes, pickupMode, existing.id],
      );
      return this.find(warehouseId, providerCode);
    }
    try {
      await query(
        `INSERT INTO warehouse_provider_locations
           (id, warehouse_id, provider_code, provider_location_identifier, provider_return_identifier, registered_at,
            panel_verified_at, panel_verified_by, status, notes, pickup_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, 'MANUAL_PANEL'), NOW(3), NOW(3))`,
        [randomUUID(), warehouseId, providerCode, identifier, returnIdentifier, registeredAt, panelVerifiedAt, panelVerifiedBy, status, notes, pickupMode],
      );
    } catch (err) {
      if (err.code === 'ER_NO_REFERENCED_ROW_2') throw new AppError('WAREHOUSE_NOT_FOUND', 'Warehouse not found.', 404);
      throw err;
    }
    return this.find(warehouseId, providerCode);
  }

  async remove(warehouseId, providerCode) {
    const res = await query(
      'DELETE FROM warehouse_provider_locations WHERE warehouse_id = ? AND provider_code = ?',
      [warehouseId, providerCode],
    );
    return res.affectedRows > 0;
  }
}

export const warehouseProviderLocationRepository = new WarehouseProviderLocationRepository();
