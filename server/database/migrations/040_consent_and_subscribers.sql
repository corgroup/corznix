-- Wave 8G-2: channel/purpose-aware consent + newsletter subscribers.
--
-- Consent is NOT a single `marketing_opt_in` boolean (§30). It is an
-- append-only event ledger keyed on the COMMUNICATION ENDPOINT (§7) —
-- normalized email or phone — separated by channel AND purpose, with a
-- monotonic sequence so "latest event wins" is deterministic under
-- concurrency (§34/§35). A materialized `consent_state` row is the fast
-- read; `consent_records` remains the audit authority (§33).
--
-- Auth OTP is untouched and MUST NOT depend on marketing consent (§9).
--
-- A newsletter signup does NOT create a customer account (§37). An
-- anonymous subscriber may later be linked to a verified customer (§40) —
-- never merged on an unverified claim.
--
-- Final legal classification (DPDP / TRAI-DLT / WhatsApp policy /
-- double-opt-in requirement) requires professional review (§10).
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE communication_settings (
  id TINYINT UNSIGNED NOT NULL,
  -- Single vs double opt-in for newsletter (§43). 0 = single (explicit
  -- consent + audit). Business/legal to confirm — not decided in code.
  newsletter_double_opt_in TINYINT(1) NOT NULL DEFAULT 0,
  -- Marketing quiet-hours seam (§142). NULL/NULL = no enforcement.
  marketing_quiet_hours_start TINYINT UNSIGNED NULL,
  marketing_quiet_hours_end TINYINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_communication_settings_singleton CHECK (id = 1),
  CONSTRAINT chk_communication_settings_quiet CHECK (
    (marketing_quiet_hours_start IS NULL AND marketing_quiet_hours_end IS NULL)
    OR (marketing_quiet_hours_start BETWEEN 0 AND 23 AND marketing_quiet_hours_end BETWEEN 0 AND 23)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO communication_settings (id) VALUES (1);

-- ---------------------------------------------------------------------------
-- Consent event ledger (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE consent_records (
  id CHAR(36) NOT NULL,
  -- Monotonic ordering authority — deterministic latest-event-wins (§34).
  seq BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  contact_key VARCHAR(255) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  action VARCHAR(12) NOT NULL,
  source VARCHAR(32) NOT NULL,
  customer_id CHAR(36) NULL,
  subscriber_id CHAR(36) NULL,
  notice_version VARCHAR(40) NULL,
  proof_ref VARCHAR(255) NULL,
  metadata_json JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_consent_records_seq (seq),
  KEY idx_consent_records_key (contact_key, channel, purpose, seq),
  KEY idx_consent_records_customer (customer_id),
  CONSTRAINT fk_consent_records_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT chk_consent_records_channel CHECK (channel IN ('EMAIL','WHATSAPP')),
  CONSTRAINT chk_consent_records_purpose CHECK (purpose IN ('MARKETING','NEWSLETTER')),
  CONSTRAINT chk_consent_records_action CHECK (action IN ('GRANTED','REVOKED')),
  CONSTRAINT chk_consent_records_source CHECK (source IN
    ('ACCOUNT_SETTINGS','CHECKOUT','FOOTER_NEWSLETTER','CMS_IMPORT','PROMOTION_FORM',
     'CONTACT_VERIFICATION','DOUBLE_OPT_IN','UNSUBSCRIBE_LINK','STAFF_RECORDED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Materialized effective consent (one row per endpoint + channel + purpose)
-- ---------------------------------------------------------------------------
CREATE TABLE consent_state (
  id CHAR(36) NOT NULL,
  contact_key VARCHAR(255) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  customer_id CHAR(36) NULL,
  effective_action VARCHAR(12) NOT NULL,
  -- The consent_records.seq that produced this state. A write only wins if
  -- its seq is greater (§35).
  source_seq BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_consent_state_key (contact_key, channel, purpose),
  KEY idx_consent_state_customer (customer_id),
  CONSTRAINT fk_consent_state_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT chk_consent_state_action CHECK (effective_action IN ('GRANTED','REVOKED')),
  CONSTRAINT chk_consent_state_channel CHECK (channel IN ('EMAIL','WHATSAPP')),
  CONSTRAINT chk_consent_state_purpose CHECK (purpose IN ('MARKETING','NEWSLETTER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Newsletter subscribers (anonymous-capable, deduped on normalized email)
-- ---------------------------------------------------------------------------
CREATE TABLE newsletter_subscribers (
  id CHAR(36) NOT NULL,
  normalized_email VARCHAR(255) NOT NULL,
  raw_email VARCHAR(255) NOT NULL,
  customer_id CHAR(36) NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'SUBSCRIBED',
  source VARCHAR(32) NOT NULL,
  confirm_token CHAR(64) NULL,
  confirmed_at DATETIME(3) NULL,
  unsubscribed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_newsletter_subscribers_email (normalized_email),
  UNIQUE KEY uk_newsletter_subscribers_confirm_token (confirm_token),
  KEY idx_newsletter_subscribers_customer (customer_id),
  CONSTRAINT fk_newsletter_subscribers_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT chk_newsletter_subscribers_status CHECK (status IN
    ('PENDING_CONFIRMATION','SUBSCRIBED','UNSUBSCRIBED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- Marketing suppression (effective = row with released_at IS NULL)
-- ---------------------------------------------------------------------------
CREATE TABLE marketing_suppressions (
  id CHAR(36) NOT NULL,
  contact_key VARCHAR(255) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  reason VARCHAR(24) NOT NULL,
  source_seq BIGINT UNSIGNED NULL,
  notes VARCHAR(255) NULL,
  created_by_staff_id CHAR(36) NULL,
  released_at DATETIME(3) NULL,
  released_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_marketing_suppressions_key (contact_key, channel, released_at),
  CONSTRAINT fk_marketing_suppressions_created_by FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_marketing_suppressions_released_by FOREIGN KEY (released_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_marketing_suppressions_channel CHECK (channel IN ('EMAIL','WHATSAPP')),
  CONSTRAINT chk_marketing_suppressions_reason CHECK (reason IN
    ('UNSUBSCRIBED','CONSENT_REVOKED','HARD_BOUNCE','MANUAL_COMPLIANCE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
