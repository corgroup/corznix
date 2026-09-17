-- Phase 2 · Slices 11 / 12 / 14 — label acquisition, warehouse pickup, and
-- richer Delhivery scan data. All additive.

-- Slice 14 — preserve the provider's operational codes alongside the mapped
-- CORCOTTON status (Dev_API.docx status families + NSL). NDR eligibility keys
-- off NSL, so it must be stored, not just logged.
ALTER TABLE shipment_events
  ADD COLUMN status_type VARCHAR(4) NULL AFTER provider_status,
  ADD COLUMN nsl_code VARCHAR(24) NULL AFTER status_type;

-- Slice 11 — real label is a provider-hosted document (an S3 URL from
-- GET /api/p/packing_slip?pdf=true). Track its lifecycle on the shipment.
-- Slice 12 — pickup is warehouse-level; the shipment only records whether a
-- pickup has been requested for it (PICKUP_REQUESTED != PICKED_UP).
ALTER TABLE shipments
  ADD COLUMN label_url VARCHAR(500) NULL AFTER tracking_url,
  ADD COLUMN label_status VARCHAR(16) NOT NULL DEFAULT 'NONE' AFTER label_url,
  ADD COLUMN label_fetched_at DATETIME(3) NULL AFTER label_status,
  ADD COLUMN label_printed_at DATETIME(3) NULL AFTER label_fetched_at,
  ADD COLUMN pickup_request_id CHAR(36) NULL AFTER label_printed_at,
  ADD COLUMN pickup_requested_at DATETIME(3) NULL AFTER pickup_request_id,
  ADD CONSTRAINT chk_shipment_label_status CHECK (label_status IN ('NONE', 'PENDING', 'AVAILABLE', 'FAILED'));

-- Slice 12 — per (warehouse, provider): is pickup raised via API, auto-scheduled
-- by the provider account, or done manually in the provider panel?
ALTER TABLE warehouse_provider_locations
  ADD COLUMN pickup_mode VARCHAR(16) NOT NULL DEFAULT 'MANUAL_PANEL' AFTER provider_return_identifier,
  ADD CONSTRAINT chk_wpl_pickup_mode CHECK (pickup_mode IN ('API', 'AUTO', 'MANUAL_PANEL'));

-- Slice 12 — one warehouse-level pickup request covers every shipment ready at
-- that location. A second request for the same warehouse/day is only allowed
-- once the open one is closed (Dev_API.docx PUR Creation).
CREATE TABLE warehouse_pickup_requests (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  pickup_date DATE NOT NULL,
  pickup_time VARCHAR(8) NOT NULL,               -- HH:MM:SS
  expected_package_count INT UNSIGNED NOT NULL,
  provider_pickup_id VARCHAR(120) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'REQUESTED',
  idempotency_key VARCHAR(140) NOT NULL,
  requested_by_staff_id CHAR(36) NULL,
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at DATETIME(3) NULL,
  failure_code VARCHAR(80) NULL,
  response_json JSON NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_wpr_idempotency (idempotency_key),
  KEY idx_wpr_warehouse_date (warehouse_id, pickup_date, status),
  CONSTRAINT fk_wpr_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
  CONSTRAINT fk_wpr_staff FOREIGN KEY (requested_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_wpr_status CHECK (status IN ('REQUESTED', 'ACCEPTED', 'UNKNOWN', 'FAILED', 'CLOSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
