-- Wave 6C.1: provider-neutral shipping business configuration and Checkout quote snapshot.
-- Provider credentials remain in server environment/secret storage and never enter these tables.
CREATE TABLE shipping_settings (
  id TINYINT UNSIGNED NOT NULL,
  provider_choice_mode VARCHAR(24) NOT NULL DEFAULT 'BACKEND_SELECTED',
  quote_ttl_seconds INT UNSIGNED NOT NULL DEFAULT 900,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_shipping_settings_singleton CHECK (id = 1),
  CONSTRAINT chk_shipping_choice_mode CHECK (provider_choice_mode IN ('BACKEND_SELECTED','CUSTOMER_VISIBLE')),
  CONSTRAINT chk_shipping_quote_ttl CHECK (quote_ttl_seconds BETWEEN 60 AND 86400)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shipping_providers (
  provider_code VARCHAR(32) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  priority INT UNSIGNED NOT NULL DEFAULT 100,
  customer_visible TINYINT(1) NOT NULL DEFAULT 0,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (provider_code),
  KEY idx_shipping_providers_enabled_priority (enabled,priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shipping_provider_services (
  provider_code VARCHAR(32) NOT NULL,
  provider_service_code VARCHAR(80) NOT NULL,
  normalized_service_level VARCHAR(24) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  customer_visible TINYINT(1) NOT NULL DEFAULT 1,
  rate_override_minor INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (provider_code,provider_service_code),
  KEY idx_shipping_services_level (normalized_service_level,enabled),
  CONSTRAINT fk_shipping_services_provider FOREIGN KEY (provider_code) REFERENCES shipping_providers(provider_code) ON DELETE CASCADE,
  CONSTRAINT chk_shipping_service_level CHECK (normalized_service_level IN ('STANDARD','EXPRESS'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shipping_provider_zones (
  id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  rule_type VARCHAR(12) NOT NULL,
  postal_code_prefix VARCHAR(6) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_shipping_provider_zone (provider_code,rule_type,postal_code_prefix),
  CONSTRAINT fk_shipping_zones_provider FOREIGN KEY (provider_code) REFERENCES shipping_providers(provider_code) ON DELETE CASCADE,
  CONSTRAINT chk_shipping_zone_rule CHECK (rule_type IN ('ALLOW','BLOCK')),
  CONSTRAINT chk_shipping_zone_prefix CHECK (postal_code_prefix REGEXP '^[0-9]{1,6}$')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO shipping_settings (id,provider_choice_mode,quote_ttl_seconds)
VALUES (1,'BACKEND_SELECTED',900);

INSERT INTO shipping_providers (provider_code,display_name,enabled,priority,customer_visible,is_default) VALUES
  ('MOCK','Development Mock',1,1,1,1),
  ('DELHIVERY','Delhivery',0,10,1,0),
  ('BLUE_DART','Blue Dart',0,20,1,0),
  ('DTDC','DTDC',0,30,1,0);

INSERT INTO shipping_provider_services
  (provider_code,provider_service_code,normalized_service_level,display_name,enabled,customer_visible,rate_override_minor)
VALUES ('MOCK','MOCK_STANDARD','STANDARD','Standard Shipping',1,1,0);

ALTER TABLE checkout_sessions
  ADD COLUMN selected_provider_code VARCHAR(32) NULL AFTER selected_shipping_method_code,
  ADD COLUMN selected_provider_service_code VARCHAR(80) NULL AFTER selected_provider_code,
  ADD COLUMN shipping_quote_reference VARCHAR(80) NULL AFTER selected_provider_service_code,
  ADD COLUMN shipping_quote_snapshot JSON NULL AFTER shipping_quote_reference,
  ADD COLUMN shipping_quote_selected_at DATETIME(3) NULL AFTER shipping_quote_snapshot,
  ADD COLUMN shipping_quote_expires_at DATETIME(3) NULL AFTER shipping_quote_selected_at,
  ADD KEY idx_checkout_shipping_quote (shipping_quote_reference);
