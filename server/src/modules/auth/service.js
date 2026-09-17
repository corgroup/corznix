// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/modules/auth/service.js (Wave 5). Logic
// unchanged except two things this wave's security review required fixing
// (both documented inline where they occur — search "SECURITY FIX"):
//   1. Login/session issuance now refuses a SUSPENDED customer. The source
//      version verified identity/OTP correctly but never checked
//      `customers.status` at all — a suspended customer could still log in
//      and receive a valid session (migration brief §105).
//   2. `getCustomerProfile`'s required-fields computation is delegated to
//      `modules/customers/profileService.js` (one implementation) instead
//      of being re-inlined a fourth time.
import { randomUUID } from 'node:crypto';
import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { createOtpHash, generateOtpCode, hashToken, randomToken, safeCompare, toMysqlDateTime } from '../../utils/otpCrypto.js';
import { createAccessToken } from '../../utils/jwt.js';
import { SESSION_EXPIRED_MESSAGES, maxLifetimeSeconds, remainingLifetimeSeconds, sessionExpiryReason } from './sessionPolicy.js';
import { normalizeEmail, normalizePhone } from '../../utils/normalize.js';
import { timingSafeEqual } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { buildCustomerProfile, CONTACT_TYPES, AUTH_PROVIDERS } from '../customers/profileService.js';

