-- Announcement bar builder.
--
-- 1. content_announcements.link_ref_type / link_ref_id — a message that links
--    to a category, collection or page stores a REFERENCE to it (like the
--    header and footer links since 106), so renaming or moving it keeps the
--    link working, and switching it off hides the link (the message stays).
-- 2. content_announcement_settings — one JSON settings row per ANNOUNCEMENTS
--    document, draft state like the messages and published inside the
--    announcements snapshot:
--      autoplaySeconds  how long each message shows (the bar hardcoded 4 s);
--      showClock        the clock at the right of the bar (desktop);
--      dismissible      whether visitors can close the bar;
--      dismissVersion   visitors who closed the bar see it again once this
--                       changes (the storefront ignored the published value
--                       until now and used a constant).
--
-- Backfill writes exactly what the storefront shows today (4 s, clock on,
-- closable, v1) and references for existing slug links, so nothing changes
-- until someone edits the bar. Forward-only, idempotent. MySQL 8.x.

ALTER TABLE content_announcements
  ADD COLUMN link_ref_type VARCHAR(16) NULL AFTER external_url,
  ADD COLUMN link_ref_id CHAR(36) NULL AFTER link_ref_type;

CREATE TABLE content_announcement_settings (
  document_id CHAR(36) NOT NULL,
  brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  settings_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (document_id),
  KEY idx_content_announcement_settings_brand (brand_id),
  CONSTRAINT fk_content_announcement_settings_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_content_announcement_settings_brand FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- backfill: today's behaviour ------------------------------------------

INSERT INTO content_announcement_settings (document_id, brand_id, settings_json)
SELECT d.id, d.brand_id, JSON_OBJECT('autoplaySeconds', 4, 'showClock', TRUE, 'dismissible', TRUE, 'dismissVersion', 'v1')
FROM content_documents d
WHERE d.doc_type = 'ANNOUNCEMENTS' AND d.doc_key = 'default' AND d.brand_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM content_announcement_settings s WHERE s.document_id = d.id);

-- Existing slug links become references (a collection wins over a category
-- with the same slug, as on the website).
UPDATE content_announcements a
JOIN categories c ON c.slug COLLATE utf8mb4_unicode_ci = a.link_target COLLATE utf8mb4_unicode_ci
  AND c.brand_id COLLATE utf8mb4_unicode_ci = a.brand_id COLLATE utf8mb4_unicode_ci
SET a.link_ref_type = 'CATEGORY', a.link_ref_id = c.id
WHERE a.link_type IN ('COLLECTION', 'CATEGORY') AND a.link_ref_id IS NULL;

UPDATE content_announcements a
JOIN collections c ON c.slug COLLATE utf8mb4_unicode_ci = a.link_target COLLATE utf8mb4_unicode_ci
  AND c.brand_id COLLATE utf8mb4_unicode_ci = a.brand_id COLLATE utf8mb4_unicode_ci
SET a.link_ref_type = 'COLLECTION', a.link_ref_id = c.id
WHERE a.link_type IN ('COLLECTION', 'CATEGORY') AND (a.link_ref_id IS NULL OR a.link_ref_type = 'CATEGORY');

UPDATE content_announcements a
JOIN content_pages p ON p.slug COLLATE utf8mb4_unicode_ci = a.link_target COLLATE utf8mb4_unicode_ci
  AND p.brand_id COLLATE utf8mb4_unicode_ci = a.brand_id COLLATE utf8mb4_unicode_ci
SET a.link_ref_type = 'PAGE', a.link_ref_id = p.id
WHERE a.link_type = 'CONTENT_PAGE' AND a.link_ref_id IS NULL;
