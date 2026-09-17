-- The transactional outbox carried no company. When an event's provider
-- outcome is AMBIGUOUS the worker hands it to the Wave 8H reconciliation
-- authority, and every reconciliation exception belongs to exactly one
-- company (migration 085) -- so without a brand here the raise could not be
-- filed at all and was silently dropped by a best-effort catch.
--
-- Collation is pinned explicitly: this table is utf8mb4_unicode_ci while
-- `brands` is utf8mb4_0900_ai_ci, and an unqualified CHAR(36) inherits the
-- table default and is then rejected as incompatible by the foreign key.
--
-- Nullable at the column level only because MySQL cannot add a NOT NULL
-- column to a table that may already hold rows; `enqueue` requires it, so no
-- new row can be written without one.

ALTER TABLE platform_outbox
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id,
  ADD INDEX idx_platform_outbox_brand (brand_id),
  ADD CONSTRAINT fk_platform_outbox_brand
    FOREIGN KEY (brand_id) REFERENCES brands (id) ON DELETE RESTRICT;
