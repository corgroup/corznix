-- Multi-company CMS — Phase 5, schema half (implementation/multi-company/
-- DESIGN.md §4.1 + §8's Phase 5 row). Adds `brand_id` to every operations
-- and documents table DESIGN.md lists as "directly scoped". Same
-- conventions as migrations 078/079 — see 078's header for the full
-- rationale recap.
--
-- Backfill strategy differs slightly from Phase 3/4: where a table has a
-- real parent already brand-scoped (fulfillments->orders, shipments->
-- fulfillments, inventory/print_stations->warehouses), backfill via a JOIN
-- to that parent rather than blindly to Cor-Cotton — more correct in
-- principle even though every current row resolves to Cor-Cotton either
-- way (decision 6). Tables with no such parent yet backfill directly.
--
-- Order matters here: warehouses first (inventory/print_stations depend on
-- it), then fulfillments (depends on orders, already brand-scoped since
-- Phase 4), then shipments (depends on fulfillments).
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ===========================================================================
-- SECTION 1 — warehouses (backfilled directly; decision §7.3, strictly
-- per-company, no shared pool). `uk_warehouses_single_default`'s generated
-- `default_guard` column widened to (brand_id, default_guard) — each
-- company gets its OWN single-default-warehouse guarantee, not one shared
-- globally.
-- ===========================================================================

ALTER TABLE warehouses
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE warehouses SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE warehouses
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_warehouses_code,
  DROP KEY uk_warehouses_single_default,
  ADD UNIQUE KEY uk_warehouses_brand_code (brand_id, code),
  ADD UNIQUE KEY uk_warehouses_brand_single_default (brand_id, default_guard),
  ADD KEY idx_warehouses_brand (brand_id),
  ADD CONSTRAINT fk_warehouses_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 2 — inventory + inventory_reservations + inventory_quarantine +
-- warehouse_transfers + print_stations + printers. inventory/print_stations
-- backfill via warehouse_id (now brand-scoped above); the rest have no
-- natural parent yet (inventory_reservations.customer_id points at
-- `customers`, already brand-scoped since Phase 4, but a reservation can
-- outlive/precede its order — backfilled directly like Phase 3/4 did for
-- similar cases) — all resolve to Cor-Cotton today regardless (decision 6).
-- ===========================================================================

ALTER TABLE inventory
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE inventory i JOIN warehouses w ON w.id = i.warehouse_id SET i.brand_id = w.brand_id;
ALTER TABLE inventory
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_inventory_brand (brand_id),
  ADD CONSTRAINT fk_inventory_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE inventory_reservations
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE inventory_reservations SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE inventory_reservations
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_inventory_reservations_brand (brand_id),
  ADD CONSTRAINT fk_inventory_reservations_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE inventory_quarantine
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE inventory_quarantine SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE inventory_quarantine
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_inventory_quarantine_brand (brand_id),
  ADD CONSTRAINT fk_inventory_quarantine_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- warehouse_transfers — 0 rows; transfer_number is business-facing, widened.
ALTER TABLE warehouse_transfers
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
ALTER TABLE warehouse_transfers
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_warehouse_transfers_number,
  ADD UNIQUE KEY uk_warehouse_transfers_brand_number (brand_id, transfer_number),
  ADD KEY idx_warehouse_transfers_brand (brand_id),
  ADD CONSTRAINT fk_warehouse_transfers_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE print_stations
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE print_stations ps JOIN warehouses w ON w.id = ps.warehouse_id SET ps.brand_id = w.brand_id;
ALTER TABLE print_stations
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_print_stations_brand (brand_id),
  ADD CONSTRAINT fk_print_stations_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE printers
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE printers p JOIN print_stations ps ON ps.id = p.print_station_id SET p.brand_id = ps.brand_id;
ALTER TABLE printers
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_printers_brand (brand_id),
  ADD CONSTRAINT fk_printers_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 3 — fulfillments (via orders) then shipments (via fulfillments).
-- fulfillment_number/shipment_number both already embed a UUID fragment
-- (like orders.order_number pre-Phase-4) but are NOT prefixed with "COR-"
-- at all today (checked application code) — no prefix collision risk, so
-- no widening needed for readability the way order_number got. Their
-- OTHER unique keys (order_id+sequence, fulfillment_id+sequence) are
-- already transitively brand-safe via the parent id.
-- ===========================================================================

ALTER TABLE fulfillments
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE fulfillments f JOIN orders o ON o.id = f.order_id SET f.brand_id = o.brand_id;
ALTER TABLE fulfillments
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_fulfillments_number,
  ADD UNIQUE KEY uk_fulfillments_brand_number (brand_id, fulfillment_number),
  ADD KEY idx_fulfillments_brand (brand_id),
  ADD CONSTRAINT fk_fulfillments_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE shipments
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE shipments s JOIN fulfillments f ON f.id = s.fulfillment_id SET s.brand_id = f.brand_id;
ALTER TABLE shipments
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_shipments_number,
  ADD UNIQUE KEY uk_shipments_brand_number (brand_id, shipment_number),
  ADD KEY idx_shipments_brand (brand_id),
  ADD CONSTRAINT fk_shipments_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 4 — return_requests, exchange_transactions (0 rows each;
-- request_number/transaction_number are customer-facing with a hardcoded
-- "COR-" prefix in application code, fixed alongside this migration —
-- widened for the same readability reasoning as orders.order_number).
-- ===========================================================================

ALTER TABLE return_requests
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
ALTER TABLE return_requests
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_return_requests_number,
  ADD UNIQUE KEY uk_return_requests_brand_number (brand_id, request_number),
  ADD KEY idx_return_requests_brand (brand_id),
  ADD CONSTRAINT fk_return_requests_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE exchange_transactions
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
ALTER TABLE exchange_transactions
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_exchange_transactions_number,
  ADD UNIQUE KEY uk_exchange_transactions_brand_number (brand_id, transaction_number),
  ADD KEY idx_exchange_transactions_brand (brand_id),
  ADD CONSTRAINT fk_exchange_transactions_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 5 — shipping_settings: genuine singleton (tinyint id, 1 row),
-- SAME precedent as return_policy/cod_settings (migration 078): brand_id
-- added as a new unique column, old id/singleton left alone. Its consumer
-- (shipping/repository.js's getSettings(), `WHERE id=1`) is UNCHANGED and
-- keeps working — same deliberate deferral as return_policy/cod_settings,
-- now a THIRD table in that same deferred bucket (their shared consumer
-- rewiring needs the storefront checkout call chain threaded with brandId,
-- deferred alongside warehouse allocation — see PHASE-5.md). Safe today:
-- Cor-Znix's own shipping_settings row exists but nothing reads it yet,
-- same as its warehouses having zero rows to mis-serve.
-- ===========================================================================

ALTER TABLE shipping_settings
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE shipping_settings SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton') WHERE id = 1;
ALTER TABLE shipping_settings
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD UNIQUE KEY uk_shipping_settings_brand (brand_id),
  ADD CONSTRAINT fk_shipping_settings_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- owner_delivery_zones — 0 rows; pincode widened (each company defines its
-- own serviceable-zone list independently).
ALTER TABLE owner_delivery_zones
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
ALTER TABLE owner_delivery_zones
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_owner_delivery_pincode,
  ADD UNIQUE KEY uk_owner_delivery_brand_pincode (brand_id, pincode),
  ADD KEY idx_owner_delivery_zones_brand (brand_id),
  ADD CONSTRAINT fk_owner_delivery_zones_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 6 — shipping_providers: decision §7.2 ("One per company...
-- shipping/comms/media provider config tables get brand_id"). PK widened
-- from the bare provider_code to (brand_id, provider_code) — each company
-- configures Delhivery/Blue Dart/DTDC/MOCK independently, own
-- enabled/priority/credentials. Cor-Znix gets its own row per provider,
-- cloned from Cor-Cotton's CURRENT values (MOCK enabled+default, every real
-- carrier disabled) — a safe, identical starting point, not real carrier
-- access; Cor-Znix must configure its own credentials before enabling one
-- for real (Phase 7 territory).
--
-- Three child tables have an FK on the OLD bare `provider_code` PK
-- (discovered mid-migration, not in the original design's table list):
-- shipping_provider_services (1 row), shipping_provider_payment_policies
-- (0 rows), shipping_provider_zones (0 rows). Each gets brand_id too and
-- its own FK re-pointed at the new composite (brand_id, provider_code) —
-- done properly rather than deferred, since both are cheap at these row
-- counts and decision §7.2 explicitly wants real per-company provider
-- config, not a half-scoped parent table. The one real
-- shipping_provider_services row (MOCK_STANDARD) is cloned for Cor-Znix
-- too, matching its cloned shipping_providers row.
-- ===========================================================================

ALTER TABLE shipping_providers
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER provider_code;
UPDATE shipping_providers SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');

ALTER TABLE shipping_provider_payment_policies DROP FOREIGN KEY fk_provider_payment_policy_provider;
ALTER TABLE shipping_provider_services DROP FOREIGN KEY fk_shipping_services_provider;
ALTER TABLE shipping_provider_zones DROP FOREIGN KEY fk_shipping_zones_provider;

ALTER TABLE shipping_providers
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (brand_id, provider_code),
  ADD CONSTRAINT fk_shipping_providers_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE shipping_provider_payment_policies
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE shipping_provider_payment_policies SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE shipping_provider_payment_policies
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_provider_payment_policy,
  ADD UNIQUE KEY uk_provider_payment_policy (brand_id, provider_code, provider_service_code),
  ADD CONSTRAINT fk_provider_payment_policy_provider FOREIGN KEY (brand_id, provider_code) REFERENCES shipping_providers(brand_id, provider_code) ON DELETE RESTRICT;

ALTER TABLE shipping_provider_zones
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE shipping_provider_zones SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE shipping_provider_zones
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_shipping_provider_zone,
  ADD UNIQUE KEY uk_shipping_provider_zone (brand_id, provider_code, rule_type, postal_code_prefix),
  ADD CONSTRAINT fk_shipping_zones_provider FOREIGN KEY (brand_id, provider_code) REFERENCES shipping_providers(brand_id, provider_code) ON DELETE RESTRICT;

ALTER TABLE shipping_provider_services
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER provider_code;
UPDATE shipping_provider_services SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE shipping_provider_services
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (brand_id, provider_code, provider_service_code),
  ADD CONSTRAINT fk_shipping_services_provider FOREIGN KEY (brand_id, provider_code) REFERENCES shipping_providers(brand_id, provider_code) ON DELETE RESTRICT;

INSERT INTO shipping_providers (provider_code, brand_id, display_name, enabled, priority, customer_visible, is_default)
SELECT sp.provider_code, (SELECT id FROM brands WHERE slug = 'corznix'), sp.display_name, sp.enabled, sp.priority, sp.customer_visible, sp.is_default
  FROM shipping_providers sp WHERE sp.brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');

INSERT INTO shipping_provider_services (provider_code, brand_id, provider_service_code, normalized_service_level, display_name, enabled, customer_visible, rate_override_minor)
SELECT s.provider_code, (SELECT id FROM brands WHERE slug = 'corznix'), s.provider_service_code, s.normalized_service_level, s.display_name, s.enabled, s.customer_visible, s.rate_override_minor
  FROM shipping_provider_services s WHERE s.brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');

-- ===========================================================================
-- SECTION 7 — documents, invoices, credit_notes, document_counters: the
-- single most legally-sensitive part of this phase (DESIGN.md §9 risk:
-- "Invoice numbering / GST identity bleeds"). document_counters' PK
-- widened from bare `name` to (brand_id, name) so each company's invoice/
-- credit-note SEQUENCE starts and runs independently — a real GST
-- requirement, not just a technical nicety. invoice_number/
-- credit_note_number widened for the same reason as order_number. The
-- "COR-INV"/"COR-CN" hardcoded prefixes (documents/service.js,
-- returns/refundRepository.js) are fixed alongside this migration to use
-- the brand's own order_prefix (migration 081), same as orders/tickets.
-- ===========================================================================

ALTER TABLE documents
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
ALTER TABLE documents
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_documents_brand (brand_id),
  ADD CONSTRAINT fk_documents_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE invoices
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
ALTER TABLE invoices
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_invoices_number,
  ADD UNIQUE KEY uk_invoices_brand_number (brand_id, invoice_number),
  ADD KEY idx_invoices_brand (brand_id),
  ADD CONSTRAINT fk_invoices_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE credit_notes
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
ALTER TABLE credit_notes
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_credit_notes_number,
  ADD UNIQUE KEY uk_credit_notes_brand_number (brand_id, credit_note_number),
  ADD KEY idx_credit_notes_brand (brand_id),
  ADD CONSTRAINT fk_credit_notes_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

ALTER TABLE document_counters
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER name;
UPDATE document_counters SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE document_counters
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (brand_id, name),
  ADD CONSTRAINT fk_document_counters_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;
