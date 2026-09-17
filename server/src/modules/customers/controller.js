import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { createOtpHash, generateOtpCode, safeCompare, toMysqlDateTime } from '../../utils/otpCrypto.js';
import { normalizeEmail, normalizePhone } from '../../utils/normalize.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { applyDefaultMarketingAfterSignIn } from '../consent/loginDefaults.js';
import { CustomerRepository, CustomerContactRepository, CustomerIdentityRepository, AuditRepository } from './repositories.js';
import { OtpChallengeRepository } from '../auth/repositories.js';
import { InfyntraWhatsAppProvider, SmtpEmailProvider } from '../auth/otpProviders.js';
import { buildCustomerProfile } from './profileService.js';

const customerRepository = new CustomerRepository();
const contactRepository = new CustomerContactRepository();
const identityRepository = new CustomerIdentityRepository();
const auditRepository = new AuditRepository();
const otpChallengeRepository = new OtpChallengeRepository();
const contactOtpProviders = { WHATSAPP: new InfyntraWhatsAppProvider(), EMAIL: new SmtpEmailProvider() };

export async function getMe(req, res, next) {
  try {
    const [contacts, identities] = await Promise.all([
      contactRepository.findForCustomer(req.customer.id),
      identityRepository.findByCustomer(req.customer.id),
    ]);
    res.json({ data: buildCustomerProfile(req.customer, identities, contacts) });
  } catch (err) {
    next(err);
  }
}

const updateSchema = z.object({
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email().optional(),
  phone: z.string().trim().min(7).optional(),
});

// CONTACT CHANGE POLICY (migration brief §49): a changed email/phone never
// inherits the previous value's verification state — `upsert(..., verified:
// false)` below is the same call used for a brand-new contact, so this is
// enforced structurally, not by a separate "did it change" check that
// could be bypassed.
export async function updateMe(req, res, next) {
  try {
    const payload = updateSchema.parse(req.body);
    const customer = await customerRepository.findById(req.customer.id);
    const existingContacts = await contactRepository.findForCustomer(customer.id);

    const updated = await customerRepository.update(customer.id, {
      first_name: payload.firstName ?? customer.first_name,
      last_name: payload.lastName ?? customer.last_name,
    });

    if (payload.email !== undefined) {
      const normalized = normalizeEmail(payload.email);
      if (!normalized) throw new AppError('VALIDATION_ERROR', 'Enter a valid email address.', 400);
      const unchanged = existingContacts.some((contact) => contact.contact_type === 'EMAIL' && contact.normalized_value === normalized);
      if (!unchanged) {
        await contactRepository.upsert({ customerId: customer.id, contactType: 'EMAIL', value: payload.email, normalizedValue: normalized, source: 'PROFILE', verified: false });
      }
    }
    if (payload.phone !== undefined) {
      const normalized = normalizePhone(payload.phone);
      if (!normalized) throw new AppError('VALIDATION_ERROR', 'Enter a valid Indian mobile number.', 400);
      const unchanged = existingContacts.some((contact) => contact.contact_type === 'PHONE' && contact.normalized_value === normalized);
      if (!unchanged) {
        await contactRepository.upsert({ customerId: customer.id, contactType: 'PHONE', value: payload.phone, normalizedValue: normalized, source: 'PROFILE', verified: false });
      }
    }

    await auditRepository.log({ customerId: customer.id, eventType: 'PROFILE_UPDATED', eventCode: 'PROFILE_UPDATED', requestId: req.id });

    const [contacts, identities] = await Promise.all([
      contactRepository.findForCustomer(customer.id),
      identityRepository.findByCustomer(customer.id),
    ]);
    res.json({ data: buildCustomerProfile(updated, identities, contacts) });
  } catch (err) {
    next(err);
  }
}

const contactTypeSchema = z.enum(['EMAIL', 'PHONE']);

export async function requestContactVerification(req, res, next) {
  try {
    const type = contactTypeSchema.parse(req.params.type.toUpperCase());
    const contact = (await contactRepository.findForCustomer(req.customer.id)).find((item) => item.contact_type === type);
    if (!contact) throw new AppError('VALIDATION_ERROR', 'Contact not found.', 400);

    const channel = type === 'PHONE' ? 'WHATSAPP' : 'EMAIL';
    const challenge = await otpChallengeRepository.create({
      id: randomUUID(),
      purpose: 'VERIFY_CONTACT',
      channel,
      destinationNormalized: contact.normalized_value,
      otpHash: 'placeholder',
      customerId: req.customer.id,
      status: 'PENDING',
      attemptCount: 0,
      maxAttempts: Number(env.OTP_MAX_ATTEMPTS),
      expiresAt: toMysqlDateTime(new Date(Date.now() + Number(env.OTP_TTL_SECONDS) * 1000)),
      requestedIp: req.ip,
      userAgent: req.headers['user-agent'] || 'unknown',
    });

    const otp = generateOtpCode();
    await otpChallengeRepository.updateHash(challenge.id, createOtpHash(otp, challenge.id, contact.normalized_value));

    try {
      const provider = channel === 'WHATSAPP' ? contactOtpProviders.WHATSAPP : contactOtpProviders.EMAIL;
      await provider.send({ destination: contact.normalized_value, otp, purpose: 'VERIFY_CONTACT', expiresInSeconds: Number(env.OTP_TTL_SECONDS) });
    } catch {
      throw new AppError('PROVIDER_UNAVAILABLE', 'We could not send the verification code right now.', 503);
    }

    res.json({ data: { challengeId: challenge.id, contactType: type, expiresInSeconds: Number(env.OTP_TTL_SECONDS), resendAfterSeconds: Number(env.OTP_RESEND_COOLDOWN_SECONDS) } });
  } catch (err) {
    next(err);
  }
}

