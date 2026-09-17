-- Homepage hero banners as real, admin-managed content.
--
-- Until now the hero was two things, neither of them manageable:
--   * the copy (heading, sub-heading, CTA label, CTA path) was HARDCODED in a
--     SLIDES array inside HeroSection.jsx, so changing a headline meant a code
--     change and a redeploy;
--   * the videos came from two fixed `site_media` slots (home_hero_1/2) that
--     no CMS screen could bind — the only route was a direct API call.
--
-- site_media cannot model this: it is a fixed set of single-asset slots keyed
-- by name, with no title, CTA, ordering or scheduling. A hero is a LIST of
-- banners, each with content and a schedule, so it gets its own table.
-- site_media stays for the genuine single-slot cases (the auth banner).
--
-- One asset per banner, used responsively for both desktop and mobile — the
-- storefront hero is a full-bleed crop, so separate art direction would be a
-- product decision, not a schema one. Adding a mobile_media_id later is
-- additive if that is ever wanted.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE hero_banners (
  id CHAR(36) NOT NULL,
  brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,

  -- The asset. RESTRICT, not CASCADE: deleting a media row out from under a
  -- live banner should be refused, the same rule product_media follows.
  media_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL,

  title VARCHAR(100) NULL,
  subtitle VARCHAR(200) NULL,
  cta_label VARCHAR(60) NULL,
  cta_href VARCHAR(500) NULL,
  alt_text VARCHAR(255) NULL,

  -- ACTIVE/INACTIVE is the admin's on-off switch. Scheduling is separate and
  -- optional: a banner can be ACTIVE but not yet started, which is why the
  -- storefront filters on both rather than treating status as the whole story.
  status VARCHAR(16) NOT NULL DEFAULT 'INACTIVE',
  display_order INT NOT NULL DEFAULT 0,
  starts_at DATETIME(3) NULL,
  ends_at DATETIME(3) NULL,

  created_by_staff_id CHAR(36) NULL,
  updated_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  -- The storefront's read is "this brand's live banners in order", so that is
  -- what gets the index.
  KEY idx_hero_banners_brand_live (brand_id, status, display_order),
  KEY idx_hero_banners_media (media_id),
  CONSTRAINT chk_hero_banners_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
  CONSTRAINT fk_hero_banners_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT,
  CONSTRAINT fk_hero_banners_media FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE RESTRICT,
  CONSTRAINT fk_hero_banners_created_by FOREIGN KEY (created_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_hero_banners_updated_by FOREIGN KEY (updated_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
