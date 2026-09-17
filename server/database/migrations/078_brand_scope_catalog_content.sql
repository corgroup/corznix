-- Multi-company CMS — Phase 3, schema half (implementation/multi-company/
-- DESIGN.md §4.1 + §8's Phase 3 row). Adds `brand_id` to every catalog and
-- content table DESIGN.md lists as "directly scoped". Backfills everything
-- to Cor-Cotton (decision 6 — all existing data is Cor-Cotton's; Cor-Znix
-- starts empty per decision 4, so every backfill here is a no-op for it).
--
-- Every `brand_id` column is explicitly `CHARACTER SET utf8mb4 COLLATE
-- utf8mb4_0900_ai_ci` to match `brands.id` — see PHASE-1.md for the
-- collation bug this avoids re-discovering.
--
-- Unique-key policy: a table's existing unique key is widened to
-- `(brand_id, <key>)` wherever that key was a *business-identity* value a
-- second company could legitimately reuse (a slug, a short code, a label,
-- a client-supplied id) — so Corcotton and Corznix can each have their own
-- "tops" category, their own "BLK" color code, etc. A key is left alone
-- where it is already scoped by a parent (most `content_*` child tables
-- carry `document_id`, and once `content_documents` itself is brand-scoped
-- below, everything hanging off a document is transitively brand-scoped
-- too) or where global uniqueness is the actually-intended behaviour
-- (`product_variants.storefront_id`, an AUTO_INCREMENT surrogate with no
-- business meaning to collide over).
--
-- Two tables (`return_policy`, `cod_settings`) are genuine singletons today
-- (`CHECK (id = 1)`, the same pattern `company_profile` had before Phase 1
-- de-singletoned it). Following that exact precedent: `brand_id` is added
-- here as a new unique column, but the old `id`/singleton CHECK is left
-- completely alone — de-singletoning them is deferred to whichever later
-- phase actually rewires their one consumer (`returns/repository.js`,
-- `paymentEligibility/repository.js` — both storefront/checkout-facing
-- reads, which need the storefront host->brand mapping DESIGN.md §8
-- assigns to Phase 4, not this one). `pin_payment_restrictions` and
-- `rto_risk_rules` have zero rows and no singleton assumption, so their
-- primary keys are safely widened to a real composite `(brand_id, ...)`
-- now.
--
-- Repository/service/controller scoping is the OTHER half of Phase 3 (see
-- PHASE-3.md) — deliberately scoped to the ADMIN/CMS read+write paths only
-- (adminCatalog, catalogSku, adminContent — everything already gated
-- behind `authenticateStaff` + `resolveBrandContext`). Public storefront
-- reads (product listings, content, site media, checkout payment
-- eligibility) stay unscoped until Phase 4's storefront host->brand
-- mapping exists — safe today because Cor-Znix has zero rows in every
-- table this migration touches, so there is nothing to leak.
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ===========================================================================
-- SECTION 1 — Catalog (13 tables)
-- ===========================================================================

-- products ------------------------------------------------------------------
ALTER TABLE products
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE products SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE products
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_products_slug,
  ADD UNIQUE KEY uk_products_brand_slug (brand_id, slug),
  ADD KEY idx_products_brand (brand_id),
  ADD CONSTRAINT fk_products_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- product_variants ------------------------------------------------------------
-- Denormalized from products.brand_id on purpose (DESIGN.md §4.1 lists this
-- as directly, not transitively, scoped) — repo INSERTs must always copy the
-- parent product's brand_id, never accept one separately (enforced at the
-- application layer + verify:brand-scope-catalog, see PHASE-3.md).
ALTER TABLE product_variants
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE product_variants SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE product_variants
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_product_variants_brand (brand_id),
  ADD CONSTRAINT fk_product_variants_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- skus ------------------------------------------------------------------------
ALTER TABLE skus
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE skus SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE skus
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_skus_sku,
  ADD UNIQUE KEY uk_skus_brand_sku (brand_id, sku),
  ADD KEY idx_skus_brand (brand_id),
  ADD CONSTRAINT fk_skus_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- categories --------------------------------------------------------------
ALTER TABLE categories
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE categories SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE categories
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_categories_slug,
  ADD UNIQUE KEY uk_categories_brand_slug (brand_id, slug),
  ADD KEY idx_categories_brand (brand_id),
  ADD CONSTRAINT fk_categories_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- collections ---------------------------------------------------------------
ALTER TABLE collections
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE collections SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE collections
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_collections_slug,
  ADD UNIQUE KEY uk_collections_brand_slug (brand_id, slug),
  ADD KEY idx_collections_brand (brand_id),
  ADD CONSTRAINT fk_collections_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- size_guides -----------------------------------------------------------------
