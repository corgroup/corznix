-- 093 — allow COD_PAYOUT as a refund method.
--
-- 092 gave a COD return a real destination (UPI or bank account) so it is no
-- longer blocked, but `chk_refund_attempts_method` still only permitted
-- ORIGINAL_PAYMENT / STORE_CREDIT / COD_BLOCKED / BLOCKED, so writing the new
-- method failed at the constraint.
--
-- COD_BLOCKED stays in the list: it remains the correct state for a COD return
-- whose customer never supplied a destination, and existing rows carry it.
--
-- The status CHECK already permits PENDING / PROCESSING / SUCCEEDED / FAILED,
-- which is the whole payout lifecycle — no change needed there.

ALTER TABLE refund_attempts
  DROP CHECK chk_refund_attempts_method;

ALTER TABLE refund_attempts
  ADD CONSTRAINT chk_refund_attempts_method
    CHECK (method IN ('ORIGINAL_PAYMENT', 'STORE_CREDIT', 'COD_PAYOUT', 'COD_BLOCKED', 'BLOCKED'));
