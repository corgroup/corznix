// Seeds the CMS-side copy for the three marketing template families, wired to
// the EXACT Meta template names WhatsApp Manager has approved.
//
//   marketing.abandoned_cart   -> corcotton_abandoned_cart   (Meta: Active)
//   marketing.new_collection   -> corcotton_new_collection   (Meta: Active)
//   marketing.offer_campaign   -> corcotton_offer            (Meta: In review)
//
// Two rules this script keeps:
//
//   * A WhatsApp template row is seeded ACTIVE only when Meta has actually
//     approved the underlying template. `corcotton_offer` is still in review,
//     so its row is seeded DRAFT — nothing can send on it, and the campaign
//     readiness check says why rather than failing at the provider.
//   * Editing copy is the operator's job, so an existing ACTIVE row is never
//     overwritten. A changed body becomes a NEW version, which is how
//     communication_templates is versioned everywhere else.
//
//   npm run seed:marketing-templates
import { randomUUID } from 'node:crypto';
import { query, pool } from '../src/database/connection/pool.js';

const [brand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
if (!brand) {
  console.error('The corcotton brand does not exist — run npm run seed first.');
  process.exit(1);
}

// Variable schemas mirror what the services actually supply. A name here that
// the service never sets would render empty in a real customer's message.
const ABANDONED_CART_VARS = {
  itemCount: { required: true, type: 'number' },
  cartValue: { required: true, type: 'string' },
  firstItemName: { required: true, type: 'string' },
  couponLine: { type: 'string' },
  cartUrl: { required: true, type: 'string' },
  customerName: { required: true, type: 'string' },
  productImageUrl: { type: 'string' },
  productName: { required: true, type: 'string' },
  variantLabel: { type: 'string' },
  quantity: { required: true, type: 'number' },
  recoveryUrlSuffix: { required: true, type: 'string' },
};

const CAMPAIGN_VARS = {
  customerName: { required: true, type: 'string' },
  offerName: { type: 'string' },
  offerDetails: { type: 'string' },
  ctaLabel: { type: 'string' },
  ctaUrl: { type: 'string' },
  imageUrl: { type: 'string' },
  collectionName: { type: 'string' },
  collectionImageUrl: { type: 'string' },
  collectionSlug: { type: 'string' },
};

const TEMPLATES = [
  {
    key: 'marketing.abandoned_cart', channel: 'EMAIL', status: 'ACTIVE', ref: null,
    subject: 'Still thinking about it?',
    body: '<p>Hi {{customerName}},</p>'
      + '<p>You left <strong>{{itemCount}}</strong> item(s) in your CORCOTTON cart — '
      + "that's <strong>{{cartValue}}</strong> waiting for you.</p>"
      + '<p><img src="{{productImageUrl}}" alt="{{productName}}" width="260" '
      + 'style="max-width:100%;border-radius:8px;display:block" /></p>'
      + '<p><strong>{{productName}}</strong><br />{{variantLabel}}<br />Quantity: {{quantity}}</p>'
      + '<p>{{couponLine}}</p>'
      + '<p><a href="{{cartUrl}}">Return to your cart</a> to finish checking out.</p>'
      + '<p>— The CORCOTTON team</p>',
    vars: ABANDONED_CART_VARS,
  },
  {
    // Meta: corcotton_abandoned_cart is APPROVED, so this may be ACTIVE.
    key: 'marketing.abandoned_cart', channel: 'WHATSAPP', status: 'ACTIVE', ref: 'corcotton_abandoned_cart',
    subject: null,
    body: 'Hey {{customerName}}, your selected CORCOTTON pieces are still in your cart. '
      + "If you're ready, you can pick up right where you left off and complete your order.",
    vars: ABANDONED_CART_VARS,
  },
  {
    key: 'marketing.new_collection', channel: 'EMAIL', status: 'ACTIVE', ref: null,
    subject: '{{collectionName}} — the new collection is here',
    body: '<p>Hi {{customerName}},</p>'
      + '<p><img src="{{collectionImageUrl}}" alt="{{collectionName}}" width="520" '
      + 'style="max-width:100%;border-radius:8px;display:block" /></p>'
      + '<p><strong>{{collectionName}}</strong></p>'
      + '<p>Minimal design. Bold identity. Made to be worn with purpose.</p>'
      + '<p><a href="{{ctaUrl}}">{{ctaLabel}}</a></p>'
      + '<p>— The CORCOTTON team</p>',
    vars: CAMPAIGN_VARS,
  },
  {
    // Meta: corcotton_new_collection is APPROVED.
    key: 'marketing.new_collection', channel: 'WHATSAPP', status: 'ACTIVE', ref: 'corcotton_new_collection',
    subject: null,
    body: 'THE NEW COLLECTION IS HERE. Meet the latest from CORCOTTON. '
      + 'Minimal design. Bold identity. Made to be worn with purpose.',
    vars: CAMPAIGN_VARS,
  },
  {
    key: 'marketing.offer_campaign', channel: 'EMAIL', status: 'ACTIVE', ref: null,
    subject: '{{offerName}}',
    body: '<p>Hi {{customerName}},</p>'
      + '<p><img src="{{imageUrl}}" alt="{{offerName}}" width="520" '
      + 'style="max-width:100%;border-radius:8px;display:block" /></p>'
      + '<p><strong>{{offerName}}</strong></p>'
      + '<p>{{offerDetails}}</p>'
      + '<p><a href="{{ctaUrl}}">{{ctaLabel}}</a></p>'
      + '<p>— The CORCOTTON team</p>',
    vars: CAMPAIGN_VARS,
  },
  {
    // Meta: corcotton_offer is IN REVIEW. Seeded DRAFT on purpose — an ACTIVE
    // row here would let a campaign try to send on a template Meta has not
    // approved. Flip to ACTIVE only when WhatsApp Manager says Active.
    key: 'marketing.offer_campaign', channel: 'WHATSAPP', status: 'DRAFT', ref: 'corcotton_offer',
    subject: null,
    body: 'Hey {{customerName}}, here is something for you from CORCOTTON. '
      + '{{offerName}}. {{offerDetails}} Tap below to explore the offer.',
    vars: CAMPAIGN_VARS,
  },
];

let created = 0;
let skipped = 0;

for (const t of TEMPLATES) {
  // eslint-disable-next-line no-await-in-loop
  const [existing] = await query(
    `SELECT id, status, body_template, provider_template_ref FROM communication_templates
      WHERE brand_id = ? AND template_key = ? AND channel = ?
      ORDER BY version DESC LIMIT 1`,
    [brand.id, t.key, t.channel]);

  const unchanged = existing
    && existing.body_template === t.body
    && (existing.provider_template_ref || null) === t.ref
    && existing.status === t.status;
  if (unchanged) {
    skipped += 1;
    console.log(`  skip    ${t.key} / ${t.channel} (already current)`);
    continue;
  }

  // eslint-disable-next-line no-await-in-loop
  const [{ v }] = await query(
    'SELECT COALESCE(MAX(version), 0) AS v FROM communication_templates WHERE brand_id = ? AND template_key = ? AND channel = ?',
    [brand.id, t.key, t.channel]);
  const version = Number(v) + 1;

  // Only one version of a key/channel may be ACTIVE at a time.
  if (t.status === 'ACTIVE') {
    // eslint-disable-next-line no-await-in-loop
    await query(
      "UPDATE communication_templates SET status = 'ARCHIVED' WHERE brand_id = ? AND template_key = ? AND channel = ? AND status = 'ACTIVE'",
      [brand.id, t.key, t.channel]);
  }

  // eslint-disable-next-line no-await-in-loop
  await query(
    `INSERT INTO communication_templates
       (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref)
     VALUES (?,?,?,?,'MARKETING',?,?,?,?,CAST(? AS JSON),?)`,
    [randomUUID(), brand.id, t.key, t.channel, version, t.status, t.subject, t.body, JSON.stringify(t.vars), t.ref]);
  created += 1;
  console.log(`  v${version}      ${t.key} / ${t.channel} -> ${t.status}${t.ref ? ` (meta: ${t.ref})` : ''}`);
}

console.log(`\nMarketing templates: ${created} written, ${skipped} already current.`);
console.log('corcotton_offer stays DRAFT on WhatsApp until Meta approves it.');
await pool.end();
