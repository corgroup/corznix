-- Company governance + operational default warehouse.
--
-- 1. `warehouses.is_default` becomes the runtime authority for "which
--    warehouse is the default dispatch origin" — replacing the implicit
--    `code = 'WH-DEFAULT'` lookup. Exactly one row may carry it (enforced by
--    a generated-column unique key, the same pattern 017 uses for the
--    initial-fulfillment guard).
-- 2. The migration-017 anchor warehouse is renamed IN PLACE to the CORCOTTON
--    Parsu Pur business identity — its `warehouse.id` is preserved so every
--    inventory / reservation / fulfillment / shipment foreign key stays
--    intact. Operational contact fields are left NULL: real pickup contact
--    data is entered through the CMS, never invented here.
-- 3. `company_profile` is a singleton holding the company owner
--    (`owner_staff_user_id`) and the configured default warehouse. The owner
--    is the single active SUPER_ADMIN; if that is ambiguous (zero or many)
--    the owner is left NULL for `verify:company-governance` to report.
-- 4. `chk_inventory_reservations_wave6b_status` is renamed to
--    `chk_inventory_reservations_status` (identical predicate) — responsibility
--    naming, no behaviour change.
--
-- Forward-only, non-destructive: no DROP TABLE, no data reset. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. warehouses.is_default — the default-dispatch-origin authority
-- ---------------------------------------------------------------------------
ALTER TABLE warehouses
  ADD COLUMN is_default TINYINT(1) NOT NULL DEFAULT 0 AFTER priority,
  ADD COLUMN default_guard TINYINT(1) GENERATED ALWAYS AS (
    CASE WHEN is_default = 1 THEN 1 ELSE NULL END
  ) STORED,
  ADD UNIQUE KEY uk_warehouses_single_default (default_guard),
  ADD CONSTRAINT chk_warehouses_is_default CHECK (is_default IN (0, 1));

-- ---------------------------------------------------------------------------
-- 2. Rename the migration-017 anchor to the Parsu Pur business identity,
--    in place (same warehouse.id), and mark it the default.
-- ---------------------------------------------------------------------------
UPDATE warehouses
   SET code = 'WH-GZP-PARSUPUR-01',
       name = 'CORCOTTON Parsu Pur Warehouse',
       address_line1 = 'C/O AASHA DEVI, Building No. 17, Parasupur',
       address_line2 = 'Parasupur, Parsu Pur, Ghazipur',
       city = 'Parsu Pur',
       state = 'Uttar Pradesh',
       postal_code = '233222',
       country = 'IN',
       is_default = 1
 WHERE id = '00000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- 3. Company profile — one company, one owner, one configured default
--    warehouse. Principal/legal address is deliberately separate from the
--    warehouse dispatch address (invoice identity is issued in 8C-4).
-- ---------------------------------------------------------------------------
CREATE TABLE company_profile (
  id CHAR(36) NOT NULL,
  -- Singleton lock: only the value 1 is ever inserted, and it is UNIQUE.
  singleton_guard TINYINT(1) NOT NULL DEFAULT 1,
  legal_name VARCHAR(200) NULL,
  trade_name VARCHAR(200) NULL,
  gstin VARCHAR(20) NULL,
  principal_address_line1 VARCHAR(255) NULL,
  principal_address_line2 VARCHAR(255) NULL,
  principal_city VARCHAR(120) NULL,
  principal_state VARCHAR(120) NULL,
  principal_postal_code VARCHAR(12) NULL,
  principal_country CHAR(2) NOT NULL DEFAULT 'IN',
  owner_staff_user_id CHAR(36) NULL,
  default_warehouse_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_company_profile_singleton (singleton_guard),
  UNIQUE KEY uk_company_profile_owner (owner_staff_user_id),
  CONSTRAINT fk_company_profile_owner FOREIGN KEY (owner_staff_user_id)
    REFERENCES staff_users(id) ON DELETE RESTRICT,
  CONSTRAINT fk_company_profile_default_warehouse FOREIGN KEY (default_warehouse_id)
    REFERENCES warehouses(id) ON DELETE RESTRICT,
  CONSTRAINT chk_company_profile_singleton CHECK (singleton_guard = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO company_profile
  (id, singleton_guard, owner_staff_user_id, default_warehouse_id, principal_country)
VALUES (
  '00000000-0000-4000-9000-000000000001',
  1,
  (SELECT s.id FROM staff_users s
     WHERE s.role = 'SUPER_ADMIN' AND s.status = 'ACTIVE'
       AND (SELECT COUNT(*) FROM staff_users
              WHERE role = 'SUPER_ADMIN' AND status = 'ACTIVE') = 1
     LIMIT 1),
  (SELECT w.id FROM warehouses w WHERE w.is_default = 1 LIMIT 1),
  'IN'
);

-- ---------------------------------------------------------------------------
-- 4. Responsibility naming for the reservation-status CHECK (no behaviour
--    change — identical predicate).
-- ---------------------------------------------------------------------------
ALTER TABLE inventory_reservations
  DROP CHECK chk_inventory_reservations_wave6b_status,
  ADD CONSTRAINT chk_inventory_reservations_status
    CHECK (status IN ('RESERVED', 'RELEASED', 'EXPIRED', 'CONSUMED'));
