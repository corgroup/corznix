import { z } from 'zod';
import { env, storefrontBaseUrl } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { normalizeEmail, normalizePhone } from '../../utils/normalize.js';
import { AuthService } from './service.js';
import { OtpChallengeRepository } from './repositories.js';
import { logger } from '../../utils/logger.js';
import { InfyntraWhatsAppProvider, SmtpEmailProvider } from './otpProviders.js';
import { randomBytes } from 'node:crypto';
import { verifyGoogleCredential } from './googleVerifier.js';
import {
  CustomerRepository,
  CustomerContactRepository,
  CustomerIdentityRepository,
  AuthSessionRepository,
  IdentityLinkRepository,
  AuditRepository,
} from '../customers/repositories.js';
import { buildCustomerProfile } from '../customers/profileService.js';
import { notificationService } from '../notifications/service.js';
import { applyDefaultMarketingAfterSignIn } from '../consent/loginDefaults.js';

const otpChallengeRepository = new OtpChallengeRepository();
const customerRepository = new CustomerRepository();
const contactRepository = new CustomerContactRepository();
const identityRepository = new CustomerIdentityRepository();
const sessionRepository = new AuthSessionRepository();
const identityLinkRepository = new IdentityLinkRepository();
const auditRepository = new AuditRepository();

const otpProviders = { WHATSAPP: new InfyntraWhatsAppProvider(), EMAIL: new SmtpEmailProvider() };

// This is the entire "AuthService -> OtpDeliveryService -> OtpProvider"
// boundary the migration brief asks for (§24): AuthService only ever calls
// `.send()` on this one object — it never knows Infyntra or nodemailer
// exist, only a channel name.
const otpDeliveryService = {
  send: ({ destination, otp, purpose, channel, expiresInSeconds }) =>
    (channel === 'WHATSAPP' ? otpProviders.WHATSAPP : otpProviders.EMAIL).send({ destination, otp, purpose, expiresInSeconds }),
};

const authService = new AuthService({
  customerRepository,
  customerContactRepository: contactRepository,
  customerIdentityRepository: identityRepository,
  otpChallengeRepository,
  sessionRepository,
  identityLinkRepository,
  auditRepository,
  otpProvider: otpDeliveryService,
  googleVerifier: verifyGoogleCredential,
});

function respond(res, data, status = 200) {
  return res.status(status).json({ data });
}

// Access-token cookie: short-lived, sent path-wide. Refresh-token cookie:
// opaque + high-entropy, scoped to the one path family that ever needs it
// — a defense-in-depth measure so an XSS/CSRF bug elsewhere in the app
// can't exfiltrate the long-lived credential (migration brief §35).
function setAuthCookies(res, { accessToken, refreshToken, sessionExpiresInSeconds }) {
  // Neither cookie outlives the session: the refresh cookie ends at the
  // session's absolute deadline (auth/sessionPolicy.js), which a refresh
  // never moves; the access cookie at the JWT expiry or that deadline.
  const sessionSeconds = Number.isFinite(Number(sessionExpiresInSeconds))
    ? Math.max(0, Number(sessionExpiresInSeconds))
    : Number(env.CUSTOMER_SESSION_MAX_LIFETIME_HOURS) * 60 * 60;
  res.cookie(env.SESSION_COOKIE_NAME, accessToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: Math.min(Number(env.JWT_ACCESS_TTL_SECONDS), sessionSeconds) * 1000,
  });
  res.cookie(env.REFRESH_COOKIE_NAME, refreshToken, {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/api/v1/auth',
    maxAge: sessionSeconds * 1000,
  });
}

function clearAuthCookies(res) {
  res.clearCookie(env.SESSION_COOKIE_NAME, { path: '/' });
  res.clearCookie(env.REFRESH_COOKIE_NAME, { path: '/api/v1/auth' });
}

// Never exposes accessToken/refreshToken/session internals in the JSON
// body — those travel only via httpOnly cookies (migration brief §43).
function authEnvelopeBody(result) {
  return { authenticated: result.authenticated, customer: result.customer };
}

