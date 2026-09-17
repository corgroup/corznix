-- Bootstrap the marketing template rows an environment is missing.
--
-- `scripts/seed-marketing-templates.js` is the canonical source for this copy
-- and is what should be run when the wording changes. This migration exists
-- because a deploy only ships Docker images: the VPS deploy directory is set
-- up once and never re-synced, so a NEW deploy/*.sh seeder script cannot reach
-- production, while migrations run on every deploy that asks for them.
--
-- Two rules, so this can never damage an environment:
--
--   * INSERT only where no row exists for (brand, template_key, channel). An
--     operator's edited copy is never touched, never archived, never replaced.
--   * The WhatsApp row for the offer campaign is inserted DRAFT, because
--     `corcotton_offer` was still In review at Meta when this was written.
--     Activating it is a deliberate act once WhatsApp Manager says Active —
--     not something a migration should decide.
--
-- The abandoned-cart templates already exist in every environment, so this
-- leaves them alone entirely. Their upgrade (the customer's own product image,
-- and the approved corcotton_abandoned_cart reference) is published through
-- the CMS Message Templates page, which is the surface that exists for exactly
-- that and keeps the version history honest.
--
-- Forward-only, non-destructive. MySQL 8.x.

SET @brand := (SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1);

-- marketing.new_collection / EMAIL
INSERT INTO communication_templates
  (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref)
SELECT UUID(), @brand, 'marketing.new_collection', 'EMAIL', 'MARKETING', 1, 'ACTIVE',
  '{{collectionName}} — the new collection is here',
  CONCAT('<p>Hi {{customerName}},</p>',
         '<p><img src="{{collectionImageUrl}}" alt="{{collectionName}}" width="520" style="max-width:100%;border-radius:8px;display:block" /></p>',
         '<p><strong>{{collectionName}}</strong></p>',
         '<p>Minimal design. Bold identity. Made to be worn with purpose.</p>',
         '<p><a href="{{ctaUrl}}">{{ctaLabel}}</a></p>',
         '<p>— The CORCOTTON team</p>'),
  CAST('{"customerName":{"required":true,"type":"string"},"offerName":{"type":"string"},"offerDetails":{"type":"string"},"ctaLabel":{"type":"string"},"ctaUrl":{"type":"string"},"imageUrl":{"type":"string"},"collectionName":{"type":"string"},"collectionImageUrl":{"type":"string"},"collectionSlug":{"type":"string"}}' AS JSON),
  NULL
WHERE @brand IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM communication_templates t
                   WHERE t.brand_id = @brand AND t.template_key = 'marketing.new_collection' AND t.channel = 'EMAIL');

-- marketing.new_collection / WHATSAPP — corcotton_new_collection is APPROVED.
INSERT INTO communication_templates
  (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref)
SELECT UUID(), @brand, 'marketing.new_collection', 'WHATSAPP', 'MARKETING', 1, 'ACTIVE',
  NULL,
  'THE NEW COLLECTION IS HERE. Meet the latest from CORCOTTON. Minimal design. Bold identity. Made to be worn with purpose.',
  CAST('{"customerName":{"required":true,"type":"string"},"offerName":{"type":"string"},"offerDetails":{"type":"string"},"ctaLabel":{"type":"string"},"ctaUrl":{"type":"string"},"imageUrl":{"type":"string"},"collectionName":{"type":"string"},"collectionImageUrl":{"type":"string"},"collectionSlug":{"type":"string"}}' AS JSON),
  'corcotton_new_collection'
WHERE @brand IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM communication_templates t
                   WHERE t.brand_id = @brand AND t.template_key = 'marketing.new_collection' AND t.channel = 'WHATSAPP');

-- marketing.offer_campaign / EMAIL
INSERT INTO communication_templates
  (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref)
SELECT UUID(), @brand, 'marketing.offer_campaign', 'EMAIL', 'MARKETING', 1, 'ACTIVE',
  '{{offerName}}',
  CONCAT('<p>Hi {{customerName}},</p>',
         '<p><img src="{{imageUrl}}" alt="{{offerName}}" width="520" style="max-width:100%;border-radius:8px;display:block" /></p>',
         '<p><strong>{{offerName}}</strong></p>',
         '<p>{{offerDetails}}</p>',
         '<p><a href="{{ctaUrl}}">{{ctaLabel}}</a></p>',
         '<p>— The CORCOTTON team</p>'),
  CAST('{"customerName":{"required":true,"type":"string"},"offerName":{"type":"string"},"offerDetails":{"type":"string"},"ctaLabel":{"type":"string"},"ctaUrl":{"type":"string"},"imageUrl":{"type":"string"},"collectionName":{"type":"string"},"collectionImageUrl":{"type":"string"},"collectionSlug":{"type":"string"}}' AS JSON),
  NULL
WHERE @brand IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM communication_templates t
                   WHERE t.brand_id = @brand AND t.template_key = 'marketing.offer_campaign' AND t.channel = 'EMAIL');

-- marketing.offer_campaign / WHATSAPP — DRAFT on purpose: corcotton_offer is
-- awaiting Meta approval, and an ACTIVE row here would let a campaign try to
-- send on a template Meta has not approved.
INSERT INTO communication_templates
  (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref)
SELECT UUID(), @brand, 'marketing.offer_campaign', 'WHATSAPP', 'MARKETING', 1, 'DRAFT',
  NULL,
  'Hey {{customerName}}, here is something for you from CORCOTTON. {{offerName}}. {{offerDetails}} Tap below to explore the offer.',
  CAST('{"customerName":{"required":true,"type":"string"},"offerName":{"type":"string"},"offerDetails":{"type":"string"},"ctaLabel":{"type":"string"},"ctaUrl":{"type":"string"},"imageUrl":{"type":"string"},"collectionName":{"type":"string"},"collectionImageUrl":{"type":"string"},"collectionSlug":{"type":"string"}}' AS JSON),
  'corcotton_offer'
WHERE @brand IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM communication_templates t
                   WHERE t.brand_id = @brand AND t.template_key = 'marketing.offer_campaign' AND t.channel = 'WHATSAPP');
