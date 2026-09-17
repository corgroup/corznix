-- Wave 8I: provider & platform operations.
--
-- The provider ABSTRACTION already exists (src/platform/shared/*: registry,
-- adapter conformance, normalized errors, non-secret config loader). This
-- migration adds the OPERATIONAL plane on top of it — and nothing here is a
-- business authority. Orders / payments / shipments / refunds / media
-- ownership / communications keep their own tables and truth.
--
--   * provider_configurations  — non-secret control-plane config (enabled /
--     priority / routing bag) + immutable revision history. NEVER a secret.
--   * provider_health           — derived operational status, one row per
--     (capability, provider_key), + a compact event log.
--   * provider_webhook_inbox    — a unified operational record of inbound
--     provider webhooks + replay. Raw payloads are NOT stored (sha + a small
--     safe summary only).
--   * platform_outbox           — generic MySQL transactional outbox + worker
--     state (retry classification, bounded backoff, dead-letter).
--   * provider_attempts         — observability log of outbound provider
--     calls (latency, normalized error, correlation id). No FK to business
--     rows; not authoritative.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE provider_configurations (
  id CHAR(36) NOT NULL,
  capability VARCHAR(24) NOT NULL,
  provider_key VARCHAR(48) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 0,
  priority INT NOT NULL DEFAULT 1000,
  -- Non-secret routing / capability bag ONLY. A key that looks like a secret
  -- or an endpoint is rejected by the service before it ever gets here.
  config_json JSON NULL,
  config_version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_provider_configurations (capability, provider_key),
  CONSTRAINT fk_provider_configurations_staff FOREIGN KEY (updated_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE provider_configuration_revisions (
  id CHAR(36) NOT NULL,
  capability VARCHAR(24) NOT NULL,
  provider_key VARCHAR(48) NOT NULL,
  config_version INT UNSIGNED NOT NULL,
  enabled TINYINT(1) NOT NULL,
  priority INT NOT NULL,
  config_json JSON NULL,
  changed_by_staff_id CHAR(36) NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_provider_config_revisions (capability, provider_key, config_version),
  KEY idx_provider_config_revisions (capability, provider_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE provider_health (
  capability VARCHAR(24) NOT NULL,
  provider_key VARCHAR(48) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  secret_status VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
  last_success_at DATETIME(3) NULL,
  last_failure_at DATETIME(3) NULL,
  last_checked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  recent_error_ratio_bps INT UNSIGNED NULL,
  avg_latency_ms INT UNSIGNED NULL,
  detail_json JSON NULL,
  PRIMARY KEY (capability, provider_key),
  CONSTRAINT chk_provider_health_status
    CHECK (status IN ('HEALTHY','DEGRADED','UNAVAILABLE','MISCONFIGURED','NOT_CONFIGURED','UNKNOWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE provider_health_events (
  id CHAR(36) NOT NULL,
  capability VARCHAR(24) NOT NULL,
  provider_key VARCHAR(48) NOT NULL,
  from_status VARCHAR(16) NULL,
  to_status VARCHAR(16) NOT NULL,
  reason VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_provider_health_events (capability, provider_key, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE provider_webhook_inbox (
  id CHAR(36) NOT NULL,
  capability VARCHAR(24) NOT NULL,
  provider_key VARCHAR(48) NOT NULL,
  provider_event_id VARCHAR(160) NULL,
  -- capability + provider + provider_event_id — a replayed webhook is one row.
  dedupe_key VARCHAR(280) NOT NULL,
  signature_valid TINYINT(1) NULL,
  verification_status VARCHAR(16) NOT NULL DEFAULT 'UNVERIFIED',
  processing_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  normalized_event_type VARCHAR(48) NULL,
  resource_type VARCHAR(32) NULL,
  resource_id VARCHAR(64) NULL,
  -- No raw payload. A digest for dedupe/audit + a tiny non-secret summary.
  payload_sha256 CHAR(64) NULL,
  safe_summary_json JSON NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  last_error_code VARCHAR(48) NULL,
  correlation_id VARCHAR(64) NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_provider_webhook_inbox_dedupe (dedupe_key),
  KEY idx_provider_webhook_inbox (capability, provider_key, received_at),
  KEY idx_provider_webhook_inbox_status (processing_status),
  CONSTRAINT chk_provider_webhook_inbox_verify CHECK (verification_status IN ('UNVERIFIED','VERIFIED','REJECTED')),
  CONSTRAINT chk_provider_webhook_inbox_proc CHECK (processing_status IN ('PENDING','APPLIED','FAILED','IGNORED','REPLAYED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE platform_outbox (
  id CHAR(36) NOT NULL,
  event_type VARCHAR(64) NOT NULL,
  aggregate_type VARCHAR(48) NULL,
  aggregate_id VARCHAR(64) NULL,
  payload_json JSON NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  outcome_class VARCHAR(24) NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 6,
  next_attempt_at DATETIME(3) NULL,
  locked_at DATETIME(3) NULL,
  locked_by VARCHAR(64) NULL,
  last_error_code VARCHAR(48) NULL,
  correlation_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  processed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_platform_outbox_due (status, next_attempt_at),
  KEY idx_platform_outbox_aggregate (aggregate_type, aggregate_id),
  CONSTRAINT chk_platform_outbox_status
    CHECK (status IN ('PENDING','PROCESSING','PROCESSED','FAILED','DEAD','RECONCILIATION_REQUIRED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE provider_attempts (
  id CHAR(36) NOT NULL,
  correlation_id VARCHAR(64) NOT NULL,
  capability VARCHAR(24) NOT NULL,
  provider_key VARCHAR(48) NOT NULL,
  operation VARCHAR(48) NOT NULL,
  resource_type VARCHAR(32) NULL,
  resource_id VARCHAR(64) NULL,
  attempt_number INT UNSIGNED NOT NULL DEFAULT 1,
  outcome VARCHAR(16) NOT NULL,
  normalized_error_code VARCHAR(48) NULL,
  http_status INT NULL,
  duration_ms INT UNSIGNED NULL,
  config_version INT UNSIGNED NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_provider_attempts_lookup (capability, provider_key, started_at),
  KEY idx_provider_attempts_correlation (correlation_id),
  KEY idx_provider_attempts_resource (resource_type, resource_id),
  CONSTRAINT chk_provider_attempts_outcome CHECK (outcome IN ('SUCCESS','FAILURE','UNKNOWN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
