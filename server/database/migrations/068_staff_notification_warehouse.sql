-- Targeted staff notifications — a notification can be scoped to one warehouse.
--
-- A row with warehouse_id NULL is a company-wide broadcast (unchanged).
-- A row with warehouse_id set is shown only to staff assigned to that
-- warehouse (staff_warehouse_assignments) plus the company-wide roles
-- (SUPER_ADMIN / ADMIN). Used for "a new order was allocated to your
-- warehouse — process it manually".

ALTER TABLE staff_notifications
  ADD COLUMN warehouse_id CHAR(36) NULL AFTER entity_id,
  ADD KEY idx_staff_notifications_warehouse (warehouse_id, created_at),
  ADD CONSTRAINT fk_staff_notifications_warehouse
    FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;
