// Wave 8G-7 — provider-neutral communication adapters.
//
// This mirrors the ADAPTER PATTERN of auth/otpProviders.js (AuthService never
// imports a vendor SDK — only an interface resolved by channel) WITHOUT
// importing or touching the OTP path. `send(message)` is generic: no
// event-specific methods, fixed sender identity, vendor request shape stays
// inside the adapter.
//
// WP-06 — real Email (SMTP) and WhatsApp (Infyntra) adapters, each gated by
// its own mode switch (COMMUNICATIONS_EMAIL_PROVIDER_MODE /
// COMMUNICATIONS_WHATSAPP_PROVIDER_MODE, both default MOCK — see env.js for
// the boot-time "never deceptively real" guard). They reuse the SAME account
// credentials as auth/otpProviders.js's real adapters (SMTP_*/INFYNTRA_*) but
// are entirely separate code: this module still never imports modules/auth/,
// and auth's OTP path is unaffected by anything here.
//
// REAL_MARKETING_SENDS stays governed by consent (isMarketable, re-checked
// immediately before send) — these adapters do not change that gate; they
// only change what happens once a send is actually due.

import nodemailer from 'nodemailer';
import { env, smtpAccount, storefrontBaseUrl } from '../../config/index.js';
import { unsubscribeToken, unsubscribeUrl } from '../consent/unsubscribe.js';
import { logger } from '../../utils/logger.js';
import { renderEmail } from './emailLayout.js';
import { emailLogoUrl } from './brandLogo.js';

const log = logger('communications-providers');

export class CommunicationProvider {
  get code() { return 'BASE'; }

  // eslint-disable-next-line no-unused-vars
  async send(message) { throw new Error('CommunicationProvider.send must be implemented'); }

  /** Verify + parse a raw provider webhook into a normalized delivery event. */
  // eslint-disable-next-line no-unused-vars
  normalizeWebhook(rawEvent) { throw new Error('CommunicationProvider.normalizeWebhook must be implemented'); }
}

const NORMALIZED_STATUS = new Set(['SENT', 'DELIVERED', 'FAILED']);

class MockProvider extends CommunicationProvider {
  #code;

