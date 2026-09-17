// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/providers/otp/index.js (Wave 5). Logic
// unchanged (this wave's security review found it sound: real WhatsApp
// Business Cloud-API-style request, real SMTP delivery, provider errors
// never surfaced to callers, mock delivery hard-gated off in production
// regardless of OTP_PROVIDER_MODE).
//
// ARCHITECTURE NOTE (migration brief §24/§25): kept inside
// modules/auth/ rather than mirrored under server/src/platform/ the way
// Media Abstraction is. Media genuinely has interchangeable storage
// backends (S3 vs Cloudinary serve an identical "store this file, get a
// URL" contract); WhatsApp and Email are not interchangeable with each
// other the way two storage providers are — they're business channels a
// customer explicitly chooses (identifier shape selects the channel, see
// features/search... err, features/auth/services on the frontend). What
// this file DOES still guarantee is the abstraction the brief actually
// asks for: `AuthService` never imports Infyntra/nodemailer/SMTP
// directly — only the `OtpProvider` interface below, resolved by channel.
import nodemailer from 'nodemailer';
import { env, isMockOtpProviderEnabled, smtpAccount } from '../../config/index.js';
import { renderEmail } from '../communications/emailLayout.js';
import { emailLogoUrl } from '../communications/brandLogo.js';

// Auth OTP e-mail uses the dedicated OTP account (SMTP_*_OTP, falling back to
// the plain SMTP_* vars).
let cachedTransporter = null;
function getSmtpTransporter() {
  if (!cachedTransporter) {
    const acct = smtpAccount('otp');
    cachedTransporter = nodemailer.createTransport({
      host: acct.host,
      port: acct.port,
      secure: acct.secure,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: acct.user ? { user: acct.user, pass: acct.password } : undefined,
    });
  }
  return cachedTransporter;
}

export class OtpProvider {
  // eslint-disable-next-line no-unused-vars
  async send({ destination, otp, purpose, expiresInSeconds }) {
    throw new Error('OtpProvider.send must be implemented');
  }
}

// DEV/TEST delivery only — logs the OTP to the server console instead of
// sending it anywhere real. Hard-refuses in production regardless of
// OTP_PROVIDER_MODE (migration brief §100: "never enable it in
// production" must not depend on a single runtime flag being set
// correctly).
export class MockOtpProvider extends OtpProvider {
  async send({ destination, otp, purpose, expiresInSeconds }) {
    if (env.NODE_ENV === 'production') {
      throw new Error('MOCK_OTP_PROVIDER_DISABLED_IN_PRODUCTION');
    }
    // eslint-disable-next-line no-console
    console.log(`[DEV OTP] destination=${destination} purpose=${purpose} otp=${otp} expiresInSeconds=${expiresInSeconds}`);
    return { ok: true, provider: 'MOCK' };
  }
}

// Infyntra's WhatsApp Business Cloud-API-style endpoint. Provider-specific URL,
// authentication, payload and recipient mapping stay entirely inside this
// adapter.
//
// WhatsApp Business rejects a free-form `type: 'text'` message to a user who
// has not messaged the business first (outside the 24h session window), which
// is always the case for a login OTP. The OTP MUST go out as an APPROVED
// template — INFYNTRA_OTP_TEMPLATE (an "authentication"-category template
// whose body has one {{1}} = the code, and a copy-code URL button). This
// mirrors modules/communications/providers.js's buildInfyntraTemplateRequest.
export function buildInfyntraRequest({ destination, otp }) {
  const baseUrl = String(env.INFYNTRA_API_BASE_URL || '').replace(/\/+$/, '');
  const apiBaseUrl = /\/api$/i.test(baseUrl) ? baseUrl : `${baseUrl}/api`;
  const phoneId = String(env.INFYNTRA_PHONE_ID || '').replace(/\D/g, '');
  const toNumber = formatInfyntraDestination(destination);
  const templateName = String(env.INFYNTRA_OTP_TEMPLATE || '').trim();
  if (!templateName) throw new Error('PROVIDER_OTP_TEMPLATE_NOT_CONFIGURED');
  return {
    url: `${apiBaseUrl}/${phoneId}/send_messages`,
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: toNumber,
      type: 'template',
      template: {
        name: templateName,
        language: { code: env.INFYNTRA_OTP_TEMPLATE_LANGUAGE || 'en' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: String(otp) }] },
          // Meta authentication templates carry a copy-code URL button; its
          // one parameter is the code. Harmless if the template has no button
          // (providers ignore an unreferenced component) — required if it does.
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: String(otp) }] },
        ],
      },
    },
  };
}

