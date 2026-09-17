// Seed the abandoned-cart recovery starter kit:
//   - a MARKETING EMAIL template `marketing.abandoned_cart` (ACTIVE)
//   - a MARKETING WHATSAPP template `marketing.abandoned_cart` (DRAFT — needs
//     an Infyntra-approved provider template name before it can send)
//   - one campaign "Abandoned cart reminder", PAUSED, email-only, 4h delay
//
// Idempotent. The operator reviews/edits the copy in CMS → Marketing →
// Message Templates, then sets the campaign ACTIVE in CMS → Marketing →
// Abandoned Carts.
//
//   npm run seed:abandoned-cart
import { pool, query } from '../src/database/connection/pool.js';
import { communicationRepository } from '../src/modules/communications/repository.js';
import { communicationTemplateService } from '../src/modules/communications/templateService.js';
import {
  ABANDONED_CART_TEMPLATE_DEFAULTS, ABANDONED_CART_VARIABLE_SCHEMA,
} from '../src/modules/abandonedCart/templates.js';

const KEY = 'marketing.abandoned_cart';
const out = { templates: [], campaign: null };

try {
  const existing = await communicationRepository.listTemplates();
  const active = new Set(existing.filter((t) => t.status === 'ACTIVE').map((t) => `${t.template_key}|${t.channel}`));
  const any = new Set(existing.map((t) => `${t.template_key}|${t.channel}`));

  // EMAIL — create + activate
  if (!active.has(`${KEY}|EMAIL`)) {
    const t = await communicationTemplateService.create({
      templateKey: KEY, channel: 'EMAIL', classification: 'MARKETING',
      subject: ABANDONED_CART_TEMPLATE_DEFAULTS.EMAIL.subject,
      bodyTemplate: ABANDONED_CART_TEMPLATE_DEFAULTS.EMAIL.bodyTemplate,
      variableSchema: ABANDONED_CART_VARIABLE_SCHEMA,
    });
    await communicationTemplateService.setStatus({ id: t.id, status: 'ACTIVE' });
    out.templates.push(`${KEY}|EMAIL v${t.version} ACTIVE`);
  } else {
    out.templates.push(`${KEY}|EMAIL already ACTIVE`);
  }

  // WHATSAPP — create DRAFT only (needs provider_template_ref)
  if (!any.has(`${KEY}|WHATSAPP`)) {
    const t = await communicationTemplateService.create({
      templateKey: KEY, channel: 'WHATSAPP', classification: 'MARKETING',
      bodyTemplate: ABANDONED_CART_TEMPLATE_DEFAULTS.WHATSAPP.bodyTemplate,
      variableSchema: ABANDONED_CART_VARIABLE_SCHEMA,
    });
    out.templates.push(`${KEY}|WHATSAPP v${t.version} DRAFT — add provider template name + activate in CMS`);
  } else {
    out.templates.push(`${KEY}|WHATSAPP already exists`);
  }

  // Default campaign — a DRAFT abandoned-cart campaign, email-only, created
  // through the same campaign API the CMS uses (docs/MESSAGING.md).
  const [have] = await query(
    "SELECT id FROM marketing_campaigns WHERE name = 'Abandoned cart reminder' AND trigger_event = 'cart.abandoned' LIMIT 1");
  if (!have) {
    const { marketingCampaignService } = await import('../src/modules/marketingCampaigns/service.js');
    const [brand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
    const c = await marketingCampaignService.create(brand.id, {
      name: 'Abandoned cart reminder', campaignType: 'ABANDONED_CART',
      channels: [{ channel: 'EMAIL', templateKey: KEY }],
      trigger: { key: 'cart.abandoned', config: { delayMinutes: 240, maxAgeHours: 168, cooldownHours: 168, minCartValueMinor: 0 } },
    }, null);
    out.campaign = `created "${c.id}" (DRAFT)`;
  } else {
    out.campaign = `already exists ("${have.id}")`;
  }

  console.log('\nAbandoned-cart starter kit\n');
  out.templates.forEach((t) => console.log(`  template  ${t}`));
  console.log(`  campaign  ${out.campaign}`);
  console.log('\nNext: review the copy in CMS → Messaging → Email Templates, then activate the');
  console.log('campaign in CMS → Messaging → Campaigns.\n');
} finally {
  await pool.end();
}