  constructor(code) { super(); this.#code = code; }

  get code() { return this.#code; }

  async send(message) {
    // A deliberate hook for the ambiguous-send test: a message whose rendered
    // body carries the marker returns an ambiguous result (request may have
    // been accepted) instead of throwing.
    if (typeof message.body === 'string' && message.body.includes('__FORCE_TIMEOUT__')) {
      return { outcome: 'AMBIGUOUS', providerMessageId: null };
    }
    if (typeof message.body === 'string' && message.body.includes('__FORCE_FAIL__')) {
      return { outcome: 'FAILED', retryable: true, error: 'MOCK_TRANSIENT' };
    }
    // Accepted != delivered. Delivery only ever arrives via a webhook (§136).
    return { outcome: 'ACCEPTED', providerMessageId: `mock-${this.#code}-${Math.random().toString(36).slice(2, 12)}` };
  }

  normalizeWebhook(rawEvent) {
    // Do not trust arbitrary payload fields — read only the keys we expect.
    const status = String(rawEvent?.status || '').toUpperCase();
    if (!NORMALIZED_STATUS.has(status)) return null;
    return {
      providerCode: this.#code,
      providerMessageId: rawEvent?.messageId ?? null,
      providerEventKey: String(rawEvent?.eventId || rawEvent?.messageId || ''),
      normalizedStatus: status,
      occurredAt: rawEvent?.occurredAt ? new Date(rawEvent.occurredAt) : new Date(),
    };
  }
}

// ---------------------------------------------------------------------------
// Real Email — SMTP via nodemailer. A cached transporter, exactly like
// auth/otpProviders.js's, but a SEPARATE instance/cache: this module does not
// import that one.
// ---------------------------------------------------------------------------
// Which mailbox a transactional email is sent FROM, decided by the template
// family rather than one hardcoded account:
//
//   support.*   -> support@   (a reply the customer should reply back to)
//   marketing.* -> marketing@ (abandoned cart, new collection, newsletter)
//   everything  -> orders@    (order, payment, shipping, delivery, refund)
//
// Marketing is deliberately its own mailbox and its own reputation: a customer
// who marks a promotion as spam must not be able to take order confirmations
// down with it, and a marketing domain block must not silence transactional
// mail. Nothing about the order/support senders changes.
//
// Auth OTP is a separate path entirely (auth/otpProviders.js, purpose 'otp',
// noreply@) and is untouched here.
//
// Each purpose falls back to the plain SMTP_* account when it has no dedicated
// credentials, so an environment with only one mailbox configured keeps
// sending instead of silently failing.
export function senderPurposeFor(templateKey) {
  const key = String(templateKey || '');
  if (key.startsWith('support.')) return 'support';
  if (key.startsWith('marketing.')) return 'marketing';
  return 'order';
}

// One transporter per purpose — these may be different mailboxes with
// different credentials, so they cannot share a connection pool.
const transporters = new Map();
function getSmtpTransporter(purpose) {
  if (!transporters.has(purpose)) {
    const acct = smtpAccount(purpose);
    transporters.set(purpose, nodemailer.createTransport({
      host: acct.host,
      port: acct.port,
      secure: acct.secure,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: acct.user ? { user: acct.user, pass: acct.password } : undefined,
    }));
  }
  return transporters.get(purpose);
}

class RealSmtpEmailProvider extends CommunicationProvider {
  get code() { return 'SMTP_EMAIL'; }

  async send(message) {
    const purpose = senderPurposeFor(message.templateKey);
    const acct = smtpAccount(purpose);
    const fromAddress = acct.from;
    if (!(acct.host && fromAddress)) {
      return { outcome: 'FAILED', retryable: false, error: 'PROVIDER_NOT_CONFIGURED' };
    }
    if (!message.to) return { outcome: 'FAILED', retryable: false, error: 'RECIPIENT_MISSING' };
    const marketing = message.classification === 'MARKETING';
    // Marketing mail always names its unsubscribe page. RFC 8058 one-click
    // (a POST the mail client makes itself) needs the API's public address,
    // which only exists when PUBLIC_API_BASE_URL is configured.
    let listUnsubscribe = null;
    if (marketing) {
      const token = encodeURIComponent(unsubscribeToken('EMAIL', message.to));
      listUnsubscribe = env.PUBLIC_API_BASE_URL
        ? { 'List-Unsubscribe': `<${env.PUBLIC_API_BASE_URL}/api/v1/consent/unsubscribe/one-click?t=${token}>, <${unsubscribeUrl('EMAIL', message.to)}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
        : { 'List-Unsubscribe': `<${unsubscribeUrl('EMAIL', message.to)}>` };
    }

    try {
      const info = await getSmtpTransporter(purpose).sendMail({
        ...(listUnsubscribe ? { headers: listUnsubscribe } : {}),
        from: fromAddress,
        to: message.to,
        // A support reply must be repliable — send it back to the support
        // mailbox, not to a noreply the customer's answer would vanish into.
        ...(purpose === 'support' ? { replyTo: acct.from } : {}),
        subject: message.subject || '(no subject)',
        // Template bodies are HTML. Sent as `text`, as they were, the customer
        // read the markup itself — "<p>Hi,</p><p>A refund of <strong>…".
        // Both alternatives come from the one body, so they cannot drift.
        ...renderEmail({
          subject: message.subject || '(no subject)',
          body: message.body || '',
          supportEmail: smtpAccount('support').from || null,
          classification: message.classification || 'TRANSACTIONAL',
          unsubscribeUrl: marketing ? unsubscribeUrl('EMAIL', message.to) : null,
          preferencesUrl: marketing ? `${storefrontBaseUrl}/account/preferences` : null,
          // The brand's own logo, as set in the CMS — changing it there changes
          // the emails, with nothing to redeploy.
          logoUrl: await emailLogoUrl(),
        }),
      });
      log.info('smtp_send_accepted', { purpose, from: fromAddress, messageIdPresent: Boolean(info?.messageId) });
      return { outcome: 'ACCEPTED', providerMessageId: info?.messageId || null };
    } catch (error) {
      // A raw SMTP DATA-phase timeout genuinely can mean "the relay may have
      // queued it anyway" — but nodemailer does not expose enough state to
      // tell that apart from an ordinary connection failure, so (unlike the
      // WhatsApp adapter below) this stays FAILED rather than AMBIGUOUS; a
      // duplicate retried email is a far smaller harm than an unbounded
      // UNKNOWN queue for a transport with no delivery webhook to reconcile
      // it later. Not a claim it can never double-send — a documented
      // trade-off, not an assumption of correctness.
      const retryable = ['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'ECONNRESET'].includes(error?.code);
      log.warn('smtp_send_failed', { code: error?.code || 'UNKNOWN' });
      return { outcome: 'FAILED', retryable, error: error?.code || 'SEND_ERROR' };
    }
  }

  normalizeWebhook() {
    // No bounce/DSN/delivery webhook is wired for raw SMTP in this deployment
    // (GAP-COM-07 in the Master Production Readiness Audit). A message sent
    // through this provider can reach SENT, never programmatically DELIVERED,
    // until that infrastructure — or a transactional-email-API provider with
    // its own webhook — exists. Returning null here (rather than fabricating
    // a contract) is the honest behaviour.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Real WhatsApp — Infyntra's Meta-Cloud-API-style endpoint. Duplicated (not
// imported) from auth/otpProviders.js's national-10-digit destination
// formatting — same account-level provider quirk, kept local to this
// adapter on purpose (§ header note above).
// ---------------------------------------------------------------------------
function formatInfyntraDestination(destination) {
  const canonical = String(destination || '').trim();
  const match = /^\+91([0-9]{10})$/.exec(canonical);
  if (!match) throw new Error('RECIPIENT_INVALID');
  if (env.PROVIDER_PHONE_FORMAT === '10_DIGITS_NO_COUNTRY_CODE') return match[1];
  if (env.PROVIDER_PHONE_FORMAT === '91_PLUS_10_DIGITS') return `91${match[1]}`;
  throw new Error('PROVIDER_PHONE_FORMAT_UNSUPPORTED');
}

/**
 * The approved Meta template contract, by template name.
 *
 * `{{1}}, {{2}}, …` are POSITIONAL. Previously the parameters were built from
 * `Object.values(variables)` — i.e. whatever order the policy happened to
 * insert its keys in. Nothing enforced that, so a policy reordering its own
 * object would silently put the AWB where the customer's name belongs and
 * send it to a real person. Position is now declared here, once, against the
 * approved template rather than inferred from the caller.
 *
 * `body` lists variable names in exact `{{n}}` order. `header` does the same
 * for templates whose HEADER carries its own separate `{{1}}`.
 *
 * Every entry below is transcribed from the approved Meta templates. Do not
 * add a template here without its approved variable order — an unlisted
 * template falls back to insertion order and logs a warning.
 */
export const META_TEMPLATE_CONTRACT = Object.freeze({
  order_management:        { lang: 'en_US', body: ['customerName', 'purchaseWording', 'orderNumber', 'itemsSummary', 'expectedDate'] },
  order_processing:        { lang: 'en',    body: ['customerName', 'orderNumber'] },
  order_ready_for_shipment:{ lang: 'en',    body: ['customerName', 'orderNumber'] },
  payment_successful:      { lang: 'en_US', body: ['customerName', 'paymentReference', 'amount', 'paymentDate'] },
  shipment_confirmation_1: { lang: 'en_US', body: ['customerName', 'awb', 'estimatedDelivery'] },
  // Approved wording: 'there is a {{2}} in {{3}} your order {{4}}'. {{3}} sits
  // inside 'in ___ your order', so it MUST be a gerund ('delivering',
  // 'shipping') — a status name like 'in transit' renders 'in in transit your
  // order'. Verified against a real send.
  order_delay:             { lang: 'en_US', body: ['customerName', 'issueType', 'affectedStage', 'orderNumber'] },
  // NOT an NDR template. Approved wording is 'before we can process your
  // order {{2}}, we need to verify some information' — a pre-processing
  // verification hold. A failed delivery uses delivery_failed; telling an NDR
  // customer we need to verify details before processing is simply wrong.
  order_action_required:   { lang: 'en_US', body: ['customerName', 'orderNumber'] },
  delivery_failed:         { lang: 'en_US', body: ['customerName', 'attemptDate', 'supportNumber'] },
  delivery_confirmation:   { lang: 'en_US', body: ['customerName', 'orderNumber'] },
  order_canceled:          { lang: 'en_US', body: ['customerName', 'orderNumber'] },
  return_confirmation:     { lang: 'en_US', body: ['orderNumber', 'resolutionType', 'amount'] },
  // Header carries the refund amount as its own {{1}}, separate from the body.
  refund_confirmation:     { lang: 'en_US', header: ['refundAmount'], body: ['customerName', 'refundAmount', 'orderNumber'] },
  order_pick_up:           { lang: 'en_US', body: ['customerName', 'orderNumber', 'pickupAddress'] },
  track_order:             { lang: 'en_US', body: ['customerName', 'orderNumber', 'deliveryWindow'] },

  // ---- MARKETING (approved 2026-09-16, WABA 1597095515147826) --------------
  // Both carry an IMAGE header whose media is supplied per send, and a URL
  // button whose suffix is supplied per send, so one approved template serves
  // every collection and every abandoned cart. Nothing here is per-campaign;
  // a new collection never needs a new template.
  //
  // corcotton_abandoned_cart — header image is the product the customer left
  // in THEIR cart; the button suffix is that customer's own recovery token.
  corcotton_abandoned_cart: {
    lang: 'en',
    headerImage: 'productImageUrl',
    body: ['customerName'],
    buttons: [{ subType: 'url', index: '0', param: 'recoveryUrlSuffix' }],
  },
  // corcotton_new_collection — header image is the campaign's selected
  // collection image; the button suffix is that collection's slug.
  corcotton_new_collection: {
    lang: 'en',
    headerImage: 'collectionImageUrl',
    body: [],
    buttons: [{ subType: 'url', index: '0', param: 'collectionSlug' }],
  },
  // corcotton_offer — header image is the campaign's own offer artwork.
  //
  // Its button is a STATIC url for now: Meta's create-template form would not
  // render the sample-URL field a dynamic button needs, and shipping an
  // unapproved or half-configured template is not an option. The button
  // therefore lands on the collections index until the template is edited to a
  // dynamic URL after approval (the EDIT form does render that field — it is
  // how corcotton_new_collection got its dynamic link). Until then there is
  // deliberately no `buttons` entry here, so nothing tries to send a button
  // parameter the approved template has no slot for.
  //
  // `pendingApproval` is load-bearing, not documentation: this template was
  // submitted to Meta on 2026-09-16 and is still In review. Its variable
  // contract is declared here so the mapping is ready, but a campaign must
  // NOT be allowed to launch on it — pending is not approved. Remove this
  // flag only when WhatsApp Manager shows the template Active.
  corcotton_offer: {
    lang: 'en',
    pendingApproval: true,
    headerImage: 'imageUrl',
    body: ['customerName', 'offerName', 'offerDetails'],
  },
});

/** Ordered `{type:'text'}` parameters for one component. */
function orderedParameters(names, variables, templateRef, component) {
  return names.map((name) => {
    const value = variables?.[name];
    if (value === undefined || value === null || value === '') {
      // A blank positional parameter shifts nothing — Meta still fills the
      // slot — but it renders an empty gap to the customer, so make it
      // visible rather than silently shipping a broken message.
      log.warn('whatsapp_template_variable_missing', { templateRef, component, name });
    }
    return { type: 'text', text: String(value ?? '') };
  });
}

/**
 * WhatsApp Business Cloud API template-message shape. Free-form text is
 * deliberately never sent here — see PROVIDER_TEMPLATE_REQUIRED below.
 */
function buildInfyntraTemplateRequest({ to, templateRef, variables }) {
  const baseUrl = String(env.INFYNTRA_API_BASE_URL || '').replace(/\/+$/, '');
  const apiBaseUrl = /\/api$/i.test(baseUrl) ? baseUrl : `${baseUrl}/api`;
  const phoneId = String(env.INFYNTRA_PHONE_ID || '').replace(/\D/g, '');
  const contract = META_TEMPLATE_CONTRACT[templateRef];
  if (!contract) {
    // Unlisted template: fall back to insertion order so an operator-created
    // template still sends, but say so loudly — this is the fragile path.
    log.warn('whatsapp_template_contract_missing', { templateRef });
  }
  const bodyParams = contract
    ? orderedParameters(contract.body, variables, templateRef, 'body')
    : Object.values(variables || {}).map((value) => ({ type: 'text', text: String(value ?? '') }));
  const headerParams = contract?.header
    ? orderedParameters(contract.header, variables, templateRef, 'header')
    : [];
  const components = [];
  // A media header carries a link, not text. The link is resolved per send
  // from THIS recipient's own data (their cart's product, the campaign's
  // collection) — never a constant — so the guard below refuses to send a
  // media template with no media rather than deliver a broken image card.
  if (contract?.headerImage) {
    const link = variables?.[contract.headerImage];
    if (!link || !/^https:\/\//i.test(String(link))) {
      throw new Error(`WHATSAPP_HEADER_MEDIA_MISSING:${templateRef}:${contract.headerImage}`);
    }
    components.push({ type: 'header', parameters: [{ type: 'image', image: { link: String(link) } }] });
  } else if (headerParams.length) {
    components.push({ type: 'header', parameters: headerParams });
  }
  if (bodyParams.length) components.push({ type: 'body', parameters: bodyParams });
  // A dynamic URL button sends only the SUFFIX Meta appends to the approved
  // base URL. An empty suffix would land the customer on the bare base URL,
  // which for a cart-recovery link means someone else's empty cart page — so
  // that is a refusal too, not a silently degraded send.
  for (const btn of contract?.buttons || []) {
    const value = variables?.[btn.param];
    if (value === undefined || value === null || value === '') {
      throw new Error(`WHATSAPP_BUTTON_PARAM_MISSING:${templateRef}:${btn.param}`);
    }
    components.push({
      type: 'button',
      sub_type: btn.subType || 'url',
      index: String(btn.index ?? '0'),
      parameters: [{ type: 'text', text: String(value) }],
    });
  }
  return {
    url: `${apiBaseUrl}/${phoneId}/send_messages`,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateRef,
        // All approved CORCOTTON templates are English (US). The env var keeps
      // a single point of change; 'en_US' is the documented default rather
      // than a bare 'en', which is a DIFFERENT Meta language and would be
      // rejected as template-not-found.
      // Language is per TEMPLATE, verified against Meta rather than assumed:
      // the account carries some approved as 'en' and some as 'en_US', and a
      // mismatch is rejected with #132001 template-does-not-exist. A template
      // with no declared language falls back to the configured default.
      language: { code: contract?.lang || env.INFYNTRA_TEMPLATE_LANGUAGE || env.INFYNTRA_OTP_TEMPLATE_LANGUAGE || 'en_US' },
        components,
      },
    },
  };
}

function classifyProviderNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^[0-9]{10}$/.test(digits)) return '10_DIGIT';
  if (/^91[0-9]{10}$/.test(digits)) return '91_PLUS_10_DIGIT';
  return 'OTHER';
}

class RealInfyntraWhatsAppProvider extends CommunicationProvider {
  get code() { return 'INFYNTRA_WHATSAPP'; }

  async send(message) {
    const configured = env.INFYNTRA_API_BASE_URL && env.INFYNTRA_API_KEY && env.INFYNTRA_PHONE_ID;
    if (!configured) return { outcome: 'FAILED', retryable: false, error: 'PROVIDER_NOT_CONFIGURED' };

    // WhatsApp Business API rejects free-form text outside a customer-
    // initiated 24h session window, and CORCOTTON has no session-window
    // signal to know if it is inside one. Every send through this adapter
    // therefore requires an APPROVED provider_template_ref
    // (communication_templates.provider_template_ref) — never the raw
    // rendered body. A template-less message is a permanent configuration
    // problem, not a transient one: retryable=false.
    if (!message.providerTemplateRef) {
      return { outcome: 'FAILED', retryable: false, error: 'PROVIDER_TEMPLATE_REQUIRED' };
    }

    let to;
    try {
      to = formatInfyntraDestination(message.to);
    } catch {
      return { outcome: 'FAILED', retryable: false, error: 'RECIPIENT_INVALID' };
    }

    let url;
    let body;
    try {
      ({ url, body } = buildInfyntraTemplateRequest({ to, templateRef: message.providerTemplateRef, variables: message.variables }));
    } catch (error) {
      // Missing header media / button suffix. Sending anyway would put a broken
      // image or a stranger's landing page in front of a customer, so this
      // fails loudly and permanently instead: the data the send depends on was
      // not there, and retrying the same message cannot change that.
      const code = String(error?.message || 'WHATSAPP_TEMPLATE_BUILD_FAILED').split(':')[0];
      log.warn('whatsapp_template_build_failed', { templateRef: message.providerTemplateRef, reason: error?.message });
      return { outcome: 'FAILED', retryable: false, error: code };
    }
    let response;
    let responseBody;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { apikey: env.INFYNTRA_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      responseBody = await response.json().catch(() => null);
    } catch {
      // Network error / timeout mid-flight — the request may have reached
      // the provider. Unlike the SMTP adapter, a duplicate WhatsApp message
      // is directly customer-visible, so this parks at UNKNOWN via the
      // engine's existing AMBIGUOUS handling rather than risking a blind
      // resend (§137 of the communications migration notes).
      log.warn('infyntra_send_ambiguous', { templateRef: message.providerTemplateRef, outboundFormat: classifyProviderNumber(to) });
      return { outcome: 'AMBIGUOUS', providerMessageId: null };
    }
    if (!response.ok) {
      const retryable = response.status >= 500 || response.status === 429;
      log.warn('infyntra_send_rejected', { status: response.status, templateRef: message.providerTemplateRef, outboundFormat: classifyProviderNumber(to) });
      return { outcome: 'FAILED', retryable, error: `HTTP_${response.status}` };
    }
    const messageId = responseBody?.messages?.[0]?.id;
    if (typeof messageId !== 'string' || !messageId) {
      log.warn('infyntra_send_invalid_response', { templateRef: message.providerTemplateRef, outboundFormat: classifyProviderNumber(to) });
      return { outcome: 'FAILED', retryable: false, error: 'PROVIDER_RESPONSE_INVALID' };
    }
    log.info('infyntra_send_accepted', { templateRef: message.providerTemplateRef, outboundFormat: classifyProviderNumber(to) });
    return { outcome: 'ACCEPTED', providerMessageId: messageId };
  }

  normalizeWebhook() {
    // No Infyntra delivery-status webhook contract is documented or available
    // to this implementation (the supplied Delhivery-focused material has no
    // bearing on Infyntra; nothing else was supplied). Same class of gap as
    // the SMTP adapter above — SENT is reachable, DELIVERED is not, until
    // that contract is obtained.
    return null;
  }
}

const MOCK_EMAIL = new MockProvider('MOCK_EMAIL');
const MOCK_WHATSAPP = new MockProvider('MOCK_WHATSAPP');
const REAL_EMAIL = new RealSmtpEmailProvider();
const REAL_WHATSAPP = new RealInfyntraWhatsAppProvider();

const BY_CODE = new Map([
  [MOCK_EMAIL.code, MOCK_EMAIL],
  [MOCK_WHATSAPP.code, MOCK_WHATSAPP],
  [REAL_EMAIL.code, REAL_EMAIL],
  [REAL_WHATSAPP.code, REAL_WHATSAPP],
]);

/**
 * Channel -> the provider that owns first send for that channel. Real
 * providers are opt-in per channel via COMMUNICATIONS_EMAIL_PROVIDER_MODE /
 * COMMUNICATIONS_WHATSAPP_PROVIDER_MODE (both default MOCK — REAL_MARKETING_
 * SENDS stays 0 until a deployment explicitly turns each one on and passes
 * the boot-time credential guard in env.js).
 */
export function providerForChannel(channel) {
  if (channel === 'WHATSAPP') return env.COMMUNICATIONS_WHATSAPP_PROVIDER_MODE === 'REAL' ? REAL_WHATSAPP : MOCK_WHATSAPP;
  return env.COMMUNICATIONS_EMAIL_PROVIDER_MODE === 'REAL' ? REAL_EMAIL : MOCK_EMAIL;
}

export function providerByCode(code) {
  return BY_CODE.get(code) || null;
}
