-- 091 — structured product specifications + SEO keywords.
--
-- Until now the storefront PDP printed a HARDCODED "Fabric: 100% Natural
-- Cotton" for every product, and fabric/GSM existed nowhere in the schema.
-- Merchandisers could only convey them by writing prose into `description`,
-- which no filter, feed or PDP row can read.
--
-- Shape follows the columns already on `products` (`fit`, `product_type`,
-- `category_id`): the specifications the business names as first-class get
-- first-class columns, so they stay queryable/filterable and cannot be
-- misspelled into a key/value bag. Anything else reusable-but-open-ended
-- goes in `product_specifications`.

ALTER TABLE products
  ADD COLUMN fabric VARCHAR(120) NULL AFTER brand,
  -- Grams per square metre. Real apparel range is ~80–500; SMALLINT is ample
  -- and the CHECK keeps a mistyped "1800" out of the catalogue.
  ADD COLUMN gsm SMALLINT UNSIGNED NULL AFTER fabric,
  ADD COLUMN seo_keywords VARCHAR(500) NULL AFTER seo_description,
  ADD CONSTRAINT chk_products_gsm CHECK (gsm IS NULL OR (gsm >= 10 AND gsm <= 2000));

-- Open-ended extras (Sleeve length, Neck type, Care instructions, Origin…).
-- Ordered, brand-scoped, and cascade-deleted with the product so a deleted
-- product can never leave orphaned spec rows behind.
CREATE TABLE product_specifications (
  id CHAR(36) NOT NULL,
  -- Collation is pinned PER COLUMN, not on the table: `products.id` is
  -- utf8mb4_unicode_ci (from 002_catalog) while `brands.id` is
  -- utf8mb4_0900_ai_ci (from the multi-company phase). A foreign key needs an
  -- exact collation match, so no single table-level collation satisfies both.
  -- Matching each referenced column here is the fix that does NOT require
  -- rewriting the collation of existing catalogue tables.
  brand_id CHAR(36) COLLATE utf8mb4_0900_ai_ci NOT NULL,
  product_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  label VARCHAR(80) NOT NULL,
  value VARCHAR(300) NOT NULL,
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- One row per label per product: re-saving "Sleeve length" updates it
  -- rather than silently accumulating duplicates on the PDP.
  UNIQUE KEY uq_product_specifications_product_label (product_id, label),
  KEY idx_product_specifications_product (product_id, display_order),
  CONSTRAINT fk_product_specifications_product
    FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_product_specifications_brand
    FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE RESTRICT
) ENGINE=InnoDB;
