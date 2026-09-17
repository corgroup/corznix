-- WP-12 / GAP-INV-03 — QC-FAIL quarantine.
--
-- Until now a return that FAILED QC restocked nothing and the physical units
-- became phantom stock — received at the warehouse but tracked in no bucket.
-- The `inventory.non_sellable` column has existed since migration 002 (DEFAULT
-- 0, `chk_inventory_nonneg` covers it) and was never written. This wires it up:
-- QC-FAIL units land in `non_sellable`, and a quarantine batch records why so
-- staff can later RELEASE them back to sellable (rework passed) or SCRAP them
-- (write-off). Additive only — the sellable authority (on_hand / reserved /
-- derived available) is untouched.

ALTER TABLE inventory_movements
  DROP CHECK chk_inventory_movements_type,
  ADD CONSTRAINT chk_inventory_movements_type CHECK (movement_type IN (
    'STOCK_RECEIVED','ORDER_RESERVED','ORDER_ALLOCATED','RESERVATION_RELEASED',
    'RESERVATION_EXPIRED','INVENTORY_CONSUMED','ORDER_CANCELLED','RETURN_RESTOCKED',
    'DAMAGED','MANUAL_ADJUSTMENT','TRANSFER_OUT','TRANSFER_IN',
    'QC_QUARANTINED','QC_RELEASED','QC_SCRAPPED'
  ));

CREATE TABLE inventory_quarantine (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  quantity_released INT UNSIGNED NOT NULL DEFAULT 0,
  quantity_scrapped INT UNSIGNED NOT NULL DEFAULT 0,
  reason VARCHAR(255) NULL,
  source_type VARCHAR(32) NOT NULL DEFAULT 'RETURN_QC_FAIL',
  source_ref VARCHAR(64) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  resolved_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_inventory_quarantine_wh_sku (warehouse_id, sku_id),
  KEY idx_inventory_quarantine_status (status, created_at),
  KEY idx_inventory_quarantine_source (source_type, source_ref),
  CONSTRAINT fk_inventory_quarantine_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_quarantine_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE RESTRICT,
  CONSTRAINT fk_inventory_quarantine_staff FOREIGN KEY (created_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_inventory_quarantine_qty CHECK (quantity > 0 AND quantity_released + quantity_scrapped <= quantity),
  CONSTRAINT chk_inventory_quarantine_status CHECK (status IN ('OPEN','RESOLVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
