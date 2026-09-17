-- Wave 8G-1: customer operations — staff-only notes + status-change history.
--
-- There is exactly ONE customer identity authority (`customers` +
-- `customer_contacts` + `customer_identities`); this migration adds NO
-- second identity store (§8). The unified CMS customer view is an
-- aggregation read model over the existing domains, not new storage.
--
--   customer_notes           staff-only INTERNAL notes (§23). Never exposed
--                            through any customer API.
--   customer_status_changes  append-only ACTIVE <-> SUSPENDED history with a
--                            reason and the acting staff member (§21). The
--                            customer row is never hard-deleted (§21/§171).
--
-- Verified email/phone are NOT editable here — a verified-identity change
-- must go through AuthService re-verification (§20), never a CMS write.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE customer_notes (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  author_staff_id CHAR(36) NULL,
  visibility VARCHAR(16) NOT NULL DEFAULT 'INTERNAL',
  body VARCHAR(2000) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_customer_notes_customer (customer_id, created_at),
  CONSTRAINT fk_customer_notes_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_customer_notes_author FOREIGN KEY (author_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_customer_notes_visibility CHECK (visibility = 'INTERNAL')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_status_changes (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  from_status VARCHAR(20) NOT NULL,
  to_status VARCHAR(20) NOT NULL,
  reason VARCHAR(255) NULL,
  changed_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_customer_status_changes_customer (customer_id, created_at),
  CONSTRAINT fk_customer_status_changes_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT fk_customer_status_changes_staff FOREIGN KEY (changed_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_customer_status_changes_values CHECK (
    from_status IN ('PENDING_PROFILE','ACTIVE','SUSPENDED') AND
    to_status IN ('ACTIVE','SUSPENDED')
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
