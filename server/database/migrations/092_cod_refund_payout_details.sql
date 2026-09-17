-- 092 — COD refund payout instructions.
--
-- A COD order has no payment instrument to refund to, so refundService had no
-- destination and marked the attempt COD_BLOCKED / BLOCKED: the customer could
-- return the goods and never get their money. Returns must not be blocked
-- merely because the order was COD, so the customer supplies a payout
-- destination (UPI or bank account) and the refund follows that.
--
-- One payout instruction per return request (UNIQUE): a return has exactly one
-- refund, so a second submission corrects the first rather than adding a
-- competing destination.
--
-- Collation is pinned per column, as in 091: return_requests.id and
-- customers.id are utf8mb4_unicode_ci while brands.id is utf8mb4_0900_ai_ci,
-- and a foreign key needs an exact match.
--
-- The account number is stored ENCRYPTED (AES-256-GCM, key from
-- PAYOUT_ENCRYPTION_KEY) because it is the one field here that is both
-- reusable by an attacker and not needed for display. `account_number_last4`
-- exists so CMS and customer surfaces can identify the destination without
-- ever decrypting it. UPI ids and IFSC codes are public-form identifiers and
-- are stored as-is.

CREATE TABLE refund_payout_details (
  id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  brand_id CHAR(36) COLLATE utf8mb4_0900_ai_ci NOT NULL,
  return_request_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  customer_id CHAR(36) COLLATE utf8mb4_unicode_ci NOT NULL,

  method VARCHAR(16) NOT NULL,

  -- UPI
  upi_id VARCHAR(120) NULL,

  -- Bank account. `account_number_cipher` holds iv:tag:ciphertext, base64.
  account_holder_name VARCHAR(160) NULL,
  account_number_cipher VARCHAR(512) NULL,
  account_number_last4 CHAR(4) NULL,
  ifsc_code VARCHAR(11) NULL,
  bank_name VARCHAR(120) NULL,

  submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uq_refund_payout_details_return (return_request_id),
  KEY idx_refund_payout_details_customer (customer_id),

  -- Each method must carry the fields it actually needs; a half-filled
  -- instruction is unpayable and must never reach the operations queue.
  CONSTRAINT chk_refund_payout_details_method
    CHECK (method IN ('UPI', 'BANK_ACCOUNT')),
  CONSTRAINT chk_refund_payout_details_fields CHECK (
    (method = 'UPI' AND upi_id IS NOT NULL)
    OR (method = 'BANK_ACCOUNT'
        AND account_holder_name IS NOT NULL
        AND account_number_cipher IS NOT NULL
        AND account_number_last4 IS NOT NULL
        AND ifsc_code IS NOT NULL)
  ),

  CONSTRAINT fk_refund_payout_details_return
    FOREIGN KEY (return_request_id) REFERENCES return_requests (id) ON DELETE CASCADE,
  CONSTRAINT fk_refund_payout_details_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_refund_payout_details_brand
    FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE RESTRICT
) ENGINE=InnoDB;

-- The operations team works failed payouts by hand, so the attempt needs to
-- record who moved it and why. `status` already carries PENDING / SUCCEEDED /
-- FAILED / BLOCKED; PROCESSING is added by the service, not by an enum here.
ALTER TABLE refund_attempts
  ADD COLUMN payout_reference VARCHAR(140) NULL AFTER provider_refund_id,
  ADD COLUMN payout_note VARCHAR(500) NULL AFTER payout_reference,
  ADD COLUMN processed_by_staff_id CHAR(36) NULL AFTER payout_note,
  ADD COLUMN processing_started_at DATETIME(3) NULL AFTER processed_by_staff_id;
