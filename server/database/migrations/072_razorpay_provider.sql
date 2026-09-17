-- Razorpay as a second payment provider, alongside Cashfree.
--
-- The CMS Providers page (provider_configurations, Wave 8I) becomes the single
-- control plane for enabling / prioritising a payment provider: on every
-- `payments` capability toggle, providerConfigService syncs the matching
-- payment_providers row (which the PaymentOrchestrator reads + the
-- payment_attempts FK references).
--
-- Disabled by default and refused unless RAZORPAY_KEY_ID + RAZORPAY_KEY_SECRET
-- are present in the environment (same gate as every other real provider).
--
-- Forward-only, non-destructive. MySQL 8.x.

INSERT INTO payment_providers (provider_code, display_name, enabled, priority, environment)
VALUES ('RAZORPAY', 'Razorpay Payments', 0, 20, 'SANDBOX')
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);
