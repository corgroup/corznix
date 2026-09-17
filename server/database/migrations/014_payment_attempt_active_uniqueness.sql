-- At most one active provider session may fund an online obligation.
ALTER TABLE payment_attempts
  ADD COLUMN active_obligation_id CHAR(36)
    GENERATED ALWAYS AS (CASE WHEN status IN ('CREATED','PENDING','AUTHORIZED') THEN obligation_id ELSE NULL END) STORED,
  ADD UNIQUE KEY uk_payment_attempt_active_obligation (active_obligation_id);
