-- Homepage copy lives in the content, not in the storefront's components.
--
-- The homepage sections "The Latest Drop", "Bestsellers", "Shop by Collection",
-- "Built on Purpose", the brand strip, "What People Say" and the trust strip
-- rendered text written into their React components. Their CMS config was
-- ignored: a heading typed in the CMS never reached the website, and the
-- seeded "Latest Drop" / "Best Sellers" headings never matched what customers
-- actually saw ("The Latest Drop" / "Bestsellers").
--
-- The storefront now renders each section from its config. This migration
-- writes the copy customers see TODAY into that config, so the website does
-- not change on deploy:
--   * the two seeded headings that never rendered are replaced by the ones
--     that did;
--   * every other value an editor already set is kept (JSON_MERGE_PATCH puts
--     today's copy underneath the stored config);
--   * both the draft rows and every published homepage snapshot are updated,
--     so the live site, a later publish and a rollback all show the same copy.
-- Sections are matched by key AND type; a section whose type was changed is
-- left alone. Forward-only. MySQL 8.x.

-- brand_strip (BRAND_STRIP)
UPDATE content_home_sections
   SET config_json = JSON_MERGE_PATCH(CAST('{"phrases":["CORCOTTON™","BUILT ON PURPOSE","MADE TO ENDURE","SUBTLE. NATURAL. TIMELESS."]}' AS JSON), IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()))
 WHERE section_key = 'brand_strip' AND section_type = 'BRAND_STRIP';
UPDATE content_publications p
  JOIN content_documents d ON d.id = p.document_id AND d.doc_type = 'HOMEPAGE'
   SET p.snapshot_json = JSON_SET(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_strip', NULL, '$.sections[*].key')), '.key', '.config'),
         JSON_MERGE_PATCH(CAST('{"phrases":["CORCOTTON™","BUILT ON PURPOSE","MADE TO ENDURE","SUBTLE. NATURAL. TIMELESS."]}' AS JSON), IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_strip', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_strip', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT())))
 WHERE JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_strip', NULL, '$.sections[*].key')) IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_strip', NULL, '$.sections[*].key')), '.key', '.type'))) = 'BRAND_STRIP';

-- latest_drop (PRODUCT_CAROUSEL)
UPDATE content_home_sections
   SET config_json = JSON_MERGE_PATCH(CAST('{"eyebrow":"The First Release","heading":"The Latest Drop"}' AS JSON), IF(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()), '$.heading')) = 'Latest Drop', JSON_REMOVE(IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()), '$.heading'), IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT())))
 WHERE section_key = 'latest_drop' AND section_type = 'PRODUCT_CAROUSEL';
UPDATE content_publications p
  JOIN content_documents d ON d.id = p.document_id AND d.doc_type = 'HOMEPAGE'
   SET p.snapshot_json = JSON_SET(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')), '.key', '.config'),
         JSON_MERGE_PATCH(CAST('{"eyebrow":"The First Release","heading":"The Latest Drop"}' AS JSON), IF(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT()), '$.heading')) = 'Latest Drop', JSON_REMOVE(IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT()), '$.heading'), IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT()))))
 WHERE JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')) IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'latest\_drop', NULL, '$.sections[*].key')), '.key', '.type'))) = 'PRODUCT_CAROUSEL';

-- category_section (CATEGORY_SECTION)
UPDATE content_home_sections
   SET config_json = JSON_MERGE_PATCH(CAST('{"heading":"Shop by Collection"}' AS JSON), IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()))
 WHERE section_key = 'category_section' AND section_type = 'CATEGORY_SECTION';
UPDATE content_publications p
  JOIN content_documents d ON d.id = p.document_id AND d.doc_type = 'HOMEPAGE'
   SET p.snapshot_json = JSON_SET(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'category\_section', NULL, '$.sections[*].key')), '.key', '.config'),
         JSON_MERGE_PATCH(CAST('{"heading":"Shop by Collection"}' AS JSON), IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'category\_section', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'category\_section', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT())))
 WHERE JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'category\_section', NULL, '$.sections[*].key')) IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'category\_section', NULL, '$.sections[*].key')), '.key', '.type'))) = 'CATEGORY_SECTION';

-- best_sellers (PRODUCT_CAROUSEL)
UPDATE content_home_sections
   SET config_json = JSON_MERGE_PATCH(CAST('{"eyebrow":"Bestsellers","heading":"Bestsellers","description":"Most loved pieces by our community."}' AS JSON), IF(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()), '$.heading')) = 'Best Sellers', JSON_REMOVE(IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()), '$.heading'), IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT())))
 WHERE section_key = 'best_sellers' AND section_type = 'PRODUCT_CAROUSEL';
