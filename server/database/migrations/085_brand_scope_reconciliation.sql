-- Brand-scope the reconciliation surface.
--
-- The Phase 3-6 brand-scoping work covered the transactional domains but left
-- the reconciliation tables company-agnostic, so a staff member of one company
-- could read AND ACT ON another company's financial exceptions:
--   * reconciliation_exceptions had no brand column at all, so list/count/byId
--     returned every company's rows and transition() could resolve or
--     acknowledge an exception belonging to a different company (an IDOR on a
--     financial record, not merely a leaky list).
--   * provider_settlement_imports deduped uploads on file_hash alone, so one
--     company's settlement file could be silently rejected as a duplicate of
--     another's.
--
-- Both unique keys therefore become per-company: a dedupe key and a file hash
-- are only meaningful within the company that owns the record.
--
-- Forward-only, non-destructive. MySQL 8.x. Follows the same shape as
-- migrations 078-083.

-- reconciliation_exceptions ---------------------------------------------------
ALTER TABLE reconciliation_exceptions
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE reconciliation_exceptions SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE reconciliation_exceptions
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_reconciliation_exceptions_dedupe,
  ADD UNIQUE KEY uk_recon_exceptions_brand_dedupe (brand_id, dedupe_key),
  ADD CONSTRAINT fk_recon_exceptions_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- provider_settlement_imports -------------------------------------------------
ALTER TABLE provider_settlement_imports
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE provider_settlement_imports SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE provider_settlement_imports
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_provider_settlement_imports_hash,
  ADD UNIQUE KEY uk_settlement_imports_brand_hash (brand_id, file_hash),
  ADD CONSTRAINT fk_settlement_imports_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;
