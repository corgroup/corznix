-- The payment routing row for the development mock provider agrees with the CMS.
--
-- Migration 011 seeded payment_providers with MOCK_PAYMENT enabled at priority 1.
-- The CMS Providers page (provider_configurations) has no row for it and shows
-- it DISABLED, and a toggle only mirrors a change the operator makes — so on
-- staging and production the routing table said "enabled" while the CMS said
-- "off", and the CMS could not switch it off (a click asserts "enable", which
-- is refused because the mock has no credentials in production).
--
-- Customers were never offered it there (MockPaymentProvider is unconfigured
-- when NODE_ENV=production), but two sources of truth that disagree is how a
-- test gateway ends up live. Only rows the CMS has never managed are changed;
-- once an operator saves MOCK_PAYMENT in the CMS, the CMS mirror owns it.
--
-- Forward-only. Idempotent. MySQL 8.x.

UPDATE payment_providers pp
LEFT JOIN provider_configurations pc
  ON pc.capability = 'payments' AND pc.provider_key = pp.provider_code
SET pp.enabled = 0
WHERE pp.provider_code = 'MOCK_PAYMENT'
  AND pp.enabled = 1
  AND pc.id IS NULL;
