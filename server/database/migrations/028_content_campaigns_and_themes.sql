-- Wave 8E Phase 6: Campaign + Theme engine — schema only.
--
-- Both ride the content engine (026):
--   * THEME    : one content_documents row per theme (doc_key = theme_key).
--     content_themes holds a CONSTRAINED token map (tokens_json) — a fixed
--     whitelist of names, each value a plain hex colour. No arbitrary CSS.
--   * CAMPAIGN : one content_documents row per campaign (doc_key = slug).
--     content_campaigns is the editable draft (schedule window, priority,
--     an optional theme, a bounded announcement/banner payload). Publishing
--     snapshots the fully-resolved campaign definition; the resolver
--     (ContentResolutionService) reads published snapshots and, at REQUEST
--     time, overlays whichever campaigns' [starts_at, ends_at) window
--     contains "now" — no cron, no scheduled job.
--   * content_campaign_runtime is an out-of-band kill switch: a live
--     campaign can be disabled instantly without a publish cycle.
--
-- Forward-only, non-destructive. MySQL 8.x. Backfill = a separate idempotent
-- seed (scripts/seed-content-campaigns.js) — includes the synthetic
-- "Diwali Test Campaign".

-- ---------------------------------------------------------------------------
-- 1. Themes (constrained token map)
-- ---------------------------------------------------------------------------
CREATE TABLE content_themes (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  theme_key VARCHAR(80) NOT NULL,
  name VARCHAR(120) NOT NULL,
  tokens_json JSON NOT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_themes_key (theme_key),
  UNIQUE KEY uk_content_themes_document (document_id),
  CONSTRAINT fk_content_themes_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT chk_content_themes_status CHECK (status IN ('ACTIVE','ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Campaigns (editable draft; schedule + priority + bounded payload)
-- ---------------------------------------------------------------------------
CREATE TABLE content_campaigns (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  campaign_key VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(140) NOT NULL,
  priority INT NOT NULL DEFAULT 0,
  starts_at DATETIME(3) NOT NULL,
  ends_at DATETIME(3) NOT NULL,
  theme_key VARCHAR(80) NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_campaigns_key (campaign_key),
  UNIQUE KEY uk_content_campaigns_slug (slug),
  UNIQUE KEY uk_content_campaigns_document (document_id),
  KEY idx_content_campaigns_window (starts_at, ends_at),
  CONSTRAINT fk_content_campaigns_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT chk_content_campaigns_status CHECK (status IN ('DRAFT','SCHEDULED','ARCHIVED')),
  CONSTRAINT chk_content_campaigns_window CHECK (ends_at > starts_at),
  CONSTRAINT chk_content_campaigns_priority CHECK (priority BETWEEN 0 AND 1000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Campaign runtime kill switch (out-of-band; no publish cycle)
-- ---------------------------------------------------------------------------
CREATE TABLE content_campaign_runtime (
  campaign_key VARCHAR(80) NOT NULL,
  disabled TINYINT(1) NOT NULL DEFAULT 0,
  disabled_reason VARCHAR(300) NULL,
  disabled_by_staff_id CHAR(36) NULL,
  disabled_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (campaign_key),
  CONSTRAINT fk_content_campaign_runtime_staff FOREIGN KEY (disabled_by_staff_id) REFERENCES staff_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
