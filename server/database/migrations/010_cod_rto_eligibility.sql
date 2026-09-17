-- Wave 6D: provider-bounded COD/Partial COD policy and checkout decision audit.
-- No production COD settings/rules are seeded: absent configuration fails closed.

CREATE TABLE cod_settings (
  id TINYINT UNSIGNED NOT NULL,
  cod_enabled TINYINT(1) NOT NULL DEFAULT 0,
  partial_cod_enabled TINYINT(1) NOT NULL DEFAULT 0,
  value_rule_basis VARCHAR(24) NOT NULL DEFAULT 'CHECKOUT_TOTAL',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_cod_settings_singleton CHECK (id=1),
  CONSTRAINT chk_cod_value_basis CHECK (value_rule_basis='CHECKOUT_TOTAL')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE cod_value_rules (
  id CHAR(36) NOT NULL,
  min_amount_minor INT UNSIGNED NOT NULL,
  max_amount_minor INT UNSIGNED NULL,
  cod_allowed TINYINT(1) NOT NULL DEFAULT 0,
  partial_cod_mode VARCHAR(16) NOT NULL DEFAULT 'DISABLED',
  advance_type VARCHAR(16) NULL,
  advance_value INT UNSIGNED NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_cod_value_rules_active_range (status,min_amount_minor,max_amount_minor),
  CONSTRAINT chk_cod_value_range CHECK (max_amount_minor IS NULL OR max_amount_minor>=min_amount_minor),
  CONSTRAINT chk_cod_partial_mode CHECK (partial_cod_mode IN ('DISABLED','AVAILABLE','REQUIRED')),
  CONSTRAINT chk_cod_advance_type CHECK (advance_type IS NULL OR advance_type IN ('FIXED','PERCENTAGE')),
  CONSTRAINT chk_cod_value_status CHECK (status IN ('ACTIVE','ARCHIVED')),
  CONSTRAINT chk_cod_percentage CHECK (advance_type<>'PERCENTAGE' OR advance_value BETWEEN 1 AND 10000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_payment_policies (
  product_id CHAR(36) NOT NULL,
  cod_policy VARCHAR(12) NOT NULL DEFAULT 'INHERIT',
  partial_cod_policy VARCHAR(12) NOT NULL DEFAULT 'INHERIT',
  prepaid_only TINYINT(1) NOT NULL DEFAULT 0,
  risk_level VARCHAR(16) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (product_id),
  CONSTRAINT fk_product_payment_policy_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT chk_product_cod_policy CHECK (cod_policy IN ('INHERIT','ALLOW','BLOCK')),
  CONSTRAINT chk_product_partial_policy CHECK (partial_cod_policy IN ('INHERIT','ALLOW','BLOCK','REQUIRE')),
  CONSTRAINT chk_product_risk_level CHECK (risk_level IS NULL OR risk_level IN ('LOW','MEDIUM','HIGH','UNKNOWN','CUSTOM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pin_payment_restrictions (
  postal_code CHAR(6) NOT NULL,
  delivery_blocked TINYINT(1) NOT NULL DEFAULT 0,
  cod_blocked TINYINT(1) NOT NULL DEFAULT 0,
  partial_cod_blocked TINYINT(1) NOT NULL DEFAULT 0,
  risk_level VARCHAR(16) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (postal_code),
  CONSTRAINT chk_pin_payment_postal CHECK (postal_code REGEXP '^[0-9]{6}$'),
  CONSTRAINT chk_pin_risk_level CHECK (risk_level IS NULL OR risk_level IN ('LOW','MEDIUM','HIGH','UNKNOWN','CUSTOM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shipping_provider_payment_policies (
  id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  provider_service_code VARCHAR(80) NULL,
  prepaid_allowed TINYINT(1) NOT NULL DEFAULT 1,
  cod_allowed TINYINT(1) NOT NULL DEFAULT 1,
  partial_cod_allowed TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_provider_payment_policy (provider_code,provider_service_code),
  CONSTRAINT fk_provider_payment_policy_provider FOREIGN KEY (provider_code) REFERENCES shipping_providers(provider_code) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE rto_risk_rules (
  risk_level VARCHAR(16) NOT NULL,
  action VARCHAR(24) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (risk_level),
  CONSTRAINT chk_rto_risk_level CHECK (risk_level IN ('LOW','MEDIUM','HIGH','UNKNOWN','CUSTOM')),
  CONSTRAINT chk_rto_risk_action CHECK (action IN ('ALLOW_FULL_COD','REQUIRE_PARTIAL_COD','PREPAID_ONLY')),
  CONSTRAINT chk_rto_risk_status CHECK (status IN ('ACTIVE','ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE checkout_payment_eligibility (
  checkout_id CHAR(36) NOT NULL,
  decision VARCHAR(32) NOT NULL,
  prepaid_available TINYINT(1) NOT NULL,
  cod_available TINYINT(1) NOT NULL,
  partial_cod_available TINYINT(1) NOT NULL,
  partial_cod_required TINYINT(1) NOT NULL,
  pay_now_minor INT UNSIGNED NOT NULL,
  pay_on_delivery_minor INT UNSIGNED NOT NULL,
  eligible_amount_minor INT UNSIGNED NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  provider_service_code VARCHAR(80) NOT NULL,
  risk_level VARCHAR(16) NOT NULL,
  reason_codes JSON NOT NULL,
  applied_rule_ids JSON NOT NULL,
  selected_payment_mode VARCHAR(24) NULL,
  evaluated_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (checkout_id),
  KEY idx_checkout_payment_decision (decision,evaluated_at),
  CONSTRAINT fk_checkout_payment_eligibility_checkout FOREIGN KEY (checkout_id) REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  CONSTRAINT chk_checkout_payment_decision CHECK (decision IN ('DELIVERY_UNAVAILABLE','PREPAID_ONLY','FULL_COD_AVAILABLE','PARTIAL_COD_OPTIONAL','PARTIAL_COD_REQUIRED')),
  CONSTRAINT chk_checkout_payment_mode CHECK (selected_payment_mode IS NULL OR selected_payment_mode IN ('PREPAID','FULL_COD','PARTIAL_COD')),
  CONSTRAINT chk_checkout_payment_money CHECK (pay_now_minor+pay_on_delivery_minor=eligible_amount_minor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
