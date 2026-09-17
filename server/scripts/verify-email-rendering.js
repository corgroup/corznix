// What the customer actually receives, for every transactional email.
//
// Every template body in this codebase is HTML, and the SMTP adapter handed it
// to nodemailer as `text` — so customers read the markup: "<p>Hi,</p><p>A
// refund of <strong>₹1.00</strong>…". It was not one broken email; it was all
// of them, and nothing looked at the rendered result.
//
// This renders EVERY starter template with sample variables through the REAL
// renderer and the REAL email layout, and asserts what lands in an inbox: an
// HTML part that carries the brand and the content, a plain-text alternative
// derived from the same body with no markup in it, no placeholder or internal
// value left behind, and a subject a person can read.
//
//   npm run verify:email-rendering
import assert from 'node:assert/strict';

const { TEMPLATE_DEFAULTS } = await import('../src/modules/notifications/templateDefaults.js');
const { NOTIFICATION_POLICIES } = await import('../src/modules/notifications/policies.js');
const { renderTemplate } = await import('../src/modules/communications/templateRenderer.js');
const { renderEmail, htmlToText } = await import('../src/modules/communications/emailLayout.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };

// A believable value per variable name, so the rendered text reads like a real
// message rather than "{{amount}}".
const SAMPLES = {
  orderNumber: 'COR-20260916-TEST0001', requestNumber: 'RMA-20260916-0001', customerName: 'Abhishek',
  amount: '₹1,199.00', refundAmount: '₹1,199.00', method: 'your original payment method',
  trackingNumber: '54729910000162', courierName: 'Delhivery', trackingUrl: 'https://www.corcotton.in/track-order',
  reason: 'you asked us to', itemsSummary: 'Oversized Cotton Tee (L) x1', deliveredAt: '16 Sept 2026',
  expectedDate: '19 Sept 2026', attemptReason: 'nobody was home', storeCreditBalance: '₹1,199.00',
};
const sampleFor = (schema) => Object.fromEntries(Object.keys(schema || {}).map((name) => [
  name, SAMPLES[name] ?? `Sample ${name}`,
]));

// The schema each template is rendered against is the policy's — that is the
// contract the sending code fills in.
const schemaByTemplateKey = new Map(
  Object.values(NOTIFICATION_POLICIES).map((p) => [p.templateKey, p.variableSchema || {}]),
);

const LEAKS = [/undefined/i, /\[object Object\]/, /\bnull\b/, /\{\{/, /NaN/];
const TAG = /<[a-z/][^>]*>/i;

try {
  const emailTemplates = Object.entries(TEMPLATE_DEFAULTS)
    .filter(([, variants]) => variants.EMAIL)
    .map(([key, variants]) => [key, variants.EMAIL]);
  assert.ok(emailTemplates.length >= 15, `found ${emailTemplates.length} email templates`);

  const checked = [];
  for (const [key, variant] of emailTemplates) {
    const schema = schemaByTemplateKey.get(key) || {};
    const variables = sampleFor(schema);
    const subject = renderTemplate(variant.subject, schema, variables, { channel: 'EMAIL' });
    const body = renderTemplate(variant.bodyTemplate, schema, variables, { channel: 'EMAIL' });
    const { html, text } = renderEmail({ subject, body, supportEmail: 'support@corcotton.in' });

    // Subject: readable, and nothing left unfilled.
    assert.ok(subject.trim().length > 5, `${key}: subject is too short`);
    assert.ok(!/\{\{/.test(subject), `${key}: subject still has a placeholder`);
    assert.ok(subject.length <= 120, `${key}: subject is too long for an inbox list`);

    // HTML part: a real document, branded, carrying the body.
    assert.ok(html.startsWith('<!doctype html>'), `${key}: no HTML document`);
    assert.ok(html.includes('CORCOTTON'), `${key}: the brand is missing`);
    assert.ok(html.includes('viewport'), `${key}: no viewport — unreadable on a phone`);
    assert.ok(html.includes('support@corcotton.in'), `${key}: no support contact in the footer`);

    // Plain-text alternative: derived from the same body, and free of markup.
    assert.ok(text.length > 30, `${key}: plain-text alternative is empty`);
    assert.ok(!TAG.test(text), `${key}: the plain-text alternative still contains markup`);
    assert.ok(text.includes('CORCOTTON'), `${key}: plain text is unbranded`);

    for (const leak of LEAKS) {
      assert.ok(!leak.test(text), `${key}: "${leak}" reached the customer's text`);
      assert.ok(!leak.test(subject), `${key}: "${leak}" reached the subject`);
    }
    checked.push(key);
  }
  pass('EVERY_EMAIL_TEMPLATE_RENDERS_FOR_A_HUMAN', `${checked.length} templates`);

  // The bug itself, frozen: a body of HTML must never be delivered as the text
  // part. If someone passes the fragment straight to `text` again, this fails.
  {
    const { html, text } = renderEmail({ subject: 'x', body: '<p>Hi,</p><p>A refund of <strong>₹1.00</strong> is on its way.</p>' });
    assert.ok(html.includes('<strong>₹1.00</strong>'), 'the HTML part keeps the markup');
    assert.equal(text.split('\n')[0], 'Hi,');
    assert.ok(text.includes('A refund of ₹1.00 is on its way.'), 'the text part reads as a sentence');
    assert.ok(!TAG.test(text), 'no markup survives into the text part');
    pass('HTML_BODY_IS_NEVER_SENT_AS_THE_TEXT_PART');
  }

  // Line breaks a human wrote must survive into HTML, or a plain-text template
  // arrives as one run-on paragraph.
  {
    const { html } = renderEmail({ subject: 'x', body: 'First line.\nSecond line.\n\nNew paragraph.' });
    assert.ok(html.includes('First line.<br>Second line.'), 'single newlines become line breaks');
    assert.ok(html.includes('<p style="margin:0 0 16px;">New paragraph.</p>'), 'blank lines become paragraphs');
    pass('PLAIN_TEXT_BODIES_ARE_NOT_RUN_TOGETHER');
  }

  // Entities decode, list markers survive, nested markup is stripped cleanly.
  {
    const text = htmlToText('<ul><li>One &amp; two</li><li>Three</li></ul><p>Tom&#39;s order &lt;3</p>');
    assert.equal(text, '• One & two\n\n• Three\n\nTom\'s order <3');
    pass('ENTITIES_AND_LISTS_READ_CORRECTLY_IN_TEXT');
  }

  // The wordmark. A PNG with alt text, never the site's SVG (Gmail and Outlook
  // drop SVG), and never an image the layout depends on to make sense.
  {
    const withLogo = renderEmail({ subject: 'x', body: '<p>Hi.</p>', logoUrl: 'https://www.corcotton.in/email-logo.png' });
    assert.ok(withLogo.html.includes('src="https://www.corcotton.in/email-logo.png"'), 'the logo is referenced');
    assert.ok(withLogo.html.includes('alt="CORCOTTON"'), 'blocked images still say who sent this');
    assert.ok(!/\.svg/i.test(withLogo.html), 'no SVG — most email clients drop it');
    assert.ok(withLogo.text.includes('CORCOTTON'), 'the text part is branded without any image');

    const noLogo = renderEmail({ subject: 'x', body: '<p>Hi.</p>', logoUrl: null });
    assert.ok(noLogo.html.includes('letter-spacing'), 'without a public URL the wordmark is set in type');
    pass('LOGO_IS_A_PNG_WITH_A_TEXT_FALLBACK');

    const logoFile = new URL('../../apps/corcotton/public/email-logo.png', import.meta.url);
    const fs = await import('node:fs');
    assert.ok(fs.existsSync(logoFile), 'the storefront actually serves /email-logo.png');
    assert.ok(fs.statSync(logoFile).size > 2000, 'the logo file is not a placeholder');
    pass('LOGO_IS_SERVED_BY_THE_STOREFRONT');

    // The logo the CMS sets wins, so changing it there changes the emails. An
    // SVG or a non-http value is refused rather than sent — Gmail and Outlook
    // drop SVG, and the mark would silently vanish.
    const { emailLogoUrl, resetEmailLogoCache, storefrontLogoUrl } = await import('../src/modules/communications/brandLogo.js');
    const { query } = await import('../src/database/connection/pool.js');
    const [brand] = await query("SELECT id, logo_media_id FROM brands WHERE slug = 'corcotton' LIMIT 1");
    assert.ok(brand, 'the corcotton brand exists');
    const [media] = await query("SELECT id, url FROM media WHERE status = 'ACTIVE' AND url LIKE 'http%' AND url NOT LIKE '%.svg' LIMIT 1");
    if (media) {
      await query('UPDATE brands SET logo_media_id = ? WHERE id = ?', [media.id, brand.id]);
      resetEmailLogoCache();
      assert.equal(await emailLogoUrl(), media.url, "the brand's own logo is used");
      await query('UPDATE brands SET logo_media_id = ? WHERE id = ?', [brand.logo_media_id, brand.id]);
    }
    resetEmailLogoCache();
    const fallback = await emailLogoUrl();
    assert.equal(fallback, storefrontLogoUrl(), 'with no brand logo it falls back to the committed wordmark');
    pass('BRAND_LOGO_FROM_THE_CMS_WINS', media ? 'brand logo + fallback' : 'fallback only (no media row)');
  }

  // The SMTP adapter must send both parts. Asserted on the source, because the
  // regression is exactly "someone passes body as text again".
  {
    const source = await import('node:fs').then((fs) => fs.readFileSync(
      new URL('../src/modules/communications/providers.js', import.meta.url), 'utf8'));
    assert.ok(source.includes('renderEmail({'), 'the SMTP adapter renders through the shared layout');
    assert.ok(!/text:\s*message\.body/.test(source), 'the SMTP adapter no longer sends the HTML body as text');
    pass('SMTP_ADAPTER_SENDS_BOTH_PARTS');
  }

  // Production 2026-09-17: marketing emails said "This is a transactional
  // message about your order", had no way to unsubscribe, and an offer with
  // no artwork showed a broken-image icon with its alt text.
  {
    const unsub = 'https://www.corcotton.in/unsubscribe?t=abc.def';
    const body = '<p>Hi,</p><p><img src="" alt="Festive Offer" width="520" /></p><p><strong>Festive Offer</strong></p><p><a href="https://www.corcotton.in">Shop Now</a></p>';
    const m = renderEmail({ subject: 'x', body, classification: 'MARKETING', unsubscribeUrl: unsub, preferencesUrl: 'https://www.corcotton.in/account/preferences' });
    assert.ok(!/transactional message/i.test(m.html) && !/transactional message/i.test(m.text), 'marketing email does not claim to be transactional');
    assert.ok(!/Need help with this order/i.test(m.html), 'marketing email is not "about this order"');
    assert.ok(m.html.includes(`href="${unsub}"`) && />Unsubscribe</.test(m.html), 'html footer links to unsubscribe');
    assert.ok(m.text.includes(`Unsubscribe: ${unsub}`), 'text part carries the unsubscribe link');
    assert.ok(!/<img[^>]*src=""/i.test(m.html) && !m.html.includes('alt="Festive Offer"'), 'an empty image is removed, not shown broken');
    assert.throws(() => renderEmail({ subject: 'x', body, classification: 'MARKETING' }), /unsubscribe link/, 'marketing without an unsubscribe link refuses to render');
    const t = renderEmail({ subject: 'x', body: '<p>Your order shipped.</p>' });
    assert.ok(/transactional message about your order/.test(t.html) && !/Unsubscribe/.test(t.html), 'transactional footer unchanged');
    const providers = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/modules/communications/providers.js', import.meta.url), 'utf8'));
    assert.ok(providers.includes("'List-Unsubscribe'"), 'SMTP adapter sets List-Unsubscribe on marketing mail');
    pass('MARKETING_EMAIL_HAS_UNSUBSCRIBE_AND_NO_BROKEN_IMAGE');
  }

  console.log('\nEmail rendering — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nEMAIL_RENDERING_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  // The brand-logo check opens the pool; without this the run hangs on an idle
  // connection after every assertion has already passed.
  const { pool } = await import('../src/database/connection/pool.js');
  await pool.end();
}