// Infyntra's current India-only panel accepts the national ten-digit mobile
// number, while the rest of CORCOTTON intentionally stores E.164 (+91...).
// Keep this provider quirk here; never weaken the application's canonical
// phone normalization or silently truncate an arbitrary international number.
export function formatInfyntraDestination(destination) {
  const canonical = String(destination || '').trim();
  const match = /^\+91([0-9]{10})$/.exec(canonical);
  if (!match) throw new Error('PROVIDER_DESTINATION_INVALID');
  if (env.PROVIDER_PHONE_FORMAT === '10_DIGITS_NO_COUNTRY_CODE') return match[1];
  if (env.PROVIDER_PHONE_FORMAT === '91_PLUS_10_DIGITS') return `91${match[1]}`;
  throw new Error('PROVIDER_PHONE_FORMAT_UNSUPPORTED');
}

function classifyProviderNumber(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^[0-9]{10}$/.test(digits)) return '10_DIGIT';
  if (/^91[0-9]{10}$/.test(digits)) return '91_PLUS_10_DIGIT';
  return 'OTHER';
}

export class InfyntraWhatsAppProvider extends OtpProvider {
  async send({ destination, otp, purpose, expiresInSeconds }) {
    const configured = env.INFYNTRA_API_BASE_URL && env.INFYNTRA_API_KEY && env.INFYNTRA_PHONE_ID;
    if (isMockOtpProviderEnabled()) {
      return new MockOtpProvider().send({ destination, otp, purpose, expiresInSeconds });
    }
    if (!configured) {
      throw new Error('PROVIDER_NOT_CONFIGURED');
    }
    if (!env.INFYNTRA_OTP_TEMPLATE) {
      // A login OTP cannot be delivered as free-form text — WhatsApp requires
      // an approved authentication template. This is a permanent config gap.
      throw new Error('PROVIDER_OTP_TEMPLATE_NOT_CONFIGURED');
    }

    const { url, body } = buildInfyntraRequest({ destination, otp });
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
      // eslint-disable-next-line no-console
      console.warn(`[infyntra] status=NETWORK_ERROR outboundFormat=${classifyProviderNumber(body.to)} maskedTo=********${body.to.slice(-4)} messageId=ABSENT category=NETWORK`);
      // Diagnostic travels with the error so the audit row can record WHY.
      // Without this an operator sees only "PROVIDER_UNAVAILABLE" and cannot
      // tell an expired API key from the provider being down without shell
      // access to the server's console.
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), { providerCategory: 'NETWORK' });
    }
    if (!response.ok) {
      // The raw body may carry account/billing detail — surface only the
      // provider's own error code + message (API semantics, safe to log) so an
      // operator can tell a bad template name from an expired key from a
      // number-not-on-WhatsApp. Never surface it to the caller.
      const provErr = responseBody?.error || responseBody?.errors?.[0] || {};
      // eslint-disable-next-line no-console
      console.warn(`[infyntra] status=${response.status} template=${env.INFYNTRA_OTP_TEMPLATE} outboundFormat=${classifyProviderNumber(body.to)} maskedTo=********${body.to.slice(-4)} providerCode=${provErr.code ?? provErr.error_code ?? 'NONE'} providerMessage=${String(provErr.message ?? provErr.error ?? '').slice(0, 160)} category=HTTP_REJECTED`);
      // Same detail the console gets — the provider's own status and error
      // code, which are API semantics rather than anything secret — carried on
      // the error so it reaches the audit row. A 401 here means the API key is
      // rejected; without recording it, that is indistinguishable from an
      // outage in everything an operator can actually see.
      throw Object.assign(new Error('PROVIDER_UNAVAILABLE'), {
        providerCategory: 'HTTP_REJECTED',
        providerStatus: response.status,
        providerCode: provErr.code ?? provErr.error_code ?? null,
        providerMessage: String(provErr.message ?? provErr.error ?? '').slice(0, 160) || null,
      });
    }
    const messageIdPresent = typeof responseBody?.messages?.[0]?.id === 'string' && responseBody.messages[0].id.length > 0;
    if (!messageIdPresent) {
      // eslint-disable-next-line no-console
      console.warn(`[infyntra] status=${response.status} outboundFormat=${classifyProviderNumber(body.to)} maskedTo=********${body.to.slice(-4)} messageId=ABSENT category=INVALID_RESPONSE`);
      throw new Error('PROVIDER_RESPONSE_INVALID');
    }

    // Safe runtime evidence: format classes and presence flags only. Never
    // emit the OTP, API key, message id, or complete recipient values.
    // eslint-disable-next-line no-console
    console.log(`[infyntra] status=${response.status} outboundFormat=${classifyProviderNumber(body.to)} maskedTo=********${body.to.slice(-4)} messageId=PRESENT contactInputFormat=${classifyProviderNumber(responseBody?.contacts?.[0]?.input)} waIdFormat=${classifyProviderNumber(responseBody?.contacts?.[0]?.wa_id)}`);
    return {
      ok: true,
      provider: 'INFYNTRA',
      status: 'ACCEPTED',
      messageIdPresent: true,
      outboundFormat: classifyProviderNumber(body.to),
      contactInputFormat: classifyProviderNumber(responseBody?.contacts?.[0]?.input),
      waIdFormat: classifyProviderNumber(responseBody?.contacts?.[0]?.wa_id),
    };
  }
}

