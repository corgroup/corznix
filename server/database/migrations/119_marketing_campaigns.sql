-- Marketing campaigns the CMS can run without a developer: Offer campaigns and
-- New Collection campaigns, on WhatsApp and/or Email, to an audience built
-- from registered users, subscribers, uploaded files, or any combination.
--
-- Four tables, because four things have different lifetimes:
--
--   marketing_audience_lists     ONE uploaded contact file, owned by the BRAND
--                                rather than by a campaign, so a list can be
--                                reused by later campaigns. Rows land
--                                unconfirmed so the admin sees the valid /
--                                invalid / duplicate counts BEFORE anything
--                                becomes audience.
--   marketing_audience_contacts  one row per line of that file, kept whether it
--                                was valid or not — the admin asked for a
--                                report of the bad rows, and silently dropping
--                                an address is indistinguishable from losing
--                                it.
--   marketing_campaigns          what is being sent, to which channels, from
--                                which audience sources, at what batch size.
--   marketing_campaign_recipients the SNAPSHOT taken at launch: the deduplicated
--                                (channel, contact) pairs this campaign will
--                                actually attempt, each with its own state.
--
-- Deduplication is enforced by the database, not by application care: a
-- UNIQUE key on (campaign_id, channel, contact_key) means the same person
-- cannot be messaged twice in one campaign even if they appear in the
-- registered users, the newsletter list AND an uploaded CSV.
--
-- Consent is NOT stored here. Eligibility is read from consent_records when the
-- snapshot is built AND re-read by the communications engine immediately before
-- each send, so an unsubscribe between launch and delivery suppresses the
-- message. Being in a file, or in the customers table, is not consent.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE IF NOT EXISTS marketing_audience_lists (
  id CHAR(36) NOT NULL,
  brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  name VARCHAR(160) NOT NULL,
  source ENUM('IMPORT') NOT NULL DEFAULT 'IMPORT',
  filename VARCHAR(255) NULL,
  total_rows INT UNSIGNED NOT NULL DEFAULT 0,
  valid_rows INT UNSIGNED NOT NULL DEFAULT 0,
  invalid_rows INT UNSIGNED NOT NULL DEFAULT 0,
  duplicate_rows INT UNSIGNED NOT NULL DEFAULT 0,
  missing_phone_rows INT UNSIGNED NOT NULL DEFAULT 0,
  missing_email_rows INT UNSIGNED NOT NULL DEFAULT 0,
  invalid_phone_rows INT UNSIGNED NOT NULL DEFAULT 0,
  invalid_email_rows INT UNSIGNED NOT NULL DEFAULT 0,
  existing_customer_rows INT UNSIGNED NOT NULL DEFAULT 0,
  -- NULL until the admin presses Confirm Import. Unconfirmed lists are never
  -- audience, so an upload can be reviewed and thrown away safely.
  confirmed_at DATETIME(3) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audience_list_brand (brand_id, created_at),
  CONSTRAINT fk_audience_list_brand FOREIGN KEY (brand_id) REFERENCES brands (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marketing_audience_contacts (
  id CHAR(36) NOT NULL,
  list_id CHAR(36) NOT NULL,
  -- 1-based line number in the uploaded file, so "row 47 is invalid" points at
  -- something the admin can actually find in their spreadsheet.
  source_row INT UNSIGNED NOT NULL,
  raw_name VARCHAR(200) NULL,
  raw_phone VARCHAR(64) NULL,
  raw_email VARCHAR(320) NULL,
  -- Normalised forms. NULL means the raw value did not survive validation.
  phone_e164 VARCHAR(20) NULL,
  email VARCHAR(320) NULL,
  -- Matched to an existing customer where one exists, so an upload never
  -- creates a second copy of somebody we already know.
  customer_id CHAR(36) NULL,
  import_status ENUM('VALID', 'INVALID', 'DUPLICATE') NOT NULL,
  invalid_reason VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_audience_contact_list (list_id, import_status),
  CONSTRAINT fk_audience_contact_list FOREIGN KEY (list_id)
    REFERENCES marketing_audience_lists (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marketing_campaigns (
  id CHAR(36) NOT NULL,
  brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  name VARCHAR(160) NOT NULL,
  campaign_type ENUM('OFFER', 'NEW_COLLECTION') NOT NULL DEFAULT 'OFFER',
  -- DRAFT -> SCHEDULED -> SENDING -> SENT, with PAUSED and CANCELLED as
  -- operator actions on a run in progress. SENDING exists so a crash
  -- mid-launch is visibly mid-launch rather than silently finished.
  status ENUM('DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED', 'SENT', 'CANCELLED')
    NOT NULL DEFAULT 'DRAFT',
  email_enabled TINYINT(1) NOT NULL DEFAULT 0,
  whatsapp_enabled TINYINT(1) NOT NULL DEFAULT 0,

  -- Which audiences feed this campaign. A JSON array of source descriptors,
  -- e.g. [{"type":"REGISTERED_USERS","filter":"HAS_ORDERED"},
  --       {"type":"EMAIL_SUBSCRIBERS"},{"type":"LIST","listId":"..."}]
  -- so a campaign can combine registered users, subscribers and an uploaded
  -- file; the snapshot deduplicates across all of them.
  audience_sources JSON NULL,

  -- Offer campaigns
  offer_name VARCHAR(160) NULL,
  offer_details VARCHAR(500) NULL,
  -- New Collection campaigns: the collection is selected, and its image, name
  -- and URL are resolved from it at send time. Nothing about a collection is
  -- copied here, so re-photographing it changes the next send.
  collection_slug VARCHAR(160) NULL,

  image_url VARCHAR(1024) NULL,
  cta_label VARCHAR(40) NULL,
  cta_url VARCHAR(1024) NULL,

  email_subject VARCHAR(240) NULL,
  email_body MEDIUMTEXT NULL,
  -- The EXACT Meta-approved template name. Nothing sends on WhatsApp without
  -- one the backend has a declared variable contract for.
  whatsapp_template_ref VARCHAR(120) NULL,

  -- How many recipients one worker pass enqueues. NULL means "use the
  -- configured default". The service clamps this to the provider's real
  -- limits, so a careless 100000 here cannot turn into 100000 API calls.
  batch_size INT UNSIGNED NULL,

  scheduled_at DATETIME(3) NULL,
  started_at DATETIME(3) NULL,
  finished_at DATETIME(3) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY ix_marketing_campaign_brand_status (brand_id, status, created_at),
  -- The scheduler scans this: campaigns whose time has come.
  KEY ix_marketing_campaign_due (status, scheduled_at),
  CONSTRAINT fk_marketing_campaign_brand FOREIGN KEY (brand_id) REFERENCES brands (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS marketing_campaign_recipients (
  id CHAR(36) NOT NULL,
  campaign_id CHAR(36) NOT NULL,
  channel ENUM('EMAIL', 'WHATSAPP') NOT NULL,
  -- The address itself: an email, or an E.164 phone number.
  contact_key VARCHAR(320) NOT NULL,
  display_name VARCHAR(200) NULL,
  customer_id CHAR(36) NULL,
  -- Where this recipient came into the snapshot from, for the report.
  source VARCHAR(40) NOT NULL,

  -- PENDING  in the snapshot, not yet handed to the communications engine
  -- SUPPRESSED  not marketable on this channel (reason recorded)
  -- QUEUED   handed over; the engine owns delivery and retries from here
  -- SENT / FAILED  mirrored back from the engine for the report
  -- CANCELLED  the operator cancelled before it was queued
  state ENUM('PENDING', 'SUPPRESSED', 'QUEUED', 'SENT', 'FAILED', 'CANCELLED')
    NOT NULL DEFAULT 'PENDING',
  reason VARCHAR(200) NULL,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  message_id CHAR(36) NULL,
  queued_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  -- THE deduplication guarantee. One contact, one channel, one message per
  -- campaign — enforced here rather than trusted to application code, so a
  -- person who appears in the customer table, the newsletter list and an
  -- uploaded CSV still receives exactly one message.
  UNIQUE KEY uq_campaign_recipient (campaign_id, channel, contact_key),
  -- The batch worker's scan: the next PENDING slice of one campaign.
  KEY ix_campaign_recipient_work (campaign_id, state, created_at),
  CONSTRAINT fk_campaign_recipient_campaign FOREIGN KEY (campaign_id)
    REFERENCES marketing_campaigns (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
