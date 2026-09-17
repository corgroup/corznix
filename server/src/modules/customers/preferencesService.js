import { AppError } from '../../utils/errors.js';
import { consentService } from '../consent/service.js';
import { newsletterService } from '../newsletter/service.js';
import { CustomerContactRepository } from './repositories.js';

const contacts = new CustomerContactRepository();

/**
 * Customer-controlled marketing preferences (§44) — Email / WhatsApp
 * marketing and newsletter, each independent. Changing a preference NEVER
 * touches the authentication identity and NEVER affects login OTP (§9).
 */
export class CustomerPreferencesService {
  async #verifiedEndpoint(customerId, channel) {
    const rows = await contacts.findForCustomer(customerId);
    const type = channel === 'WHATSAPP' ? 'PHONE' : 'EMAIL';
    const contact = rows.find((c) => c.contact_type === type && c.is_verified);
    return contact?.normalized_value || null;
  }

  async get(customerId) {
    const [consent, newsletter, rows] = await Promise.all([
      consentService.forCustomer(customerId),
      newsletterService.forCustomer(customerId),
      contacts.findForCustomer(customerId),
    ]);
    // A channel the customer has a number/address for but has not verified
    // cannot carry a preference yet. Say so, instead of the option silently
    // not existing (production: no WhatsApp option, and no reason given).
    const unverified = ['EMAIL', 'WHATSAPP'].filter((channel) => {
      const type = channel === 'WHATSAPP' ? 'PHONE' : 'EMAIL';
      const mine = rows.filter((c) => c.contact_type === type);
      return mine.length > 0 && !mine.some((c) => c.is_verified);
    });
    return {
      // `decided` separates "has never been asked" from "said no". Both arrive
      // as granted:false — an absent consent row defaults to REVOKED (opt-in,
      // §44) — and without the distinction a surface that pre-ticks a box for
      // new customers would also re-tick it for someone who opted out, and
      // silently re-consent them on the next save. `sourceSeq` is 0 only while
      // no decision has ever been recorded.
      channels: consent.map((s) => ({ channel: s.channel, purpose: s.purpose, granted: s.granted, decided: Number(s.sourceSeq || 0) > 0 })),
      newsletter: newsletter ? { status: newsletter.status, email: newsletter.email } : null,
      unverified,
    };
  }

  /**
   * Saying "no" must be recorded even when there was never a subscription to
   * end. newsletterService.unsubscribe 404s on an unknown contact — correct for
   * the public unsubscribe link, wrong here, where a customer who unticks a box
   * they never ticked would see an error and their opt-out would go unrecorded.
   */
  async #unsubscribeOrRevoke({ endpoint, source, customerId }) {
    try {
      await newsletterService.unsubscribe({ email: endpoint, source });
    } catch (err) {
      if (err?.code !== 'NEWSLETTER_NOT_FOUND') throw err;
      await consentService.record({
        contactKey: endpoint, channel: 'EMAIL', purpose: 'NEWSLETTER', action: 'REVOKED',
        source, customerId,
      });
    }
  }

  /**
   * `source` records WHERE the customer made this decision. It used to be
   * hardcoded ACCOUNT_SETTINGS, so a newsletter opt-in taken during checkout
   * was indistinguishable from one made on the account page — and the
   * Subscribers view had no way to report which surface actually converted.
   */
  async set({ customerId, channel, purpose, granted, source = 'ACCOUNT_SETTINGS' }) {
    if (!['EMAIL', 'WHATSAPP'].includes(channel)) throw new AppError('VALIDATION_ERROR', 'Unknown channel.', 400);
    if (!['MARKETING', 'NEWSLETTER'].includes(purpose)) throw new AppError('VALIDATION_ERROR', 'Unknown purpose.', 400);
    if (!['ACCOUNT_SETTINGS', 'CHECKOUT'].includes(source)) throw new AppError('VALIDATION_ERROR', 'Unknown consent source.', 400);
    const endpoint = await this.#verifiedEndpoint(customerId, channel);
    if (!endpoint) {
      throw new AppError('PREFERENCE_ENDPOINT_UNVERIFIED', `Verify your ${channel === 'WHATSAPP' ? 'phone' : 'email'} first.`, 409);
    }

    if (purpose === 'NEWSLETTER' && channel === 'EMAIL') {
      // Goes through newsletterService so the subscriber row, its consent
      // record and the de-duplication rules are the SAME ones the storefront
      // popup and footer use — one subscriber system, not two.
      if (granted) await newsletterService.subscribe({ email: endpoint, source, customerId });
      else await this.#unsubscribeOrRevoke({ endpoint, source, customerId });
    } else {
      await consentService.record({
        contactKey: endpoint, channel, purpose, action: granted ? 'GRANTED' : 'REVOKED',
        source, customerId,
      });
    }
    return this.get(customerId);
  }
}

export const customerPreferencesService = new CustomerPreferencesService();
