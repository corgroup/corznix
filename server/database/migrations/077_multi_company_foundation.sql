-- Multi-company CMS — Phase 1 (schema only, additive, NO behaviour change).
-- See implementation/multi-company/DESIGN.md §3 and §8 (Phase 1 row).
--
-- This migration only lays the foundation: it extends the dormant `brands`
-- table into a real tenant entity, adds the per-staff access grant table and
-- the session's "current company" column, and de-singletons company_profile
-- into a per-brand `company_profiles`. Nothing in the application reads or
-- enforces any of this yet — `company_profile` (singular) stays the live
-- source of truth for invoicing until the Phase 5/6 cut-over, and every
-- table in DESIGN.md §4 still has zero `brand_id` scoping. That work is
-- Phases 3-6, deliberately not touched here.
--
-- All 6 §7 decisions are resolved (see DESIGN.md, updated 2026-09-04):
--   1. Customers: separate per-brand accounts (acted on in a later phase).
--   2. Payment/shipping/comms providers: one account per company (later phase).
--   3. Warehouses: strictly per-company, no shared pool (later phase).
--   4. Cor-Znix: starts empty — no data import.
--   5. Cor-Znix legal identity (GSTIN etc.): left blank/incomplete for now.
--   6. All existing data belongs to Cor-Cotton — full backfill below.
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. `brands` -> real tenant entity
-- ---------------------------------------------------------------------------
-- HISTORY: this section was originally applied by hand to the development
-- database and left commented out here. That made the schema unreproducible —
-- a fresh database never got these columns, and migration 078 onward could not
-- resolve a brand. It is now live SQL so any environment can be built from
-- migrations alone. brands.id was created (migration 001) on the MySQL 8
-- server-default collation (utf8mb4_0900_ai_ci), unlike every other id/FK
-- column here (utf8mb4_unicode_ci) — every brand_id column added from 078
-- onward matches utf8mb4_0900_ai_ci explicitly.
ALTER TABLE brands
  ADD COLUMN group_name     VARCHAR(80)  NOT NULL DEFAULT 'CORGROUP' AFTER status,
  ADD COLUMN display_name   VARCHAR(120) NULL AFTER group_name,
  ADD COLUMN logo_media_id  CHAR(36)     NULL AFTER display_name,
  ADD COLUMN icon_svg       MEDIUMTEXT   NULL AFTER logo_media_id,
  ADD COLUMN theme_json     JSON         NULL AFTER icon_svg,
  ADD COLUMN storefront_url VARCHAR(255) NULL AFTER theme_json,
  ADD COLUMN support_email  VARCHAR(255) NULL AFTER storefront_url,
  ADD COLUMN is_default     TINYINT(1)   NOT NULL DEFAULT 0 AFTER support_email,
  ADD CONSTRAINT fk_brands_logo_media FOREIGN KEY (logo_media_id)
    REFERENCES media(id) ON DELETE SET NULL;

-- The tenant rows themselves. Migrations run BEFORE any seed script, and
-- every backfill from 078 onward resolves brand_id via a (SELECT id FROM
-- brands WHERE slug = 'corcotton') subquery — so the rows must exist here or
-- those backfills silently write NULL into a column the next statement makes
-- NOT NULL. Keyed on uq_brands_slug, so this is idempotent and preserves the
-- existing ids on any database that already has them.
INSERT INTO brands (id, name, slug, status, display_name, is_default)
VALUES
  (UUID(), 'CORCOTTON', 'corcotton', 'active', 'Corcotton', 1),
  (UUID(), 'Corznix',   'corznix',   'active', 'Corznix',   0)
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), is_default = VALUES(is_default);

