-- Wave 8F-6: refund attempts + partial-quantity credit notes.
--
-- Financial resolution reuses the existing authorities (PaymentService /
-- payment_attempts, StoreCreditService, the credit-note + document services).
-- No second financial engine.
--
--   refund_attempts        the refund state machine (§90) — PENDING /
--                          PROCESSING / SUCCEEDED / FAILED / UNKNOWN / BLOCKED,
--                          idempotent per return request (§91). The provider is
--                          the ORIGINAL payment provider (§89).
--   credit_notes (partial) the whole-invoice UNIQUE is removed so multiple
--                          partial-return credit notes can attach to one
--                          invoice (§100). The original invoice is never
--                          mutated (§97) — a partial credit note does NOT
--                          cancel it.
--   credit_note_items      returned quantity / value snapshot (§97).
--   return_policy          refund_destination + cod_refund_method. COD refund
--                          method is NULL (unconfigured) by default -> a COD
--                          refund is deterministically BLOCKED, never invented
--                          (§93).
--
-- FINAL_ACCOUNTING_GST_VALIDATION stays NOT_YET: credit notes carry an
-- indicative tax snapshot but treatment_status = PENDING_CONFIGURATION —
-- no fabricated GST reversal (§97/§98).
--
-- Forward-only, non-destructive. MySQL 8.x. Integer minor units only.

-- ---------------------------------------------------------------------------
-- 1. Refund resolution policy
-- ---------------------------------------------------------------------------
ALTER TABLE return_policy
  ADD COLUMN refund_destination VARCHAR(24) NOT NULL DEFAULT 'ORIGINAL_PAYMENT'
    AFTER return_destination_strategy,
  ADD COLUMN cod_refund_method VARCHAR(24) NULL AFTER refund_destination,
  ADD CONSTRAINT chk_return_policy_refund_destination
    CHECK (refund_destination IN ('ORIGINAL_PAYMENT','STORE_CREDIT')),
  ADD CONSTRAINT chk_return_policy_cod_refund_method
    CHECK (cod_refund_method IS NULL OR cod_refund_method IN ('STORE_CREDIT'));

-- ---------------------------------------------------------------------------
-- 2. Refund attempts (the refund state machine)
-- ---------------------------------------------------------------------------
CREATE TABLE refund_attempts (
  id CHAR(36) NOT NULL,
  refund_number VARCHAR(48) NOT NULL,
  return_request_id CHAR(36) NOT NULL,
  order_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  -- The original captured payment this refund reverses. NULL for a
  -- store-credit refund or a blocked COD refund.
  source_payment_attempt_id CHAR(36) NULL,
  provider_code VARCHAR(32) NULL,
  method VARCHAR(24) NOT NULL,
  amount_minor INT UNSIGNED NOT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'INR',
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  provider_refund_id VARCHAR(120) NULL,
  idempotency_key VARCHAR(160) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  failure_code VARCHAR(120) NULL,
  reconciled_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_refund_attempts_number (refund_number),
  UNIQUE KEY uk_refund_attempts_request (return_request_id),
  UNIQUE KEY uk_refund_attempts_idempotency (idempotency_key),
  KEY idx_refund_attempts_order (order_id),
  KEY idx_refund_attempts_status (status),
  CONSTRAINT fk_refund_attempts_request FOREIGN KEY (return_request_id)
    REFERENCES return_requests(id) ON DELETE RESTRICT,
  CONSTRAINT fk_refund_attempts_order FOREIGN KEY (order_id)
    REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_refund_attempts_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_refund_attempts_payment_attempt FOREIGN KEY (source_payment_attempt_id)
    REFERENCES payment_attempts(id) ON DELETE RESTRICT,
  CONSTRAINT chk_refund_attempts_method CHECK (method IN
    ('ORIGINAL_PAYMENT','STORE_CREDIT','COD_BLOCKED')),
  CONSTRAINT chk_refund_attempts_status CHECK (status IN
    ('PENDING','PROCESSING','SUCCEEDED','FAILED','UNKNOWN','BLOCKED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Partial-quantity credit notes
-- ---------------------------------------------------------------------------
-- Keep a plain index on invoice_id (fk_credit_notes_invoice needs one) while
-- dropping the whole-invoice UNIQUE, so several partial credit notes can share
-- an invoice.
ALTER TABLE credit_notes
  ADD INDEX idx_credit_notes_invoice (invoice_id),
  DROP INDEX uk_credit_notes_invoice,
  ADD COLUMN credit_note_type VARCHAR(16) NOT NULL DEFAULT 'FULL' AFTER order_id,
  ADD COLUMN return_request_id CHAR(36) NULL AFTER credit_note_type,
  ADD COLUMN taxable_minor INT UNSIGNED NULL AFTER amount_minor,
  ADD COLUMN indicative_tax_minor INT UNSIGNED NULL AFTER taxable_minor,
  ADD UNIQUE KEY uk_credit_notes_return_request (return_request_id),
  ADD CONSTRAINT fk_credit_notes_return_request FOREIGN KEY (return_request_id)
    REFERENCES return_requests(id) ON DELETE RESTRICT,
  ADD CONSTRAINT chk_credit_notes_type CHECK (credit_note_type IN ('FULL','PARTIAL_RETURN'));

CREATE TABLE credit_note_items (
  id CHAR(36) NOT NULL,
  credit_note_id CHAR(36) NOT NULL,
  order_item_id CHAR(36) NOT NULL,
  sku VARCHAR(64) NOT NULL,
  product_name VARCHAR(200) NOT NULL,
  hsn_sac VARCHAR(20) NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price_minor INT UNSIGNED NOT NULL,
  returned_value_minor INT UNSIGNED NOT NULL,
  -- Indicative only — final GST reversal treatment is not configured (§97/§98).
  indicative_tax_minor INT UNSIGNED NOT NULL DEFAULT 0,
  invoice_item_ref VARCHAR(64) NULL,
  PRIMARY KEY (id),
  KEY idx_credit_note_items_cn (credit_note_id),
  CONSTRAINT fk_credit_note_items_cn FOREIGN KEY (credit_note_id)
    REFERENCES credit_notes(id) ON DELETE CASCADE,
  CONSTRAINT fk_credit_note_items_order_item FOREIGN KEY (order_item_id)
    REFERENCES order_items(id) ON DELETE RESTRICT,
  CONSTRAINT chk_credit_note_items_quantity CHECK (quantity > 0),
  CONSTRAINT chk_credit_note_items_value CHECK (returned_value_minor = unit_price_minor * quantity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
