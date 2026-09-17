-- Wave 8G-6: backend-authoritative promotions + coupons.
--
-- Promotion  = a pricing rule (eligibility window, conditions, discount).
-- Coupon     = a non-secret code that references exactly one promotion.
-- (Wave 8E content_campaigns stay separate — they are visual/content only.)
--
-- The client NEVER sends a discount amount — only a coupon code. The backend
-- resolves eligibility from permanent order/customer truth and computes the
-- discount in integer minor units (percentage stored as basis points, §97/§99).
--
-- Redemption is a state machine (RESERVED -> CONSUMED / RELEASED / EXPIRED,
-- §106). A code entered in the cart RESERVES against the usage limits; only a
-- finalized order CONSUMES. Usage-limit races are resolved by locking the
-- promotion row (§104/§105) — never a read-then-increment.
--
-- The per-order discount + per-line allocation is frozen into an immutable
-- snapshot at order creation (§114/§115); later promotion edits never touch a
-- past order, and Wave 8F returns read that snapshot, never the live promo
-- (§116).
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE promotions (
  id CHAR(36) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500) NULL,
  -- Bumped on every rule edit so an order snapshot records exactly which rule
  -- version priced it.
  version INT UNSIGNED NOT NULL DEFAULT 1,
  status VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  trigger_type VARCHAR(16) NOT NULL DEFAULT 'CODE_REQUIRED',
  discount_type VARCHAR(16) NOT NULL,
  discount_scope VARCHAR(8) NOT NULL DEFAULT 'ORDER',
  -- PERCENTAGE -> basis points (e.g. 1500 = 15%). FIXED_AMOUNT -> minor units.
  discount_value INT UNSIGNED NOT NULL,
  max_discount_minor INT UNSIGNED NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  -- Eligibility.
  starts_at DATETIME(3) NULL,
  ends_at DATETIME(3) NULL,
  min_subtotal_minor INT UNSIGNED NOT NULL DEFAULT 0,
  min_quantity INT UNSIGNED NOT NULL DEFAULT 0,
  eligible_product_ids JSON NULL,
  eligible_category_ids JSON NULL,
  eligible_collection_ids JSON NULL,
  eligible_segment_id CHAR(36) NULL,
  first_order_only TINYINT(1) NOT NULL DEFAULT 0,
  -- Usage limits.
  usage_limit_total INT UNSIGNED NULL,
  usage_limit_per_customer INT UNSIGNED NOT NULL DEFAULT 1,
  redeemed_count INT UNSIGNED NOT NULL DEFAULT 0,
  -- Stacking (§111/§112).
  stackable TINYINT(1) NOT NULL DEFAULT 0,
  priority INT NOT NULL DEFAULT 100,
  -- Reusability after cancel/return is an explicit business policy seam (§110).
  restore_policy VARCHAR(24) NOT NULL DEFAULT 'CONFIG_REQUIRED',
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_promotions_status (status),
  KEY idx_promotions_trigger (trigger_type, status),
  CONSTRAINT fk_promotions_segment FOREIGN KEY (eligible_segment_id)
    REFERENCES customer_segments(id) ON DELETE SET NULL,
  CONSTRAINT fk_promotions_creator FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_promotions_status CHECK (status IN ('DRAFT','ACTIVE','PAUSED','ARCHIVED')),
  CONSTRAINT chk_promotions_trigger CHECK (trigger_type IN ('AUTOMATIC','CODE_REQUIRED')),
  CONSTRAINT chk_promotions_dtype CHECK (discount_type IN ('PERCENTAGE','FIXED_AMOUNT')),
  CONSTRAINT chk_promotions_dscope CHECK (discount_scope IN ('ORDER','ITEM')),
  CONSTRAINT chk_promotions_value CHECK (discount_value > 0),
  CONSTRAINT chk_promotions_restore CHECK (restore_policy IN ('CONFIG_REQUIRED','NEVER_RESTORE','RESTORE_ON_FULL_CANCEL','RESTORE_ON_FULL_REFUND'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE promotion_coupons (
  id CHAR(36) NOT NULL,
  promotion_id CHAR(36) NOT NULL,
  -- Normalized to UPPER-case, trimmed. Non-secret, unique across all coupons.
  code_normalized VARCHAR(64) NOT NULL,
  code_display VARCHAR(64) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_promotion_coupons_code (code_normalized),
  KEY idx_promotion_coupons_promo (promotion_id),
  CONSTRAINT fk_promotion_coupons_promo FOREIGN KEY (promotion_id)
    REFERENCES promotions(id) ON DELETE CASCADE,
  CONSTRAINT chk_promotion_coupons_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE promotion_redemptions (
  id CHAR(36) NOT NULL,
  promotion_id CHAR(36) NOT NULL,
  coupon_id CHAR(36) NULL,
  customer_id CHAR(36) NOT NULL,
  checkout_id CHAR(36) NULL,
  order_id CHAR(36) NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'RESERVED',
  discount_minor INT UNSIGNED NOT NULL DEFAULT 0,
  reserved_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NULL,
  consumed_at DATETIME(3) NULL,
  released_at DATETIME(3) NULL,
  release_reason VARCHAR(32) NULL,
  PRIMARY KEY (id),
  -- One live redemption row per (promotion, checkout) — the reserve path is
  -- idempotent on retry.
  UNIQUE KEY uk_promotion_redemptions_checkout (promotion_id, checkout_id),
  -- Exactly one CONSUMED redemption per (promotion, order) — the duplicate
  -- finalization / webhook guard (§109/§119).
  UNIQUE KEY uk_promotion_redemptions_order (promotion_id, order_id),
  KEY idx_promotion_redemptions_customer (promotion_id, customer_id, status),
  KEY idx_promotion_redemptions_checkout_only (checkout_id),
  KEY idx_promotion_redemptions_sweep (status, expires_at),
  CONSTRAINT fk_promotion_redemptions_promo FOREIGN KEY (promotion_id)
    REFERENCES promotions(id) ON DELETE CASCADE,
  CONSTRAINT fk_promotion_redemptions_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE,
  CONSTRAINT chk_promotion_redemptions_status CHECK (status IN ('RESERVED','CONSUMED','RELEASED','EXPIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable per-order discount snapshot (§115). Never updated after creation.
CREATE TABLE order_discounts (
  id CHAR(36) NOT NULL,
  order_id CHAR(36) NOT NULL,
  promotion_id CHAR(36) NOT NULL,
  promotion_version INT UNSIGNED NOT NULL,
  coupon_code VARCHAR(64) NULL,
  discount_type VARCHAR(16) NOT NULL,
  discount_scope VARCHAR(8) NOT NULL,
  discount_value INT UNSIGNED NOT NULL,
  discount_total_minor INT UNSIGNED NOT NULL,
  eligibility_context_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_order_discounts_order (order_id),
  KEY idx_order_discounts_promo (promotion_id),
  CONSTRAINT fk_order_discounts_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_discounts_promo FOREIGN KEY (promotion_id)
    REFERENCES promotions(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE order_item_discounts (
  id CHAR(36) NOT NULL,
  order_id CHAR(36) NOT NULL,
  order_item_id CHAR(36) NOT NULL,
  promotion_id CHAR(36) NOT NULL,
  discount_minor INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_item_discounts (order_item_id, promotion_id),
  KEY idx_order_item_discounts_order (order_id),
  CONSTRAINT fk_order_item_discounts_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT fk_order_item_discounts_item FOREIGN KEY (order_item_id)
    REFERENCES order_items(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Checkout carries at most one applied coupon; the discount folds into
-- total_minor so the entire payment pipeline stays authoritative.
ALTER TABLE checkout_sessions
  ADD COLUMN coupon_code VARCHAR(64) NULL AFTER total_minor,
  ADD COLUMN discount_minor INT UNSIGNED NOT NULL DEFAULT 0 AFTER coupon_code,
  ADD COLUMN promotion_context_json JSON NULL AFTER discount_minor,
  DROP CHECK chk_checkout_totals,
  ADD CONSTRAINT chk_checkout_totals CHECK (total_minor = subtotal_minor + shipping_minor - discount_minor);

-- Orders gain a first-class promotion discount. `subtotal_minor` stays GROSS
-- (sum of gross line totals — no tax / invoice ripple), `discount_minor` is
-- the promo total, and the amount owed drops by it. The existing balance
-- invariant (paid + cod + exchange-credit = total) is preserved.
ALTER TABLE orders
  ADD COLUMN discount_minor INT UNSIGNED NOT NULL DEFAULT 0 AFTER total_minor,
  DROP CHECK chk_order_totals,
  ADD CONSTRAINT chk_order_totals CHECK (
    total_minor = subtotal_minor + shipping_minor - discount_minor
    AND online_paid_minor + cod_due_minor + exchange_credit_applied_minor = total_minor
  );