// Constant-time: the nonce is a secret the attacker is trying to match.
const nonceMatches = (expected, actual) => {
  if (typeof expected !== 'string' || typeof actual !== 'string' || !expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
};

export class AuthService {
  constructor({
    customerRepository,
    customerContactRepository,
    customerIdentityRepository,
    otpChallengeRepository,
    sessionRepository,
    identityLinkRepository,
    auditRepository,
    otpProvider,
    googleVerifier,
  }) {
    this.customerRepository = customerRepository;
    this.customerContactRepository = customerContactRepository;
    this.customerIdentityRepository = customerIdentityRepository;
    this.otpChallengeRepository = otpChallengeRepository;
    this.sessionRepository = sessionRepository;
    this.identityLinkRepository = identityLinkRepository;
    this.auditRepository = auditRepository;
    this.otpProvider = otpProvider;
    this.googleVerifier = googleVerifier;
  }

  async getCustomerProfile(customerId) {
    const customer = await this.customerRepository.findById(customerId);
    const contacts = await this.customerContactRepository.findForCustomer(customerId);
    const identities = await this.customerIdentityRepository.findByCustomer(customerId);
    return buildCustomerProfile(customer, identities, contacts);
  }

  // --- OTP -----------------------------------------------------------------

  async requestOtp({ channel, identifier, ip, userAgent, requestId }) {
    const normalizedIdentifier = channel === 'WHATSAPP' ? normalizePhone(identifier) : normalizeEmail(identifier);
    if (!normalizedIdentifier) {
      throw new AppError('VALIDATION_ERROR', 'Please enter a valid identifier.', 400);
    }

    // Resend cooldown — keyed on the destination, not the caller, so it
    // can't be bypassed by clearing cookies/switching IPs.
    const recentChallenge = await this.otpChallengeRepository.findLatestPendingByDestination(normalizedIdentifier, channel);
    if (recentChallenge) {
      const cooldownMs = Number(env.OTP_RESEND_COOLDOWN_SECONDS || 0) * 1000;
      if (cooldownMs > 0 && Date.now() - new Date(recentChallenge.created_at).getTime() < cooldownMs) {
        throw new AppError('OTP_RATE_LIMITED', 'Please wait before requesting a new code.', 429);
      }
    }

    // A successfully accepted resend supersedes every older pending code
    // for this destination/channel. This keeps the customer-facing rule
    // unambiguous: only the newest delivered OTP can authenticate.
    await this.otpChallengeRepository.cancelPendingByDestination(normalizedIdentifier, channel);

    // Two-phase insert: the hash is keyed on the challenge's own id (see
    // utils/otpCrypto.js), so the row must exist before the real hash can
    // be computed.
    const challenge = await this.otpChallengeRepository.create({
      id: randomUUID(),
      purpose: 'LOGIN',
      channel,
      destinationNormalized: normalizedIdentifier,
      otpHash: 'placeholder',
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: Number(env.OTP_MAX_ATTEMPTS),
      expiresAt: toMysqlDateTime(new Date(Date.now() + Number(env.OTP_TTL_SECONDS) * 1000)),
      requestedIp: ip,
      userAgent,
    });

    const otp = generateOtpCode();
    await this.otpChallengeRepository.updateHash(challenge.id, createOtpHash(otp, challenge.id, normalizedIdentifier));

    try {
      await this.otpProvider.send({ destination: normalizedIdentifier, otp, purpose: 'LOGIN', channel, expiresInSeconds: Number(env.OTP_TTL_SECONDS) });
    } catch (err) {
      // The caller still gets a safe, stable code — but log the real reason so
      // an operator can actually fix it (config vs network vs provider reject).
      // The message is a short marker only, never the OTP / API key / payload.
      console.warn(`[otp] send failed channel=${channel} reason=${err?.message || 'UNKNOWN'}`);
      // A code that was never delivered must not hold the resend cooldown:
      // `findLatestPendingByDestination` would otherwise see this row and
      // refuse the customer's next request for OTP_RESEND_COOLDOWN_SECONDS,
      // leaving them stuck between a 503 (send failed) and a 429 (wait).
      // Only this challenge is PENDING here — older ones were cancelled above.
      await this.otpChallengeRepository.cancelPendingByDestination(normalizedIdentifier, channel).catch(() => {});
      await this.auditRepository.log({
        eventType: 'OTP_SEND_FAILED', eventCode: err?.message || 'PROVIDER_UNAVAILABLE',
        // The provider's own status and error code, when the adapter attached
        // them. These are API semantics, never credentials or the OTP — and
        // without them every failure reads as an unexplained
        // "PROVIDER_UNAVAILABLE", which is indistinguishable between an
        // expired API key and the provider being down.
        metadata: {
          channel,
          ...(err?.providerCategory ? { providerCategory: err.providerCategory } : {}),
          ...(err?.providerStatus ? { providerStatus: err.providerStatus } : {}),
          ...(err?.providerCode ? { providerCode: err.providerCode } : {}),
          ...(err?.providerMessage ? { providerMessage: err.providerMessage } : {}),
        },
        requestId,
      }).catch(() => {});
      throw new AppError('PROVIDER_UNAVAILABLE', 'We could not send the verification code right now. Please try again shortly.', 503);
    }

    await this.auditRepository.log({ eventType: 'OTP_REQUESTED', eventCode: 'OTP_REQUESTED', metadata: { channel }, requestId });

    return {
      challengeId: challenge.id,
      expiresInSeconds: Number(env.OTP_TTL_SECONDS),
      resendAfterSeconds: Number(env.OTP_RESEND_COOLDOWN_SECONDS),
    };
  }

  async verifyOtp({ challengeId, otp, ip, userAgent, requestId, brandId }) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to verify an OTP.', 500);
    const challenge = await this.otpChallengeRepository.findById(challengeId);
    if (!challenge) throw new AppError('OTP_INVALID', 'The verification code is invalid.', 400);
    if (challenge.status === 'CONSUMED') throw new AppError('OTP_ALREADY_USED', 'This code has already been used.', 400);
    if (challenge.status === 'LOCKED') throw new AppError('OTP_ATTEMPTS_EXCEEDED', 'Too many attempts. Please request a new code.', 429);
    if (challenge.status === 'CANCELLED') throw new AppError('OTP_RATE_LIMITED', 'This code is no longer active.', 429);
    if (new Date(challenge.expires_at) < new Date()) {
      await this.otpChallengeRepository.markExpired(challenge.id);
      throw new AppError('OTP_EXPIRED', 'The verification code has expired.', 401);
    }

    const actualHash = createOtpHash(String(otp), challenge.id, challenge.destination_normalized);
    if (!safeCompare(actualHash, challenge.otp_hash)) {
      const nextAttempts = Number(challenge.attempt_count || 0) + 1;
      if (nextAttempts >= Number(challenge.max_attempts || env.OTP_MAX_ATTEMPTS)) {
        await this.otpChallengeRepository.lock(challenge.id);
        throw new AppError('OTP_ATTEMPTS_EXCEEDED', 'Too many attempts. Please request a new code.', 429);
      }
      await this.otpChallengeRepository.incrementAttempts(challenge.id, nextAttempts);
      throw new AppError('OTP_INVALID', 'The verification code is invalid.', 400);
    }

    await this.otpChallengeRepository.consume(challenge.id);

    const identifier = challenge.destination_normalized;
    const provider = challenge.channel === 'WHATSAPP' ? AUTH_PROVIDERS.PHONE_OTP : AUTH_PROVIDERS.EMAIL_OTP;
    const subject = provider === AUTH_PROVIDERS.PHONE_OTP ? normalizePhone(identifier) : normalizeEmail(identifier);

    const customer = await this.resolveOrCreateCustomer({
      brandId,
      provider,
      subject,
      contactType: challenge.channel === 'WHATSAPP' ? CONTACT_TYPES.PHONE : CONTACT_TYPES.EMAIL,
      contactValue: identifier,
      source: challenge.channel === 'WHATSAPP' ? 'WHATSAPP_ONBOARDING' : 'EMAIL_ONBOARDING',
    });

    return this.buildAuthenticationEnvelope({ customer, provider, ip, userAgent, requestId });
  }

  // Shared by verifyOtp: find-by-identity, else find-by-existing-verified-
  // contact (one candidate only — more than one is a real conflict, not
  // silently resolved), else create new. See docs/MIGRATION.md §18 for the
  // full account-linking rules this implements.
  async resolveOrCreateCustomer({ brandId, provider, subject, contactType, contactValue, source }) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to resolve a customer.', 500);
    const existingIdentity = await this.customerIdentityRepository.findByProviderSubject(provider, subject, brandId);
    if (existingIdentity) {
      const customer = await this.customerRepository.findById(existingIdentity.customer_id);
      if (!customer) throw new AppError('AUTH_REQUIRED', 'Authentication required.', 401);
      // The code just proved control of this contact. Without this, a
      // returning customer's number stayed unverified forever and they could
      // never receive WhatsApp messages (production, 2026-09-17).
      await this.customerContactRepository.markVerifiedByValue(customer.id, contactType, subject, source);
      return customer;
    }

    const existingContacts = await this.customerContactRepository.findByTypeAndNormalized(contactType, subject, brandId);
    if (existingContacts.length > 1) {
      throw new AppError('IDENTITY_CONFLICT', 'This contact is already associated with another customer.', 409);
    }
    if (existingContacts.length === 1) {
      const customer = await this.customerRepository.findById(existingContacts[0].customer_id);
      // The contact string matches, but no identity for THIS provider
      // exists yet for that customer — attach one now. This is safe
      // (not a cross-account-takeover risk) only because OTP verification
      // just proved control of this exact contact value.
      await this.customerIdentityRepository.create({ customerId: customer.id, brandId, provider, providerSubject: subject });
      await this.customerContactRepository.markVerifiedByValue(customer.id, contactType, subject, source);
      return customer;
    }

    const customer = await this.customerRepository.create({ firstName: '', lastName: '', brandId });
    await this.customerContactRepository.upsert({
      customerId: customer.id,
      contactType,
      value: contactValue,
      normalizedValue: subject,
      source,
      verified: true,
    });
    await this.customerIdentityRepository.create({ customerId: customer.id, brandId, provider, providerSubject: subject });
    return customer;
  }

  // --- Google ----------------------------------------------------------------

  async loginWithGoogle({ credential, expectedNonce, ip, userAgent, requestId, brandId }) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required for Google sign-in.', 500);
    const claims = await this.googleVerifier(credential).catch(() => {
      throw new AppError('GOOGLE_AUTH_FAILED', 'We could not verify your Google sign-in.', 401);
    });
    // Redirect sign-in: the token must carry the nonce this browser was issued,
    // or it was obtained somewhere else and replayed here. The JSON endpoint
    // passes none — it is guarded by the allowed-origin check instead.
    if (expectedNonce !== undefined && !nonceMatches(expectedNonce, claims.nonce)) {
      throw new AppError('GOOGLE_NONCE_MISMATCH', 'We could not verify your Google sign-in.', 401);
    }
    const provider = AUTH_PROVIDERS.GOOGLE;
    const subject = claims.sub;
    const email = normalizeEmail(claims.email);

    const existingIdentity = await this.customerIdentityRepository.findByProviderSubject(provider, subject, brandId);
    if (existingIdentity) {
      const customer = await this.customerRepository.findById(existingIdentity.customer_id);
      return this.buildAuthenticationEnvelope({ customer, provider, ip, userAgent, requestId });
    }

    const candidateContacts = email ? await this.customerContactRepository.findByTypeAndNormalized(CONTACT_TYPES.EMAIL, email, brandId) : [];

    if (candidateContacts.length === 0) {
      const customer = await this.customerRepository.create({ firstName: claims.firstName || '', lastName: claims.lastName || '', brandId });
      await this.customerContactRepository.upsert({
        customerId: customer.id,
        contactType: CONTACT_TYPES.EMAIL,
        value: claims.email,
        normalizedValue: email,
        source: 'GOOGLE',
        verified: true, // Google's own `email_verified` claim was already checked in googleVerifier.js.
      });
      await this.customerIdentityRepository.create({ customerId: customer.id, brandId, provider, providerSubject: subject });
      return this.buildAuthenticationEnvelope({ customer, provider, ip, userAgent, requestId });
    }

    if (candidateContacts.length === 1) {
      const matchedContact = candidateContacts[0];
      const customer = await this.customerRepository.findById(matchedContact.customer_id);

      // A matching contact string is never proof of ownership on its own:
      // only a VERIFIED contact may be auto-linked (migration brief §20).
      // An unverified match requires the customer to prove ownership via
      // an identity-link confirmation while already authenticated some
      // other way first.
      if (!matchedContact.is_verified) {
        const linkRequest = await this.identityLinkRepository.create({
          candidateCustomerId: customer.id,
          incomingProvider: provider,
          incomingProviderSubject: subject,
          incomingVerifiedContact: email,
          proofChannel: 'EMAIL',
          expiresAt: toMysqlDateTime(new Date(Date.now() + 15 * 60 * 1000)),
        });
        await this.auditRepository.log({ customerId: customer.id, eventType: 'IDENTITY_LINK_REQUIRED', eventCode: 'IDENTITY_LINK_REQUIRED', metadata: { provider, linkRequestId: linkRequest.id }, requestId });
        throw new AppError('IDENTITY_LINK_REQUIRED', 'Please verify your existing account to link this identity.', 409, { linkRequestId: linkRequest.id });
      }

      await this.customerIdentityRepository.create({ customerId: customer.id, brandId, provider, providerSubject: subject });
      return this.buildAuthenticationEnvelope({ customer, provider, ip, userAgent, requestId });
    }

    throw new AppError('IDENTITY_CONFLICT', 'This Google identity is already linked elsewhere.', 409);
  }

  // Completes a pending identity_link_request. "Proof of ownership" is the
  // caller already holding a valid session for the candidate customer
  // (obtained via one of THAT customer's existing verified identities) —
  // never contact-text matching alone.
  async confirmIdentityLink({ linkRequestId, authenticatedCustomerId, requestId }) {
    const outcome = await withTransaction(async (connection) => {
      const [rows] = await connection.execute('SELECT * FROM identity_link_requests WHERE id = ? LIMIT 1 FOR UPDATE', [linkRequestId]);
      const request = rows[0];
      if (!request) return { errorCode: 'IDENTITY_LINK_INVALID' };
      if (request.status !== 'PENDING') return { errorCode: request.status === 'CONFLICT' ? 'IDENTITY_CONFLICT' : 'IDENTITY_LINK_INVALID' };
      if (new Date(request.expires_at) < new Date()) {
        await connection.execute("UPDATE identity_link_requests SET status = 'EXPIRED' WHERE id = ?", [request.id]);
        return { errorCode: 'IDENTITY_LINK_EXPIRED' };
      }
      if (String(request.candidate_customer_id) !== String(authenticatedCustomerId)) {
        return { errorCode: 'IDENTITY_LINK_INVALID' };
      }

      // Multi-company (DESIGN.md §7.1) — Phase 4. brandId is always the
      // candidate customer's own brand, never taken from the request body —
      // a customer can only ever link an identity within their own company.
      const [candidateRows] = await connection.execute('SELECT brand_id FROM customers WHERE id = ? LIMIT 1', [request.candidate_customer_id]);
      const brandId = candidateRows[0]?.brand_id;
      if (!brandId) return { errorCode: 'IDENTITY_LINK_INVALID' };

      const [conflictRows] = await connection.execute(
        'SELECT id FROM customer_identities WHERE provider = ? AND provider_subject = ? AND brand_id = ? AND customer_id <> ? LIMIT 1',
        [request.incoming_provider, request.incoming_provider_subject, brandId, request.candidate_customer_id]
      );
      if (conflictRows[0]) {
        await connection.execute("UPDATE identity_link_requests SET status = 'CONFLICT' WHERE id = ?", [request.id]);
        return { errorCode: 'IDENTITY_CONFLICT' };
      }

      await connection.execute(
        'INSERT INTO customer_identities (id, customer_id, brand_id, provider, provider_subject, verified_at, created_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
        [randomUUID(), request.candidate_customer_id, brandId, request.incoming_provider, request.incoming_provider_subject]
      );
      if (request.incoming_verified_contact) {
        const contactType = request.proof_channel === 'WHATSAPP' ? CONTACT_TYPES.PHONE : CONTACT_TYPES.EMAIL;
        await connection.execute(
          `UPDATE customer_contacts SET is_verified = 1, verified_at = NOW(), source = 'IDENTITY_LINK', updated_at = NOW()
           WHERE customer_id = ? AND contact_type = ? AND normalized_value = ?`,
          [request.candidate_customer_id, contactType, request.incoming_verified_contact]
        );
      }
      await connection.execute("UPDATE identity_link_requests SET status = 'VERIFIED', completed_at = NOW() WHERE id = ?", [request.id]);
      return { customerId: request.candidate_customer_id, linked: true };
    });

    if (outcome.errorCode) {
      const messages = {
        IDENTITY_LINK_INVALID: 'This link request is invalid.',
        IDENTITY_LINK_EXPIRED: 'This link request has expired.',
        IDENTITY_CONFLICT: 'This identity is already linked to another customer.',
      };
      throw new AppError(outcome.errorCode, messages[outcome.errorCode], outcome.errorCode === 'IDENTITY_CONFLICT' ? 409 : 400);
    }

    await this.auditRepository.log({ customerId: outcome.customerId, eventType: 'IDENTITY_LINKED', eventCode: 'IDENTITY_LINKED', requestId });
    return outcome;
  }

  // --- Session -----------------------------------------------------------

  async buildAuthenticationEnvelope({ customer, provider, ip, userAgent, requestId }) {
    // SECURITY FIX (this wave's review — see file banner): the source
    // version never checked customer status here at all. A SUSPENDED
    // customer must never receive a session just because they correctly
    // proved identity.
    if (customer.status === 'SUSPENDED') {
      throw new AppError('ACCOUNT_SUSPENDED', 'This account is currently suspended.', 403);
    }

    const profile = await this.getCustomerProfile(customer.id);
    const { accessToken, refreshToken } = await this.issueSession(customer.id, ip, userAgent);

    await this.auditRepository.log({ customerId: customer.id, eventType: 'AUTH_LOGIN_SUCCESS', eventCode: 'AUTH_LOGIN_SUCCESS', metadata: { provider }, requestId });

    return { authenticated: true, customer: profile, accessToken, refreshToken };
  }

  // Refresh token = `${sessionId}.${secret}` so rotation/reuse checks can
  // locate the session row without a reverse hash -> session index.
  // The session's absolute deadline is fixed here, at login (max lifetime);
  // refreshSession never moves it. See auth/sessionPolicy.js.
  async issueSession(customerId, ip, userAgent) {
    const sessionId = randomUUID();
    const refreshToken = `${sessionId}.${randomToken()}`;
    await this.sessionRepository.create({
      id: sessionId,
      customerId,
      tokenHash: hashToken(refreshToken),
      expiresInSeconds: maxLifetimeSeconds(),
      userAgent,
      ipAddress: ip,
    });
    return { accessToken: createAccessToken({ customerId, sessionId }), refreshToken, sessionExpiresInSeconds: maxLifetimeSeconds() };
  }

  // Validates + rotates an opaque refresh token inside one transaction so a
  // mid-rotation failure can never leave the session half-updated. Reuse of
  // an already-rotated token revokes the whole session (theft signal).
  async refreshSession({ refreshToken, requestId }) {
    const raw = String(refreshToken || '');
    const separatorIndex = raw.indexOf('.');
    if (separatorIndex <= 0) throw new AppError('REFRESH_TOKEN_INVALID', 'Refresh token is invalid.', 401);

    const sessionId = raw.slice(0, separatorIndex);
    const incomingHash = hashToken(raw);

    const outcome = await withTransaction(async (connection) => {
      // Ages computed by MySQL, as in AuthSessionRepository#findWithAge.
      const [rows] = await connection.execute(
        `SELECT *,
                TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds,
                TIMESTAMPDIFF(SECOND, COALESCE(last_seen_at, created_at), NOW()) AS idle_seconds,
                TIMESTAMPDIFF(SECOND, NOW(), expires_at) AS seconds_to_expiry,
                (expires_at <= NOW()) AS past_expiry
           FROM auth_sessions WHERE id = ? LIMIT 1 FOR UPDATE`,
        [sessionId]
      );
      const session = rows[0];
      if (!session) return { errorCode: 'REFRESH_TOKEN_INVALID' };
      if (session.status === 'REVOKED') return { errorCode: 'SESSION_REVOKED' };
      if (session.status === 'EXPIRED') return { errorCode: 'SESSION_EXPIRED', expiry: 'MAX_LIFETIME' };
      // A refresh is not activity that can revive an idle session, and it can
      // never carry a session past its maximum lifetime.
      const expiry = sessionExpiryReason(session);
      if (expiry) {
        await connection.execute("UPDATE auth_sessions SET status = 'EXPIRED' WHERE id = ?", [session.id]);
        return { errorCode: 'SESSION_EXPIRED', expiry };
      }
      if (!safeCompare(incomingHash, session.token_hash)) {
        await connection.execute("UPDATE auth_sessions SET status = 'REVOKED', last_seen_at = NOW() WHERE id = ?", [session.id]);
        await connection.execute(
          `INSERT INTO audit_logs (id, customer_id, event_type, event_code, metadata, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
          [randomUUID(), session.customer_id, 'AUTH_SESSION_REVOKED', 'AUTH_REFRESH_TOKEN_REUSE', JSON.stringify({ sessionId: session.id }), requestId]
        );
        return { errorCode: 'REFRESH_TOKEN_INVALID' };
      }

      const customerRows = await connection.execute('SELECT status FROM customers WHERE id = ? LIMIT 1', [session.customer_id]);
      if (customerRows[0][0]?.status === 'SUSPENDED') {
        await connection.execute("UPDATE auth_sessions SET status = 'REVOKED', last_seen_at = NOW() WHERE id = ?", [session.id]);
        return { errorCode: 'ACCOUNT_SUSPENDED' };
      }

      // Rotation only: expires_at (the absolute deadline) is left exactly where
      // login set it. It used to be pushed SESSION_TTL_DAYS ahead every time,
      // so a customer who returned within a month was never signed out.
      const newRefreshToken = `${session.id}.${randomToken()}`;
      await connection.execute('UPDATE auth_sessions SET token_hash = ?, last_seen_at = NOW() WHERE id = ?', [hashToken(newRefreshToken), session.id]);

      return {
        accessToken: createAccessToken({ customerId: session.customer_id, sessionId: session.id }),
        refreshToken: newRefreshToken,
        sessionExpiresInSeconds: remainingLifetimeSeconds(session),
      };
    });

    if (outcome.errorCode) {
      const messages = {
        REFRESH_TOKEN_INVALID: 'Refresh token is invalid.',
        SESSION_REVOKED: 'This session has been revoked.',
        SESSION_EXPIRED: SESSION_EXPIRED_MESSAGES[outcome.expiry] || SESSION_EXPIRED_MESSAGES.MAX_LIFETIME,
        ACCOUNT_SUSPENDED: 'This account is currently suspended.',
      };
      throw new AppError(outcome.errorCode, messages[outcome.errorCode], outcome.errorCode === 'ACCOUNT_SUSPENDED' ? 403 : 401);
    }

    return outcome;
  }
}
