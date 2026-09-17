-- Wave 8E Phase 7: signed short-lived preview tokens.
--
-- A staff member with content.read can mint an opaque, high-entropy token
-- scoped to one content surface (or "all") and an optional "as of" instant
-- (to preview a scheduled campaign / a future-dated announcement). The
-- storefront passes it as ?preview=<token>; the public content resolvers
-- then serve the DRAFT instead of the published snapshot for that scope
-- only. Only the SHA-256 hash is stored; tokens are short-lived (<= 1h) and
-- revocable. An invalid / expired / revoked / out-of-scope token is
-- silently ignored (the published content is served) — a leaked token can
-- never widen what the public sees.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE content_preview_tokens (
  id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  staff_user_id CHAR(36) NULL,
  scope VARCHAR(80) NOT NULL DEFAULT 'all',
  as_of DATETIME(3) NULL,
  label VARCHAR(160) NULL,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at DATETIME(3) NULL,
  use_count INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_preview_tokens_hash (token_hash),
  KEY idx_content_preview_tokens_staff (staff_user_id),
  KEY idx_content_preview_tokens_expiry (expires_at),
  CONSTRAINT fk_content_preview_tokens_staff FOREIGN KEY (staff_user_id) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
