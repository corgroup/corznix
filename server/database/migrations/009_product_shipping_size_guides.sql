-- Wave 6C.2: product-owned fulfillment metadata and flexible reusable guides.
-- Existing products remain intentionally unconfigured; no inferred backfill.

ALTER TABLE size_guides
  ADD COLUMN title VARCHAR(160) NULL AFTER name,
  ADD COLUMN description VARCHAR(500) NULL AFTER title,
  ADD COLUMN columns_json JSON NULL AFTER unit,
  DROP CHECK chk_size_guides_status,
  ADD CONSTRAINT chk_size_guides_status CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED'));

ALTER TABLE size_guide_rows
  ADD COLUMN values_json JSON NULL AFTER size;

CREATE TABLE IF NOT EXISTS product_shipping_profiles (
  id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  weight_grams INT UNSIGNED NULL,
  length_mm INT UNSIGNED NULL,
  width_mm INT UNSIGNED NULL,
  height_mm INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_shipping_profiles_product (product_id),
  CONSTRAINT fk_product_shipping_profiles_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT chk_product_shipping_profiles_values CHECK (
    (weight_grams IS NULL OR weight_grams > 0) AND
    (length_mm IS NULL OR length_mm > 0) AND
    (width_mm IS NULL OR width_mm > 0) AND
    (height_mm IS NULL OR height_mm > 0)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