export async function getSession(req, res, next) {
  try {
    if (!req.customer) {
      // refreshable says whether a refresh could possibly succeed. An expired
      // access token and a genuine guest both land here as authenticated:false,
      // so the storefront spends one refresh before believing "guest" — which
      // is right for the first case and, for the second, a request that can
      // only 401 on every page load. The refresh cookie is httpOnly, so the
      // browser cannot tell the two apart; this server can, because that
      // cookie's path covers /api/v1/auth. Presence only: whether the token is
      // still valid is for /refresh to decide.
      return respond(res, {
        authenticated: false,
        customer: null,
        refreshable: Boolean(req.cookies?.[env.REFRESH_COOKIE_NAME]),
      });
    }
    const contacts = await contactRepository.findForCustomer(req.customer.id);
    const identities = await identityRepository.findByCustomer(req.customer.id);
    respond(res, { authenticated: true, customer: buildCustomerProfile(req.customer, identities, contacts) });
  } catch (err) {
    next(err);
  }
}

const otpRequestSchema = z.object({
  identifier: z.string().trim().min(1),
});

// Frontend detects phone-vs-email shape (migration brief §5) and only ever
// sends one or the other; the server independently re-derives the channel
// from the identifier's own shape rather than trusting a client-supplied
// `channel` field, so a mismatched/forged value can't route an email
// address through the WhatsApp path or vice versa.
function detectChannel(identifier) {
  // Email local-parts may legitimately contain long digit sequences. Check
  // email syntax first so values such as `customer20260827@example.com`
  // cannot be stripped down and misrouted through the phone normalizer.
  const email = normalizeEmail(identifier);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'EMAIL';
  return normalizePhone(identifier) ? 'WHATSAPP' : null;
}

export async function requestOtp(req, res, next) {
  try {
    const payload = otpRequestSchema.parse(req.body);
    const channel = detectChannel(payload.identifier);
    if (!channel) {
      throw new AppError('VALIDATION_ERROR', 'Enter a valid Indian mobile number or email address.', 400);
    }
    const result = await authService.requestOtp({
      channel,
      identifier: payload.identifier,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      requestId: req.id,
    });
    respond(res, { ...result, channel });
  } catch (err) {
    next(err);
  }
}

const otpVerifySchema = z.object({
  challengeId: z.string().uuid(),
  otp: z.string().regex(/^\d{4}$/, 'OTP must be exactly 4 digits.'),
});

export async function verifyOtp(req, res, next) {
  try {
    const payload = otpVerifySchema.parse(req.body);
    const result = await authService.verifyOtp({
      challengeId: payload.challengeId,
      otp: payload.otp,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      requestId: req.id,
      brandId: req.brandId,
    });
    setAuthCookies(res, result);
    if (result?.authenticated) await applyDefaultMarketingAfterSignIn(result.customer?.id);
    respond(res, authEnvelopeBody(result));
  } catch (err) {
    next(err);
  }
}

const googleSchema = z.object({ credential: z.string().min(10) });

// Google's redirect UX posts the credential here as a form, from their own
// origin, instead of handing it back through a pop-up. That matters because
// Safari and the other ITP browsers block the third-party storage the pop-up
// flow leans on, and sign-in stalls inside Google's frames without ever
// returning a credential — the customer waits on accounts.google.com/gsi/
// transform and nothing happens.
//
// A cross-site POST cannot carry our session cookie, so Google sends a
// double-submit token instead: the same value in a cookie they set and in the
// form body. Matching the two is what proves the post came from the sign-in
// the customer actually started. This is Google's documented mechanism for
// this flow, and skipping it would leave an endpoint anyone could post to.
//
// The response is a redirect, never JSON: the browser is mid-navigation, so
// there is nothing on the other end to read a body. Set-Cookie is honoured on
// a cross-site POST response — SameSite governs when a cookie is SENT, not
// when it is set — and api/www share a registrable domain, so the session
// travels to the storefront on the redirect that follows.
// Google redirect sign-in is bound to the browser that started it by a
// one-time nonce. The storefront asks for one before showing the Google
// button; it is kept here in an HttpOnly cookie and handed to Google, which
// signs it into the ID token. At the callback the two must match.
//
// This replaces Google's own double-submit cookie as the proof. That cookie is
// written by Google's script on the storefront host (www.corcotton.in) and is
// never sent to this API host, so on every deployed environment the check could
// only ever fail — sign-in worked on localhost alone, where cookies ignore the
// port. The nonce is stronger anyway: it sits inside the signed token.
const GOOGLE_NONCE_COOKIE = 'cor_group_google_nonce';
const GOOGLE_NONCE_TTL_MS = 30 * 60 * 1000;
// Google's page posts the callback cross-site, and only a SameSite=None cookie
// travels on a cross-site POST. Browsers accept those only when Secure;
// http://localhost counts as secure for this.
const googleNonceCookieOptions = { httpOnly: true, secure: true, sameSite: 'none', path: '/api/v1/auth/google' };
// Google's own origin, or "null" when the browser withholds it after Google's
// redirect chain (Safari on iOS does). Absent is allowed too.
const GOOGLE_POST_ORIGINS = new Set(['https://accounts.google.com', 'null']);

