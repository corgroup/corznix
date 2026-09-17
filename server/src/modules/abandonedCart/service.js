import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { env } from '../../config/index.js';
import { formatMinor } from '../notifications/format.js';
import { normalizeIndianMobile, resolveRecipient } from '../notifications/recipients.js';
import { communicationService } from '../communications/service.js';
import { communicationRepository } from '../communications/repository.js';
import { consentService } from '../consent/service.js';
import { cartService } from '../cart/service.js';
import { cartRecoveryService } from '../cart/recoveryService.js';
import { promotionRepository } from '../promotions/repository.js';
import { query } from '../../database/connection/pool.js';
import { abandonedCartRepository } from './repository.js';
import { ABANDONED_CART_VARIABLE_SCHEMA } from './templates.js';

const log = logger('abandoned-cart');

const CHANNEL_FIELD = {
  EMAIL: { enabled: 'emailEnabled', key: 'emailTemplateKey' },
  WHATSAPP: { enabled: 'whatsappEnabled', key: 'whatsappTemplateKey' },
};


export class AbandonedCartService {
  constructor({
    repository = abandonedCartRepository,
    communications = communicationService,
    commRepository = communicationRepository,
    consent = consentService,
    carts = cartService,
    cartRecovery = cartRecoveryService,
    promotions = promotionRepository,
  } = {}) {
    this.cartRecovery = cartRecovery;
    this.repository = repository;
    this.communications = communications;
    this.commRepository = commRepository;
    this.consent = consent;
    this.carts = carts;
    this.promotions = promotions;
  }

  // Campaign creation, editing, pausing and deleting are handled by the
  // unified campaign API (marketingCampaigns). This module is the detector:
  // it finds abandoned carts for ACTIVE `cart.abandoned` campaigns and sends
  // the reminder through the communications engine.

  /** Per-customer reminder log for the Cart Recovery page. */
  reminderLog({ campaignIds = null, page = 1, pageSize = 50 } = {}) {
    const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    return this.repository.reminderLog({ campaignIds, limit, offset });
  }

