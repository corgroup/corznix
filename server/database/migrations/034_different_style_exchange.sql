-- Wave 8F-4: different-style exchange + Reserved Exchange Credit.
--
-- Locked flow (§50): eligibility -> exchange transaction -> reserved exchange
-- credit -> customer shops the normal catalog -> checkout recognises the
-- reserved credit -> a NEW exchange order, linked back to the original.
--
--   exchange_transactions     the transaction linking original order, return
--                             request, reserved credit and the new order (§52).
--   reserved_exchange_credits  a RESTRICTED, customer-bound, exchange-bound,
--                             non-transferable, single-consume liability (§51).
--                             This is NOT the closed-loop CORCOTTON Credit
--                             ledger — only a cheaper-item remainder crosses
--                             over there, as one GRANT (§65/§96).
--   orders.is_exchange_order / exchange_type / exchange_transaction_id /
--   exchange_credit_applied_minor  the new order's exchange metadata (§52).
--
-- Money is integer minor units only (§64/§87). Reserved exchange value is
-- NEVER refunded to the original payment method (§53/§59/§60).
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. orders: exchange metadata + a credit-aware totals invariant
-- ---------------------------------------------------------------------------
ALTER TABLE orders
  MODIFY COLUMN checkout_id CHAR(36) NULL,
  ADD COLUMN is_exchange_order TINYINT(1) NOT NULL DEFAULT 0 AFTER finalization_source,
  ADD COLUMN exchange_type VARCHAR(24) NULL AFTER is_exchange_order,
  ADD COLUMN exchange_transaction_id CHAR(36) NULL AFTER exchange_type,
  ADD COLUMN exchange_credit_applied_minor INT UNSIGNED NOT NULL DEFAULT 0 AFTER exchange_transaction_id,
  DROP CHECK chk_order_totals,
  ADD CONSTRAINT chk_order_totals CHECK (
    total_minor = subtotal_minor + shipping_minor
    AND online_paid_minor + cod_due_minor + exchange_credit_applied_minor = total_minor
  ),
  ADD CONSTRAINT chk_orders_exchange_type CHECK (
    exchange_type IS NULL OR exchange_type IN ('DIFFERENT_STYLE','SAME_STYLE')
  );

-- ---------------------------------------------------------------------------
-- 2. Exchange transaction
-- ---------------------------------------------------------------------------
CREATE TABLE exchange_transactions (
  id CHAR(36) NOT NULL,
  transaction_number VARCHAR(48) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  original_order_id CHAR(36) NOT NULL,
  return_request_id CHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  -- Frozen from the original immutable transaction snapshot (§64) — never the
  -- current product price, never already-returned value.
  eligible_value_minor INT UNSIGNED NOT NULL,
  eligibility_snapshot_json JSON NOT NULL,
  -- Opaque, server-issued checkout context. The client passes this, never a
  -- raw transaction id (§57).
  context_token CHAR(64) NOT NULL,
  new_exchange_order_id CHAR(36) NULL,
  expires_at DATETIME(3) NOT NULL,
  reserved_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  consumed_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  expired_at DATETIME(3) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_exchange_transactions_number (transaction_number),
  UNIQUE KEY uk_exchange_transactions_context (context_token),
  UNIQUE KEY uk_exchange_transactions_request (return_request_id),
  UNIQUE KEY uk_exchange_transactions_new_order (new_exchange_order_id),
  KEY idx_exchange_transactions_customer (customer_id),
  KEY idx_exchange_transactions_status_expiry (status, expires_at),
  CONSTRAINT fk_exchange_transactions_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_exchange_transactions_order FOREIGN KEY (original_order_id)
    REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_exchange_transactions_request FOREIGN KEY (return_request_id)
    REFERENCES return_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_exchange_transactions_new_order FOREIGN KEY (new_exchange_order_id)
    REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT chk_exchange_transactions_status CHECK (status IN
    ('RESERVED','CONSUMED','CANCELLED','EXPIRED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE orders
  ADD CONSTRAINT fk_orders_exchange_txn FOREIGN KEY (exchange_transaction_id)
    REFERENCES exchange_transactions(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. Reserved exchange credit (restricted liability, NOT store credit)
-- ---------------------------------------------------------------------------
CREATE TABLE reserved_exchange_credits (
  id CHAR(36) NOT NULL,
  exchange_transaction_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(16) NOT NULL DEFAULT 'RESERVED',
  amount_minor INT UNSIGNED NOT NULL,
  consumed_amount_minor INT UNSIGNED NOT NULL DEFAULT 0,
  -- Optimistic guard for the consume-vs-expiry race (§62). Every terminal
  -- transition bumps it; a stale reader loses.
  version INT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  consumed_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  expired_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_reserved_exchange_credits_transaction (exchange_transaction_id),
  KEY idx_reserved_exchange_credits_customer (customer_id),
  KEY idx_reserved_exchange_credits_status_expiry (status, expires_at),
  CONSTRAINT fk_reserved_exchange_credits_transaction FOREIGN KEY (exchange_transaction_id)
    REFERENCES exchange_transactions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_reserved_exchange_credits_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT chk_reserved_exchange_credits_status CHECK (status IN
    ('RESERVED','CONSUMED','CANCELLED','EXPIRED')),
  CONSTRAINT chk_reserved_exchange_credits_consumed CHECK (consumed_amount_minor <= amount_minor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
