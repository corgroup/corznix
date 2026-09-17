-- Single source of truth for website links.
--
-- Header, dropdown, mobile menu, footer and homepage links used to store a
-- COPY of an entity's name and URL ("TOPS" -> /collections/tops). Renaming the
-- Tops category, changing its URL or deleting it left every copy stale.
--
-- From now on a link to a category, collection or content page is a
-- reference: the website resolves the entity's CURRENT name, URL and status at
-- request time (server/src/modules/content/entityLinks.js).
--
--   1. content_nav_items / content_footer_links get link_ref_type +
--      link_ref_id — the referenced entity, by id (slug-proof).
--   2. content_entity_slug_history — every slug a category/collection has had
--      (and the slug of a deleted one). A link still written as an old URL
--      resolves to the entity that owned it, or disappears if it was deleted.
--
-- Backfill resolves today's slug-based rows to ids. Forward-only,
-- non-destructive; the old link_type/link_target columns stay authoritative
-- for anything that is not an entity (custom paths, external URLs). MySQL 8.x.

ALTER TABLE content_nav_items
  ADD COLUMN link_ref_type VARCHAR(16) NULL AFTER external_url,
  ADD COLUMN link_ref_id CHAR(36) NULL AFTER link_ref_type;

ALTER TABLE content_footer_links
  ADD COLUMN link_ref_type VARCHAR(16) NULL AFTER external_url,
  ADD COLUMN link_ref_id CHAR(36) NULL AFTER link_ref_type;

CREATE TABLE content_entity_slug_history (
  entity_type VARCHAR(16) NOT NULL,
  entity_id CHAR(36) NOT NULL,
  slug VARCHAR(180) NOT NULL,
  brand_id CHAR(36) NULL,
  recorded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (entity_type, entity_id, slug),
  KEY idx_content_entity_slug_history_slug (slug),
  CONSTRAINT chk_content_entity_slug_history_type CHECK (entity_type IN ('CATEGORY', 'COLLECTION', 'PAGE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- backfill: slug-based rows -> entity ids ----------------------------------
-- /collections/<slug> shows a collection when one exists, else the category,
-- so collections are matched first.

UPDATE content_nav_items i
JOIN collections c ON c.slug COLLATE utf8mb4_unicode_ci = i.link_target COLLATE utf8mb4_unicode_ci
  AND c.brand_id COLLATE utf8mb4_unicode_ci = i.brand_id COLLATE utf8mb4_unicode_ci
SET i.link_ref_type = 'COLLECTION', i.link_ref_id = c.id
WHERE i.link_type IN ('COLLECTION', 'CATEGORY') AND i.link_ref_id IS NULL;

UPDATE content_nav_items i
JOIN categories c ON c.slug COLLATE utf8mb4_unicode_ci = i.link_target COLLATE utf8mb4_unicode_ci
  AND c.brand_id COLLATE utf8mb4_unicode_ci = i.brand_id COLLATE utf8mb4_unicode_ci
SET i.link_ref_type = 'CATEGORY', i.link_ref_id = c.id
WHERE i.link_type IN ('COLLECTION', 'CATEGORY') AND i.link_ref_id IS NULL;

UPDATE content_nav_items i
JOIN content_pages p ON p.slug COLLATE utf8mb4_unicode_ci = i.link_target COLLATE utf8mb4_unicode_ci
  AND p.brand_id COLLATE utf8mb4_unicode_ci = i.brand_id COLLATE utf8mb4_unicode_ci
SET i.link_ref_type = 'PAGE', i.link_ref_id = p.id
WHERE i.link_type = 'CONTENT_PAGE' AND i.link_ref_id IS NULL;

UPDATE content_footer_links l
JOIN content_footer_groups g ON g.id = l.group_id
JOIN collections c ON c.slug COLLATE utf8mb4_unicode_ci = l.link_target COLLATE utf8mb4_unicode_ci
  AND c.brand_id COLLATE utf8mb4_unicode_ci = g.brand_id COLLATE utf8mb4_unicode_ci
SET l.link_ref_type = 'COLLECTION', l.link_ref_id = c.id
WHERE l.link_type IN ('COLLECTION', 'CATEGORY') AND l.link_ref_id IS NULL;

UPDATE content_footer_links l
JOIN content_footer_groups g ON g.id = l.group_id
JOIN categories c ON c.slug COLLATE utf8mb4_unicode_ci = l.link_target COLLATE utf8mb4_unicode_ci
  AND c.brand_id COLLATE utf8mb4_unicode_ci = g.brand_id COLLATE utf8mb4_unicode_ci
SET l.link_ref_type = 'CATEGORY', l.link_ref_id = c.id
WHERE l.link_type IN ('COLLECTION', 'CATEGORY') AND l.link_ref_id IS NULL;

UPDATE content_footer_links l
JOIN content_footer_groups g ON g.id = l.group_id
JOIN content_pages p ON p.slug COLLATE utf8mb4_unicode_ci = l.link_target COLLATE utf8mb4_unicode_ci
  AND p.brand_id COLLATE utf8mb4_unicode_ci = g.brand_id COLLATE utf8mb4_unicode_ci
SET l.link_ref_type = 'PAGE', l.link_ref_id = p.id
WHERE l.link_type = 'CONTENT_PAGE' AND l.link_ref_id IS NULL;
