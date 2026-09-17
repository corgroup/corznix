-- Multi-company CMS — Phase 5 follow-up. `refund_attempts` is NOT in
-- DESIGN.md §4.1's table list at all — a real gap found while wiring this
-- phase, same class as migration 080's `customer_identities` and this
-- phase's shipping-provider child tables. Directly analogous to
-- `credit_notes` (money movement tied to an order/customer), so gets the
-- same treatment: brand_id backfilled via a JOIN to `orders`,
-- `refund_number` widened to (brand_id, refund_number) since its generator
-- also hardcodes a "COR-RFND-" prefix (fixed alongside this migration in
-- returns/refundService.js, same as every other order/ticket/invoice
-- prefix this phase and Phase 4 touched).
--
-- 0 rows today. Forward-only, non-destructive. MySQL 8.x.

ALTER TABLE refund_attempts
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE refund_attempts ra JOIN orders o ON o.id = ra.order_id SET ra.brand_id = o.brand_id;
ALTER TABLE refund_attempts
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_refund_attempts_number,
  ADD UNIQUE KEY uk_refund_attempts_brand_number (brand_id, refund_number),
  ADD KEY idx_refund_attempts_brand (brand_id),
  ADD CONSTRAINT fk_refund_attempts_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;