-- ---------------------------------------------------------------------------
-- 2. `staff_brand_access` — per-staff, per-company access grant
-- ---------------------------------------------------------------------------
CREATE TABLE staff_brand_access (
  staff_user_id CHAR(36) NOT NULL,
  -- Explicit collation to match brands.id (utf8mb4_0900_ai_ci, the MySQL 8
  -- server default that migration 001 inherited) — every other id/FK column
  -- in this codebase is utf8mb4_unicode_ci, so this is the one exception.
  brand_id      CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  -- Company-specific role. Independent of staff_users.role so a person can
  -- be narrowed on one company without touching their identity record.
  role          VARCHAR(32) NOT NULL,
  -- Optional per-(staff,company) permission overrides layered on the role
  -- map: { "granted": [...], "revoked": [...] }. Unused until Phase 5.
  permission_overrides_json JSON NULL,
  granted_by    CHAR(36) NULL,
  granted_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (staff_user_id, brand_id),
  KEY idx_sba_brand (brand_id),
  CONSTRAINT fk_sba_staff FOREIGN KEY (staff_user_id) REFERENCES staff_users(id) ON DELETE CASCADE,
  CONSTRAINT fk_sba_brand FOREIGN KEY (brand_id)      REFERENCES brands(id)      ON DELETE CASCADE,
  CONSTRAINT fk_sba_granted_by FOREIGN KEY (granted_by) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_sba_role CHECK (role IN ('SUPER_ADMIN','ADMIN','CATALOG_MANAGER','OPERATIONS','SUPPORT','VIEWER'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Backfill: every current non-SUPER_ADMIN staff member already effectively
-- has whatever access their role grants on the one company that exists
-- today. Make that explicit as a Cor-Cotton grant. SUPER_ADMIN gets no row
-- by design (§3.2) — implicit access to every brand, never inferred from a
-- row's absence for anyone else.
INSERT INTO staff_brand_access (staff_user_id, brand_id, role, granted_by, granted_at)
SELECT su.id, b.id, su.role, NULL, CURRENT_TIMESTAMP(3)
  FROM staff_users su
  CROSS JOIN brands b
 WHERE su.role <> 'SUPER_ADMIN'
   AND b.slug = 'corcotton';

-- ---------------------------------------------------------------------------
-- 3. `staff_sessions.current_brand_id` — the switcher's target column
-- ---------------------------------------------------------------------------
ALTER TABLE staff_sessions
  ADD COLUMN current_brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER staff_user_id,
  ADD CONSTRAINT fk_staff_sessions_brand FOREIGN KEY (current_brand_id)
    REFERENCES brands(id) ON DELETE SET NULL;

-- Backfill active sessions to Cor-Cotton so nothing reads as "brand-less"
-- once Phase 2 starts consuming this column. No behaviour change today —
-- nothing reads it yet.
UPDATE staff_sessions ss
  JOIN brands b ON b.slug = 'corcotton'
   SET ss.current_brand_id = b.id
 WHERE ss.status = 'ACTIVE';

-- ---------------------------------------------------------------------------
-- 4. `company_profiles` (plural) — de-singleton of `company_profile`
-- ---------------------------------------------------------------------------
-- `company_profile` (singular) is left untouched and stays the live source
-- of truth for invoicing/GST until the Phase 5/6 cut-over — this table is
-- populated in parallel so that later phases have real data to switch onto,
-- not a migration to run under invoicing load.
CREATE TABLE company_profiles (
  brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  legal_name VARCHAR(200) NULL,
  trade_name VARCHAR(200) NULL,
  constitution VARCHAR(40) NULL,
  gstin VARCHAR(20) NULL,
  gst_registration_type VARCHAR(20) NULL,
  gst_state_code CHAR(2) NULL,
  gst_effective_from DATE NULL,
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
  PRIMARY KEY (brand_id),
  -- Deliberately NOT globally unique on owner_staff_user_id (unlike the
  -- singleton-era `company_profile`): the same person (e.g. the group's
  -- SUPER_ADMIN) may legitimately be the registered owner of more than one
  -- company. brand_id already guarantees one profile per company.
  KEY idx_company_profiles_owner (owner_staff_user_id),
  CONSTRAINT fk_company_profiles_brand FOREIGN KEY (brand_id)
    REFERENCES brands(id) ON DELETE CASCADE,
  CONSTRAINT fk_company_profiles_owner FOREIGN KEY (owner_staff_user_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT fk_company_profiles_default_warehouse FOREIGN KEY (default_warehouse_id)
    REFERENCES warehouses(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Cor-Cotton: copy the real, already-verified singleton row over verbatim.
INSERT INTO company_profiles (
  brand_id, legal_name, trade_name, constitution, gstin, gst_registration_type,
  gst_state_code, gst_effective_from, principal_address_line1, principal_address_line2,
  principal_city, principal_state, principal_postal_code, principal_country,
  owner_staff_user_id, default_warehouse_id, created_at, updated_at
)
SELECT b.id, cp.legal_name, cp.trade_name, cp.constitution, cp.gstin, cp.gst_registration_type,
       cp.gst_state_code, cp.gst_effective_from, cp.principal_address_line1, cp.principal_address_line2,
       cp.principal_city, cp.principal_state, cp.principal_postal_code, cp.principal_country,
       cp.owner_staff_user_id, cp.default_warehouse_id, cp.created_at, cp.updated_at
  FROM company_profile cp
  JOIN brands b ON b.slug = 'corcotton';

-- Cor-Znix: decision 5 — left blank/incomplete on purpose. Nothing here is
-- placeholder or fabricated; every legal/tax field stays NULL until the
-- user supplies Cor-Znix's real registered details. Invoicing for Cor-Znix
-- stays blocked by that absence, same as every other missing-config gate
-- in this codebase (tax profiles, provider credentials, etc).
INSERT INTO company_profiles (brand_id, principal_country)
SELECT b.id, 'IN' FROM brands b WHERE b.slug = 'corznix';
