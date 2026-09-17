-- 099 — FULLY_WITHHELD as a refund method.
--
-- A return whose entire refundable value is covered by the non-refundable COD
-- advance still has to COMPLETE: `returnLifecycleService` only marks a return
-- completed once the refund resolves, so refusing to resolve would strand a
-- legitimate return in the workflow forever. It resolves as a zero-value refund
-- carrying this method — nothing moved, and the row records why.
--
-- Separate from 098 on purpose. 098 had already been applied when this became
-- necessary, and editing an applied migration is how a working database and a
-- freshly built one quietly stop matching.
--
-- The constraint is `chk_refund_attempts_method` (plural), added by 037 and
-- last rewritten by 093, and MySQL drops a CHECK with DROP CHECK.

ALTER TABLE refund_attempts
  DROP CHECK chk_refund_attempts_method;

ALTER TABLE refund_attempts
  ADD CONSTRAINT chk_refund_attempts_method
    CHECK (method IN ('ORIGINAL_PAYMENT', 'STORE_CREDIT', 'COD_PAYOUT', 'COD_BLOCKED', 'BLOCKED', 'FULLY_WITHHELD'));
