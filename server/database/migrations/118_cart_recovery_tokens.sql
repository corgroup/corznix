-- Cart recovery links for abandoned-cart marketing.
--
-- The abandoned-cart reminder used to point at `${STOREFRONT_BASE_URL}/cart` —
-- the same URL for every customer. It only worked at all because a cart is
-- customer-scoped and the customer happened to still be signed in; a signed-out
-- recipient landed on an empty cart page, and the message could not say which
-- product it was about.
--
-- A recovery token is a per-send, per-customer secret that names ONE abandoned
-- cart episode. What is stored here is the SHA-256 of the token, never the
-- token itself, so a dump of this table cannot be used to redeem anything --
-- the same reason password hashes exist. The plaintext exists only inside the
-- WhatsApp/email that was sent to that customer.
--
-- `items_json` is a snapshot of what was in the cart when the reminder went
-- out: sku_id + quantity only. Prices and stock are deliberately NOT snapshot;
-- they are re-resolved from the catalogue at redemption, so a customer can
-- never check out at a stale price.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE IF NOT EXISTS cart_recovery_tokens (
  id CHAR(36) NOT NULL,
  -- SHA-256 hex of the plaintext token. UNIQUE so a redemption is a single
  -- indexed lookup and a duplicate issue is impossible.
  token_hash CHAR(64) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  cart_id CHAR(36) NOT NULL,
  -- The episode this link belongs to. A cart that has moved on since (the
  -- customer added something, or checked out) makes the link stale, which is
  -- what stops a week-old reminder from resurrecting a cart the customer has
  -- already emptied on purpose.
  cart_activity_at DATETIME(3) NOT NULL,
  items_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  -- First successful redemption. Kept for campaign attribution; redeeming
  -- twice is allowed (a customer may open the link on phone and laptop), so
  -- this records the first, it does not gate the second.
  redeemed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_cart_recovery_token_hash (token_hash),
  KEY ix_cart_recovery_customer (customer_id, created_at),
  KEY ix_cart_recovery_expiry (expires_at),
  CONSTRAINT fk_cart_recovery_customer FOREIGN KEY (customer_id)
    REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
