-- Phase 2 — automated shipment workflow.
--
-- After an order is confirmed and moves to PROCESSING, the system drives
-- package -> book -> AWB -> label -> pickup automatically (no admin click per
-- order). These columns track that automation per shipment so it is resumable,
-- retryable, visible, and never double-runs a step.
--
-- Booking idempotency itself is unchanged (shipment_booking_attempts, migration
-- 019) — this only records where the automation is.

ALTER TABLE shipments
  ADD COLUMN auto_fulfillment_status VARCHAR(16) NOT NULL DEFAULT 'IDLE' AFTER shipping_cost_source,
  ADD COLUMN auto_fulfillment_step VARCHAR(24) NULL AFTER auto_fulfillment_status,
  ADD COLUMN auto_fulfillment_error VARCHAR(255) NULL AFTER auto_fulfillment_step,
  ADD COLUMN auto_fulfillment_attempts INT UNSIGNED NOT NULL DEFAULT 0 AFTER auto_fulfillment_error,
  ADD COLUMN auto_fulfillment_next_at DATETIME(3) NULL AFTER auto_fulfillment_attempts,
  ADD COLUMN auto_fulfillment_updated_at DATETIME(3) NULL AFTER auto_fulfillment_next_at,
  ADD CONSTRAINT chk_shipment_auto_status CHECK (auto_fulfillment_status IN
    ('IDLE', 'QUEUED', 'RUNNING', 'BLOCKED', 'DONE', 'FAILED')),
  ADD KEY idx_shipments_auto_fulfillment (auto_fulfillment_status, auto_fulfillment_next_at);
