-- Multi-warehouse commerce foundation.
--
-- Evolves the single global inventory authority into a warehouse-scoped
-- one WITHOUT creating a second authority: `inventory` keeps being the
-- single balance-of-record, now keyed by (warehouse_id, sku_id). Existing
-- balances, reservations, movements and fulfillments are backfilled to one
-- migration-anchor warehouse (WH-DEFAULT) so nothing is lost.
--
-- Forward-safe, non-destructive: no DROP TABLE, no data reset. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. Warehouse master + the migration-anchor warehouse
-- ---------------------------------------------------------------------------
CREATE TABLE warehouses (
  id CHAR(36) NOT NULL,
  code VARCHAR(32) NOT NULL,
  name VARCHAR(160) NOT NULL,
  address_line1 VARCHAR(255) NULL,
  address_line2 VARCHAR(255) NULL,
  city VARCHAR(120) NULL,
  state VARCHAR(120) NULL,
  postal_code VARCHAR(12) NULL,
  country CHAR(2) NOT NULL DEFAULT 'IN',
  contact_name VARCHAR(160) NULL,
  contact_phone VARCHAR(20) NULL,
  contact_email VARCHAR(255) NULL,
  -- Lower = preferred when several warehouses can each fulfil an order.
  priority INT NOT NULL DEFAULT 100,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_warehouses_code (code),
  KEY idx_warehouses_status_priority (status, priority),
  CONSTRAINT chk_warehouses_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The anchor. Real warehouse master data (dev fixtures / staging) is entered
-- through the CMS; this row only exists so existing inventory has a home.
INSERT INTO warehouses (id, code, name, status, priority)
VALUES ('00000000-0000-4000-8000-000000000001', 'WH-DEFAULT', 'Default Warehouse', 'ACTIVE', 100);

-- ---------------------------------------------------------------------------
-- 2. Staff -> warehouse scope
-- ---------------------------------------------------------------------------
CREATE TABLE staff_warehouse_assignments (
  id CHAR(36) NOT NULL,
  staff_user_id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_staff_warehouse (staff_user_id, warehouse_id),
  KEY idx_staff_warehouse_warehouse (warehouse_id),
  CONSTRAINT fk_staff_warehouse_staff FOREIGN KEY (staff_user_id) REFERENCES staff_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_staff_warehouse_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. inventory -> warehouse-scoped authority
-- ---------------------------------------------------------------------------
ALTER TABLE inventory
  ADD COLUMN warehouse_id CHAR(36) NULL AFTER id;

UPDATE inventory SET warehouse_id = '00000000-0000-4000-8000-000000000001' WHERE warehouse_id IS NULL;

-- fk_inventory_sku currently leans on uk_inventory_sku; give it a plain
-- index first so the unique key can be replaced by the composite one.
ALTER TABLE inventory ADD KEY idx_inventory_sku (sku_id);
ALTER TABLE inventory DROP INDEX uk_inventory_sku;
ALTER TABLE inventory
  MODIFY COLUMN warehouse_id CHAR(36) NOT NULL,
  ADD UNIQUE KEY uk_inventory_warehouse_sku (warehouse_id, sku_id),
  ADD CONSTRAINT fk_inventory_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 4. reservation items -> warehouse-scoped (a reservation line is stock at
--    a specific warehouse)
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_reservation_items
  ADD COLUMN warehouse_id CHAR(36) NULL AFTER reservation_id;

UPDATE inventory_reservation_items SET warehouse_id = '00000000-0000-4000-8000-000000000001' WHERE warehouse_id IS NULL;

-- fk_inventory_reservation_items_reservation leans on the composite unique;
-- give it a plain index before replacing that key.
ALTER TABLE inventory_reservation_items ADD KEY idx_inventory_reservation_items_reservation (reservation_id);
ALTER TABLE inventory_reservation_items DROP INDEX uk_inventory_reservation_items_reservation_sku;
ALTER TABLE inventory_reservation_items
  MODIFY COLUMN warehouse_id CHAR(36) NOT NULL,
  ADD UNIQUE KEY uk_inventory_reservation_items_line (reservation_id, warehouse_id, sku_id),
  ADD CONSTRAINT fk_inventory_reservation_items_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 5. movements -> warehouse-aware; add inter-warehouse transfer types
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_movements
  ADD COLUMN warehouse_id CHAR(36) NULL AFTER sku_id;

UPDATE inventory_movements SET warehouse_id = '00000000-0000-4000-8000-000000000001' WHERE warehouse_id IS NULL;

ALTER TABLE inventory_movements
  MODIFY COLUMN warehouse_id CHAR(36) NOT NULL,
  ADD KEY idx_inventory_movements_warehouse (warehouse_id, created_at),
  ADD CONSTRAINT fk_inventory_movements_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  DROP CHECK chk_inventory_movements_type,
  ADD CONSTRAINT chk_inventory_movements_type CHECK (movement_type IN (
    'STOCK_RECEIVED','ORDER_RESERVED','ORDER_ALLOCATED','RESERVATION_RELEASED',
    'RESERVATION_EXPIRED','INVENTORY_CONSUMED','ORDER_CANCELLED','RETURN_RESTOCKED',
    'DAMAGED','MANUAL_ADJUSTMENT','TRANSFER_OUT','TRANSFER_IN'
  ));

-- ---------------------------------------------------------------------------
-- 6. checkout session keeps its warehouse allocation intent
-- ---------------------------------------------------------------------------
ALTER TABLE checkout_sessions
  ADD COLUMN warehouse_allocation_json JSON NULL AFTER shipping_quote_reference;

-- ---------------------------------------------------------------------------
-- 7. fulfillment + shipment warehouse ownership + immutable warehouse snapshot
-- ---------------------------------------------------------------------------
ALTER TABLE fulfillments
  ADD COLUMN warehouse_id CHAR(36) NULL AFTER order_id,
  ADD COLUMN warehouse_snapshot_json JSON NULL AFTER financial_snapshot_json;

UPDATE fulfillments SET warehouse_id = '00000000-0000-4000-8000-000000000001' WHERE warehouse_id IS NULL;

-- One Order may now have several INITIAL fulfillments — one per warehouse.
-- The initial-order guard therefore becomes (order_id, warehouse_id) rather
-- than order_id alone.
ALTER TABLE fulfillments
  DROP INDEX uk_fulfillments_initial_order,
  DROP COLUMN initial_order_guard;

ALTER TABLE fulfillments
  ADD COLUMN initial_order_warehouse_guard VARCHAR(80) GENERATED ALWAYS AS (
    CASE WHEN fulfillment_type = 'INITIAL' THEN CONCAT(order_id, ':', COALESCE(warehouse_id, '')) ELSE NULL END
  ) STORED,
  ADD UNIQUE KEY uk_fulfillments_initial_order_warehouse (initial_order_warehouse_guard),
  ADD CONSTRAINT fk_fulfillments_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT;

ALTER TABLE shipments
  ADD COLUMN warehouse_id CHAR(36) NULL AFTER fulfillment_id;

UPDATE shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
  SET s.warehouse_id = f.warehouse_id WHERE s.warehouse_id IS NULL;

ALTER TABLE shipments
  ADD KEY idx_shipments_warehouse (warehouse_id),
  ADD CONSTRAINT fk_shipments_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 8. inter-warehouse transfer foundation (lifecycle enforced in the service;
--    in-transit stock is neither at source nor available at destination)
-- ---------------------------------------------------------------------------
CREATE TABLE warehouse_transfers (
  id CHAR(36) NOT NULL,
  transfer_number VARCHAR(48) NOT NULL,
  source_warehouse_id CHAR(36) NOT NULL,
  destination_warehouse_id CHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  note VARCHAR(500) NULL,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  dispatched_at DATETIME(3) NULL,
  received_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_warehouse_transfers_number (transfer_number),
  KEY idx_warehouse_transfers_status (status),
  CONSTRAINT fk_warehouse_transfers_source FOREIGN KEY (source_warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  CONSTRAINT fk_warehouse_transfers_dest FOREIGN KEY (destination_warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  CONSTRAINT fk_warehouse_transfers_staff FOREIGN KEY (created_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_warehouse_transfers_status CHECK (status IN ('DRAFT','DISPATCHED','IN_TRANSIT','RECEIVED','CANCELLED')),
  CONSTRAINT chk_warehouse_transfers_distinct CHECK (source_warehouse_id <> destination_warehouse_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE warehouse_transfer_items (
  id CHAR(36) NOT NULL,
  transfer_id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  quantity_received INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_warehouse_transfer_items_line (transfer_id, sku_id),
  KEY idx_warehouse_transfer_items_sku (sku_id),
  CONSTRAINT fk_warehouse_transfer_items_transfer FOREIGN KEY (transfer_id) REFERENCES warehouse_transfers(id) ON DELETE CASCADE,
  CONSTRAINT fk_warehouse_transfer_items_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE RESTRICT,
  CONSTRAINT chk_warehouse_transfer_items_qty CHECK (quantity > 0 AND quantity_received <= quantity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
