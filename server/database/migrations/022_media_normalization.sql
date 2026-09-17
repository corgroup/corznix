-- Wave 8D: media platform normalization.
--
--  * `media` becomes a provider-neutral asset registry: `provider_key` +
--    `external_id` replace the Cloudinary-specific `cloudinary_public_id`
--    column name (documented Wave 3.5 debt). Provider ownership is immutable
--    history — a future R2 migration never rewrites a Cloudinary asset's
--    `provider_key`.
--  * `product_media` gains a nullable `media_id` FK into that registry
--    (ON DELETE RESTRICT — a mapped asset can never be hard-deleted out from
--    under a product), an `is_primary` flag, and a unique
--    (product, variant, position) key so a concurrent reorder cannot create
--    duplicate positions. `url` stays NOT NULL for storefront back-compat
--    (catalogMapper reads it); GRADIENT rows keep `media_id` NULL — a CSS
--    gradient string is not a provider asset.
--  * Deterministic, non-destructive backfill: every existing IMAGE/VIDEO
--    product_media row pointing at Cloudinary gets a `media` registry row
--    (deduped by URL) with its `external_id` parsed from the delivery URL,
--    and its `media_id` linked. Zero rows are deleted or reshaped.
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. media — provider-neutral asset registry
-- ---------------------------------------------------------------------------
ALTER TABLE media
  ADD COLUMN provider_key VARCHAR(32) NOT NULL DEFAULT 'cloudinary' AFTER brand_id,
  ADD COLUMN external_id VARCHAR(255) NULL AFTER provider_key,
  ADD COLUMN format VARCHAR(32) NULL AFTER bytes,
  ADD COLUMN alt_text VARCHAR(255) NULL AFTER format,
  ADD COLUMN original_filename VARCHAR(255) NULL AFTER alt_text,
  ADD COLUMN status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' AFTER original_filename,
  ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) AFTER created_at;

-- Carry the existing provider id onto the neutral column, then drop the
-- Cloudinary-specific name. Only modules/media/service.js read it.
UPDATE media SET external_id = cloudinary_public_id WHERE external_id IS NULL;
ALTER TABLE media DROP COLUMN cloudinary_public_id;

ALTER TABLE media
  ADD CONSTRAINT chk_media_status CHECK (status IN ('ACTIVE','ARCHIVED')),
  ADD UNIQUE KEY uk_media_provider_external (provider_key, external_id),
  ADD KEY idx_media_status (status);

-- ---------------------------------------------------------------------------
-- 2. product_media — registry link, primary flag, deterministic ordering
-- ---------------------------------------------------------------------------
-- `media_id` takes media.id's collation explicitly: the `media` table
-- (created in the first migration) is utf8mb4_0900_ai_ci while product_media
-- is utf8mb4_unicode_ci — a pre-existing schema-wide inconsistency this wave
-- does not try to unwind. Matching the column collation here is what lets the
-- FK be created.
ALTER TABLE product_media
  ADD COLUMN media_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER variant_id,
  ADD COLUMN is_primary TINYINT(1) NOT NULL DEFAULT 0 AFTER position,
  ADD CONSTRAINT fk_product_media_asset FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE RESTRICT,
  ADD UNIQUE KEY uk_product_media_position (product_id, variant_id, position),
  ADD KEY idx_product_media_primary (product_id, is_primary);

-- ---------------------------------------------------------------------------
-- 3. Backfill the asset registry from existing Cloudinary product media
-- ---------------------------------------------------------------------------
-- One media row per distinct Cloudinary delivery URL currently referenced by
-- an IMAGE/VIDEO product_media row. `external_id` = the Cloudinary public_id
-- parsed from the URL (strip host + `/upload/` + `v<digits>/` prefix +
-- extension). Deterministic: same URL always yields the same external_id.
INSERT INTO media (id, brand_id, provider_key, external_id, url, resource_type, format, alt_text, status, created_at, updated_at)
SELECT
  UUID(),
  (SELECT id FROM brands WHERE slug = 'corcotton'),
  'cloudinary',
  REGEXP_REPLACE(
    REGEXP_REPLACE(SUBSTRING_INDEX(src.url, '/upload/', -1), '^v[0-9]+/', ''),
    '\\.[A-Za-z0-9]+$', ''
  ),
  src.url,
  CASE WHEN src.media_type = 'VIDEO' THEN 'video' ELSE 'image' END,
  LOWER(REGEXP_SUBSTR(src.url, '[A-Za-z0-9]+$')),
  MIN(src.alt_text),
  'ACTIVE',
  NOW(3),
  NOW(3)
FROM (
  SELECT DISTINCT url, media_type, alt_text
  FROM product_media
  WHERE status = 'ACTIVE'
    AND media_type IN ('IMAGE', 'VIDEO')
    AND url LIKE 'https://res.cloudinary.com/%/upload/%'
) AS src
GROUP BY src.url, src.media_type;

-- Link every backfilled product_media row to its registry asset by URL.
-- (`m.url` is 0900_ai_ci, `pm.url` is unicode_ci — coerce for the compare.)
UPDATE product_media pm
JOIN media m
  ON m.url COLLATE utf8mb4_unicode_ci = pm.url
  AND m.provider_key = 'cloudinary'
SET pm.media_id = m.id
WHERE pm.media_id IS NULL
  AND pm.media_type IN ('IMAGE', 'VIDEO');

-- Deterministic primary within each (product, variant-scope) group: the
-- lowest-position real asset (IMAGE/VIDEO) wins; a GRADIENT-only scope falls
-- back to its lowest-position gradient. This mirrors what the storefront
-- already derives from media_type + position (catalogMapper: image = first
-- IMAGE, bg = first GRADIENT) — no storefront code reads is_primary; it
-- exists for the CMS. The service maintains "exactly one primary per
-- (product, variant) scope".
UPDATE product_media pm
JOIN (
  SELECT id,
    ROW_NUMBER() OVER (
      PARTITION BY product_id, variant_id
      ORDER BY (media_type = 'GRADIENT') ASC, position ASC, created_at ASC, id ASC
    ) AS rn
  FROM product_media
  WHERE status = 'ACTIVE'
) ranked ON ranked.id = pm.id AND ranked.rn = 1
SET pm.is_primary = 1;
