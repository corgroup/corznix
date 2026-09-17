-- Header builder: the last hardcoded parts of the storefront header become
-- CMS content.
--
-- Until now three things in the mobile menu lived only in MobileMenu.jsx:
--   * which icon each top-level item shows (looked up by the item's LABEL,
--     so renaming "TOPS" silently lost its icon),
--   * the promo card under TOPS / BOTTOMS / ACCESSORIES ("Built for every
--     season." / "Shop Tops") — also keyed by label,
--   * the secondary links (About Us ... Contact Us) and the "Built on
--     purpose." tagline at the bottom of the drawer.
-- The CMS could not change any of them, and renaming a nav item broke them.
--
-- Changes:
--   1. content_nav_items.icon — icon NAME (whitelisted server-side, resolved
--      to a component by the storefront's iconRegistry).
--   2. content_nav_settings — one JSON settings row per NAVIGATION document:
--      { mobileLinks: [{label, path}], mobileTagline }. Draft state like the
--      nav items themselves; published inside the navigation snapshot.
--   The promo card under a mobile submenu is no longer separate copy: the
--   storefront uses the dropdown's own promo panel (one menu everywhere).
--
-- Backfill writes exactly the values the storefront renders today, so the
-- storefront is unchanged until someone edits them. Forward-only,
-- non-destructive, idempotent guards on every backfill statement. MySQL 8.x.

ALTER TABLE content_nav_items
  ADD COLUMN icon VARCHAR(40) NULL AFTER mega_menu_key;

CREATE TABLE content_nav_settings (
  document_id CHAR(36) NOT NULL,
  brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  settings_json JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (document_id),
  KEY idx_content_nav_settings_brand (brand_id),
  CONSTRAINT fk_content_nav_settings_document FOREIGN KEY (document_id) REFERENCES content_documents (id) ON DELETE CASCADE,
  CONSTRAINT fk_content_nav_settings_brand FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---- backfill: today's hardcoded values, CORCOTTON only ------------------

INSERT INTO content_nav_settings (document_id, brand_id, settings_json)
SELECT d.id, d.brand_id, JSON_OBJECT(
  'mobileLinks', JSON_ARRAY(
    JSON_OBJECT('label', 'About Us', 'path', '/pages/our-story'),
    JSON_OBJECT('label', 'Size Guide', 'path', '/size-guide'),
    JSON_OBJECT('label', 'Help & Support', 'path', '/help'),
    JSON_OBJECT('label', 'Shipping & Returns', 'path', '/pages/shipping'),
    JSON_OBJECT('label', 'Contact Us', 'path', '/pages/contact')
  ),
  'mobileTagline', 'Built on purpose.'
)
FROM content_documents d
JOIN brands b ON b.id = d.brand_id
WHERE d.doc_type = 'NAVIGATION' AND d.doc_key = 'primary' AND b.slug = 'corcotton'
  AND NOT EXISTS (SELECT 1 FROM content_nav_settings s WHERE s.document_id = d.id);

UPDATE content_nav_items i
JOIN brands b ON b.id = i.brand_id
SET i.icon = CASE i.item_key
  WHEN 'nav_tops' THEN 'shirt'
  WHEN 'nav_bottoms' THEN 'pants'
  WHEN 'nav_accessories' THEN 'bag-handle'
  WHEN 'nav_new_in' THEN 'sparkles'
END
WHERE b.slug = 'corcotton' AND i.icon IS NULL
  AND i.item_key IN ('nav_tops', 'nav_bottoms', 'nav_accessories', 'nav_new_in');
