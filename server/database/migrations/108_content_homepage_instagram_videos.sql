-- The homepage testimonials slot becomes an Instagram video section.
--
-- The REVIEWS section on the homepage showed featured customer reviews under
-- "Testimonials / What People Say". That slot now shows Instagram reels and
-- posts in a carousel (section type INSTAGRAM_VIDEOS, managed in
-- CMS -> Experience -> Homepage).
--
-- Reviews themselves are NOT touched: customers still review products after
-- delivery, moderators still publish them, and they still show on the
-- product page. Only the homepage section that pointed at them changes.
--
-- The section keeps its place and its on/off setting, in the draft and in
-- every published homepage snapshot (so a rollback cannot bring the
-- testimonials back). It shows the store's latest Instagram posts once an
-- account is connected (migration 109, modules/instagram) and stays hidden
-- until then. Forward-only. MySQL 8.x.

-- The section type is a whitelist enforced by the database too (026); the new
-- type has to be allowed before any row can use it.
ALTER TABLE content_home_sections DROP CHECK chk_content_home_sections_type;
ALTER TABLE content_home_sections ADD CONSTRAINT chk_content_home_sections_type CHECK (section_type IN
  ('HERO', 'BRAND_STRIP', 'PRODUCT_CAROUSEL', 'CATEGORY_SECTION', 'COLLECTION_GRID', 'EDITORIAL_BANNER',
   'PROMO_BANNER', 'IMAGE_TEXT', 'REVIEWS', 'TRUST_STRIP', 'CONTENT_BLOCK', 'INSTAGRAM_VIDEOS'));

UPDATE content_home_sections
   SET section_key = 'instagram_videos',
       section_type = 'INSTAGRAM_VIDEOS',
       config_json = CAST('{"eyebrow":"The CORCOTTON community","heading":"Real People. Real Style.","description":"See how our community wears CORCOTTON every day.","autoplaySeconds":6,"mode":"LATEST","limit":8,"picks":[]}' AS JSON)
 WHERE section_key = 'reviews' AND section_type = 'REVIEWS';

UPDATE content_publications p
  JOIN content_documents d ON d.id = p.document_id AND d.doc_type = 'HOMEPAGE'
   SET p.snapshot_json = JSON_SET(p.snapshot_json,
         JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')), 'instagram_videos',
         REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')), '.key', '.type'), 'INSTAGRAM_VIDEOS',
         REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')), '.key', '.config'), CAST('{"eyebrow":"The CORCOTTON community","heading":"Real People. Real Style.","description":"See how our community wears CORCOTTON every day.","autoplaySeconds":6,"mode":"LATEST","limit":8,"picks":[]}' AS JSON))
 WHERE JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')) IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')), '.key', '.type'))) = 'REVIEWS';
