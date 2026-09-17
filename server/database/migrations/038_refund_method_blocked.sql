-- Wave 8F-6 fixup: a refund can be BLOCKED for reasons other than an
-- unconfigured COD method — e.g. no resolvable captured payment source. Add a
-- generic BLOCKED method so completeResolution can record a deterministic
-- blocked state instead of failing the whole return completion.
--
-- Forward-only, non-destructive. MySQL 8.x.
ALTER TABLE refund_attempts
  DROP CHECK chk_refund_attempts_method,
  ADD CONSTRAINT chk_refund_attempts_method CHECK (method IN
    ('ORIGINAL_PAYMENT','STORE_CREDIT','COD_BLOCKED','BLOCKED'));
