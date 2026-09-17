-- Refunds that come from an order CANCELLATION, not from a return.
--
-- refund_attempts was built for the returns flow: return_request_id is NOT
-- NULL and uniquely keyed, so a cancelled order — which has no return request —
-- had nowhere to record a refund at all. Cancellation therefore only ever
-- computed the amount owed and raised a staff task; the money never left,
-- and there was no row, no provider reference and no status to look at.
--
-- return_request_id becomes nullable (MySQL allows many NULLs in a UNIQUE
-- index, so uk_refund_attempts_request still holds one refund per return), and
-- `origin` records which flow created the row. One refund per cancelled order
-- is enforced by the existing unique idempotency_key
-- ("order_cancel_refund:<order id>"), so a retried cancellation can never
-- create a second refund.
--
-- Forward-only, non-destructive. MySQL 8.x.

ALTER TABLE refund_attempts
  MODIFY COLUMN return_request_id CHAR(36) NULL;

ALTER TABLE refund_attempts
  ADD COLUMN origin VARCHAR(24) NOT NULL DEFAULT 'RETURN' AFTER customer_id;

-- Existing rows all came from returns; the default already says so.
ALTER TABLE refund_attempts
  ADD INDEX ix_refund_attempts_order_origin (order_id, origin);
