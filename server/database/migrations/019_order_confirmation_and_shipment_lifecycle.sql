-- Order confirmation boundary + mocked shipment booking / tracking lifecycle.
--
-- 1. `orders.order_status` gains CONFIRMED / PROCESSING / COMPLETED, plus
--    confirmation metadata. The Order is still created once at checkout — the
--    CMS confirms the existing allocation, it never creates a second Order.
-- 2. The Wave 7A provider guard `chk_shipment_wave7a_no_provider` (which forced
--    every provider field NULL) is replaced with state-aware consistency
--    constraints: provider identity is absent until a shipment is booked and
--    complete once it is.
-- 3. `shipment_booking_attempts` gives booking an internal idempotency ledger;
--    `shipment_events` is the normalised, deduplicated tracking pipeline.
--
-- Forward-only, non-destructive. MySQL 8.x. No real carrier is contacted.

-- ---------------------------------------------------------------------------
-- 1. Order confirmation
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN confirmed_at DATETIME(3) NULL AFTER placed_at,
  ADD COLUMN confirmed_by_staff_id CHAR(36) NULL AFTER confirmed_at,
  ADD COLUMN processing_started_at DATETIME(3) NULL AFTER confirmed_by_staff_id,
  ADD COLUMN completed_at DATETIME(3) NULL AFTER processing_started_at,
  -- Fingerprint of the confirmed warehouse allocation (warehouse+sku+qty), for
  -- the optimistic stale-allocation check at confirm time.
  ADD COLUMN allocation_fingerprint CHAR(64) NULL AFTER completed_at,
  ADD CONSTRAINT fk_orders_confirmed_by FOREIGN KEY (confirmed_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  DROP CHECK chk_order_status,
  ADD CONSTRAINT chk_order_status CHECK (order_status IN
    ('PLACED','CONFIRMED','PROCESSING','COMPLETED','CANCELLED'));

-- ---------------------------------------------------------------------------
-- 2. Shipment provider fields — replace the absolute guard with state rules
-- ---------------------------------------------------------------------------
ALTER TABLE shipments
  ADD COLUMN booking_idempotency_key VARCHAR(120) NULL AFTER booking_status,
  ADD COLUMN last_provider_status VARCHAR(80) NULL AFTER tracking_url,
  ADD COLUMN last_event_at DATETIME(3) NULL AFTER last_provider_status,
  ADD UNIQUE KEY uk_shipments_booking_idempotency_key (booking_idempotency_key),
  DROP CHECK chk_shipment_wave7a_no_provider,
  DROP CHECK chk_shipment_status,
  DROP CHECK chk_shipment_booking_status,
  ADD CONSTRAINT chk_shipment_status CHECK (status IN (
    'DRAFT','READY_TO_BOOK','BOOKING_PENDING','BOOKED','PICKUP_PENDING','PICKED_UP',
    'IN_TRANSIT','OUT_FOR_DELIVERY','DELIVERED','FAILED','CANCELLED',
    'DELIVERY_EXCEPTION','RTO_IN_TRANSIT','RTO_RETURNED','LOST'
  )),
  ADD CONSTRAINT chk_shipment_booking_status CHECK (booking_status IN (
    'NOT_READY','READY','PENDING','BOOKED','FAILED','CANCELLED','UNKNOWN'
  )),
  -- Before a booking is attempted, no provider identity may exist.
  ADD CONSTRAINT chk_shipment_unbooked_clean CHECK (
    booking_status NOT IN ('NOT_READY','READY') OR (
      provider_code IS NULL AND external_shipment_id IS NULL AND
      tracking_number IS NULL AND tracking_url IS NULL AND booked_at IS NULL
    )
  ),
  -- A booked shipment carries a complete, immutable provider identity.
  ADD CONSTRAINT chk_shipment_booked_complete CHECK (
    booking_status <> 'BOOKED' OR (
      provider_code IS NOT NULL AND external_shipment_id IS NOT NULL AND
      tracking_number IS NOT NULL AND booked_at IS NOT NULL
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Booking idempotency ledger
-- ---------------------------------------------------------------------------
CREATE TABLE shipment_booking_attempts (
  id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  provider_shipment_id VARCHAR(120) NULL,
  tracking_number VARCHAR(120) NULL,
  failure_code VARCHAR(80) NULL,
  response_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_shipment_booking_attempts_key (idempotency_key),
  KEY idx_shipment_booking_attempts_shipment (shipment_id),
  CONSTRAINT fk_shipment_booking_attempts_shipment FOREIGN KEY (shipment_id)
    REFERENCES shipments(id) ON DELETE CASCADE,
  CONSTRAINT chk_shipment_booking_attempts_status CHECK (status IN
    ('PENDING','SUCCEEDED','FAILED','UNKNOWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Normalised, deduplicated tracking events
-- ---------------------------------------------------------------------------
CREATE TABLE shipment_events (
  id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'MOCK',
  provider_code VARCHAR(32) NOT NULL,
  provider_event_key VARCHAR(120) NOT NULL,
  provider_status VARCHAR(80) NULL,
  normalized_status VARCHAR(24) NOT NULL,
  occurred_at DATETIME(3) NOT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  location_text VARCHAR(160) NULL,
  remarks VARCHAR(500) NULL,
  -- Whether this event actually advanced the shipment (a stale / duplicate
  -- event is still stored for traceability but applies nothing).
  applied TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_shipment_events_dedupe (provider_code, provider_event_key),
  KEY idx_shipment_events_shipment (shipment_id, occurred_at),
  CONSTRAINT fk_shipment_events_shipment FOREIGN KEY (shipment_id)
    REFERENCES shipments(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
