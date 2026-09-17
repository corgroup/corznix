-- Catalog + inventory schema. ADAPTED_SOURCE_TO_TARGET from
-- corcotton-store/server/migrations/002_catalog.sql (verified MySQL 8.x
-- compatible: InnoDB, CHECK constraints supported since 8.0.16, no
-- PostgreSQL-specific syntax) — see docs/MIGRATION.md, "Backend Salvage
-- Decisions" for the full reuse/adapt/reject classification.
--
-- Product = style/model (e.g. "Oversized Cotton Tee"), never a color/size row.
-- Variant = one color of a product. SKU = one sellable size within a variant.
-- Money is always minor units (paise) — never floating point. See
-- apps/corcotton/src/features/catalog/utils/money.js for the frontend-side
-- boundary that converts this to the display unit legacy cart/wishlist code
-- still uses.

CREATE TABLE IF NOT EXISTS categories (
  id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(140) NOT NULL,
  parent_id CHAR(36) NULL,
  display_order INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_categories_slug (slug),
  KEY idx_categories_parent (parent_id),
  CONSTRAINT fk_categories_parent FOREIGN KEY (parent_id) REFERENCES categories(id) ON DELETE CASCADE,
  CONSTRAINT chk_categories_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS collections (
  id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(140) NOT NULL,
  description VARCHAR(500) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  display_order INT NOT NULL DEFAULT 0,
  published_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_collections_slug (slug),
  CONSTRAINT chk_collections_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS size_guides (
  id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(140) NOT NULL,
  unit VARCHAR(10) NOT NULL DEFAULT 'in',
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_size_guides_slug (slug),
  CONSTRAINT chk_size_guides_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS size_guide_rows (
  id CHAR(36) NOT NULL,
  size_guide_id CHAR(36) NOT NULL,
  size VARCHAR(20) NOT NULL,
  chest DECIMAL(6,2) NULL,
  length DECIMAL(6,2) NULL,
  shoulder DECIMAL(6,2) NULL,
  sleeve DECIMAL(6,2) NULL,
  display_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_size_guide_rows_guide (size_guide_id, display_order),
  CONSTRAINT fk_size_guide_rows_guide FOREIGN KEY (size_guide_id) REFERENCES size_guides(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  id CHAR(36) NOT NULL,
  slug VARCHAR(180) NOT NULL,
  name VARCHAR(200) NOT NULL,
  short_description VARCHAR(500) NULL,
  description TEXT NULL,
  brand VARCHAR(100) NOT NULL DEFAULT 'CORCOTTON',
  category_id CHAR(36) NULL,
  fit VARCHAR(60) NULL,
  product_type VARCHAR(60) NOT NULL,
  size_guide_id CHAR(36) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
  published_at DATETIME(3) NULL,
  seo_title VARCHAR(200) NULL,
  seo_description VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_products_slug (slug),
  KEY idx_products_status (status),
  KEY idx_products_category (category_id),
  KEY idx_products_type (product_type),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL,
  CONSTRAINT fk_products_size_guide FOREIGN KEY (size_guide_id) REFERENCES size_guides(id) ON DELETE SET NULL,
  CONSTRAINT chk_products_status CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS product_collections (
  product_id CHAR(36) NOT NULL,
  collection_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (product_id, collection_id),
  KEY idx_product_collections_collection (collection_id),
  CONSTRAINT fk_product_collections_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_product_collections_collection FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A variant is one color of a product. `storefront_id` is a stable, small
-- integer identity for frontend routing/URLs, decoupled from the internal
-- UUID PK.
CREATE TABLE IF NOT EXISTS product_variants (
  id CHAR(36) NOT NULL,
  storefront_id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  product_id CHAR(36) NOT NULL,
  color_name VARCHAR(60) NULL,
  color_hex VARCHAR(9) NULL,
  badge VARCHAR(40) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_variants_storefront_id (storefront_id),
  KEY idx_product_variants_product (product_id, display_order),
  CONSTRAINT fk_product_variants_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT chk_product_variants_status CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci AUTO_INCREMENT=1;

-- A SKU is one sellable size within a variant. Money is always minor units
-- (paise): never floating point.
CREATE TABLE IF NOT EXISTS skus (
  id CHAR(36) NOT NULL,
  variant_id CHAR(36) NOT NULL,
  sku VARCHAR(64) NOT NULL,
  size VARCHAR(20) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  price_minor INT UNSIGNED NOT NULL,
  sale_price_minor INT UNSIGNED NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  display_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_skus_sku (sku),
  UNIQUE KEY uk_skus_variant_size (variant_id, size),
  CONSTRAINT fk_skus_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT chk_skus_status CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')),
  CONSTRAINT chk_skus_sale_price CHECK (sale_price_minor IS NULL OR sale_price_minor <= price_minor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- media_type GRADIENT covers the CSS-gradient placeholder used across the
-- storefront for products with no real photography yet (`url` holds the
-- literal gradient string) — see docs/MEDIA_ABSTRACTION.md; this table
-- itself stays provider-agnostic (a URL + type), Cloudinary never appears
-- here or in any catalog code.
CREATE TABLE IF NOT EXISTS product_media (
  id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  variant_id CHAR(36) NULL,
  media_type VARCHAR(16) NOT NULL DEFAULT 'IMAGE',
  url VARCHAR(1000) NOT NULL,
  alt_text VARCHAR(255) NULL,
  position INT NOT NULL DEFAULT 0,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_product_media_product (product_id, position),
  KEY idx_product_media_variant (variant_id, position),
  CONSTRAINT fk_product_media_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_product_media_variant FOREIGN KEY (variant_id) REFERENCES product_variants(id) ON DELETE CASCADE,
  CONSTRAINT chk_product_media_type CHECK (media_type IN ('IMAGE', 'VIDEO', 'GRADIENT')),
  CONSTRAINT chk_product_media_status CHECK (status IN ('ACTIVE', 'ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Inventory state cache per SKU. Authoritative history lives in
-- inventory_movements below; this table is only ever mutated in the same
-- transaction as a corresponding movement row (never overwritten directly).
-- NOT YET WIRED into the catalog read API this wave (see docs/MIGRATION.md,
-- "Inventory Authority") — schema exists now so a later wave (Cart/
-- Checkout, real stock enforcement) does not need another migration.
CREATE TABLE IF NOT EXISTS inventory (
  id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  on_hand INT NOT NULL DEFAULT 0,
  reserved INT NOT NULL DEFAULT 0,
  allocated INT NOT NULL DEFAULT 0,
  non_sellable INT NOT NULL DEFAULT 0,
  safety_stock INT NOT NULL DEFAULT 0,
  low_stock_threshold INT NOT NULL DEFAULT 5,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_inventory_sku (sku_id),
  CONSTRAINT fk_inventory_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE CASCADE,
  CONSTRAINT chk_inventory_nonneg CHECK (on_hand >= 0 AND reserved >= 0 AND allocated >= 0 AND non_sellable >= 0 AND safety_stock >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Append-only. Never updated or deleted; the sole audit trail of every
-- inventory-affecting event.
CREATE TABLE IF NOT EXISTS inventory_movements (
  id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  movement_type VARCHAR(32) NOT NULL,
  quantity_delta INT NOT NULL,
  reference_type VARCHAR(40) NULL,
  reference_id VARCHAR(64) NULL,
  reason VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_inventory_movements_sku (sku_id, created_at DESC),
  CONSTRAINT fk_inventory_movements_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE CASCADE,
  CONSTRAINT chk_inventory_movements_type CHECK (movement_type IN (
    'STOCK_RECEIVED', 'ORDER_RESERVED', 'ORDER_ALLOCATED', 'RESERVATION_RELEASED',
    'ORDER_CANCELLED', 'RETURN_RESTOCKED', 'DAMAGED', 'MANUAL_ADJUSTMENT'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Reservation foundation (checkout orchestration itself is a later phase).
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id CHAR(36) NOT NULL,
  sku_id CHAR(36) NOT NULL,
  quantity INT NOT NULL,
  reference_type VARCHAR(40) NOT NULL,
  reference_id VARCHAR(64) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  released_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_inventory_reservations_sku_status (sku_id, status),
  KEY idx_inventory_reservations_status_expiry (status, expires_at),
  CONSTRAINT fk_inventory_reservations_sku FOREIGN KEY (sku_id) REFERENCES skus(id) ON DELETE CASCADE,
  CONSTRAINT chk_inventory_reservations_qty CHECK (quantity > 0),
  CONSTRAINT chk_inventory_reservations_status CHECK (status IN ('ACTIVE', 'RELEASED', 'CONSUMED', 'EXPIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
