-- CORE GROUP platform — initial schema
-- Brand-scoping rule applied throughout: a table carries `brand_id` only when
-- the row it represents genuinely belongs to one brand. Users/roles are global
-- identity/definition tables; brand-specific access is a property of the grant
-- (user_brand_roles), not of the user or role itself. Media assets do belong
-- to one brand, so `media.brand_id` is required.

CREATE TABLE IF NOT EXISTS brands (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  slug VARCHAR(60) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  configuration JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_brands_slug (slug),
  CONSTRAINT chk_brands_status CHECK (status IN ('active', 'inactive'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL PRIMARY KEY,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(160) NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_email (email),
  CONSTRAINT chk_users_status CHECK (status IN ('active', 'inactive'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS roles (
  id CHAR(36) NOT NULL PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  description VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_roles_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Authorization grants: which user has which role, optionally scoped to one
-- brand. brand_id = NULL means the grant applies across all brands
-- (used for super_admin).
CREATE TABLE IF NOT EXISTS user_brand_roles (
  id CHAR(36) NOT NULL PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  brand_id CHAR(36) NULL,
  role_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_ubr_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_ubr_brand FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE CASCADE,
  CONSTRAINT fk_ubr_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_brand_role (user_id, brand_id, role_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS media (
  id CHAR(36) NOT NULL PRIMARY KEY,
  brand_id CHAR(36) NOT NULL,
  cloudinary_public_id VARCHAR(255) NOT NULL,
  url VARCHAR(500) NOT NULL,
  resource_type VARCHAR(32) NULL,
  width INT NULL,
  height INT NULL,
  bytes INT NULL,
  uploaded_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_media_brand FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE CASCADE,
  CONSTRAINT fk_media_uploaded_by FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL,
  INDEX idx_media_brand_id (brand_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
