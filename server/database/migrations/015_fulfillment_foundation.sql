-- Wave 7A: first-party forward fulfillment foundation.
-- Consumes immutable Order truth. Never mutates inventory, never reprices,
-- never books a carrier. Provider fields stay NULL until Wave 7B.
-- Forward-only, non-destructive: CREATE TABLE only.

CREATE TABLE fulfillments (
  id CHAR(36) NOT NULL,
  order_id CHAR(36) NOT NULL,
  fulfillment_number VARCHAR(48) NOT NULL,
  fulfillment_type VARCHAR(16) NOT NULL DEFAULT 'INITIAL',
  sequence INT UNSIGNED NOT NULL DEFAULT 1,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  readiness_status VARCHAR(16) NOT NULL DEFAULT 'BLOCKED',
  block_reason VARCHAR(32) NULL,
  shipping_address_snapshot_json JSON NOT NULL,
  shipping_method_snapshot_json JSON NOT NULL,
  financial_snapshot_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  ready_at DATETIME(3) NULL,
  fulfilled_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  -- Initial-fulfillment uniqueness without blocking future multi-fulfillment
  -- (split shipments / multi-warehouse): the guard is NULL for every
  -- non-initial row, and MySQL permits duplicate NULLs in a UNIQUE index.
  initial_order_guard CHAR(36) GENERATED ALWAYS AS (
    CASE WHEN fulfillment_type = 'INITIAL' THEN order_id ELSE NULL END
  ) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uk_fulfillments_number (fulfillment_number),
  UNIQUE KEY uk_fulfillments_initial_order (initial_order_guard),
  UNIQUE KEY uk_fulfillments_order_sequence (order_id, sequence),
  KEY idx_fulfillments_status (status),
  KEY idx_fulfillments_readiness (readiness_status),
  CONSTRAINT fk_fulfillments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT chk_fulfillment_type CHECK (fulfillment_type IN ('INITIAL','SUPPLEMENTARY')),
  CONSTRAINT chk_fulfillment_status CHECK (status IN (
    'PENDING','READY','PROCESSING','PARTIALLY_FULFILLED','FULFILLED','ON_HOLD','CANCELLED'
  )),
  CONSTRAINT chk_fulfillment_readiness_status CHECK (readiness_status IN ('READY','BLOCKED')),
  CONSTRAINT chk_fulfillment_block_reason CHECK (block_reason IS NULL OR block_reason IN (
    'MISSING_SHIPPING_ADDRESS','MISSING_SHIPPING_METADATA','INVALID_ORDER_STATE',
    'ORDER_CANCELLED','NO_FULFILLABLE_ITEMS'
  )),
  CONSTRAINT chk_fulfillment_readiness_consistency CHECK (
    (readiness_status = 'BLOCKED' AND block_reason IS NOT NULL) OR
    (readiness_status = 'READY' AND block_reason IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fulfillment_items (
  id CHAR(36) NOT NULL,
  fulfillment_id CHAR(36) NOT NULL,
  order_item_id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_fulfillment_items_line (fulfillment_id, order_item_id),
  KEY idx_fulfillment_items_order_item (order_item_id),
  KEY idx_fulfillment_items_sku (sku_id),
  CONSTRAINT fk_fulfillment_items_fulfillment FOREIGN KEY (fulfillment_id) REFERENCES fulfillments(id) ON DELETE CASCADE,
  CONSTRAINT fk_fulfillment_items_order_item FOREIGN KEY (order_item_id) REFERENCES order_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_fulfillment_items_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE RESTRICT,
  CONSTRAINT chk_fulfillment_item_quantity CHECK (quantity > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shipments (
  id CHAR(36) NOT NULL,
  fulfillment_id CHAR(36) NOT NULL,
  shipment_number VARCHAR(48) NOT NULL,
  sequence INT UNSIGNED NOT NULL DEFAULT 1,
  status VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  booking_status VARCHAR(20) NOT NULL DEFAULT 'NOT_READY',
  provider_code VARCHAR(32) NULL,
  service_code VARCHAR(80) NULL,
  external_shipment_id VARCHAR(120) NULL,
  tracking_number VARCHAR(120) NULL,
  tracking_url VARCHAR(500) NULL,
  package_snapshot_json JSON NULL,
  cod_collection_minor INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  booked_at DATETIME(3) NULL,
  shipped_at DATETIME(3) NULL,
  delivered_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_shipments_number (shipment_number),
  UNIQUE KEY uk_shipments_fulfillment_sequence (fulfillment_id, sequence),
  KEY idx_shipments_status (status),
  KEY idx_shipments_booking_status (booking_status),
  CONSTRAINT fk_shipments_fulfillment FOREIGN KEY (fulfillment_id) REFERENCES fulfillments(id) ON DELETE CASCADE,
  CONSTRAINT chk_shipment_status CHECK (status IN (
    'DRAFT','READY_TO_BOOK','BOOKING_PENDING','BOOKED','PICKUP_PENDING','PICKED_UP',
    'IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','FAILED','CANCELLED'
  )),
  CONSTRAINT chk_shipment_booking_status CHECK (booking_status IN (
    'NOT_READY','READY','PENDING','BOOKED','FAILED','CANCELLED'
  )),
  -- Wave 7A never books a carrier: provider identity must stay absent.
  CONSTRAINT chk_shipment_wave7a_no_provider CHECK (
    provider_code IS NULL AND external_shipment_id IS NULL AND
    tracking_number IS NULL AND tracking_url IS NULL
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE fulfillment_events (
  id CHAR(36) NOT NULL,
  fulfillment_id CHAR(36) NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  from_status VARCHAR(24) NULL,
  to_status VARCHAR(24) NULL,
  detail_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_fulfillment_events_fulfillment (fulfillment_id, created_at),
  CONSTRAINT fk_fulfillment_events_fulfillment FOREIGN KEY (fulfillment_id) REFERENCES fulfillments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
