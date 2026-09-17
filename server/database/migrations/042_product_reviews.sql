-- Wave 8G-4: verified-purchase product reviews + moderation.
--
-- "Verified purchase" is computed by the backend from a DELIVERED order item
-- that belongs to the reviewing customer (§66/§67) — the client can never
-- self-assert it. Eligibility is anchored to the order item, not the product,
-- so a repeat legitimate purchase earns a new review (§68); one review per
-- eligible delivered order item (UNIQUE order_item_id).
--
-- The customer's original text is immutable — moderation only moves `status`
-- and records a reason (§72). `status_version` resolves a publish-vs-reject
-- race deterministically (§78). Only PUBLISHED reviews reach the public PDP
-- API (§75).
--
-- Review images are deferred (§73/§74) — the media provider key is disabled
-- and support/review evidence must not flow through the public catalog media
-- path. Text reviews are fully functional.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE product_reviews (
  id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  product_id CHAR(36) NOT NULL,
  variant_id CHAR(36) NULL,
  -- The eligibility anchor — a specific delivered order item.
  order_item_id CHAR(36) NOT NULL,
  rating TINYINT UNSIGNED NOT NULL,
  title VARCHAR(160) NULL,
  body VARCHAR(5000) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PENDING',
  -- Optimistic guard for the moderation race (§78).
  status_version INT UNSIGNED NOT NULL DEFAULT 0,
  verified_purchase TINYINT(1) NOT NULL DEFAULT 1,
  product_snapshot_json JSON NULL,
  moderation_reason VARCHAR(255) NULL,
  moderated_by_staff_id CHAR(36) NULL,
  moderated_at DATETIME(3) NULL,
  published_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_product_reviews_order_item (order_item_id),
  KEY idx_product_reviews_product_status (product_id, status),
  KEY idx_product_reviews_customer (customer_id, created_at),
  KEY idx_product_reviews_status (status),
  CONSTRAINT fk_product_reviews_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_reviews_product FOREIGN KEY (product_id)
    REFERENCES products(id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_reviews_variant FOREIGN KEY (variant_id)
    REFERENCES product_variants(id) ON DELETE SET NULL,
  CONSTRAINT fk_product_reviews_order_item FOREIGN KEY (order_item_id)
    REFERENCES order_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_reviews_moderator FOREIGN KEY (moderated_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_product_reviews_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT chk_product_reviews_status CHECK (status IN ('PENDING','PUBLISHED','REJECTED','HIDDEN'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_review_events (
  id CHAR(36) NOT NULL,
  review_id CHAR(36) NOT NULL,
  event_type VARCHAR(40) NOT NULL,
  from_status VARCHAR(12) NULL,
  to_status VARCHAR(12) NULL,
  actor_type VARCHAR(12) NOT NULL DEFAULT 'SYSTEM',
  actor_id CHAR(36) NULL,
  reason VARCHAR(255) NULL,
  detail_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_product_review_events_review (review_id, created_at),
  CONSTRAINT fk_product_review_events_review FOREIGN KEY (review_id)
    REFERENCES product_reviews(id) ON DELETE CASCADE,
  CONSTRAINT chk_product_review_events_actor CHECK (actor_type IN ('CUSTOMER','STAFF','SYSTEM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Materialized rating aggregate — the ONE authoritative write path is
-- reviewAdminService (recompute from PUBLISHED reviews); a full rebuild path
-- exists for reconciliation (§76). average_bps = average rating * 10000
-- (integer precision, no float authority).
CREATE TABLE product_rating_aggregates (
  product_id CHAR(36) NOT NULL,
  review_count INT UNSIGNED NOT NULL DEFAULT 0,
  rating_sum INT UNSIGNED NOT NULL DEFAULT 0,
  average_bps INT UNSIGNED NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (product_id),
  CONSTRAINT fk_product_rating_aggregates_product FOREIGN KEY (product_id)
    REFERENCES products(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