  /**
   * Send this campaign's reminder for ONE named customer's current cart, now.
   *
   * There was no safe way to verify abandoned-cart recovery on production:
   * activating a campaign scans every customer with an abandoned cart, and the
   * only way to see a reminder was to wait out the delay and message whoever
   * happened to qualify. This runs the real reminder path — the customer's
   * real cart, real product image, a real recovery token, the consent gate,
   * the approved template — for one customer only. The only thing it skips is
   * the wait, and it does not consume that cart's real episode, so the
   * scheduled reminder still goes out later as normal.
   *
   * Works on a PAUSED campaign: that is the state a campaign should be tested
   * in, before it is switched on for everyone.
   */
  async sendTestReminder(campaignId, { contact }) {
    const campaign = await this.repository.campaignById(campaignId);
    if (!campaign) throw new AppError('ABANDONED_CART_CAMPAIGN_NOT_FOUND', 'Campaign not found.', 404);

    const raw = String(contact || '').trim();
    if (!raw) throw new AppError('VALIDATION_ERROR', 'Give the customer\'s email address or phone number.', 400);
    const isEmail = raw.includes('@');
    const normalized = isEmail ? raw.toLowerCase() : normalizeIndianMobile(raw);
    if (!normalized) throw new AppError('VALIDATION_ERROR', 'That is not a valid email address or Indian mobile number.', 400);

    const [match] = await query(
      `SELECT customer_id FROM customer_contacts
        WHERE contact_type = ? AND normalized_value = ? LIMIT 1`,
      [isEmail ? 'EMAIL' : 'PHONE', normalized]);
    if (!match) throw new AppError('CUSTOMER_NOT_FOUND', 'No customer account has that email address or phone number.', 404);
    const customerId = match.customer_id;

    const cart = await this.carts.getCart(customerId, { create: false });
    if (!cart.id || !cart.items.length) {
      throw new AppError('CART_EMPTY', 'That customer has nothing in their cart. Add a product to it first.', 409);
    }

    const channels = ['EMAIL', 'WHATSAPP'].filter((ch) => campaign[CHANNEL_FIELD[ch].enabled] && campaign[CHANNEL_FIELD[ch].key]);
    if (!channels.length) throw new AppError('VALIDATION_ERROR', 'Enable at least one channel on this campaign.', 400);

    // Every channel is reported, including the ones that cannot send and why —
    // a test that silently drops a channel would look like a delivery fault.
    const results = [];
    const deliverable = [];
    for (const channel of channels) {
      // eslint-disable-next-line no-await-in-loop
      const recipient = await resolveRecipient(customerId, channel);
      if (!recipient) { results.push({ channel, outcome: 'SKIPPED', reason: 'NO_VERIFIED_CONTACT' }); continue; }
      // eslint-disable-next-line no-await-in-loop
      const gate = await this.consent.isMarketable({ contactKey: recipient.contactKey, channel, purpose: 'MARKETING' });
      if (!gate.marketable) { results.push({ channel, outcome: 'SUPPRESSED', reason: gate.reason || 'NO_CONSENT' }); continue; }
      deliverable.push({ channel, recipient });
    }

    if (deliverable.length) {
      const activityAt = cart.updatedAt ? new Date(cart.updatedAt) : new Date();
      // Its own event id, never the cart's episode key: the test must not use
      // up the reminder the customer would really get.
      const businessEventId = `abandoned_cart_test:${campaign.id}:${cart.id}:${Date.now()}`;
      results.push(...await this.#composeAndEnqueue(campaign, {
        customerId, cart, activityAt, deliverable, businessEventId,
      }));
    }

    log.info('test_reminder', { campaignId, results });
    return {
      product: cart.items[0]?.name || null,
      itemCount: cart.itemCount,
      results,
      note: 'QUEUED means handed to the messaging engine. Check the actual inbox and phone to confirm delivery.',
    };
  }

  // ---- worker: scan + enqueue -----------------------------------
  /**
   * One pass over every ACTIVE campaign. Never throws — a bad campaign or a
   * provider hiccup is logged and skipped. Returns a per-campaign summary.
   */
  async runOnce({ limitPerCampaign = env.ABANDONED_CART_BATCH_SIZE, customerIds = null } = {}) {
    const campaigns = await this.repository.activeCampaignsRaw();
    const summary = { campaigns: campaigns.length, scanned: 0, reminded: 0, skipped: 0, byCampaign: {} };
    for (const campaign of campaigns) {
      // eslint-disable-next-line no-await-in-loop
      const one = await this.#runCampaign(campaign, limitPerCampaign, customerIds).catch((err) => {
        log.error('campaign_run_failed', { campaignId: campaign.id, error: err.message });
        return { scanned: 0, reminded: 0, skipped: 0, error: err.code || 'ERROR' };
      });
      summary.scanned += one.scanned;
      summary.reminded += one.reminded;
      summary.skipped += one.skipped;
      summary.byCampaign[campaign.id] = one;
    }
    return summary;
  }

  async #runCampaign(campaign, limit, customerIds = null) {
    const candidates = await this.repository.candidateCarts(campaign, { limit, customerIds });
    const out = { name: campaign.name, scanned: candidates.length, reminded: 0, skipped: 0 };

    const channels = ['EMAIL', 'WHATSAPP'].filter((ch) => campaign[CHANNEL_FIELD[ch].enabled] && campaign[CHANNEL_FIELD[ch].key]);
    if (!channels.length) return out;

    for (const cand of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const done = await this.#remindCart(campaign, cand, channels).catch((err) => {
        log.error('remind_failed', { campaignId: campaign.id, cartId: cand.cart_id, error: err.message });
        return false;
      });
      if (done) out.reminded += 1; else out.skipped += 1;
    }
    return out;
  }

  async #remindCart(campaign, cand, channels) {
    // Load the canonical cart (price lives here, not on cart_items). This also
    // drops rows whose product/variant/SKU is no longer ACTIVE.
    const cart = await this.carts.getCart(cand.customer_id, { create: false });
    if (!cart.id || !cart.items.length) return false;
    if (cart.subtotalMinor < campaign.minCartValueMinor) return false;

    // cart_activity_at is the episode key. If the live cart has moved on since
    // the candidate query, treat this as a new episode next tick — don't send
    // against a stale timestamp.
    const activityAt = cart.updatedAt ? new Date(cart.updatedAt) : new Date(cand.cart_activity_at);
    if (Math.abs(activityAt.getTime() - new Date(cand.cart_activity_at).getTime()) > 1000) return false;

    const episodeStamp = activityAt.toISOString();
    const businessEventId = `abandoned_cart:${campaign.id}:${cand.cart_id}:${episodeStamp}`;

    // Resolve deliverable + marketable channels BEFORE claiming the episode.
    // A customer with no verified contact / no marketing consent is left as a
    // candidate — if they consent later and the cart is still abandoned, they
    // get reminded then instead of burning this episode on a suppressed send.
    const deliverable = [];
    for (const channel of channels) {
      // eslint-disable-next-line no-await-in-loop
      const recipient = await resolveRecipient(cand.customer_id, channel);
      if (!recipient) continue;
      // eslint-disable-next-line no-await-in-loop
      const gate = await this.consent.isMarketable({ contactKey: recipient.contactKey, channel, purpose: 'MARKETING' });
      if (!gate.marketable) continue;
      deliverable.push({ channel, recipient });
    }
    if (!deliverable.length) return false;

    // Reserve the episode (UNIQUE key). If another tick beat us, stop.
    const claim = await this.repository.recordSend({
      campaignId: campaign.id, cartId: cand.cart_id, customerId: cand.customer_id,
      cartActivityAt: activityAt, cartSubtotalMinor: cart.subtotalMinor,
      channels: deliverable.map((d) => d.channel), businessEventId,
    });
    if (!claim.created) return false;

    const results = await this.#composeAndEnqueue(campaign, {
      customerId: cand.customer_id, cart, activityAt, deliverable, businessEventId,
    });
    return results.some((r) => r.outcome === 'QUEUED');
  }

  /**
   * Build one customer's reminder from THEIR cart and hand it to the engine.
   * Shared by the scheduled scan and by sendTestReminder, so a test exercises
   * exactly the code a real reminder does — recovery token, product image,
   * approved template and all.
   * @returns {Promise<Array<{channel:string, outcome:string, reason?:string}>>}
   */
  async #composeAndEnqueue(campaign, { customerId, cart, activityAt, deliverable, businessEventId }) {
    const couponLine = campaign.couponCode
      ? `Use code ${campaign.couponCode} at checkout for a little extra off.`
      : '';

    // One recovery link per episode, minted for THIS customer. It carries the
    // exact sku + quantity they left, so the button restores that cart rather
    // than dropping them on a shared /cart page that is empty when they are
    // signed out.
    const recovery = await this.cartRecovery.issue({
      customerId,
      cartId: cart.id,
      cartActivityAt: activityAt,
      items: cart.items.map((item) => ({ skuId: item.skuId, quantity: item.quantity })),
    });

    // The product the message is about: the first line of THIS cart. The image
    // comes from the cart line itself (already filtered to ACTIVE IMAGE media
    // by the cart repository), so it is the customer's own product or nothing
    // — never a placeholder and never another customer's.
    const lead = cart.items[0];
    const variantLabel = [lead?.selectedColor, lead?.selectedSize].filter(Boolean).join(' · ');
    const imageUrl = /^https:\/\//i.test(String(lead?.media?.url || '')) ? lead.media.url : null;

    const variables = {
      itemCount: cart.itemCount,
      cartValue: formatMinor(cart.subtotalMinor, cart.currency || 'INR'),
      firstItemName: lead?.name || 'your items',
      couponLine,
      cartUrl: recovery.url,
      customerName: await this.#firstName(customerId),
      productImageUrl: imageUrl,
      productName: lead?.name || 'your items',
      variantLabel,
      quantity: lead?.quantity ?? 1,
      recoveryUrlSuffix: recovery.suffix,
    };

    const results = [];
    for (const { channel, recipient } of deliverable) {
      // The approved WhatsApp template carries an IMAGE header, so a product
      // with no usable photo cannot be sent on that channel at all. Skipping
      // here (rather than letting the provider refuse it later) keeps a doomed
      // message out of the queue; the email still goes.
      if (channel === 'WHATSAPP' && !imageUrl) {
        log.warn('whatsapp_skipped_no_product_image', { campaignId: campaign.id, cartId: cart.id });
        results.push({ channel, outcome: 'SKIPPED', reason: 'NO_PRODUCT_IMAGE' });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.communications.enqueue({
          businessEventId,
          policyKey: 'marketing.abandoned_cart',
          classification: 'MARKETING',
          channel,
          purpose: 'MARKETING',
          templateKey: campaign[CHANNEL_FIELD[channel].key],
          recipient,
          variables: this.#varsFor(variables, channel),
        });
        results.push({ channel, outcome: 'QUEUED' });
      } catch (err) {
        // TEMPLATE_NOT_AVAILABLE etc. — for a scheduled send the episode row
        // stays (so we don't spam retries every tick); logged for the operator.
        log.warn('enqueue_skipped', { campaignId: campaign.id, channel, code: err.code || 'ERROR', detail: err.message });
        results.push({ channel, outcome: 'FAILED', reason: err.code || 'ERROR' });
      }
    }
    return results;
  }

  /**
   * The name the customer is greeted by. Falls back to a neutral greeting
   * rather than "undefined" or an email local-part — a marketing message that
   * opens "Hey null," is worse than one that opens "Hey there,".
   */
  async #firstName(customerId) {
    const [row] = await query('SELECT first_name FROM customers WHERE id = ? LIMIT 1', [customerId]);
    const name = String(row?.first_name || '').trim();
    return name || 'there';
  }

  #varsFor(all, channel) {
    // Only the keys the schema declares — the engine validates against it.
    void channel;
    const out = {};
    for (const key of Object.keys(ABANDONED_CART_VARIABLE_SCHEMA)) {
      // null is OMITTED, not passed through. The renderer rejects a variable
      // that was supplied as null — so passing `productImageUrl: null` for a
      // product with no photograph failed the whole send rather than simply
      // leaving the image out. An absent optional variable renders as nothing.
      if (all[key] !== undefined && all[key] !== null) out[key] = all[key];
    }
    return out;
  }
}

export const abandonedCartService = new AbandonedCartService();
