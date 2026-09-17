-- Wave 8D: product <-> category becomes a real many-to-many, and a category
-- can no longer be cascade-deleted out from under its children or products.
--
--  * categories.parent_id FK: ON DELETE CASCADE -> RESTRICT (§74). Deleting a
--    parent with children now fails at the DB; the service archives instead.
--    + categories.description.
--  * product_categories: the M2M membership table. `is_primary` marks the one
--    category that mirrors the legacy `products.category_id` pointer (kept in
--    sync by the service so the storefront's existing category filtering,
--    which reads products.category_id, is unaffected). product side CASCADEs
--    (deleting a product drops its memberships); category side RESTRICTs
--    (a mapped category can't be hard-deleted — the service guards this and
--    prefers ARCHIVE).
--  * Backfill: one is_primary row per product from its current category_id.
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. categories — safe parent delete + description
-- ---------------------------------------------------------------------------
ALTER TABLE categories
  DROP FOREIGN KEY fk_categories_parent;
ALTER TABLE categories
  ADD COLUMN description VARCHAR(500) NULL AFTER slug,
  ADD CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories (id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2. product_categories — M2M membership
-- ---------------------------------------------------------------------------
CREATE TABLE product_categories (
  product_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  category_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  position INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (product_id, category_id),
  KEY idx_product_categories_category (category_id),
  KEY idx_product_categories_primary (product_id, is_primary),
  CONSTRAINT fk_product_categories_product FOREIGN KEY (product_id) REFERENCES products (id) ON DELETE CASCADE,
  CONSTRAINT fk_product_categories_category FOREIGN KEY (category_id) REFERENCES categories (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Backfill from the legacy single-category pointer
-- ---------------------------------------------------------------------------
INSERT INTO product_categories (product_id, category_id, is_primary, position, created_at)
SELECT p.id, p.category_id, 1, 0, NOW(3)
FROM products p
WHERE p.category_id IS NOT NULL;
