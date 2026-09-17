-- Wave 8G-7: provider-neutral communication orchestration.
--
--   Domain event -> policy -> recipient resolution -> classification ->
--   consent/suppression gate -> template+version -> channel routing ->
--   MySQL outbox -> provider adapter -> normalized delivery event.
--
-- Auth OTP is explicitly OUT of this system (§124) — it keeps its own
-- AuthService -> OtpProvider boundary and is never routed through this queue.
--
-- Every message carries an explicit CLASSIFICATION (TRANSACTIONAL | MARKETING).
-- MARKETING consent is re-checked IMMEDIATELY BEFORE the provider send (§132)
-- so an unsubscribe after enqueue results in SUPPRESSED, never a send.
--
-- Message identity is deterministic: dedupe_key = business_event_id + policy +
-- recipient + channel (§131) — a worker retry can never create a second
-- logical send. Delivery is only ever claimed from a provider webhook, never
-- from send-acceptance (§136); a post-request timeout parks the message at
-- UNKNOWN (§137). Webhooks are verified, deduped and applied monotonically so
-- a late event cannot regress DELIVERED -> SENT (§140).
--
-- Bulk sending is a distinct broadcast object referencing a template revision,
-- a segment revision and a frozen audience snapshot (§144/§145) — never the
-- Wave 8E visual campaign table. No real provider blast runs locally.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE communication_templates (
  id CHAR(36) NOT NULL,
  template_key VARCHAR(80) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  classification VARCHAR(16) NOT NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  status VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  subject VARCHAR(255) NULL,
  body_template MEDIUMTEXT NOT NULL,
  -- { "customerName": { "required": true, "type": "string" }, ... }
  variable_schema JSON NOT NULL,
  -- For WhatsApp: the CMS references an APPROVED provider template identity —
  -- never provider credentials, never raw arbitrary code (§128).
  provider_template_ref VARCHAR(120) NULL,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_comm_templates_key_channel_ver (template_key, channel, version),
  KEY idx_comm_templates_lookup (template_key, channel, status),
  CONSTRAINT fk_comm_templates_creator FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_comm_templates_channel CHECK (channel IN ('EMAIL','WHATSAPP')),
  CONSTRAINT chk_comm_templates_class CHECK (classification IN ('TRANSACTIONAL','MARKETING')),
  CONSTRAINT chk_comm_templates_status CHECK (status IN ('DRAFT','ACTIVE','ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE communication_broadcasts (
  id CHAR(36) NOT NULL,
  name VARCHAR(160) NOT NULL,
  template_key VARCHAR(80) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  purpose VARCHAR(16) NOT NULL,
  segment_id CHAR(36) NOT NULL,
  segment_revision_id CHAR(36) NULL,
  audience_snapshot_id CHAR(36) NULL,
  scheduled_at DATETIME(3) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  recipient_count INT UNSIGNED NOT NULL DEFAULT 0,
  enqueued_count INT UNSIGNED NOT NULL DEFAULT 0,
  suppressed_count INT UNSIGNED NOT NULL DEFAULT 0,
  variables_json JSON NULL,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_comm_broadcasts_status (status, scheduled_at),
  CONSTRAINT fk_comm_broadcasts_segment FOREIGN KEY (segment_id)
    REFERENCES customer_segments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_comm_broadcasts_snapshot FOREIGN KEY (audience_snapshot_id)
    REFERENCES customer_segment_snapshots(id) ON DELETE SET NULL,
  CONSTRAINT fk_comm_broadcasts_creator FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_comm_broadcasts_channel CHECK (channel IN ('EMAIL','WHATSAPP')),
  CONSTRAINT chk_comm_broadcasts_purpose CHECK (purpose IN ('MARKETING','NEWSLETTER')),
  CONSTRAINT chk_comm_broadcasts_status CHECK (status IN ('DRAFT','SCHEDULED','RESOLVING','SENDING','SENT','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The transactional outbox. One row = one logical message to one recipient.
CREATE TABLE communication_messages (
  id CHAR(36) NOT NULL,
  -- business_event_id + policy_key + recipient_key + channel (§131).
  dedupe_key VARCHAR(320) NOT NULL,
  classification VARCHAR(16) NOT NULL,
  channel VARCHAR(16) NOT NULL,
  purpose VARCHAR(16) NULL,
  template_key VARCHAR(80) NOT NULL,
  template_version INT UNSIGNED NOT NULL,
  business_event_id VARCHAR(160) NOT NULL,
  policy_key VARCHAR(80) NOT NULL,
  broadcast_id CHAR(36) NULL,
  recipient_customer_id CHAR(36) NULL,
  recipient_contact_key VARCHAR(255) NOT NULL,
  variables_json JSON NULL,
  rendered_subject VARCHAR(255) NULL,
  rendered_body MEDIUMTEXT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'QUEUED',
  status_version INT UNSIGNED NOT NULL DEFAULT 0,
  -- Provider ownership: set on the first send attempt, retries stay on it (§135).
  provider_code VARCHAR(32) NULL,
  provider_message_id VARCHAR(160) NULL,
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 5,
  next_attempt_at DATETIME(3) NULL,
  locked_at DATETIME(3) NULL,
  last_error VARCHAR(255) NULL,
  suppressed_reason VARCHAR(48) NULL,
  sent_at DATETIME(3) NULL,
  delivered_at DATETIME(3) NULL,
  failed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_comm_messages_dedupe (dedupe_key),
  KEY idx_comm_messages_due (status, next_attempt_at),
  KEY idx_comm_messages_broadcast (broadcast_id),
  KEY idx_comm_messages_event (business_event_id),
  CONSTRAINT fk_comm_messages_broadcast FOREIGN KEY (broadcast_id)
    REFERENCES communication_broadcasts(id) ON DELETE SET NULL,
  CONSTRAINT fk_comm_messages_customer FOREIGN KEY (recipient_customer_id)
    REFERENCES customers(id) ON DELETE SET NULL,
  CONSTRAINT chk_comm_messages_channel CHECK (channel IN ('EMAIL','WHATSAPP')),
  CONSTRAINT chk_comm_messages_class CHECK (classification IN ('TRANSACTIONAL','MARKETING')),
  CONSTRAINT chk_comm_messages_status CHECK (status IN ('QUEUED','SENDING','SENT','DELIVERED','FAILED','UNKNOWN','SUPPRESSED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE communication_message_events (
  id CHAR(36) NOT NULL,
  message_id CHAR(36) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  from_status VARCHAR(12) NULL,
  to_status VARCHAR(12) NULL,
  -- Provider webhook idempotency key — a replayed webhook is a no-op (§140).
  provider_event_key VARCHAR(160) NULL,
  detail_json JSON NULL,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_comm_message_events_provider_key (message_id, provider_event_key),
  KEY idx_comm_message_events_message (message_id, occurred_at),
  CONSTRAINT fk_comm_message_events_message FOREIGN KEY (message_id)
    REFERENCES communication_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
