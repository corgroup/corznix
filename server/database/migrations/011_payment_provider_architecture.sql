-- Wave 6E: provider-neutral payment plans, attempts, and deduplicated events.
CREATE TABLE payment_providers (
  provider_code VARCHAR(32) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  priority INT UNSIGNED NOT NULL DEFAULT 100,
  environment VARCHAR(16) NOT NULL DEFAULT 'SANDBOX',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (provider_code), KEY idx_payment_providers_enabled (enabled,priority),
  CONSTRAINT chk_payment_provider_environment CHECK (environment IN ('MOCK','SANDBOX','PRODUCTION'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_obligations (
  id CHAR(36) NOT NULL, checkout_id CHAR(36) NOT NULL,
  obligation_type VARCHAR(12) NOT NULL, amount_minor INT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL, status VARCHAR(16) NOT NULL,
  source_payment_mode VARCHAR(24) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id), UNIQUE KEY uk_payment_obligation_checkout_type (checkout_id,obligation_type),
  CONSTRAINT fk_payment_obligation_checkout FOREIGN KEY (checkout_id) REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  CONSTRAINT chk_payment_obligation_type CHECK (obligation_type IN ('ONLINE','COD')),
  CONSTRAINT chk_payment_obligation_status CHECK (status IN ('PENDING','PAID','FAILED','NOT_REQUIRED','DUE','CANCELLED')),
  CONSTRAINT chk_payment_obligation_mode CHECK (source_payment_mode IN ('PREPAID','FULL_COD','PARTIAL_COD'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_attempts (
  id CHAR(36) NOT NULL, obligation_id CHAR(36) NOT NULL, checkout_id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL, merchant_reference VARCHAR(80) NOT NULL,
  provider_payment_id VARCHAR(120) NULL, provider_session_reference TEXT NULL,
  amount_minor INT UNSIGNED NOT NULL, currency CHAR(3) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'CREATED', provider_raw_status VARCHAR(80) NULL,
  failure_code VARCHAR(80) NULL, failure_message_safe VARCHAR(255) NULL,
  idempotency_key CHAR(36) NOT NULL, session_expires_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id), UNIQUE KEY uk_payment_attempt_idempotency (idempotency_key),
  UNIQUE KEY uk_payment_attempt_merchant_reference (merchant_reference),
  UNIQUE KEY uk_payment_attempt_provider_payment (provider_code,provider_payment_id),
  KEY idx_payment_attempt_obligation_status (obligation_id,status,created_at),
  CONSTRAINT fk_payment_attempt_obligation FOREIGN KEY (obligation_id) REFERENCES payment_obligations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_attempt_checkout FOREIGN KEY (checkout_id) REFERENCES checkout_sessions(id) ON DELETE CASCADE,
  CONSTRAINT fk_payment_attempt_provider FOREIGN KEY (provider_code) REFERENCES payment_providers(provider_code) ON DELETE RESTRICT,
  CONSTRAINT chk_payment_attempt_status CHECK (status IN ('CREATED','PENDING','AUTHORIZED','SUCCEEDED','FAILED','CANCELLED','EXPIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_provider_events (
  id CHAR(36) NOT NULL, provider_code VARCHAR(32) NOT NULL,
  provider_event_id VARCHAR(160) NOT NULL, payment_attempt_id CHAR(36) NULL,
  event_type VARCHAR(100) NOT NULL, signature_verified TINYINT(1) NOT NULL,
  payload_sha256 CHAR(64) NOT NULL, processing_status VARCHAR(16) NOT NULL DEFAULT 'RECEIVED',
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3), processed_at DATETIME(3) NULL,
  PRIMARY KEY (id), UNIQUE KEY uk_payment_provider_event (provider_code,provider_event_id),
  KEY idx_payment_events_attempt (payment_attempt_id,received_at),
  CONSTRAINT fk_payment_event_provider FOREIGN KEY (provider_code) REFERENCES payment_providers(provider_code) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_event_attempt FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts(id) ON DELETE SET NULL,
  CONSTRAINT chk_payment_event_status CHECK (processing_status IN ('RECEIVED','PROCESSED','REJECTED','IGNORED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO payment_providers (provider_code,display_name,enabled,priority,environment) VALUES
 ('MOCK_PAYMENT','Development Mock Payment',1,1,'MOCK'),
 ('CASHFREE','Cashfree Payments',0,10,'SANDBOX');
