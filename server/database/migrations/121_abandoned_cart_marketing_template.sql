-- The abandoned-cart marketing template, for environments that have none.
--
-- Found on production immediately after deploying 120: `marketing.abandoned_cart`
-- did not exist there at all — no EMAIL row, no WHATSAPP row. The abandoned-cart
-- campaign refuses to enable a channel without an ACTIVE MARKETING template for
-- its key, so abandoned-cart recovery had never been able to send a single
-- message on production. 120 skipped this key because the local database had
-- the rows and I assumed production did too; it did not.
--
-- Same rules as 120: INSERT only where no row exists for
-- (brand, template_key, channel), so an environment that already has this
-- template — edited or not — is left completely alone.
--
-- Both rows are ACTIVE: corcotton_abandoned_cart is APPROVED at Meta
-- (verified in WhatsApp Manager, WABA 1597095515147826), unlike the offer
-- template in 120 which is still in review and was therefore seeded DRAFT.
--
-- The EMAIL body carries the customer's own product image. When a product has
-- no photograph the service omits the variable and the renderer produces an
-- empty string, so nothing prints the word "undefined" — the img simply has no
-- source. WhatsApp is skipped entirely for such a product, because its
-- approved template has a required IMAGE header.
--
-- Forward-only, non-destructive. MySQL 8.x.

SET @brand := (SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1);
SET @ac_vars := '{"itemCount":{"required":true,"type":"number"},"cartValue":{"required":true,"type":"string"},"firstItemName":{"required":true,"type":"string"},"couponLine":{"type":"string"},"cartUrl":{"required":true,"type":"string"},"customerName":{"required":true,"type":"string"},"productImageUrl":{"type":"string"},"productName":{"required":true,"type":"string"},"variantLabel":{"type":"string"},"quantity":{"required":true,"type":"number"},"recoveryUrlSuffix":{"required":true,"type":"string"}}';

INSERT INTO communication_templates
  (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref)
SELECT UUID(), @brand, 'marketing.abandoned_cart', 'EMAIL', 'MARKETING', 1, 'ACTIVE',
  'Still thinking about it?',
  CONCAT('<p>Hi {{customerName}},</p>',
         '<p>You left <strong>{{itemCount}}</strong> item(s) in your CORCOTTON cart — ',
         'that''s <strong>{{cartValue}}</strong> waiting for you.</p>',
         '<p><img src="{{productImageUrl}}" alt="{{productName}}" width="260" style="max-width:100%;border-radius:8px;display:block" /></p>',
         '<p><strong>{{productName}}</strong><br />{{variantLabel}}<br />Quantity: {{quantity}}</p>',
         '<p>{{couponLine}}</p>',
         '<p><a href="{{cartUrl}}">Return to your cart</a> to finish checking out.</p>',
         '<p>— The CORCOTTON team</p>'),
  CAST(@ac_vars AS JSON),
  NULL
WHERE @brand IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM communication_templates t
                   WHERE t.brand_id = @brand AND t.template_key = 'marketing.abandoned_cart' AND t.channel = 'EMAIL');

INSERT INTO communication_templates
  (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref)
SELECT UUID(), @brand, 'marketing.abandoned_cart', 'WHATSAPP', 'MARKETING', 1, 'ACTIVE',
  NULL,
  CONCAT('Hey {{customerName}}, your selected CORCOTTON pieces are still in your cart. ',
         'If you''re ready, you can pick up right where you left off and complete your order.'),
  CAST(@ac_vars AS JSON),
  'corcotton_abandoned_cart'
WHERE @brand IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM communication_templates t
                   WHERE t.brand_id = @brand AND t.template_key = 'marketing.abandoned_cart' AND t.channel = 'WHATSAPP');
