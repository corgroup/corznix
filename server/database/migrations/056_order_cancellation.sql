-- WP-09 — order cancellation cascade (GAP-ORD-04 / GAP-INV-01 / GAP-SHIP-07).
--
-- Cancelling an order used to only flip order_status and (for a CONFIRMED
-- order) issue a credit note — inventory was never released/restored
-- (permanent unrecorded loss), fulfilments stayed active, shipments were
-- orphaned. The cascade needs a place to record when and why a cancellation
-- happened, alongside the existing confirmed_at / processing_started_at /
-- completed_at lifecycle stamps. Additive, all nullable.

-- shipments.cancelled_at already exists (migration 015); only orders needs
-- the cancellation stamps.
ALTER TABLE orders
  ADD COLUMN cancelled_at DATETIME(3) NULL AFTER completed_at,
  ADD COLUMN cancellation_reason VARCHAR(255) NULL AFTER cancelled_at,
  ADD COLUMN cancelled_by_staff_id CHAR(36) NULL AFTER cancellation_reason,
  ADD CONSTRAINT fk_orders_cancelled_by_staff FOREIGN KEY (cancelled_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL;
