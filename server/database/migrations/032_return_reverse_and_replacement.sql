-- Wave 8F-2: normal return + replacement.
--
-- Adds the minimal provider-neutral REVERSE shipment seam needed now (§8) —
-- full serviceability / cancellation / tracking / webhook hardening is 8F-5 —
-- and links a replacement's outgoing fulfillment back to its return request
-- (§37). Financial resolution stays pending until 8F-6.
--
--   return_shipments        one reverse (customer -> warehouse) shipment per
--                           return request. Direction is explicit (§68).
--   return_shipment_events  normalised, deduplicated reverse tracking (§78/§80).
--   fulfillments.return_request_id  a REPLACEMENT's SUPPLEMENTARY fulfillment
--                           points back at the return request; the existing
--                           fulfillment_items rows already carry the original
--                           order-item linkage.
--
-- Forward-only, non-destructive. MySQL 8.x. No real carrier is contacted.

-- ---------------------------------------------------------------------------
-- 1. Replacement linkage on the existing fulfillment authority (reuse, §34)
-- ---------------------------------------------------------------------------
ALTER TABLE fulfillments
  ADD COLUMN return_request_id CHAR(36) NULL AFTER order_id,
  ADD COLUMN source_reservation_id CHAR(36) NULL AFTER return_request_id,
  ADD UNIQUE KEY uk_fulfillments_return_request (return_request_id),
  ADD CONSTRAINT fk_fulfillments_return_request FOREIGN KEY (return_request_id)
    REFERENCES return_requests(id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_fulfillments_source_reservation FOREIGN KEY (source_reservation_id)
    REFERENCES inventory_reservations(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2. Reverse shipment (customer -> warehouse)
-- ---------------------------------------------------------------------------
CREATE TABLE return_shipments (
  id CHAR(36) NOT NULL,
  return_request_id CHAR(36) NOT NULL,
  shipment_number VARCHAR(48) NOT NULL,
  direction VARCHAR(8) NOT NULL DEFAULT 'RETURN',
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING',
  provider_code VARCHAR(32) NULL,
  provider_shipment_id VARCHAR(120) NULL,
  reverse_awb VARCHAR(120) NULL,
  tracking_url VARCHAR(500) NULL,
  -- Frozen origin (customer) + destination (warehouse) at booking-intent time.
  pickup_address_snapshot_json JSON NOT NULL,
  destination_warehouse_id CHAR(36) NOT NULL,
  destination_warehouse_snapshot_json JSON NOT NULL,
  -- Which provider/config was chosen — a later CMS switch must not silently
  -- reroute this shipment's retries (§73).
  provider_snapshot_json JSON NULL,
  booking_idempotency_key VARCHAR(160) NULL,
  last_provider_status VARCHAR(80) NULL,
  last_event_at DATETIME(3) NULL,
  booked_at DATETIME(3) NULL,
  picked_up_at DATETIME(3) NULL,
  received_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_return_shipments_number (shipment_number),
  UNIQUE KEY uk_return_shipments_request (return_request_id),
  UNIQUE KEY uk_return_shipments_booking_key (booking_idempotency_key),
  KEY idx_return_shipments_status (status),
  CONSTRAINT fk_return_shipments_request FOREIGN KEY (return_request_id)
    REFERENCES return_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_shipments_warehouse FOREIGN KEY (destination_warehouse_id)
    REFERENCES warehouses(id) ON DELETE RESTRICT,
  CONSTRAINT chk_return_shipments_direction CHECK (direction = 'RETURN'),
  CONSTRAINT chk_return_shipments_status CHECK (status IN (
    'PENDING','BOOKED','PICKUP_SCHEDULED','PICKED_UP','IN_TRANSIT',
    'RECEIVED','CANCELLED','FAILED','UNKNOWN','MANUAL_RETURN_LOGISTICS_REQUIRED'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE return_shipment_events (
  id CHAR(36) NOT NULL,
  return_shipment_id CHAR(36) NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'MOCK',
  provider_code VARCHAR(32) NOT NULL,
  provider_event_key VARCHAR(160) NOT NULL,
  provider_status VARCHAR(80) NULL,
  normalized_status VARCHAR(24) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  location_text VARCHAR(160) NULL,
  remarks VARCHAR(500) NULL,
  applied TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_return_shipment_events_dedupe (provider_code, provider_event_key),
  KEY idx_return_shipment_events_shipment (return_shipment_id, occurred_at),
  CONSTRAINT fk_return_shipment_events_shipment FOREIGN KEY (return_shipment_id)
    REFERENCES return_shipments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Reverse booking idempotency ledger (mirrors shipment_booking_attempts)
-- ---------------------------------------------------------------------------
CREATE TABLE return_shipment_booking_attempts (
  id CHAR(36) NOT NULL,
  return_shipment_id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  provider_shipment_id VARCHAR(120) NULL,
  reverse_awb VARCHAR(120) NULL,
  failure_code VARCHAR(120) NULL,
  response_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_return_shipment_booking_attempts_key (idempotency_key),
  KEY idx_return_shipment_booking_attempts_shipment (return_shipment_id),
  CONSTRAINT fk_return_shipment_booking_attempts_shipment FOREIGN KEY (return_shipment_id)
    REFERENCES return_shipments(id) ON DELETE CASCADE,
  CONSTRAINT chk_return_shipment_booking_attempts_status CHECK (status IN
    ('PENDING','SUCCEEDED','FAILED','UNKNOWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. QC result on the return request (idempotent restock guard, §41)
-- ---------------------------------------------------------------------------
ALTER TABLE return_requests
  ADD COLUMN qc_result VARCHAR(12) NULL AFTER status,
  ADD COLUMN qc_recorded_at DATETIME(3) NULL AFTER qc_result,
  ADD COLUMN received_at DATETIME(3) NULL AFTER qc_recorded_at,
  ADD COLUMN restocked_at DATETIME(3) NULL AFTER received_at,
  ADD CONSTRAINT chk_return_requests_qc_result CHECK (qc_result IS NULL OR qc_result IN ('PASS','FAIL'));

ALTER TABLE return_request_items
  ADD COLUMN restocked_quantity INT UNSIGNED NOT NULL DEFAULT 0 AFTER quantity,
  ADD COLUMN restock_warehouse_id CHAR(36) NULL AFTER restocked_quantity,
  ADD CONSTRAINT fk_return_request_items_restock_warehouse FOREIGN KEY (restock_warehouse_id)
    REFERENCES warehouses(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_return_request_items_restocked CHECK (restocked_quantity <= quantity);