ALTER TABLE size_guides
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE size_guides SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE size_guides
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_size_guides_slug,
  ADD UNIQUE KEY uk_size_guides_brand_slug (brand_id, slug),
  ADD KEY idx_size_guides_brand (brand_id),
  ADD CONSTRAINT fk_size_guides_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- sku_aliases ------------------------------------------------------------
ALTER TABLE sku_aliases
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE sku_aliases SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE sku_aliases
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_sku_aliases_brand (brand_id),
  ADD CONSTRAINT fk_sku_aliases_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- catalog_color_codes -----------------------------------------------------
ALTER TABLE catalog_color_codes
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE catalog_color_codes SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE catalog_color_codes
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uq_catalog_color_codes_code,
  DROP KEY uq_catalog_color_codes_label,
  ADD UNIQUE KEY uk_catalog_color_codes_brand_code (brand_id, code),
  ADD UNIQUE KEY uk_catalog_color_codes_brand_label (brand_id, label),
  ADD CONSTRAINT fk_catalog_color_codes_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- catalog_fit_codes ---------------------------------------------------------
ALTER TABLE catalog_fit_codes
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE catalog_fit_codes SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE catalog_fit_codes
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uq_catalog_fit_codes_code,
  DROP KEY uq_catalog_fit_codes_label,
  ADD UNIQUE KEY uk_catalog_fit_codes_brand_code (brand_id, code),
  ADD UNIQUE KEY uk_catalog_fit_codes_brand_label (brand_id, label),
  ADD CONSTRAINT fk_catalog_fit_codes_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- catalog_product_type_codes -----------------------------------------------
ALTER TABLE catalog_product_type_codes
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE catalog_product_type_codes SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE catalog_product_type_codes
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uq_catalog_product_type_codes_code,
  DROP KEY uq_catalog_product_type_codes_label,
  ADD UNIQUE KEY uk_catalog_ptc_brand_code (brand_id, code),
  ADD UNIQUE KEY uk_catalog_ptc_brand_label (brand_id, label),
  ADD CONSTRAINT fk_catalog_ptc_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- qc_questions ----------------------------------------------------------------
ALTER TABLE qc_questions
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE qc_questions SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE qc_questions
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_qc_questions_client_id,
  ADD UNIQUE KEY uk_qc_questions_brand_client_id (brand_id, client_question_id),
  ADD KEY idx_qc_questions_brand (brand_id),
  ADD CONSTRAINT fk_qc_questions_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- tax_profiles -----------------------------------------------------------
ALTER TABLE tax_profiles
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE tax_profiles SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE tax_profiles
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_tax_profiles_brand (brand_id),
  ADD CONSTRAINT fk_tax_profiles_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- cod_value_rules -------------------------------------------------------------
ALTER TABLE cod_value_rules
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE cod_value_rules SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE cod_value_rules
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_cod_value_rules_brand (brand_id),
  ADD CONSTRAINT fk_cod_value_rules_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 2 — Content (10 tables)
-- ===========================================================================

-- content_documents — the scope-holder every content_pages/faq/nav/home
-- section/footer group/campaign/theme row ultimately hangs off via
-- document_id. Its (doc_type, doc_key) key MUST become brand-scoped: this
-- is what lets Corcotton and Corznix each have their own NAVIGATION/main,
-- FOOTER/main, HOMEPAGE/main document.
ALTER TABLE content_documents
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_documents SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_documents
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_content_documents_scope,
  ADD UNIQUE KEY uk_content_documents_brand_scope (brand_id, doc_type, doc_key),
  ADD KEY idx_content_documents_brand (brand_id),
  ADD CONSTRAINT fk_content_documents_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_pages ------------------------------------------------------------
ALTER TABLE content_pages
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_pages SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_pages
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_content_pages_key,
  DROP KEY uk_content_pages_slug,
  ADD UNIQUE KEY uk_content_pages_brand_key (brand_id, page_key),
  ADD UNIQUE KEY uk_content_pages_brand_slug (brand_id, slug),
  ADD KEY idx_content_pages_brand (brand_id),
  ADD CONSTRAINT fk_content_pages_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_faq_items ----------------------------------------------------------
ALTER TABLE content_faq_items
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_faq_items SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_faq_items
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_content_faq_items_key,
  ADD UNIQUE KEY uk_content_faq_items_brand_key (brand_id, item_key),
  ADD KEY idx_content_faq_items_brand (brand_id),
  ADD CONSTRAINT fk_content_faq_items_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_nav_items — already scoped by document_id (whose parent document
-- is now brand-scoped above); brand_id added for the same defense-in-depth
-- reason as every other table here, no unique-key change needed.
ALTER TABLE content_nav_items
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_nav_items SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_nav_items
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_content_nav_items_brand (brand_id),
  ADD CONSTRAINT fk_content_nav_items_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_mega_menus — standalone (no document_id at all); menu_key must
