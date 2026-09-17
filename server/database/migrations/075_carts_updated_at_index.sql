-- The abandoned-cart scanner (migration 074) filters carts by last-activity
-- time. `carts` was only ever read by customer_id before, so add the index the
-- scan needs.
ALTER TABLE carts ADD INDEX idx_carts_updated_at (updated_at);
