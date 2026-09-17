-- WP-12 — make the low-stock threshold a real, per-row, optionally-unset
-- setting. It was INT NOT NULL DEFAULT 5 with no write path, so every row
-- was permanently "low stock when available <= 5" and the reporting query
-- (reportingRepository.lowStock: `low_stock_threshold IS NOT NULL AND ...`)
-- could never actually exclude a row. NULL now means "no low-stock flag for
-- this row". Existing values are left untouched.
--
-- Not the inventory authority — on_hand / reserved / derived available are
-- unchanged. This is a hint column only.
ALTER TABLE inventory
  MODIFY COLUMN low_stock_threshold INT NULL;
