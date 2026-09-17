-- Wave 6B: SKU inventory authority and multi-line reservation state machine.
-- Existing inventory/on-hand values and movement history are preserved.

ALTER TABLE inventory
  ADD CONSTRAINT chk_inventory_reserved_lte_on_hand CHECK (reserved <= on_hand);

ALTER TABLE inventory_movements
  DROP CHECK chk_inventory_movements_type,
  ADD CONSTRAINT chk_inventory_movements_type CHECK (movement_type IN (
    'STOCK_RECEIVED', 'ORDER_RESERVED', 'ORDER_ALLOCATED', 'RESERVATION_RELEASED',
    'RESERVATION_EXPIRED', 'INVENTORY_CONSUMED', 'ORDER_CANCELLED',
    'RETURN_RESTOCKED', 'DAMAGED', 'MANUAL_ADJUSTMENT'
  ));

RENAME TABLE inventory_reservations TO inventory_reservations_legacy;

CREATE TABLE inventory_reservations (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NULL,
  idempotency_key VARCHAR(128) NOT NULL,
  request_fingerprint CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  released_at DATETIME(3) NULL,
  consumed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_inventory_reservations_idempotency (idempotency_key),
  KEY idx_inventory_reservations_status_expiry (status, expires_at),
  KEY idx_inventory_reservations_customer (customer_id, created_at),
  CONSTRAINT fk_inventory_reservations_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT chk_inventory_reservations_wave6b_status CHECK (status IN ('RESERVED', 'RELEASED', 'EXPIRED', 'CONSUMED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE inventory_reservation_items (
  id CHAR(36) NOT NULL,
  reservation_id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_inventory_reservation_items_reservation_sku (reservation_id, sku_id),
  KEY idx_inventory_reservation_items_sku (sku_id),
  CONSTRAINT fk_inventory_reservation_items_reservation FOREIGN KEY (reservation_id) REFERENCES inventory_reservations(id) ON DELETE CASCADE,
  CONSTRAINT fk_inventory_reservation_items_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE RESTRICT,
  CONSTRAINT chk_inventory_reservation_items_quantity CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO inventory_reservations
  (id, customer_id, idempotency_key, request_fingerprint, status, expires_at, created_at, updated_at, released_at, consumed_at)
SELECT id, NULL, CONCAT('legacy:', id), SHA2(CONCAT(sku_id, ':', quantity), 256),
       CASE status WHEN 'ACTIVE' THEN 'RESERVED' ELSE status END,
       expires_at, created_at, created_at, released_at,
       CASE WHEN status='CONSUMED' THEN released_at ELSE NULL END
FROM inventory_reservations_legacy;

INSERT INTO inventory_reservation_items (id, reservation_id, sku_id, quantity, created_at)
SELECT UUID(), id, sku_id, quantity, created_at FROM inventory_reservations_legacy;

DROP TABLE inventory_reservations_legacy;
