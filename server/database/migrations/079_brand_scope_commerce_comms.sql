-- Multi-company CMS — Phase 4, schema half (implementation/multi-company/
-- DESIGN.md §4.1 + §8's Phase 4 row). Adds `brand_id` to every commerce and
-- comms/support table DESIGN.md lists as "directly scoped". Backfills
-- everything to Cor-Cotton (decision 6 — Cor-Znix starts empty).
--
-- Same conventions as migration 078 (Phase 3) — see that file's header for
-- the full rationale. Recap: every `brand_id` column is
-- `CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci` to match `brands.id`;
-- a unique key is widened to `(brand_id, <key>)` only where the key is a
-- genuine business-identity value a second company could legitimately
-- reuse; opaque generated identifiers (idempotency keys, confirm tokens,
-- dedupe keys, UUID-suffixed numbers) stay globally unique on purpose.
--
-- `return_policy` / `cod_settings` already got `brand_id` in migration 078
-- (they're genuine singletons, handled there) — NOT touched again here.
-- Their storefront consumers get rewired to actually use it in this phase's
-- repository half instead (see PHASE-4.md).
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ===========================================================================
-- SECTION 1 — Commerce (10 tables)
-- ===========================================================================

-- carts — unique key stays on customer_id alone: once `customers` is
-- brand-scoped below, a given customer_id already implies exactly one
-- brand, so widening would be a no-op that just adds noise.
ALTER TABLE carts
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE carts SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE carts
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_carts_brand (brand_id),
  ADD CONSTRAINT fk_carts_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- checkout_sessions — idempotency_key/inventory_reservation_id are opaque
-- generated identifiers, not business-facing; no widening.
ALTER TABLE checkout_sessions
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE checkout_sessions SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE checkout_sessions
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_checkout_sessions_brand (brand_id),
  ADD CONSTRAINT fk_checkout_sessions_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- orders — order_number is customer-facing (currently hardcoded "COR-"
-- prefix, fixed alongside this migration in orders/repository.js to derive
-- the prefix from the brand instead — see PHASE-4.md). It already embeds a
-- UUID fragment so real collisions are already impossible, but it is
-- exactly the kind of customer-facing business identity the Phase 3 policy
-- widens for defense-in-depth and future readability (a Cor-Znix support
-- agent should be able to tell which company's order they're looking at
-- from the number alone once the prefix fix lands).
ALTER TABLE orders
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE orders SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE orders
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_orders_number,
  ADD UNIQUE KEY uk_orders_brand_number (brand_id, order_number),
  ADD KEY idx_orders_brand (brand_id),
  ADD CONSTRAINT fk_orders_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- customers — decision §7.1: separate per-brand accounts. No column on
-- customers itself is a business-identity key; the real uniqueness
-- decision lives on `customer_contacts` (email/phone), which is
-- transitively scoped via this brand_id and gets its lookup query fixed in
-- the repository half of this phase, not a schema change (§4.2 policy:
-- transitively-scoped tables get no column of their own).
ALTER TABLE customers
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE customers SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE customers
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_customers_brand (brand_id),
  ADD CONSTRAINT fk_customers_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- promotions — no business-identity key on this table today (coupon code
-- text lives per-redemption on order_discounts.coupon_code, not as a
-- column here); no widening, just the column.
ALTER TABLE promotions
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE promotions SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE promotions
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_promotions_brand (brand_id),
  ADD CONSTRAINT fk_promotions_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- customer_segments — segment_key is a business-identity key (a CMS user
-- picks it); widen so both companies can each have their own "vip" segment.
ALTER TABLE customer_segments
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE customer_segments SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE customer_segments
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_customer_segments_key,
  ADD UNIQUE KEY uk_customer_segments_brand_key (brand_id, segment_key),
  ADD KEY idx_customer_segments_brand (brand_id),
  ADD CONSTRAINT fk_customer_segments_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- newsletter_subscribers — normalized_email widened (decision §7.1's
-- per-brand-identity principle applies here too: a person can subscribe to
-- both companies' newsletters independently). confirm_token is a random
-- generated token, stays global.
ALTER TABLE newsletter_subscribers
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE newsletter_subscribers SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE newsletter_subscribers
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_newsletter_subscribers_email,
  ADD UNIQUE KEY uk_newsletter_subscribers_brand_email (brand_id, normalized_email),
  ADD KEY idx_newsletter_subscribers_brand (brand_id),
  ADD CONSTRAINT fk_newsletter_subscribers_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- marketing_suppressions — no existing unique constraint to widen (app-
-- layer enforced); just the column + index for scoping reads/writes.
ALTER TABLE marketing_suppressions
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE marketing_suppressions SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE marketing_suppressions
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_marketing_suppressions_brand (brand_id),
  ADD CONSTRAINT fk_marketing_suppressions_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- consent_records — `seq` is an append-only audit sequence number (like
-- product_variants.storefront_id in Phase 3), stays global on purpose: it
-- is a proof-of-order surrogate, not a business identity.
ALTER TABLE consent_records
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE consent_records SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE consent_records
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_consent_records_brand (brand_id),
  ADD CONSTRAINT fk_consent_records_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- store_credit_accounts — (customer_id, currency) stays as-is: once
-- customers is brand-scoped, customer_id alone already implies one brand.
ALTER TABLE store_credit_accounts
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE store_credit_accounts SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE store_credit_accounts
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_store_credit_accounts_brand (brand_id),
  ADD CONSTRAINT fk_store_credit_accounts_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 2 — Comms / support (5 tables)
-- ===========================================================================

-- support_tickets — ticket_number gets the same brand-prefix fix as
-- orders.order_number (see repository half). idempotency_key stays global
-- (opaque, client-supplied for retry-safety, not a business identity).
ALTER TABLE support_tickets
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE support_tickets SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE support_tickets
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_support_tickets_number,
  ADD UNIQUE KEY uk_support_tickets_brand_number (brand_id, ticket_number),
  ADD KEY idx_support_tickets_brand (brand_id),
  ADD CONSTRAINT fk_support_tickets_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- internal_conversations — direct_key (a sorted staff-pair key for 1:1 DMs)
-- widened so the same two staff members get a SEPARATE thread per company
-- context — matches the whole point of scoping comms per DESIGN.md §4.1.
ALTER TABLE internal_conversations
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE internal_conversations SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE internal_conversations
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_internal_conversations_direct,
  ADD UNIQUE KEY uk_internal_conversations_brand_direct (brand_id, direct_key),
  ADD KEY idx_internal_conversations_brand (brand_id),
  ADD CONSTRAINT fk_internal_conversations_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- communication_templates — template_key is the business identity a CMS
-- user picks; widen alongside its existing (channel, version) composite.
ALTER TABLE communication_templates
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE communication_templates SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE communication_templates
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP KEY uk_comm_templates_key_channel_ver,
  ADD UNIQUE KEY uk_comm_templates_brand_key_channel_ver (brand_id, template_key, channel, version),
  ADD KEY idx_communication_templates_brand (brand_id),
  ADD CONSTRAINT fk_communication_templates_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- communication_broadcasts — no existing unique key to widen.
ALTER TABLE communication_broadcasts
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE communication_broadcasts SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE communication_broadcasts
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_communication_broadcasts_brand (brand_id),
  ADD CONSTRAINT fk_communication_broadcasts_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- staff_notifications — already has warehouse_id (per-warehouse
-- notifications); brand_id added directly per DESIGN.md §4.1's explicit
-- note, since not every notification is warehouse-specific (e.g. a support
-- ticket or order-level notification has no warehouse at all). dedupe_key
-- is built from real entity ids elsewhere in the codebase (order/ticket/
-- shipment ids etc.), already collision-safe without widening.
ALTER TABLE staff_notifications
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER id;
UPDATE staff_notifications SET brand_id = (SELECT id FROM brands WHERE slug = 'corcotton');
ALTER TABLE staff_notifications
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  ADD KEY idx_staff_notifications_brand (brand_id),
  ADD CONSTRAINT fk_staff_notifications_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 3 — carry-forward from Phase 3's own "Next" notes (PHASE-3.md):
-- content_campaign_runtime (kill-switch table, keyed globally by
-- campaign_key, not brand-scoped despite content_campaigns itself already
-- being brand-scoped since migration 078). 0 rows — safe to widen its PK
-- now while it's free.
-- ===========================================================================

ALTER TABLE content_campaign_runtime
  ADD COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL AFTER campaign_key;
ALTER TABLE content_campaign_runtime
  MODIFY COLUMN brand_id CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL,
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (brand_id, campaign_key),
  ADD CONSTRAINT fk_content_campaign_runtime_brand FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT;

-- ===========================================================================
-- SECTION 4 — storefront host -> brand mapping needs a real value here.
-- Corcotton's live storefront domain, so resolveStorefrontBrand (repository
-- half of this phase) has something real to match against. Cor-Znix has no
-- live storefront yet (decision §7.4 — starts empty, Phase 7) so its
-- storefront_url stays NULL on purpose; unmapped/unknown hosts (localhost
-- dev, an unrecognized domain) fall back to the `is_default` brand, exactly
-- like the CMS admin side already does in resolveBrandContext (Phase 2).
-- ===========================================================================

UPDATE brands SET storefront_url = 'https://www.corcotton.in' WHERE slug = 'corcotton';
