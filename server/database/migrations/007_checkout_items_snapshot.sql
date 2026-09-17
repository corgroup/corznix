-- Wave 6C hardening: preserve the authoritative items owned by each Checkout Session.
ALTER TABLE checkout_sessions
  ADD COLUMN items_snapshot JSON NULL AFTER cart_fingerprint;

