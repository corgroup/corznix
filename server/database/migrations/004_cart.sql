-- Wave 6A: authenticated cart persistence. SKU is the canonical sellable
-- identity; price is intentionally not stored on cart_items.
CREATE TABLE IF NOT EXISTS carts (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_carts_customer (customer_id),
  CONSTRAINT fk_carts_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS cart_items (
  id CHAR(36) NOT NULL,
  cart_id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_cart_items_cart_sku (cart_id, sku_id),
  KEY idx_cart_items_cart (cart_id),
  CONSTRAINT fk_cart_items_cart FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
  CONSTRAINT fk_cart_items_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE RESTRICT,
  CONSTRAINT chk_cart_items_quantity CHECK (quantity BETWEEN 1 AND 99)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
