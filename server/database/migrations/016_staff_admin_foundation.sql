-- Wave 8A: Staff / Admin (CMS) identity, sessions, and audit foundation.
--
-- Deliberately a SEPARATE identity domain from the customer domain
-- (customers / customer_identities / auth_sessions / audit_logs — see
-- 003_customer_auth.sql). A CORCOTTON customer is never a CMS operator and
-- authenticating as a customer never implies any staff authority.
--
-- This does NOT reuse the legacy users / roles / user_brand_roles scaffold
-- from 001_init.sql (still empty apart from 4 seed roles, served only by
-- 501 stub routes). Wave 8A's brief calls for a simple single-`role`
-- column model, not the per-brand grant table that scaffold implies.
--
-- Forward-only, non-destructive: CREATE TABLE only. MySQL 8.x.

CREATE TABLE staff_users (
  id CHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  -- Lower-cased / trimmed form — the actual uniqueness authority, so
  -- "Ops@x.com" and " ops@x.com " can never become two accounts.
  email_normalized VARCHAR(255) NOT NULL,
  -- scrypt-derived, self-describing string ("scrypt$N$r$p$salt$hash").
  -- Never a plaintext or fast-hash (SHA-256) value.
  password_hash VARCHAR(255) NOT NULL,
  first_name VARCHAR(120) NOT NULL,
  last_name VARCHAR(120) NOT NULL,
  role VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_staff_users_email_normalized (email_normalized),
  CONSTRAINT chk_staff_users_role CHECK (role IN (
    'SUPER_ADMIN','ADMIN','CATALOG_MANAGER','OPERATIONS','SUPPORT','VIEWER'
  )),
  CONSTRAINT chk_staff_users_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE staff_sessions (
  id CHAR(36) NOT NULL,
  staff_user_id CHAR(36) NOT NULL,
  -- SHA-256(hex) of the opaque high-entropy session token. The raw token
  -- lives only in the HttpOnly browser cookie, never in the database.
  token_hash CHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  -- Absolute lifetime (bounded — no permanent admin sessions).
  expires_at DATETIME(3) NOT NULL,
  -- Sliding idle-timeout anchor; refreshed on each authenticated request.
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  revoked_at DATETIME(3) NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(512) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_staff_sessions_token_hash (token_hash),
  KEY idx_staff_sessions_user (staff_user_id),
  KEY idx_staff_sessions_status_expiry (status, expires_at),
  CONSTRAINT fk_staff_sessions_user FOREIGN KEY (staff_user_id)
    REFERENCES staff_users(id) ON DELETE CASCADE,
  CONSTRAINT chk_staff_sessions_status CHECK (status IN ('ACTIVE','REVOKED','EXPIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only. No update/delete API is ever exposed for this table.
CREATE TABLE staff_audit_logs (
  id CHAR(36) NOT NULL,
  -- NULL-able so a failed login for a non-existent email still records.
  staff_user_id CHAR(36) NULL,
  -- Best-effort actor label for events with no resolvable staff_user_id
  -- (e.g. login failure). An email address, never a secret.
  actor_email VARCHAR(255) NULL,
  action VARCHAR(64) NOT NULL,
  resource_type VARCHAR(64) NULL,
  resource_id VARCHAR(64) NULL,
  -- Safe, minimal context only. Never passwords, tokens, or hashes.
  metadata_json JSON NULL,
  ip_address VARCHAR(64) NULL,
  request_id VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_staff_audit_logs_user (staff_user_id, created_at),
  KEY idx_staff_audit_logs_action (action, created_at),
  CONSTRAINT fk_staff_audit_logs_user FOREIGN KEY (staff_user_id)
    REFERENCES staff_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
