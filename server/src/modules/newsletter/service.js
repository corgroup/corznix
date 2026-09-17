import { randomBytes } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { normalizeEmail, normalizePhone } from '../../utils/normalize.js';
import { consentService } from '../consent/service.js';
import { CustomerContactRepository } from '../customers/repositories.js';
import { newsletterRepository } from './repository.js';

const contacts = new CustomerContactRepository();

/**
 * Newsletter / subscriber operations (§37-43). A signup never creates a
 * customer account. Dedupe is enforced by the unique normalized email.
 * Every state change also records a channel/purpose consent event.
 *
 * DOUBLE_OPT_IN_POLICY is configuration (`communication_settings`), not a
 * hard-coded assumption (§43).
 */
export class NewsletterService {
  constructor({ repository = newsletterRepository, consent = consentService } = {}) {
    this.repository = repository;
    this.consent = consent;
  }

  #dto(s) {
    return {
      id: s.id,
      channel: s.channel || 'EMAIL',
      contact: s.normalized_contact ?? s.normalized_email,
      email: s.normalized_email ?? null,
      status: s.status,
      source: s.source,
      customerId: s.customer_id ?? null,
      confirmedAt: s.confirmed_at ?? null,
      unsubscribedAt: s.unsubscribed_at ?? null,
      // The CMS list renders this as the "Since" column. It was never in the
      // DTO, so every row there has been showing "Invalid Date" — the repo
      // selected created_at and this dropped it before the page saw it.
      createdAt: s.created_at ?? null,
    };
  }

  async doubleOptInPolicy() {
    const settings = await this.repository.settings();
    return settings?.newsletter_double_opt_in ? 'DOUBLE_OPT_IN' : 'SINGLE_OPT_IN';
  }

  /**
   * Idempotent subscribe. Repeat signup returns the existing subscriber; an
   * UNSUBSCRIBED row is re-activated. Never a second row (§39).
   */
  async subscribe({
    email, phone = null, channel = 'EMAIL',
    source = 'FOOTER_NEWSLETTER', customerId = null, noticeVersion = null,
  }) {
    if (!['EMAIL', 'WHATSAPP'].includes(channel)) {
      throw new AppError('VALIDATION_ERROR', 'Unknown subscription channel.', 400);
    }
    const isWhatsApp = channel === 'WHATSAPP';
    const rawContact = String((isWhatsApp ? phone : email) ?? '').trim();
    const normalized = isWhatsApp ? normalizePhone(rawContact) : normalizeEmail(rawContact);
    if (!normalized) {
      throw new AppError('VALIDATION_ERROR',
        isWhatsApp ? 'Enter a valid mobile number.' : 'Enter a valid email address.', 400);
    }
    // Double opt-in is an emailed confirmation link, so it cannot apply to a
    // WhatsApp subscription — that channel confirms as SUBSCRIBED directly.
    const doubleOptIn = !isWhatsApp && (await this.doubleOptInPolicy()) === 'DOUBLE_OPT_IN';

    let subscriber = await this.repository.byContact(normalized, channel);
    if (subscriber) {
      if (subscriber.status === 'SUBSCRIBED' || subscriber.status === 'PENDING_CONFIRMATION') {
        // Already active/pending — idempotent. Attach the customer id if newly known.
        if (customerId && !subscriber.customer_id) {
          await this.repository.update(subscriber.id, { customer_id: customerId });
          subscriber = await this.repository.byId(subscriber.id);
        }
        return { ...this.#dto(subscriber), deduped: true };
      }
      // Was UNSUBSCRIBED -> re-subscribe (history is preserved).
      const confirmToken = doubleOptIn ? randomBytes(32).toString('hex') : null;
      await this.repository.update(subscriber.id, {
        status: doubleOptIn ? 'PENDING_CONFIRMATION' : 'SUBSCRIBED',
        source, confirm_token: confirmToken, unsubscribed_at: null,
        confirmed_at: doubleOptIn ? null : new Date(),
        customer_id: customerId || subscriber.customer_id,
      });
      subscriber = await this.repository.byId(subscriber.id);
    } else {
      const confirmToken = doubleOptIn ? randomBytes(32).toString('hex') : null;
      let id;
      try {
        id = await this.repository.insert({
          normalizedContact: normalized, rawContact, channel, customerId,
          status: doubleOptIn ? 'PENDING_CONFIRMATION' : 'SUBSCRIBED', source, confirmToken,
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          // Concurrent signup won the race — return its row.
          return { ...this.#dto(await this.repository.byContact(normalized, channel)), deduped: true };
        }
        throw err;
      }
      subscriber = await this.repository.byId(id);
    }

    if (subscriber.status === 'SUBSCRIBED') {
      await this.consent.record({
        contactKey: normalized, channel, purpose: 'NEWSLETTER', action: 'GRANTED',
        source, customerId, subscriberId: subscriber.id, noticeVersion,
      });
    }
    return { ...this.#dto(subscriber), doubleOptInPending: subscriber.status === 'PENDING_CONFIRMATION' };
  }

  async confirm(token) {
    const subscriber = await this.repository.byConfirmToken(token);
    if (!subscriber) throw new AppError('NEWSLETTER_TOKEN_INVALID', 'This confirmation link is invalid or expired.', 404);
    if (subscriber.status === 'SUBSCRIBED') return this.#dto(subscriber);
    await this.repository.update(subscriber.id, { status: 'SUBSCRIBED', confirmed_at: new Date(), confirm_token: null });
    await this.consent.record({
      contactKey: subscriber.normalized_contact ?? subscriber.normalized_email, channel: 'EMAIL', purpose: 'NEWSLETTER', action: 'GRANTED',
      source: 'DOUBLE_OPT_IN', customerId: subscriber.customer_id, subscriberId: subscriber.id,
    });
    return this.#dto(await this.repository.byId(subscriber.id));
  }

  /** Deterministic withdrawal. History is never deleted (§41). */
  async unsubscribe({ email = null, token = null, source = 'UNSUBSCRIBE_LINK' }) {
    let subscriber = token ? await this.repository.byConfirmToken(token) : null;
    if (!subscriber && email) {
      const normalized = normalizeEmail(email);
      subscriber = normalized ? await this.repository.byEmail(normalized) : null;
    }
    if (!subscriber) throw new AppError('NEWSLETTER_NOT_FOUND', 'No matching subscription.', 404);
    if (subscriber.status !== 'UNSUBSCRIBED') {
      await this.repository.update(subscriber.id, { status: 'UNSUBSCRIBED', unsubscribed_at: new Date(), confirm_token: null });
    }
    // REVOKE records + raises a CONSENT_REVOKED suppression via consentService.
    await this.consent.record({
      contactKey: subscriber.normalized_contact ?? subscriber.normalized_email,
      channel: subscriber.channel || 'EMAIL',
      purpose: 'NEWSLETTER', action: 'REVOKED',
      source, customerId: subscriber.customer_id, subscriberId: subscriber.id,
    });
    return this.#dto(await this.repository.byId(subscriber.id));
  }

  /** Link anonymous subscriber rows to a now-verified customer email (§40). */
  async linkVerifiedCustomerEmail(customerId, normalizedEmail) {
    if (!customerId || !normalizedEmail) return;
    await this.repository.linkCustomerByEmail(normalizedEmail, customerId);
    await this.consent.linkCustomer(normalizedEmail, 'EMAIL', customerId);
  }

  async forCustomer(customerId) {
    const rows = await contacts.findForCustomer(customerId);
    const emails = rows.filter((c) => c.contact_type === 'EMAIL' && c.is_verified).map((c) => c.normalized_value);
    for (const e of emails) {
      const s = await this.repository.byEmail(e);
      if (s) return this.#dto(s);
    }
    return null;
  }

  // ---- CMS ----------------------------------------------------------
  list(filters) { return this.repository.list(filters).then((rows) => rows.map((s) => this.#dto(s))); }

  async detail(id) {
    const s = await this.repository.byId(id);
    if (!s) throw new AppError('NEWSLETTER_NOT_FOUND', 'Subscriber not found.', 404);
    // normalized_contact, not normalized_email: a WhatsApp subscriber has no
    // email at all since migration 102, and keying off the email column would
    // show that subscriber an empty consent history and no suppressions.
    const key = s.normalized_contact ?? s.normalized_email;
    const [consentHistory, suppressions] = await Promise.all([
      this.consent.history({ contactKey: key }),
      this.consent.suppressionsForKey(key),
    ]);
    return { ...this.#dto(s), consentHistory, suppressions };
  }
}

export const newsletterService = new NewsletterService();
