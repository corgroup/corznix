-- Wave 8D: Size Guide Studio data model + the site-media ownership boundary.
--
--  * size_guides gains `notes` (operator free-text shown under the table).
--  * size_guide_rows gains `values_cm_json` (the centimetre variant of
--    `values_json`, which stays the canonical inch measurements), plus
--    uniqueness on (guide, display_order) and (guide, size) so a guide can
--    never carry duplicate positions or duplicate size labels.
--  * site_media: a fixed-vocabulary key -> media asset map. This is how the
--    storefront's hero videos / promo + auth banners stop being bundled
--    local files and instead resolve through the media registry
--    (provider-neutral, Cloudinary-backed). NOT a CMS — no editing surface,
--    just data ownership. A Home/Banner CMS (Wave 8E) would later own the
--    key set.
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. size_guides / size_guide_rows
-- ---------------------------------------------------------------------------
ALTER TABLE size_guides
  ADD COLUMN notes VARCHAR(1000) NULL AFTER description;

ALTER TABLE size_guide_rows
  ADD COLUMN values_cm_json JSON NULL AFTER values_json,
  ADD UNIQUE KEY uk_size_guide_rows_order (size_guide_id, display_order),
  ADD UNIQUE KEY uk_size_guide_rows_size (size_guide_id, size);

-- ---------------------------------------------------------------------------
-- 2. site_media — storefront hero / banner asset ownership
-- ---------------------------------------------------------------------------
CREATE TABLE site_media (
  media_key VARCHAR(64) NOT NULL,
  media_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  alt_text VARCHAR(255) NULL,
  updated_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (media_key),
  KEY idx_site_media_media (media_id),
  CONSTRAINT fk_site_media_asset FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE RESTRICT,
  CONSTRAINT fk_site_media_staff FOREIGN KEY (updated_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
