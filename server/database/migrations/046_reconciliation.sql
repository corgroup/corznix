-- Wave 8H: reconciliation exception management.
--
-- Reporting itself is a read-only projection over authoritative domains and
-- needs NO tables. The ONLY new schema is the reconciliation layer: an
-- exception is raised when internal financial truth disagrees with itself or
-- with imported provider evidence, and is worked without ever silently
-- mutating a source record (§85).
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE reconciliation_exceptions (
  id CHAR(36) NOT NULL,
  exception_type VARCHAR(48) NOT NULL,
  source_domain VARCHAR(24) NOT NULL,
  reference_type VARCHAR(32) NOT NULL,
  reference_id VARCHAR(64) NOT NULL,
  expected_minor BIGINT NULL,
  actual_minor BIGINT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(16) NOT NULL DEFAULT 'OPEN',
  detail_json JSON NULL,
  assigned_staff_id CHAR(36) NULL,
  resolution_note VARCHAR(500) NULL,
  -- Deterministic identity so a re-scan of the same discrepancy updates the
  -- one row instead of piling up duplicates.
  dedupe_key VARCHAR(200) NOT NULL,
  first_detected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_detected_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_reconciliation_exceptions_dedupe (dedupe_key),
  KEY idx_reconciliation_exceptions_status (status, exception_type),
  KEY idx_reconciliation_exceptions_ref (reference_type, reference_id),
  CONSTRAINT fk_reconciliation_exceptions_staff FOREIGN KEY (assigned_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_reconciliation_exceptions_status
    CHECK (status IN ('OPEN','ACKNOWLEDGED','MANUAL_REVIEW','RESOLVED','REOPENED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE reconciliation_events (
  id CHAR(36) NOT NULL,
  exception_id CHAR(36) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  from_status VARCHAR(16) NULL,
  to_status VARCHAR(16) NULL,
  actor_staff_id CHAR(36) NULL,
  note VARCHAR(500) NULL,
  detail_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_reconciliation_events_exception (exception_id, created_at),
  CONSTRAINT fk_reconciliation_events_exception FOREIGN KEY (exception_id)
    REFERENCES reconciliation_exceptions(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Provider settlement / remittance evidence imported from a CSV. No live
-- provider settlement API is integrated — this is the import seam (§83).
-- Re-importing the same file is a no-op (file_hash unique).
CREATE TABLE provider_settlement_imports (
  id CHAR(36) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  kind VARCHAR(24) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_hash CHAR(64) NOT NULL,
  row_count INT UNSIGNED NOT NULL DEFAULT 0,
  matched_count INT UNSIGNED NOT NULL DEFAULT 0,
  exception_count INT UNSIGNED NOT NULL DEFAULT 0,
  imported_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_provider_settlement_imports_hash (file_hash),
  CONSTRAINT fk_provider_settlement_imports_staff FOREIGN KEY (imported_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_provider_settlement_imports_kind CHECK (kind IN ('PAYMENT','REFUND','COD'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
