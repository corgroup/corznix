-- Wave 8F-3: same-style exchange price-difference policy.
--
-- SKUs of one product may legitimately carry different prices
-- (skus.price_minor is per-SKU). Wave-8F research does not define what happens
-- when a same-style target costs more/less than what the customer paid (§46),
-- so the backend must NOT silently charge or refund.
--
--   BLOCK          (default) a price-different same-style target is rejected
--                  with SAME_STYLE_PRICE_POLICY_REQUIRED until a policy is set.
--   EVEN_EXCHANGE  explicitly configured: swap proceeds with NO money movement
--                  regardless of the difference (business accepts the delta).
--
-- Equal-price targets are always allowed (NOT_REQUIRED) under either setting.
--
-- Forward-only, non-destructive. MySQL 8.x.

ALTER TABLE return_policy
  ADD COLUMN same_style_price_difference_policy VARCHAR(16) NOT NULL DEFAULT 'BLOCK'
    AFTER exchange_window_days,
  ADD CONSTRAINT chk_return_policy_same_style_price
    CHECK (same_style_price_difference_policy IN ('BLOCK','EVEN_EXCHANGE'));
