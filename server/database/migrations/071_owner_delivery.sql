-- Owner Delivery — a CORCOTTON-operated last-mile option for specific PIN
-- codes, priced independently of any carrier.
--
-- Business rule (2026-09-04): Owner Delivery is a synthetic shipping method
-- injected into the checkout quote AFTER carrier orchestration. It is offered
-- ONLY when the destination PIN matches an enabled owner_delivery_zones row
-- AND the master toggle (shipping_settings.owner_delivery_enabled) is on. It
-- is never booked with a carrier — the store delivers it and the order stays
-- in the manual fulfilment queue (consistent with the standing manual-
-- fulfilment rule).
--
-- Forward-only, non-destructive. MySQL 8.x.

ALTER TABLE shipping_settings
  ADD COLUMN owner_delivery_enabled TINYINT(1) NOT NULL DEFAULT 0
    AFTER express_additional_charge_minor;

CREATE TABLE owner_delivery_zones (
  id CHAR(36) NOT NULL,
  -- Human label for the area (e.g. "South Delhi", "Noida Sector 62").
  name VARCHAR(120) NOT NULL,
  -- Exactly one 6-digit Indian PIN per row. A zone spanning several PINs is
  -- several rows (each can carry its own charge).
  pincode CHAR(6) NOT NULL,
  charge_minor INT UNSIGNED NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  notes VARCHAR(255) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_owner_delivery_pincode (pincode),
  KEY idx_owner_delivery_enabled (enabled, pincode),
  CONSTRAINT chk_owner_delivery_pincode CHECK (pincode REGEXP '^[0-9]{6}$'),
  CONSTRAINT fk_owner_delivery_created_by FOREIGN KEY (created_by)
    REFERENCES staff_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
