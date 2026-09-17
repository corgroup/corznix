-- Default-ON marketing (owner decision, 2026-09-17): a registered customer's
-- verified email and WhatsApp start with MARKETING granted, shown to them in a
-- visible notice, and every OFF they choose is permanent until they turn it
-- back on. The ledger has to say where such a grant came from, so two sources
-- are added:
--   DEFAULT_ON_SIGNUP   — applied when a customer signs in / verifies a contact
--   DEFAULT_ON_BASELINE — the one-time baseline for customers who already
--                         existed when this shipped
-- A default is only ever written when the customer has never made a decision
-- on that channel; it never overrides a REVOKED record.
ALTER TABLE consent_records DROP CHECK chk_consent_records_source;
ALTER TABLE consent_records ADD CONSTRAINT chk_consent_records_source CHECK (source IN
  ('ACCOUNT_SETTINGS','CHECKOUT','FOOTER_NEWSLETTER','CMS_IMPORT','PROMOTION_FORM',
   'CONTACT_VERIFICATION','DOUBLE_OPT_IN','UNSUBSCRIBE_LINK','STAFF_RECORDED',
   'DEFAULT_ON_SIGNUP','DEFAULT_ON_BASELINE'));
