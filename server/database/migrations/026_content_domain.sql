-- Wave 8E: Content & Experience domain — schema only.
--
-- Model (§20/§21/§67/§109):
--   * content_documents   — one row per publishable content SCOPE
--     (navigation:primary, homepage:home, footer:main, announcements:default,
--      mega_menus:default). Carries the optimistic-concurrency counter
--      (working_version, bumped on every draft save) and the live pointer
--      (published_publication_id).
--   * content_publications — IMMUTABLE snapshots. Publishing writes the full
--     resolved DTO of that scope as snapshot_json + advances the pointer.
--     Rollback = a new publication whose snapshot is copied from an older one
--     (source_publication_id records the lineage). Old rows are never edited.
--   * The normalized *_items / *_sections / *_groups / *_links tables ARE the
--     editable DRAFT. The public storefront never joins them at request time —
--     it reads one content_publications.snapshot_json row (version-keyed,
--     cacheable). Bounded typed structures (mega-menu inner layout, footer
--     contact/socials) live in validated *_json columns, not their own tables.
--
-- Forward-only, non-destructive. MySQL 8.x. No content backfill here — that is
-- a separate idempotent seed (§115).

-- ---------------------------------------------------------------------------
-- 1. Scope registry + immutable publication history
-- ---------------------------------------------------------------------------
CREATE TABLE content_documents (
  id CHAR(36) NOT NULL,
  doc_type VARCHAR(32) NOT NULL,
  doc_key VARCHAR(140) NOT NULL DEFAULT 'default',
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  working_version INT UNSIGNED NOT NULL DEFAULT 1,
  published_version INT UNSIGNED NULL,
  published_publication_id CHAR(36) NULL,
  draft_dirty TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_documents_scope (doc_type, doc_key),
  CONSTRAINT chk_content_documents_type CHECK (doc_type IN
    ('NAVIGATION','MEGA_MENUS','ANNOUNCEMENTS','HOMEPAGE','FOOTER','CONTENT_PAGE','FAQ','THEME','CAMPAIGN')),
  CONSTRAINT chk_content_documents_status CHECK (status IN ('ACTIVE','ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_publications (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  version INT UNSIGNED NOT NULL,
  state VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED',
  snapshot_json JSON NOT NULL,
  source_publication_id CHAR(36) NULL,
  change_summary VARCHAR(500) NULL,
  published_by_staff_id CHAR(36) NULL,
  published_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_publications_version (document_id, version),
  KEY idx_content_publications_doc_state (document_id, state),
  CONSTRAINT fk_content_publications_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_content_publications_source FOREIGN KEY (source_publication_id) REFERENCES content_publications (id) ON DELETE SET NULL,
  CONSTRAINT fk_content_publications_staff FOREIGN KEY (published_by_staff_id) REFERENCES staff_users (id) ON DELETE SET NULL,
  CONSTRAINT chk_content_publications_state CHECK (state IN ('PUBLISHED','SUPERSEDED','ROLLED_BACK'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE content_documents
  ADD CONSTRAINT fk_content_documents_publication FOREIGN KEY (published_publication_id)
  REFERENCES content_publications (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. Navigation (draft, item-level ordering)
-- ---------------------------------------------------------------------------
CREATE TABLE content_nav_items (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  item_key VARCHAR(80) NOT NULL,
  parent_id CHAR(36) NULL,
  label VARCHAR(120) NOT NULL,
  link_type VARCHAR(24) NOT NULL DEFAULT 'CUSTOM_INTERNAL',
  link_target VARCHAR(180) NULL,
  external_url VARCHAR(500) NULL,
  mega_menu_key VARCHAR(80) NULL,
  position INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_nav_items_key (document_id, item_key),
  UNIQUE KEY uk_content_nav_items_position (document_id, parent_id, position),
  KEY idx_content_nav_items_parent (parent_id),
  CONSTRAINT fk_content_nav_items_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_content_nav_items_parent FOREIGN KEY (parent_id) REFERENCES content_nav_items (id) ON DELETE CASCADE,
  CONSTRAINT chk_content_nav_items_link_type CHECK (link_type IN
    ('HOME','PRODUCT','COLLECTION','CATEGORY','CONTENT_PAGE','SEARCH','ACCOUNT','CUSTOM_INTERNAL','EXTERNAL')),
  CONSTRAINT chk_content_nav_items_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Mega menus (bounded typed layout in payload_json; promo media by id)
-- ---------------------------------------------------------------------------
CREATE TABLE content_mega_menus (
  id CHAR(36) NOT NULL,
  menu_key VARCHAR(80) NOT NULL,
  name VARCHAR(120) NOT NULL,
  promo_media_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL,
  payload_json JSON NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_mega_menus_key (menu_key),
  CONSTRAINT fk_content_mega_menus_media FOREIGN KEY (promo_media_id) REFERENCES media (id) ON DELETE RESTRICT,
  CONSTRAINT chk_content_mega_menus_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Announcement slides (ordering + per-slide schedule)
-- ---------------------------------------------------------------------------
CREATE TABLE content_announcements (
  id CHAR(36) NOT NULL,
  announcement_key VARCHAR(80) NOT NULL,
  text VARCHAR(300) NOT NULL,
  link_type VARCHAR(24) NULL,
  link_target VARCHAR(180) NULL,
  external_url VARCHAR(500) NULL,
  starts_at DATETIME(3) NULL,
  expires_at DATETIME(3) NULL,
  position INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_announcements_key (announcement_key),
  UNIQUE KEY uk_content_announcements_position (position),
  CONSTRAINT chk_content_announcements_link_type CHECK (link_type IS NULL OR link_type IN
    ('HOME','PRODUCT','COLLECTION','CATEGORY','CONTENT_PAGE','SEARCH','CUSTOM_INTERNAL','EXTERNAL')),
  CONSTRAINT chk_content_announcements_status CHECK (status IN ('ACTIVE','DISABLED')),
  CONSTRAINT chk_content_announcements_schedule CHECK (expires_at IS NULL OR starts_at IS NULL OR expires_at > starts_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 5. Homepage sections (whitelisted types, ordering, per-type config_json)
-- ---------------------------------------------------------------------------
CREATE TABLE content_home_sections (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  section_key VARCHAR(80) NOT NULL,
  section_type VARCHAR(32) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  config_json JSON NOT NULL,
  media_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_home_sections_key (document_id, section_key),
  UNIQUE KEY uk_content_home_sections_position (document_id, position),
  CONSTRAINT fk_content_home_sections_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_content_home_sections_media FOREIGN KEY (media_id) REFERENCES media (id) ON DELETE RESTRICT,
  CONSTRAINT chk_content_home_sections_type CHECK (section_type IN
    ('HERO','BRAND_STRIP','PRODUCT_CAROUSEL','CATEGORY_SECTION','COLLECTION_GRID','EDITORIAL_BANNER','PROMO_BANNER','IMAGE_TEXT','REVIEWS','TRUST_STRIP','CONTENT_BLOCK'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 6. Footer (groups + links normalized; contact/socials bounded JSON)
-- ---------------------------------------------------------------------------
CREATE TABLE content_footer_groups (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  group_key VARCHAR(40) NOT NULL,
  label VARCHAR(120) NOT NULL,
  position INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_footer_groups_key (document_id, group_key),
  UNIQUE KEY uk_content_footer_groups_position (document_id, position),
  CONSTRAINT fk_content_footer_groups_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT chk_content_footer_groups_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_footer_links (
  id CHAR(36) NOT NULL,
  group_id CHAR(36) NOT NULL,
  label VARCHAR(120) NOT NULL,
  link_type VARCHAR(24) NOT NULL DEFAULT 'CUSTOM_INTERNAL',
  link_target VARCHAR(180) NULL,
  external_url VARCHAR(500) NULL,
  position INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  PRIMARY KEY (id),
  UNIQUE KEY uk_content_footer_links_position (group_id, position),
  CONSTRAINT fk_content_footer_links_group FOREIGN KEY (group_id) REFERENCES content_footer_groups (id) ON DELETE CASCADE,
  CONSTRAINT chk_content_footer_links_link_type CHECK (link_type IN
    ('HOME','PRODUCT','COLLECTION','CATEGORY','CONTENT_PAGE','SEARCH','ACCOUNT','CUSTOM_INTERNAL','EXTERNAL')),
  CONSTRAINT chk_content_footer_links_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE content_footer_meta (
  document_id CHAR(36) NOT NULL,
  meta_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (document_id),
  CONSTRAINT fk_content_footer_meta_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
