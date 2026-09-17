-- Wave 8F-1: shared post-purchase domain — return / replacement / exchange
-- request identity, item-level accounting, eligibility snapshots, lifecycle.
--
-- The backend is the ONLY authority on eligibility, quantity accounting and
-- lifecycle (§14, §5). The four business flows are explicit request types
-- (§22) — never a loosely-typed JSON workflow.
--
--   return_policy          singleton config — the ONE place the 7-day window
--                          lives on the backend (§15). Mirrors the frontend
--                          constant apps/corcotton/src/constants/returnPolicy.js
--   return_requests        request aggregate root (§21): customer, order,
--                          type, status, frozen eligibility snapshot,
--                          idempotency, resolution.
--   return_request_items   per-order-item lines with quantity + a frozen
--                          per-item eligibility snapshot (§17, §23). Later
--                          catalog edits never rewrite request history.
--   return_request_events  append-only lifecycle / audit timeline (§118).
--
-- Reverse shipment, QC, financial resolution and inventory effects are
-- introduced in 8F-2..8F-6 — this migration only lays the domain foundation.
--
-- Forward-only, non-destructive. MySQL 8.x. Integer minor units only.

-- ---------------------------------------------------------------------------
-- 1. Return / replacement / exchange policy (singleton, id = 1)
-- ---------------------------------------------------------------------------
CREATE TABLE return_policy (
  id TINYINT UNSIGNED NOT NULL,
  return_window_days INT UNSIGNED NOT NULL DEFAULT 7,
  replacement_window_days INT UNSIGNED NOT NULL DEFAULT 7,
  exchange_window_days INT UNSIGNED NOT NULL DEFAULT 7,
  -- Reserved Exchange Credit lifetime for Different-Style Exchange (§61).
  reserved_exchange_credit_expiry_days INT UNSIGNED NOT NULL DEFAULT 7,
  -- Free-text customer reason cap (§26).
  max_reason_length INT UNSIGNED NOT NULL DEFAULT 1000,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT chk_return_policy_singleton CHECK (id = 1),
  CONSTRAINT chk_return_policy_windows CHECK (
    return_window_days BETWEEN 0 AND 365 AND
    replacement_window_days BETWEEN 0 AND 365 AND
    exchange_window_days BETWEEN 0 AND 365 AND
    reserved_exchange_credit_expiry_days BETWEEN 1 AND 365
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO return_policy (id) VALUES (1);

-- ---------------------------------------------------------------------------
-- 2. Return / exchange request aggregate
-- ---------------------------------------------------------------------------
CREATE TABLE return_requests (
  id CHAR(36) NOT NULL,
  request_number VARCHAR(48) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  order_id CHAR(36) NOT NULL,
  request_type VARCHAR(24) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'REQUESTED',
  -- Backend-owned reason code (§26); free text is optional and length-capped.
  reason_code VARCHAR(48) NULL,
  customer_note VARCHAR(1000) NULL,
  -- Frozen at creation: policy version + window + per-order context (§23).
  eligibility_snapshot_json JSON NOT NULL,
  -- Chosen pickup address, frozen (§23). NULL until 8F-2/8F-5.
  pickup_address_snapshot_json JSON NULL,
  -- Return destination warehouse (§70). Resolved by backend policy, not the client.
  return_warehouse_id CHAR(36) NULL,
  -- Persistent request idempotency (§24): customer + order + operation token.
  idempotency_key VARCHAR(180) NULL,
  -- Financial + inventory outcome, written by 8F-6. Opaque here.
  resolution_json JSON NULL,
  created_by VARCHAR(16) NOT NULL DEFAULT 'CUSTOMER',
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  approved_at DATETIME(3) NULL,
  rejected_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_return_requests_number (request_number),
  UNIQUE KEY uk_return_requests_idempotency (idempotency_key),
  KEY idx_return_requests_customer (customer_id, requested_at),
  KEY idx_return_requests_order (order_id),
  KEY idx_return_requests_status (status),
  CONSTRAINT fk_return_requests_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_requests_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_requests_warehouse FOREIGN KEY (return_warehouse_id)
    REFERENCES warehouses(id) ON DELETE RESTRICT,
  CONSTRAINT chk_return_requests_type CHECK (request_type IN
    ('RETURN','REPLACEMENT','SAME_STYLE_EXCHANGE','DIFFERENT_STYLE_EXCHANGE')),
  CONSTRAINT chk_return_requests_created_by CHECK (created_by IN ('CUSTOMER','STAFF')),
  CONSTRAINT chk_return_requests_status CHECK (status IN (
    'REQUESTED','APPROVED','REJECTED',
    'PICKUP_PENDING','PICKUP_BOOKED','PICKED_UP','IN_TRANSIT',
    'RECEIVED','QC_PASSED','QC_FAILED',
    'RESOLUTION_PENDING','COMPLETED','CANCELLED',
    'MANUAL_RETURN_LOGISTICS_REQUIRED','EXPIRED'
  ))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Request line items — one row per participating order item
-- ---------------------------------------------------------------------------
CREATE TABLE return_request_items (
  id CHAR(36) NOT NULL,
  return_request_id CHAR(36) NOT NULL,
  order_item_id CHAR(36) NOT NULL,
  -- The fulfillment / package the unit shipped in — the delivery event that
  -- starts this item's return window is that package's, not the order's (§16).
  fulfillment_id CHAR(36) NULL,
  sku_id CHAR(36) NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  reason_code VARCHAR(48) NULL,
  item_note VARCHAR(1000) NULL,
  -- Frozen financial + timing snapshot (§23).
  unit_price_minor INT UNSIGNED NOT NULL,
  eligible_value_minor INT UNSIGNED NOT NULL,
  delivered_at DATETIME(3) NULL,
  return_deadline DATETIME(3) NULL,
  -- Exchange target (same-style / different-style). NULL for RETURN / REPLACEMENT.
  target_product_id CHAR(36) NULL,
  target_variant_id CHAR(36) NULL,
  target_sku_id CHAR(36) NULL,
  target_unit_price_minor INT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_return_request_items_line (return_request_id, order_item_id),
  KEY idx_return_request_items_order_item (order_item_id),
  KEY idx_return_request_items_sku (sku_id),
  CONSTRAINT fk_return_request_items_request FOREIGN KEY (return_request_id)
    REFERENCES return_requests(id) ON DELETE CASCADE,
  CONSTRAINT fk_return_request_items_order_item FOREIGN KEY (order_item_id)
    REFERENCES order_items(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_request_items_sku FOREIGN KEY (sku_id)
    REFERENCES skus(id) ON DELETE RESTRICT,
  CONSTRAINT fk_return_request_items_target_sku FOREIGN KEY (target_sku_id)
    REFERENCES skus(id) ON DELETE RESTRICT,
  CONSTRAINT chk_return_request_items_quantity CHECK (quantity > 0),
  CONSTRAINT chk_return_request_items_eligible_value
    CHECK (eligible_value_minor = unit_price_minor * quantity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 4. Append-only lifecycle / audit timeline
-- ---------------------------------------------------------------------------
CREATE TABLE return_request_events (
  id CHAR(36) NOT NULL,
  return_request_id CHAR(36) NOT NULL,
  event_type VARCHAR(48) NOT NULL,
  from_status VARCHAR(32) NULL,
  to_status VARCHAR(32) NULL,
  actor_type VARCHAR(16) NOT NULL DEFAULT 'SYSTEM',
  actor_id CHAR(36) NULL,
  detail_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_return_request_events_request (return_request_id, created_at),
  CONSTRAINT fk_return_request_events_request FOREIGN KEY (return_request_id)
    REFERENCES return_requests(id) ON DELETE CASCADE,
  CONSTRAINT chk_return_request_events_actor CHECK (actor_type IN ('CUSTOMER','STAFF','SYSTEM'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