export class SmtpEmailProvider extends OtpProvider {
  async send({ destination, otp, purpose, expiresInSeconds }) {
    const acct = smtpAccount('otp');
    const fromAddress = acct.from;
    if (isMockOtpProviderEnabled()) {
      return new MockOtpProvider().send({ destination, otp, purpose, expiresInSeconds });
    }
    if (!(acct.host && fromAddress)) {
      throw new Error('PROVIDER_NOT_CONFIGURED');
    }

    const minutes = Math.max(1, Math.round(Number(expiresInSeconds) / 60));
    try {
      await getSmtpTransporter().sendMail({
        from: fromAddress,
        to: destination,
        subject: 'Your CORCOTTON verification code',
        // The same branded wrapper every other customer email uses, so the one
        // email a new customer sees first does not arrive as a bare line of
        // text. The code is repeated in the plain-text alternative, which is
        // derived from this body.
        ...renderEmail({
          subject: 'Your CORCOTTON verification code',
          body: `<p>Your verification code is:</p>`
            + `<p style="margin:0 0 16px;font:700 28px/1.2 Helvetica,Arial,sans-serif;letter-spacing:.2em;">${otp}</p>`
            + `<p>It expires in ${minutes} minute${minutes === 1 ? '' : 's'}.</p>`
            + `<p>If you didn't ask for this code, you can safely ignore this email — nobody can sign in without it.</p>`,
          supportEmail: smtpAccount('support').from || null,
          logoUrl: await emailLogoUrl(),
        }),
      });
    } catch (error) {
      const category = error?.code === 'EAUTH'
        ? 'AUTH'
        : ['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS'].includes(error?.code)
          ? 'NETWORK'
          : 'OTHER';
      // eslint-disable-next-line no-console
      console.warn(`[smtp] status=FAILED category=${category}`);
      throw new Error('PROVIDER_UNAVAILABLE');
    }
    return { ok: true, provider: 'SMTP' };
  }
}
