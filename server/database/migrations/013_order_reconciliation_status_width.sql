-- RECONCILIATION_REQUIRED is 23 characters; retain the full durable state.
ALTER TABLE order_finalization_jobs MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT 'PENDING';
