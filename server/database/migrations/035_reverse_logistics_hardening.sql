-- Wave 8F-5: reverse logistics + pickup completion (harden the 8F-2 seam).
--
-- Adds: a hard serviceability gate record, a provider snapshot frozen at
-- booking-intent time (§73), reconciliation of UNKNOWN bookings (§75), and a
-- minimal authenticity-checked webhook inbox for reverse tracking (§79).
--
-- No real carrier is ever contacted. Forward-only, non-destructive. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. Return destination routing policy (§70) — not hardcoded to one warehouse
-- ---------------------------------------------------------------------------
ALTER TABLE return_policy
  ADD COLUMN return_destination_strategy VARCHAR(24) NOT NULL DEFAULT 'ORIGIN_FULFILLMENT'
    AFTER same_style_price_difference_policy,
  ADD CONSTRAINT chk_return_policy_destination_strategy
    CHECK (return_destination_strategy IN ('ORIGIN_FULFILLMENT','DEFAULT_WAREHOUSE'));

-- ---------------------------------------------------------------------------
-- 2. Reverse shipment: serviceability record + reconciliation
-- ---------------------------------------------------------------------------
ALTER TABLE return_shipments
  ADD COLUMN serviceable TINYINT(1) NULL AFTER destination_warehouse_snapshot_json,
  ADD COLUMN serviceability_checked_at DATETIME(3) NULL AFTER serviceable,
  ADD COLUMN reconciled_at DATETIME(3) NULL AFTER cancelled_at;

-- ---------------------------------------------------------------------------
-- 3. Reverse-tracking webhook inbox (§79)
-- ---------------------------------------------------------------------------
CREATE TABLE return_shipment_webhook_events (
  id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  provider_event_id VARCHAR(160) NOT NULL,
  return_shipment_id CHAR(36) NULL,
  -- Authenticity seam: whether the delivered payload passed the provider's
  -- signature/secret check. An unauthenticated payload is stored but never
  -- applied.
  signature_valid TINYINT(1) NOT NULL DEFAULT 0,
  raw_payload_json JSON NOT NULL,
  normalized_status VARCHAR(24) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'RECEIVED',
  error VARCHAR(255) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_return_shipment_webhook_dedupe (provider_code, provider_event_id),
  KEY idx_return_shipment_webhook_shipment (return_shipment_id),
  CONSTRAINT fk_return_shipment_webhook_shipment FOREIGN KEY (return_shipment_id)
    REFERENCES return_shipments(id) ON DELETE SET NULL,
  CONSTRAINT chk_return_shipment_webhook_status CHECK (status IN
    ('RECEIVED','PROCESSED','DUPLICATE','REJECTED','FAILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
