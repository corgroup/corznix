// One place where every customer email becomes an actual email.
//
// Template bodies are HTML fragments ("<p>Hi …</p>"), and the SMTP adapter was
// handing them to nodemailer as `text`, so customers read the markup: "<p>Hi,
// </p><p>A refund of <strong>₹1.00</strong>…". Every transactional email was
// affected, not one.
//
// So the fragment is wrapped here — once, for all of them — into a branded
// HTML document, and a plain-text alternative is derived from the SAME
// fragment, so the two can never drift and a client that refuses HTML still
// gets a readable message.
//
// Constraints that shaped it: email clients support a small, old subset of
// CSS, ignore <style> often enough that everything visual is inlined, and
// render on phones where a fixed-width table is unreadable. No external CSS
// and no web fonts; the only image is the wordmark, which carries alt text so
// a blocked-images inbox still reads correctly.

const BRAND = 'CORCOTTON';
const INK = '#111111';
const MUTED = '#6b6b6b';
const LINE = '#e6e6e6';
const PAGE = '#f5f4f2';

const BLOCK_END = /<\/(p|div|h[1-6]|li|tr|table|ul|ol|blockquote)>/gi;

/** The plain-text alternative, derived from the same HTML the customer sees. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ')
    .replace(BLOCK_END, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map((line) => line.trim()).join('\n')
    .trim();
}

const looksLikeHtml = (body) => /<\/?[a-z][\s\S]*>/i.test(String(body || ''));

/** A plain-text body still has to become HTML, or the wrapper eats its line breaks. */
const paragraphs = (text) => String(text || '')
  .split(/\n{2,}/)
  .map((block) => `<p style="margin:0 0 16px;">${block.trim().replaceAll('\n', '<br>')}</p>`)
  .join('');

/**
 * @param {{ subject: string, body: string, supportEmail?: string|null }} message
 * @returns {{ html: string, text: string }}
 */
// `logoUrl` is resolved by the caller (brandLogo.js): it comes from the brand's
// own appearance record, so this stays a pure renderer. Null means the wordmark
// is set in type — correct for a host with no public image URL.
export function renderEmail({
  subject, body, supportEmail = null, logoUrl = null,
  classification = 'TRANSACTIONAL', unsubscribeUrl = null, preferencesUrl = null,
}) {
  const marketing = classification === 'MARKETING';
  if (marketing && !unsubscribeUrl) {
    // Never send marketing without a way out.
    throw Object.assign(new Error('A marketing email needs an unsubscribe link.'), { code: 'UNSUBSCRIBE_LINK_MISSING' });
  }
  // An optional picture a campaign did not supply renders as nothing, not as
  // a broken-image icon with its alt text (production, 2026-09-17).
  const fragment = (looksLikeHtml(body) ? String(body || '') : paragraphs(body))
    .replace(/<p>\s*<img\b[^>]*\bsrc=""[^>]*>\s*<\/p>/gi, '')
    .replace(/<img\b[^>]*\bsrc=""[^>]*>/gi, '');
  const year = new Date().getFullYear();
  const contact = supportEmail
    ? `<a href="mailto:${supportEmail}" style="color:${MUTED};">${supportEmail}</a>`
    : null;

  // Tables and inline styles on purpose: Outlook ignores most of the rest.
  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE};padding:24px 12px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#ffffff;border:1px solid ${LINE};border-radius:8px;">
<tr><td style="padding:24px 28px 8px;border-bottom:1px solid ${LINE};">
${logoUrl
    ? `<img src="${logoUrl}" alt="${BRAND}" width="150" height="21" style="display:block;border:0;outline:none;text-decoration:none;height:auto;width:150px;max-width:150px;">`
    : `<span style="font:700 20px/1.2 Helvetica,Arial,sans-serif;letter-spacing:.14em;color:${INK};">${BRAND}</span>`}
</td></tr>
<tr><td style="padding:24px 28px 8px;font:400 15px/1.6 Helvetica,Arial,sans-serif;color:${INK};">
${fragment}
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid ${LINE};font:400 12px/1.6 Helvetica,Arial,sans-serif;color:${MUTED};">
${marketing
    // A marketing email is not "about your order", and it must say how to
    // stop receiving it.
    ? `<p style="margin:0 0 6px;">You are receiving this as a registered ${BRAND} customer or subscriber. Offers and new collections are on by default — you can turn them off anytime.</p>
<p style="margin:0 0 6px;"><a href="${unsubscribeUrl}" style="color:${MUTED};">Unsubscribe</a>${preferencesUrl ? ` · <a href="${preferencesUrl}" style="color:${MUTED};">Manage preferences</a>` : ''}</p>
<p style="margin:0;">© ${year} ${BRAND}™.</p>`
    : `<p style="margin:0 0 6px;">Need help with this order? ${contact ? `Write to ${contact}.` : 'Reply to this email and our team will help.'}</p>
<p style="margin:0;">© ${year} ${BRAND}™. This is a transactional message about your order.</p>`}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  let footerText;
  if (marketing) {
    footerText = `You are receiving this as a registered ${BRAND} customer or subscriber. Offers and new collections are on by default — you can turn them off anytime.\nUnsubscribe: ${unsubscribeUrl}`
      + `${preferencesUrl ? `\nManage preferences: ${preferencesUrl}` : ''}\n© ${year} ${BRAND}.`;
  } else {
    footerText = `${contact
      ? `Need help with this order? Write to ${supportEmail}.`
      : 'Need help with this order? Reply to this email and our team will help.'}\n© ${year} ${BRAND}. This is a transactional message about your order.`;
  }
  const text = `${htmlToText(fragment)}\n\n—\n${BRAND}\n${footerText}`;

  return { html, text };
}