export async function googleNonce(_req, res, next) {
  try {
    const nonce = randomBytes(32).toString('base64url');
    res.cookie(GOOGLE_NONCE_COOKIE, nonce, { ...googleNonceCookieOptions, maxAge: GOOGLE_NONCE_TTL_MS });
    res.set('Cache-Control', 'no-store');
    respond(res, { nonce });
  } catch (err) {
    next(err);
  }
}

export async function googleRedirectCallback(req, res) {
  const back = (params) => {
    const url = new URL('/login', storefrontBaseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    return res.redirect(302, url.toString());
  };
  // Single use, whatever happens next.
  const storedNonce = req.cookies?.[GOOGLE_NONCE_COOKIE];
  res.clearCookie(GOOGLE_NONCE_COOKIE, googleNonceCookieOptions);
  try {
    const origin = req.headers.origin;
    if (origin !== undefined && !GOOGLE_POST_ORIGINS.has(origin)) {
      logger('auth').warn('google_redirect_bad_origin', { origin });
      return back({ google: 'failed', reason: 'csrf' });
    }
    // Google's double-submit pair cannot be required (see above), but when both
    // halves did arrive they must still agree.
    const bodyProof = req.body?.g_csrf_token;
    const browserProof = req.cookies?.g_csrf_token;
    if (bodyProof && browserProof && bodyProof !== browserProof) {
      logger('auth').warn('google_redirect_double_submit_mismatch', { origin: origin ?? 'absent' });
      return back({ google: 'failed', reason: 'csrf' });
    }
    if (!storedNonce) {
      // Sign-in started more than 30 minutes ago, or before this browser was
      // issued a nonce at all. Starting again fixes it.
      logger('auth').warn('google_redirect_nonce_missing', { origin: origin ?? 'absent' });
      return back({ google: 'failed', reason: 'expired' });
    }
    const credential = req.body?.credential;
    if (!credential) return back({ google: 'failed', reason: 'no_credential' });

    const result = await authService.loginWithGoogle({
      credential,
      expectedNonce: storedNonce,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      requestId: req.id,
      brandId: req.brandId,
    });
    setAuthCookies(res, result);
    if (result?.authenticated) await applyDefaultMarketingAfterSignIn(result.customer?.id);
    // The profile step needs the customer signed in to reach it, which they
    // now are; the storefront reads pendingProfile from the session.
    return back({ google: 'ok' });
  } catch (err) {
    // Never a 500 into a navigation: the customer would land on a blank error
    // page with no way back. The reason rides the redirect instead.
    const code = err?.code || 'UNKNOWN';
    logger('auth').warn('google_redirect_failed', { code });
    const reason = code === 'GOOGLE_AUTH_FAILED' ? 'verify' : code === 'GOOGLE_NONCE_MISMATCH' ? 'csrf' : 'unknown';
    return back({ google: 'failed', reason });
  }
}

export async function loginWithGoogle(req, res, next) {
  try {
    const payload = googleSchema.parse(req.body);
    const result = await authService.loginWithGoogle({
      credential: payload.credential,
      ip: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
      requestId: req.id,
      brandId: req.brandId,
    });
    setAuthCookies(res, result);
    if (result?.authenticated) await applyDefaultMarketingAfterSignIn(result.customer?.id);
    respond(res, authEnvelopeBody(result));
  } catch (err) {
    next(err);
  }
}

export async function refresh(req, res, next) {
  try {
    const rawRefreshToken = req.cookies?.[env.REFRESH_COOKIE_NAME];
    if (!rawRefreshToken) {
      throw new AppError('REFRESH_TOKEN_INVALID', 'Refresh token is required.', 401);
    }
    const result = await authService.refreshSession({ refreshToken: rawRefreshToken, requestId: req.id });
    setAuthCookies(res, result);
    respond(res, { authenticated: true });
  } catch (err) {
    // A failed refresh always clears cookies too — never leave a stale,
    // invalid refresh cookie sitting in the browser (migration brief §91).
    clearAuthCookies(res);
    next(err);
  }
}

const identityLinkSchema = z.object({ linkRequestId: z.string().uuid() });

export async function confirmIdentityLink(req, res, next) {
  try {
    const payload = identityLinkSchema.parse(req.body);
    const result = await authService.confirmIdentityLink({
      linkRequestId: payload.linkRequestId,
      authenticatedCustomerId: req.customer.id,
      requestId: req.id,
    });
    // Linking verifies a contact on the account.
    if (result?.linked) await applyDefaultMarketingAfterSignIn(result.customerId);
    respond(res, result);
  } catch (err) {
    next(err);
  }
}

const profileCompleteSchema = z.object({
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().optional(),
});

export async function completeProfile(req, res, next) {
  try {
    const payload = profileCompleteSchema.parse(req.body);
    const customer = await customerRepository.findById(req.customer.id);
    const existingContacts = await contactRepository.findForCustomer(customer.id);

    const updated = await customerRepository.update(customer.id, {
      first_name: payload.firstName ?? customer.first_name ?? '',
      last_name: payload.lastName ?? customer.last_name ?? '',
    });

    if (payload.email) {
      const normalizedEmail = normalizeEmail(payload.email);
      if (!normalizedEmail) throw new AppError('VALIDATION_ERROR', 'Enter a valid email address.', 400);
      // Collected during profile completion, not proven via OTP here — an
      // UNVERIFIED contact (migration brief §7/§104), even though the
      // column name/upsert path is shared with the OTP-verified case.
      const unchanged = existingContacts.some((contact) => contact.contact_type === 'EMAIL' && contact.normalized_value === normalizedEmail);
      if (!unchanged) {
        await contactRepository.upsert({ customerId: customer.id, contactType: 'EMAIL', value: payload.email, normalizedValue: normalizedEmail, source: 'PROFILE', verified: false });
      }
    }
    if (payload.phone) {
      const normalizedPhone = normalizePhone(payload.phone);
      if (!normalizedPhone) throw new AppError('VALIDATION_ERROR', 'Enter a valid Indian mobile number.', 400);
      const unchanged = existingContacts.some((contact) => contact.contact_type === 'PHONE' && contact.normalized_value === normalizedPhone);
      if (!unchanged) {
        await contactRepository.upsert({ customerId: customer.id, contactType: 'PHONE', value: payload.phone, normalizedValue: normalizedPhone, source: 'PROFILE', verified: false });
      }
    }

    const contacts = await contactRepository.findForCustomer(customer.id);
    const identities = await identityRepository.findByCustomer(customer.id);
    const profile = buildCustomerProfile(updated, identities, contacts);

    // A customer only ever becomes ACTIVE once their own required fields
    // are actually satisfied — never fabricated as a side effect of
    // calling this endpoint with a partial payload.
    if (profile.profileComplete && customer.status === 'PENDING_PROFILE') {
      await customerRepository.update(customer.id, { status: 'ACTIVE', profile_completed_at: new Date() });
      // The one email a new customer never got. Sent here rather than at first
      // OTP, because until the profile is complete there is no name and no
      // usable account to welcome them to. Isolated and deduped on the
      // customer, so a re-saved profile cannot send it twice.
      await notificationService.emit('CUSTOMER_WELCOME', {
        customerId: customer.id,
        customerName: profile.firstName || null,
      }).catch(() => {});
    }

    await auditRepository.log({ customerId: customer.id, eventType: 'PROFILE_COMPLETED', eventCode: 'PROFILE_COMPLETED', requestId: req.id });
    respond(res, { authenticated: true, customer: profile });
  } catch (err) {
    next(err);
  }
}

export async function logout(req, res, next) {
  try {
    await sessionRepository.revoke(req.session.id);
    await auditRepository.log({ customerId: req.customer.id, eventType: 'AUTH_LOGOUT', eventCode: 'AUTH_LOGOUT', metadata: { sessionId: req.session.id }, requestId: req.id });
    clearAuthCookies(res);
    respond(res, { loggedOut: true });
  } catch (err) {
    next(err);
  }
}
