-- Wave 8E Phase 5: Content pages + FAQ — schema only.
--
-- Both ride the existing content engine (026):
--   * CONTENT_PAGE : one content_documents row per page (doc_key = slug).
--     content_pages holds the page's metadata + SEO; content_page_blocks is
--     the ordered, TYPED body (no raw HTML/CSS/JS is ever stored — every
--     block is a whitelisted structured type, resolved to a safe DTO at
--     snapshot time). Publishing snapshots the resolved page into
--     content_publications like every other scope.
--   * FAQ : a single content_documents row (doc_key = 'default').
--     content_faq_items is the ordered draft; grouped by category at
--     snapshot time.
--
-- Forward-only, non-destructive. MySQL 8.x. No content backfill here — see
-- database/seeds/content-pages.json + scripts/seed-content-pages.js (§115).

-- ---------------------------------------------------------------------------
-- 1. Content pages (metadata + SEO; one row per page)
-- ---------------------------------------------------------------------------
CREATE TABLE content_pages (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  page_key VARCHAR(80) NOT NULL,
  slug VARCHAR(140) NOT NULL,
  title VARCHAR(160) NOT NULL,
  nav_label VARCHAR(120) NULL,
  seo_title VARCHAR(180) NULL,
  seo_description VARCHAR(320) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_pages_key (page_key),
  UNIQUE KEY uk_content_pages_slug (slug),
  UNIQUE KEY uk_content_pages_document (document_id),
  CONSTRAINT fk_content_pages_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT chk_content_pages_status CHECK (status IN ('ACTIVE','ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 2. Page body blocks (ordered, whitelisted structured types)
-- ---------------------------------------------------------------------------
CREATE TABLE content_page_blocks (
  id CHAR(36) NOT NULL,
  page_id CHAR(36) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  block_type VARCHAR(24) NOT NULL,
  data_json JSON NOT NULL,
  media_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_page_blocks_position (page_id, position),
  CONSTRAINT fk_content_page_blocks_page FOREIGN KEY (page_id) REFERENCES content_pages (id) ON DELETE CASCADE,
  CONSTRAINT fk_content_page_blocks_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE RESTRICT,
  CONSTRAINT chk_content_page_blocks_type CHECK (block_type IN
    ('HEADING','PARAGRAPH','LIST','IMAGE','CONTACT','DIVIDER','CALLOUT'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. FAQ items (ordered draft; grouped by category at snapshot time)
-- ---------------------------------------------------------------------------
CREATE TABLE content_faq_items (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  item_key VARCHAR(80) NOT NULL,
  category VARCHAR(120) NOT NULL DEFAULT 'General',
  question VARCHAR(300) NOT NULL,
  answer JSON NOT NULL,
  position INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_faq_items_key (item_key),
  UNIQUE KEY uk_content_faq_items_position (document_id, position),
  CONSTRAINT fk_content_faq_items_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT chk_content_faq_items_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
