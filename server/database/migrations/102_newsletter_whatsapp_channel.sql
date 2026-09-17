-- 102 — a newsletter subscriber can be a WhatsApp number, not only an email.
--
-- The table was email-only by construction: `normalized_email` NOT NULL and a
-- unique key on (brand_id, normalized_email). The consent ledger has always
-- modelled both channels (chk_consent_records_channel allows EMAIL and
-- WHATSAPP, and consentService normalises a phone for the WHATSAPP case), so
-- the subscriber row was the single thing standing between a WhatsApp opt-in
-- and being recordable at all.
--
-- The contact becomes channel-agnostic: `channel` says which kind it is and
-- `normalized_contact` / `raw_contact` hold it, whichever kind. The old email
-- columns are KEPT and stay populated for EMAIL rows — they are read in
-- several places and by anything outside this codebase looking at the table —
-- but they are now nullable, because a WhatsApp row has no email to put
-- there. `normalized_contact` is the canonical key from here on.
--
-- Uniqueness moves with it: (brand_id, channel, normalized_contact), so the
-- same person can hold one email subscription and one WhatsApp subscription
-- without either colliding, and a repeat signup on either channel still
-- de-duplicates onto its existing row.

ALTER TABLE newsletter_subscribers
  ADD COLUMN channel VARCHAR(16) NOT NULL DEFAULT 'EMAIL' AFTER brand_id,
  ADD COLUMN normalized_contact VARCHAR(255) NULL AFTER channel,
  ADD COLUMN raw_contact VARCHAR(255) NULL AFTER normalized_contact;

-- Backfill before the columns are made mandatory. Every existing row is an
-- email subscriber, which is what the DEFAULT on `channel` already asserts.
UPDATE newsletter_subscribers
   SET normalized_contact = normalized_email,
       raw_contact = raw_email
 WHERE normalized_contact IS NULL;

ALTER TABLE newsletter_subscribers
  MODIFY COLUMN normalized_contact VARCHAR(255) NOT NULL,
  MODIFY COLUMN raw_contact VARCHAR(255) NOT NULL,
  MODIFY COLUMN normalized_email VARCHAR(255) NULL,
  MODIFY COLUMN raw_email VARCHAR(255) NULL;

ALTER TABLE newsletter_subscribers
  ADD CONSTRAINT chk_newsletter_subscribers_channel
  CHECK (channel IN ('EMAIL','WHATSAPP'));

-- The old key would have refused a second WhatsApp row (NULL email is fine,
-- but it also cannot express "one per channel"), so it is replaced rather
-- than supplemented.
ALTER TABLE newsletter_subscribers
  DROP INDEX uk_newsletter_subscribers_brand_email;

ALTER TABLE newsletter_subscribers
  ADD UNIQUE KEY uk_newsletter_subscribers_brand_channel_contact (brand_id, channel, normalized_contact);

CREATE INDEX ix_newsletter_subscribers_channel ON newsletter_subscribers (brand_id, channel, status);
