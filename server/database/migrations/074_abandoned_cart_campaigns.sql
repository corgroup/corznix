-- Abandoned-cart recovery campaigns — CMS-managed marketing automation.
--
-- A campaign is a set of rules (timing, channels, conditions, template keys).
-- A background worker (abandonedCart/worker.js) periodically scans persistent
-- authenticated carts, and for each ACTIVE campaign enqueues one reminder per
-- eligible cart through the existing communications outbox (classification
-- MARKETING — consent is re-checked at the send boundary like any broadcast).
--
-- Two hard guarantees the business asked for:
--   1. NEVER after a purchase — a cart is ineligible if the customer has placed
--      any order at/after the cart's last-activity timestamp.
--   2. NEVER repeatedly — abandoned_cart_sends has a UNIQUE key on
--      (campaign_id, cart_id, cart_activity_at). One send per "episode"; a
--      later cart edit moves cart_activity_at and permits exactly one more.
--      A per-customer cooldown adds a second ceiling across all campaigns.

CREATE TABLE abandoned_cart_campaigns (
  id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'PAUSED',          -- ACTIVE | PAUSED

  -- timing (all relative to carts.updated_at = last cart activity)
  delay_minutes INT UNSIGNED NOT NULL DEFAULT 240,       -- wait this long after abandonment before reminding
  max_age_hours INT UNSIGNED NOT NULL DEFAULT 168,       -- ignore carts older than this (stale, not worth it)
  cooldown_hours INT UNSIGNED NOT NULL DEFAULT 168,      -- min gap between two reminders to the same customer

  -- channels — a channel sends only when enabled AND its template key resolves
  -- to an ACTIVE MARKETING template for that channel
  email_enabled TINYINT(1) NOT NULL DEFAULT 1,
  whatsapp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  email_template_key VARCHAR(80) NULL,
  whatsapp_template_key VARCHAR(80) NULL,

  -- conditions
  min_cart_value_minor INT UNSIGNED NOT NULL DEFAULT 0,  -- only carts whose live subtotal is >= this

  -- optional incentive rendered into the message copy. If set it must match an
  -- existing promotion coupon; this table never issues or reserves a coupon.
  coupon_code VARCHAR(40) NULL,

  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  KEY idx_acc_status (status),
  CONSTRAINT fk_acc_creator FOREIGN KEY (created_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_acc_status CHECK (status IN ('ACTIVE','PAUSED')),
  CONSTRAINT chk_acc_delay CHECK (delay_minutes BETWEEN 5 AND 20160),
  CONSTRAINT chk_acc_max_age CHECK (max_age_hours BETWEEN 1 AND 2160),
  CONSTRAINT chk_acc_cooldown CHECK (cooldown_hours BETWEEN 1 AND 2160)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE abandoned_cart_sends (
  id CHAR(36) NOT NULL,
  campaign_id CHAR(36) NOT NULL,
  cart_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,

  -- the "episode" identity — carts.updated_at at the moment the reminder was
  -- enqueued. Part of the UNIQUE key: the same untouched cart can never be
  -- reminded twice by the same campaign.
  cart_activity_at DATETIME(3) NOT NULL,
  cart_subtotal_minor INT UNSIGNED NOT NULL,
  channels_enqueued VARCHAR(40) NOT NULL,                -- 'EMAIL' | 'WHATSAPP' | 'EMAIL,WHATSAPP'
  business_event_id VARCHAR(160) NOT NULL,

  -- observability only — set later by the stats query when an order from this
  -- customer lands within the attribution window. Never gates a send.
  converted_order_id CHAR(36) NULL,
  converted_at DATETIME(3) NULL,

  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (id),
  UNIQUE KEY uk_acc_send_episode (campaign_id, cart_id, cart_activity_at),
  KEY idx_acc_send_customer (customer_id, created_at),
  KEY idx_acc_send_campaign (campaign_id, created_at),
  CONSTRAINT fk_accs_campaign FOREIGN KEY (campaign_id) REFERENCES abandoned_cart_campaigns(id) ON DELETE CASCADE,
  CONSTRAINT fk_accs_cart FOREIGN KEY (cart_id) REFERENCES carts(id) ON DELETE CASCADE,
  CONSTRAINT fk_accs_customer FOREIGN KEY (customer_id) REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
