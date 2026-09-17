-- Multi-company CMS — Phase 4 follow-up. `customer_identities` (OTP/Google
-- login identity: provider + provider_subject, e.g. a normalized phone/email
-- or a Google `sub` claim) is NOT in DESIGN.md §4.1/§4.2's table lists — a
-- real gap found while wiring the auth service for this phase, same class of
-- finding as Phase 3's staff-provisioning gap (PHASE-3.md).
--
-- Its existing UNIQUE (provider, provider_subject) is globally scoped today,
-- which directly contradicts decision §7.1 ("separate per-brand accounts...
-- even with the same email/phone") — the same phone number could never
-- create an OTP identity on both Cor-Cotton and Cor-Znix. Treated like
-- `product_variants` in Phase 3: denormalized from the parent
-- (`customers.brand_id`) as a DIRECT column rather than left transitive,
-- because the uniqueness constraint itself needs brand_id in it — a plain
-- JOIN through customer_id cannot fix a UNIQUE KEY.
--
-- 153 rows, all Cor-Cotton (decision 6). Forward-only, non-destructive.

ALTER TABLE customer_identities
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER customer_id;
UPDATE customer_identities SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE customer_identities
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_customer_identities_provider_subject,
  ADD UNIQUE KEY uk_customer_identities_brand_provider_subject (brand_id, provider, provider_subject),
  ADD KEY idx_customer_identities_brand (brand_id),
  ADD CONSTRAINT fk_customer_identities_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;
