-- Phase 2 · Slice 3 — carrier pickup-location mapping (brief §35).
--
-- CORCOTTON's internal warehouse identity stays provider-neutral. Delhivery
-- (and every future carrier) identifies a pickup location by a registered
-- name that is CASE- AND SPACE-SENSITIVE and must match the manifest payload
-- exactly. That mapping lives here — never by renaming the internal warehouse.
--
-- One row per (warehouse, provider). No backfill: the identifier must come
-- from a real provider warehouse registration (Warehouse Creation API / the
-- provider panel), never a guess.

CREATE TABLE warehouse_provider_locations (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  -- Exact string the provider expects as pickup_location.name — verbatim.
  provider_location_identifier VARCHAR(160) NOT NULL,
  -- Optional distinct return-location identifier (defaults to the pickup one).
  provider_return_identifier VARCHAR(160) NULL,
  -- Set once the location is confirmed registered on the provider side.
  registered_at DATETIME(3) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  notes VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_wpl_warehouse_provider (warehouse_id, provider_code),
  KEY idx_wpl_provider (provider_code),
  CONSTRAINT fk_wpl_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE CASCADE,
  CONSTRAINT chk_wpl_status CHECK (status IN ('ACTIVE', 'DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