-- become brand-scoped.
ALTER TABLE content_mega_menus
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_mega_menus SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_mega_menus
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_content_mega_menus_key,
  ADD UNIQUE KEY uk_content_mega_menus_brand_key (brand_id, menu_key),
  ADD KEY idx_content_mega_menus_brand (brand_id),
  ADD CONSTRAINT fk_content_mega_menus_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_home_sections — already scoped by document_id, no unique-key change.
ALTER TABLE content_home_sections
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_home_sections SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_home_sections
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_content_home_sections_brand (brand_id),
  ADD CONSTRAINT fk_content_home_sections_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_footer_groups — already scoped by document_id, no unique-key change.
ALTER TABLE content_footer_groups
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_footer_groups SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_footer_groups
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_content_footer_groups_brand (brand_id),
  ADD CONSTRAINT fk_content_footer_groups_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_announcements — standalone (no document_id); both unique keys
-- must become brand-scoped, including the position ladder (each brand gets
-- its own 0..N announcement ordering).
ALTER TABLE content_announcements
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_announcements SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_announcements
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_content_announcements_key,
  DROP KEY uk_content_announcements_position,
  ADD UNIQUE KEY uk_content_announcements_brand_key (brand_id, announcement_key),
  ADD UNIQUE KEY uk_content_announcements_brand_position (brand_id, position),
  ADD CONSTRAINT fk_content_announcements_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_campaigns -----------------------------------------------------------
ALTER TABLE content_campaigns
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_campaigns SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_campaigns
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_content_campaigns_key,
  DROP KEY uk_content_campaigns_slug,
  ADD UNIQUE KEY uk_content_campaigns_brand_key (brand_id, campaign_key),
  ADD UNIQUE KEY uk_content_campaigns_brand_slug (brand_id, slug),
  ADD KEY idx_content_campaigns_brand (brand_id),
  ADD CONSTRAINT fk_content_campaigns_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- content_themes ---------------------------------------------------------
ALTER TABLE content_themes
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE content_themes SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE content_themes
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_content_themes_key,
  ADD UNIQUE KEY uk_content_themes_brand_key (brand_id, theme_key),
  ADD KEY idx_content_themes_brand (brand_id),
  ADD CONSTRAINT fk_content_themes_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 3 — site_media (composite-PK restructure; the 5th "special" table
-- lives with catalog's other 4 below since site_media has real rows today)
-- ===========================================================================

ALTER TABLE site_media
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER media_key;
UPDATE site_media SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE site_media
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (brand_id, media_key),
  ADD CONSTRAINT fk_site_media_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 4 — the two genuine singletons (return_policy, cod_settings) and
-- the two zero-row composite-safe tables (pin_payment_restrictions,
-- rto_risk_rules). See the file header for why these four are NOT treated
-- like Section 1/2's tables.
-- ===========================================================================

-- return_policy — 1 real row. brand_id added as a new unique column; the
-- tinyint `id` PK and its `CHECK (id = 1)` singleton guard are left exactly
-- as they are (same precedent as company_profile in Phase 1). Its one
-- consumer (returns/repository.js, `WHERE id = 1`) is unchanged and keeps
-- working — de-singletoning is deferred to whichever phase rewires that
-- consumer for real multi-brand returns.
ALTER TABLE return_policy
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE return_policy SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton') WHERE id = 1;
ALTER TABLE return_policy
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD UNIQUE KEY uk_return_policy_brand (brand_id),
  ADD CONSTRAINT fk_return_policy_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- cod_settings — 0 rows, same treatment as return_policy for consistency
-- (its consumer, paymentEligibility/repository.js `WHERE id = 1`, is
-- likewise a storefront/checkout read deferred to Phase 4).
ALTER TABLE cod_settings
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
ALTER TABLE cod_settings
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD UNIQUE KEY uk_cod_settings_brand (brand_id),
  ADD CONSTRAINT fk_cod_settings_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- pin_payment_restrictions — 0 rows, no singleton assumption anywhere in
-- its one consumer (a plain `WHERE postal_code = ?` lookup, unaffected by
-- widening the key) — safe to give it its real composite PK now.
ALTER TABLE pin_payment_restrictions
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER postal_code;
ALTER TABLE pin_payment_restrictions
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (brand_id, postal_code),
  ADD CONSTRAINT fk_pin_payment_restrictions_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- rto_risk_rules — 0 rows, same reasoning as pin_payment_restrictions.
ALTER TABLE rto_risk_rules
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER risk_level;
ALTER TABLE rto_risk_rules
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (brand_id, risk_level),
  ADD CONSTRAINT fk_rto_risk_rules_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;
