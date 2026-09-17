-- Wave 8D: manual collections gain an explicit, deterministic product order.
--
--  * product_collections.position — the product's slot within a collection.
--    Unique per (collection, position) so a concurrent reorder can't create
--    duplicate slots. Backfilled 0..n-1 per collection by insertion order.
--  * collections.published_at already exists (unused) — left as-is for a
--    future Wave 8E visibility/scheduling story; `status` (ACTIVE/ARCHIVED)
--    is the storefront-visibility switch this wave.
--
-- Forward-only, non-destructive. MySQL 8.x. Manual membership only — no rule
-- engine / smart-collection DSL / scheduler (§41).

ALTER TABLE product_collections
  ADD COLUMN position INT NOT NULL DEFAULT 0 AFTER collection_id;

UPDATE product_collections pc
JOIN (
  SELECT product_id, collection_id,
    ROW_NUMBER() OVER (PARTITION BY collection_id ORDER BY created_at ASC, product_id ASC) - 1 AS rn
  FROM product_collections
) ranked
  ON ranked.product_id = pc.product_id AND ranked.collection_id = pc.collection_id
SET pc.position = ranked.rn;

ALTER TABLE product_collections
  ADD UNIQUE KEY uk_product_collections_position (collection_id, position);
