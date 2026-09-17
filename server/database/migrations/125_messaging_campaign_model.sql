-- Messaging Phase 1 (docs/MESSAGING.md): one campaign model for every kind of
-- campaign, built on marketing_campaigns rather than beside it.
--
--   campaign_types     what kind of campaign (data, not code)
--   campaign_channels  which template each channel sends
--   trigger_* columns  what makes the campaign run
--   campaign_runs      each execution, UNIQUE per trigger key, so the same
--                      campaign can never run twice for the same event/time
--
-- Existing Offer / New Collection campaigns and the abandoned-cart campaigns
-- are migrated in. EXPAND ONLY: deploys start the new containers before
-- migrations run, so nothing the previous release reads is dropped here. The
-- superseded columns and abandoned_cart_campaigns are removed by a later
-- contract migration once this release is verified on production.

-- ---- campaign types --------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_types (
  type_key VARCHAR(40) NOT NULL,
  label VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  -- What the builder pre-selects in the Trigger step.
  suggested_trigger VARCHAR(40) NOT NULL DEFAULT 'send_now',
  -- Which content fields the Message step shows: ["offer","collection","media","cta"].
  content_fields JSON NOT NULL,
  sort_order INT NOT NULL DEFAULT 100,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (type_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO campaign_types (type_key, label, description, suggested_trigger, content_fields, sort_order) VALUES
  ('NEW_COLLECTION',  'New Collection',  'Announce a collection with its own image, name and link.', 'send_now', JSON_ARRAY('collection','cta'), 10),
  ('PRODUCT_LAUNCH',  'Product Launch',  'Introduce a new product.', 'send_now', JSON_ARRAY('offer','media','cta'), 20),
  ('SALE_OFFER',      'Sale / Offer',    'A discount, sale or limited-time offer.', 'send_now', JSON_ARRAY('offer','media','cta'), 30),
  ('FESTIVAL',        'Festival',        'A festive greeting or festival offer, usually scheduled.', 'scheduled', JSON_ARRAY('offer','media','cta'), 40),
  ('ANNOUNCEMENT',    'Announcement',    'News for customers.', 'send_now', JSON_ARRAY('offer','media','cta'), 50),
  ('ABANDONED_CART',  'Abandoned Cart',  'Remind customers who left items in their cart.', 'cart.abandoned', JSON_ARRAY(), 60),
  ('CUSTOMER_UPDATE', 'Customer Update', 'A non-order update for customers.', 'send_now', JSON_ARRAY('offer','media','cta'), 70),
  ('RESTOCK',         'Restock',         'Tell customers an item is back.', 'send_now', JSON_ARRAY('offer','media','cta'), 80),
  ('WIN_BACK',        'Win-back',        'Bring back customers who have not ordered in a while.', 'send_now', JSON_ARRAY('offer','media','cta'), 90),
  ('CUSTOM',          'Custom',          'Anything else.', 'send_now', JSON_ARRAY('offer','media','cta'), 100);

-- ---- campaigns: type, status, trigger ---------------------------------------
ALTER TABLE marketing_campaigns
  MODIFY campaign_type VARCHAR(40) NOT NULL DEFAULT 'CUSTOM';
UPDATE marketing_campaigns SET campaign_type = 'SALE_OFFER' WHERE campaign_type = 'OFFER';
ALTER TABLE marketing_campaigns
  ADD CONSTRAINT fk_marketing_campaign_type FOREIGN KEY (campaign_type) REFERENCES campaign_types (type_key);

-- DRAFT / SCHEDULED / ACTIVE / PAUSED / COMPLETED / CANCELLED. SENDING and SENT
-- stay in the ENUM until the contract migration so the previous release keeps
-- working during the deploy window; no new row uses them.
ALTER TABLE marketing_campaigns
  MODIFY status ENUM('DRAFT', 'SCHEDULED', 'ACTIVE', 'SENDING', 'PAUSED', 'COMPLETED', 'SENT', 'CANCELLED')
    NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN trigger_type ENUM('SEND_NOW', 'SCHEDULED', 'EVENT') NOT NULL DEFAULT 'SEND_NOW' AFTER audience_sources,
  ADD COLUMN trigger_event VARCHAR(60) NULL AFTER trigger_type,
  -- Event settings, e.g. cart.abandoned: {"delayMinutes":240,"maxAgeHours":168,...}
  ADD COLUMN trigger_config JSON NULL AFTER trigger_event,
  -- The state a PAUSED campaign returns to on resume (SCHEDULED or ACTIVE).
  ADD COLUMN paused_from VARCHAR(16) NULL AFTER status;

UPDATE marketing_campaigns SET status = 'COMPLETED' WHERE status = 'SENT';
UPDATE marketing_campaigns SET status = 'ACTIVE' WHERE status = 'SENDING';
UPDATE marketing_campaigns SET trigger_type = 'SCHEDULED' WHERE scheduled_at IS NOT NULL;
UPDATE marketing_campaigns SET paused_from = 'ACTIVE' WHERE status = 'PAUSED';

-- ---- channels ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_channels (
  id CHAR(36) NOT NULL,
  campaign_id CHAR(36) NOT NULL,
  channel ENUM('EMAIL', 'WHATSAPP') NOT NULL,
  -- communication_templates.template_key of an ACTIVE MARKETING template.
  template_key VARCHAR(80) NOT NULL,
  -- WhatsApp: the provider's approved template name, when it differs from the
  -- template row's own reference.
  provider_template_ref VARCHAR(120) NULL,
  -- Phase 3: {"1":"customer.firstName","2":"collection.name"}
  variable_mapping JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_channel (campaign_id, channel),
  CONSTRAINT fk_campaign_channel_campaign FOREIGN KEY (campaign_id) REFERENCES marketing_campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO campaign_channels (id, campaign_id, channel, template_key)
  SELECT UUID(), id, 'EMAIL',
         CASE campaign_type WHEN 'NEW_COLLECTION' THEN 'marketing.new_collection' ELSE 'marketing.offer_campaign' END
    FROM marketing_campaigns WHERE email_enabled = 1;
INSERT IGNORE INTO campaign_channels (id, campaign_id, channel, template_key, provider_template_ref)
  SELECT UUID(), id, 'WHATSAPP',
         CASE campaign_type WHEN 'NEW_COLLECTION' THEN 'marketing.new_collection' ELSE 'marketing.offer_campaign' END,
         whatsapp_template_ref
    FROM marketing_campaigns WHERE whatsapp_enabled = 1;

-- ---- runs --------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_runs (
  id CHAR(36) NOT NULL,
  campaign_id CHAR(36) NOT NULL,
  -- 'send_now', 'scheduled:2026-10-20T09:00:00.000Z', 'collection:<id>', …
  trigger_key VARCHAR(191) NOT NULL,
  status ENUM('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'RUNNING',
  -- What fired it (e.g. the published collection) and the configuration used.
  context JSON NULL,
  config JSON NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_run_trigger (campaign_id, trigger_key),
  KEY ix_campaign_run_status (status, started_at),
  CONSTRAINT fk_campaign_run_campaign FOREIGN KEY (campaign_id) REFERENCES marketing_campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One run per existing campaign that already built a snapshot.
INSERT IGNORE INTO campaign_runs (id, campaign_id, trigger_key, status, started_at, finished_at)
  SELECT UUID(), c.id, 'migrated',
         CASE c.status WHEN 'COMPLETED' THEN 'COMPLETED' WHEN 'CANCELLED' THEN 'CANCELLED'
                       WHEN 'PAUSED' THEN 'PAUSED' ELSE 'RUNNING' END,
         COALESCE(c.started_at, c.created_at), c.finished_at
    FROM marketing_campaigns c
   WHERE EXISTS (SELECT 1 FROM marketing_campaign_recipients r WHERE r.campaign_id = c.id);

-- ---- recipients belong to a run ------------------------------------------------
ALTER TABLE marketing_campaign_recipients
  ADD COLUMN run_id CHAR(36) NULL AFTER campaign_id;
UPDATE marketing_campaign_recipients r
  JOIN campaign_runs cr ON cr.campaign_id = r.campaign_id AND cr.trigger_key = 'migrated'
   SET r.run_id = cr.id;
ALTER TABLE marketing_campaign_recipients
  MODIFY run_id CHAR(36) NOT NULL,
  ADD CONSTRAINT fk_campaign_recipient_run FOREIGN KEY (run_id) REFERENCES campaign_runs (id) ON DELETE CASCADE,
  -- One contact, one channel, one message per RUN (a recurring event campaign
  -- may legitimately reach the same person again in a later run).
  ADD UNIQUE KEY uq_run_recipient (run_id, channel, contact_key),
  ADD KEY ix_run_recipient_work (run_id, state, created_at),
  DROP INDEX uq_campaign_recipient;

-- ---- abandoned-cart campaigns become campaigns ------------------------------------
-- Same ids, so abandoned_cart_sends history and its once-per-episode key carry over.
INSERT IGNORE INTO marketing_campaigns
  (id, brand_id, name, campaign_type, status, paused_from, email_enabled, whatsapp_enabled,
   trigger_type, trigger_event, trigger_config, created_by, created_at)
  SELECT a.id,
         (SELECT b.id FROM brands b WHERE b.slug = 'corcotton' LIMIT 1),
         a.name, 'ABANDONED_CART',
         CASE a.status WHEN 'ACTIVE' THEN 'ACTIVE' ELSE 'PAUSED' END,
         CASE a.status WHEN 'ACTIVE' THEN NULL ELSE 'ACTIVE' END,
         a.email_enabled, a.whatsapp_enabled,
         'EVENT', 'cart.abandoned',
         JSON_OBJECT('delayMinutes', a.delay_minutes, 'maxAgeHours', a.max_age_hours,
                     'cooldownHours', a.cooldown_hours, 'minCartValueMinor', a.min_cart_value_minor,
                     'couponCode', a.coupon_code),
         a.created_by_staff_id, a.created_at
    FROM abandoned_cart_campaigns a;

INSERT IGNORE INTO campaign_channels (id, campaign_id, channel, template_key)
  SELECT UUID(), a.id, 'EMAIL', a.email_template_key FROM abandoned_cart_campaigns a
   WHERE a.email_enabled = 1 AND a.email_template_key IS NOT NULL;
INSERT IGNORE INTO campaign_channels (id, campaign_id, channel, template_key)
  SELECT UUID(), a.id, 'WHATSAPP', a.whatsapp_template_key FROM abandoned_cart_campaigns a
   WHERE a.whatsapp_enabled = 1 AND a.whatsapp_template_key IS NOT NULL;

ALTER TABLE abandoned_cart_sends DROP FOREIGN KEY fk_accs_campaign;
ALTER TABLE abandoned_cart_sends
  ADD CONSTRAINT fk_accs_campaign FOREIGN KEY (campaign_id) REFERENCES marketing_campaigns (id) ON DELETE CASCADE;