UPDATE content_publications p
  JOIN content_documents d ON d.id = p.document_id AND d.doc_type = 'HOMEPAGE'
   SET p.snapshot_json = JSON_SET(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')), '.key', '.config'),
         JSON_MERGE_PATCH(CAST('{"eyebrow":"Bestsellers","heading":"Bestsellers","description":"Most loved pieces by our community."}' AS JSON), IF(JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT()), '$.heading')) = 'Best Sellers', JSON_REMOVE(IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT()), '$.heading'), IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT()))))
 WHERE JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')) IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'best\_sellers', NULL, '$.sections[*].key')), '.key', '.type'))) = 'PRODUCT_CAROUSEL';

-- brand_banner (EDITORIAL_BANNER)
UPDATE content_home_sections
   SET config_json = JSON_MERGE_PATCH(CAST('{"eyebrow":"Our Philosophy","heading":"Built on Purpose","body":"We don''t chase trends. We build with purpose. Every piece is a reminder to endure, to move forward, and to stay true to who you are.","ctaLabel":"Read Our Story","ctaPath":"/pages/our-story"}' AS JSON), IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()))
 WHERE section_key = 'brand_banner' AND section_type = 'EDITORIAL_BANNER';
UPDATE content_publications p
  JOIN content_documents d ON d.id = p.document_id AND d.doc_type = 'HOMEPAGE'
   SET p.snapshot_json = JSON_SET(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_banner', NULL, '$.sections[*].key')), '.key', '.config'),
         JSON_MERGE_PATCH(CAST('{"eyebrow":"Our Philosophy","heading":"Built on Purpose","body":"We don''t chase trends. We build with purpose. Every piece is a reminder to endure, to move forward, and to stay true to who you are.","ctaLabel":"Read Our Story","ctaPath":"/pages/our-story"}' AS JSON), IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_banner', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_banner', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT())))
 WHERE JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_banner', NULL, '$.sections[*].key')) IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'brand\_banner', NULL, '$.sections[*].key')), '.key', '.type'))) = 'EDITORIAL_BANNER';

-- reviews (REVIEWS)
UPDATE content_home_sections
   SET config_json = JSON_MERGE_PATCH(CAST('{"eyebrow":"Testimonials","heading":"What People Say"}' AS JSON), IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()))
 WHERE section_key = 'reviews' AND section_type = 'REVIEWS';
UPDATE content_publications p
  JOIN content_documents d ON d.id = p.document_id AND d.doc_type = 'HOMEPAGE'
   SET p.snapshot_json = JSON_SET(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')), '.key', '.config'),
         JSON_MERGE_PATCH(CAST('{"eyebrow":"Testimonials","heading":"What People Say"}' AS JSON), IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT())))
 WHERE JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')) IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'reviews', NULL, '$.sections[*].key')), '.key', '.type'))) = 'REVIEWS';

-- trust_strip (TRUST_STRIP)
UPDATE content_home_sections
   SET config_json = JSON_MERGE_PATCH(CAST('{"items":[{"icon":"leaf","title":"100% Natural Cotton","sub":"Pure. Safe. Gentle."},{"icon":"shield-check","title":"Ethically Made","sub":"For people and planet."},{"icon":"refresh","title":"Easy Returns","sub":"Hassle-free & quick"},{"icon":"truck","title":"Free Shipping","sub":"On every order"}]}' AS JSON), IF(JSON_TYPE(config_json) = 'OBJECT', config_json, JSON_OBJECT()))
 WHERE section_key = 'trust_strip' AND section_type = 'TRUST_STRIP';
UPDATE content_publications p
  JOIN content_documents d ON d.id = p.document_id AND d.doc_type = 'HOMEPAGE'
   SET p.snapshot_json = JSON_SET(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'trust\_strip', NULL, '$.sections[*].key')), '.key', '.config'),
         JSON_MERGE_PATCH(CAST('{"items":[{"icon":"leaf","title":"100% Natural Cotton","sub":"Pure. Safe. Gentle."},{"icon":"shield-check","title":"Ethically Made","sub":"For people and planet."},{"icon":"refresh","title":"Easy Returns","sub":"Hassle-free & quick"},{"icon":"truck","title":"Free Shipping","sub":"On every order"}]}' AS JSON), IF(JSON_TYPE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'trust\_strip', NULL, '$.sections[*].key')), '.key', '.config'))) = 'OBJECT', JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'trust\_strip', NULL, '$.sections[*].key')), '.key', '.config')), JSON_OBJECT())))
 WHERE JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'trust\_strip', NULL, '$.sections[*].key')) IS NOT NULL
   AND JSON_UNQUOTE(JSON_EXTRACT(p.snapshot_json, REPLACE(JSON_UNQUOTE(JSON_SEARCH(p.snapshot_json, 'one', 'trust\_strip', NULL, '$.sections[*].key')), '.key', '.type'))) = 'TRUST_STRIP';
