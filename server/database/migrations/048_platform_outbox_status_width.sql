-- Wave 8I fix — platform_outbox.status was VARCHAR(16) but the state machine
-- (and its own CHECK constraint) includes 'RECONCILIATION_REQUIRED' (23 chars).
-- Widen it. Forward-only, non-destructive, no data change.

ALTER TABLE platform_outbox
  MODIFY COLUMN status VARCHAR(28) NOT NULL DEFAULT 'PENDING';
