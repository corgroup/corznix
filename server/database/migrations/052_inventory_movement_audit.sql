-- WP-12 (standalone Inventory CMS) — enrich the append-only movement ledger
-- so the in-app movement viewer can show WHO made a staff-driven change and
-- the resulting on-hand balance. Both nullable and additive: system-driven
-- movements (reservation reserve / release / expire / consume) leave them
-- NULL (no staff actor; the resulting balance is not fetched on the hot
-- checkout path). Manual adjustments and return restocks populate both.
--
-- The inventory AUTHORITY is untouched — `inventory (warehouse_id, sku_id)`
-- with derived `available` stays exactly as it was. This only annotates the
-- audit trail.
ALTER TABLE inventory_movements
  ADD COLUMN actor_staff_id CHAR(36) NULL AFTER reason,
  ADD COLUMN balance_after INT NULL AFTER actor_staff_id,
  ADD CONSTRAINT fk_inventory_movements_actor FOREIGN KEY (actor_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL;