const confirmSchema = z.object({ otp: z.string().regex(/^\d{4}$/) });

export async function confirmContactVerification(req, res, next) {
  try {
    const type = contactTypeSchema.parse(req.params.type.toUpperCase());
    const payload = confirmSchema.parse(req.body);
    const contact = (await contactRepository.findForCustomer(req.customer.id)).find((item) => item.contact_type === type);
    if (!contact) throw new AppError('VALIDATION_ERROR', 'Contact not found.', 400);

    const channel = type === 'PHONE' ? 'WHATSAPP' : 'EMAIL';
    const challenge = await otpChallengeRepository.findLatestPendingContactChallenge(contact.normalized_value, channel, req.customer.id);
    if (!challenge) throw new AppError('OTP_INVALID', 'The verification code is invalid.', 400);
    if (new Date(challenge.expires_at) < new Date()) {
      await otpChallengeRepository.markExpired(challenge.id);
      throw new AppError('OTP_EXPIRED', 'The verification code has expired.', 401);
    }

    if (!safeCompare(createOtpHash(payload.otp, challenge.id, challenge.destination_normalized), challenge.otp_hash)) {
      const nextAttempts = Number(challenge.attempt_count || 0) + 1;
      if (nextAttempts >= Number(challenge.max_attempts || env.OTP_MAX_ATTEMPTS)) {
        await otpChallengeRepository.lock(challenge.id);
        throw new AppError('OTP_ATTEMPTS_EXCEEDED', 'Too many attempts. Please request a new code.', 429);
      }
      await otpChallengeRepository.incrementAttempts(challenge.id, nextAttempts);
      throw new AppError('OTP_INVALID', 'The verification code is invalid.', 400);
    }

    const provider = type === 'PHONE' ? 'PHONE_OTP' : 'EMAIL_OTP';
    const subject = type === 'PHONE' ? normalizePhone(contact.value) : normalizeEmail(contact.value);

    await withTransaction(async (connection) => {
      const existingIdentityRows = await connection.execute('SELECT * FROM customer_identities WHERE provider = ? AND provider_subject = ? LIMIT 1', [provider, subject]);
      const existingIdentity = existingIdentityRows[0][0];
      if (existingIdentity && String(existingIdentity.customer_id) !== String(req.customer.id)) {
        throw new AppError('IDENTITY_CONFLICT', 'This identity is already linked to another customer.', 409);
      }
      await connection.execute('UPDATE customer_contacts SET is_verified = 1, verified_at = NOW(), source = ?, updated_at = NOW() WHERE id = ?', ['CONTACT_VERIFICATION', contact.id]);
      if (!existingIdentity) {
        await connection.execute('INSERT INTO customer_identities (id, customer_id, provider, provider_subject, verified_at, created_at) VALUES (?, ?, ?, ?, NOW(), NOW())', [randomUUID(), req.customer.id, provider, subject]);
      }
      await connection.execute("UPDATE otp_challenges SET status = 'CONSUMED', consumed_at = NOW() WHERE id = ?", [challenge.id]);
    });

    await auditRepository.log({ customerId: req.customer.id, eventType: 'CONTACT_VERIFIED', eventCode: 'CONTACT_VERIFIED', metadata: { type }, requestId: req.id });
    // Wave 8G-2: link any anonymous newsletter subscriber to this now-verified
    // customer email (§40). Best-effort — never blocks contact verification.
    if (type === 'EMAIL') {
      const { newsletterService } = await import('../newsletter/service.js');
      await newsletterService.linkVerifiedCustomerEmail(req.customer.id, normalizeEmail(contact.value)).catch(() => {});
    }
    // A newly verified email/phone gets the default marketing preference —
    // unless the customer has already decided about that channel.
    await applyDefaultMarketingAfterSignIn(req.customer.id);
    res.json({ data: { contactType: type, verified: true } });
  } catch (err) {
    next(err);
  }
}
