// Marketing campaigns run from the CMS: Offer campaigns and New Collection
// campaigns, over WhatsApp and/or Email, to an audience built from registered
// users, newsletter subscribers, uploaded contact files, or any combination.
//
// Three rules this module exists to enforce, none of which can be switched off
// from the CMS:
//
//  1. BEING IN A LIST IS NOT CONSENT. Eligibility is decided by ConsentService
//     per contact per channel when the batch is processed, and the
//     communications engine re-checks it again immediately before the send —
//     which is what catches an unsubscribe that lands mid-campaign.
//  2. ONE CONTACT, ONE MESSAGE. The snapshot table has a UNIQUE key on
//     (campaign_id, channel, contact_key), so somebody who appears in the
//     customer table, the newsletter list AND an uploaded CSV still gets
//     exactly one message. The database enforces it, not this code.
//  3. WHATSAPP SENDS ONLY ON AN APPROVED META TEMPLATE. A campaign whose
//     template Meta has not approved is BLOCKED, never quietly downgraded.
//
// Sending is a queue, not a loop: launch() writes the snapshot and returns.
// runDue() then processes it in batches sized by configuration and clamped to
// what the provider will actually accept, so a 100,000-person audience is the
// same code path as a 100-person one and neither fires 100,000 requests at
// once.
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { env, storefrontBaseUrl } from '../../config/index.js';
import { query } from '../../database/connection/pool.js';
import { communicationService } from '../communications/service.js';
import { communicationRepository } from '../communications/repository.js';
import { consentService } from '../consent/service.js';
import { META_TEMPLATE_CONTRACT } from '../communications/providers.js';
import { parseAudienceFile } from './audienceFile.js';
import { catalogService } from '../catalog/service.js';
import { normalizeIndianMobile } from '../notifications/recipients.js';
import { marketingCampaignRepository, campaignEventPrefix } from './repository.js';
import { TRIGGERS, triggerOf, availableTriggers } from './triggers.js';
import { promotionRepository } from '../promotions/repository.js';
import { segmentService } from '../segments/service.js';

const log = logger('marketing-campaigns');

const CHANNELS = Object.freeze(['EMAIL', 'WHATSAPP']);

// Statuses in which a campaign's configuration may change. An ACTIVE or
// SCHEDULED campaign has exactly one configuration: pause it to edit.
const EDITABLE = Object.freeze(['DRAFT', 'PAUSED']);
const ONE_OFF_TRIGGERS = Object.freeze(['SEND_NOW', 'SCHEDULED']);

const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

export const AUDIENCE_SOURCE_TYPES = Object.freeze([
  'REGISTERED_USERS', 'SEGMENT', 'EMAIL_SUBSCRIBERS', 'WHATSAPP_SUBSCRIBERS', 'LIST',
]);
export const REGISTERED_USER_FILTERS = Object.freeze([
  'ALL', 'NEW_USERS', 'HAS_ORDERED', 'NEVER_ORDERED',
]);

// Batch sizing. The default is modest and the ceiling is what the provider
// will actually take; a campaign asking for more is clamped rather than
// refused, because the admin's intent ("send it all") is still honoured — just
// over more passes.
const DEFAULT_BATCH_SIZE = Number(env.MARKETING_BATCH_SIZE || 100);
const MAX_BATCH_SIZE = Number(env.MARKETING_MAX_BATCH_SIZE || 500);
// Pause between individual provider hand-offs inside a batch, so a big
// campaign spreads out instead of arriving as a burst.
const PER_MESSAGE_DELAY_MS = Number(env.MARKETING_SEND_SPACING_MS || 0);
const FREQUENCY_CAP_HOURS = Number(env.MARKETING_FREQUENCY_CAP_HOURS ?? 24);

const trimOrNull = (v, max) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Which consent purpose a recipient is judged against, decided by where they
 * came into the audience from.
 *
 * The ledger models MARKETING and NEWSLETTER as separate purposes, and the
 * storefront's newsletter signup grants NEWSLETTER — that is the box the
 * customer actually ticked ("new releases, stories and updates"). Asking for
 * MARKETING instead suppressed every newsletter subscriber as NO_CONSENT,
 * which is how this was found: a New Collection campaign on production
 * resolved 3 subscribers and could send to none of them.
 *
 * So a subscriber audience is judged on NEWSLETTER, and registered users or an
 * uploaded list on MARKETING. A contact reached from more than one source
 * keeps the first source that named them, so the purpose matches the
 * permission they actually gave.
 */
const purposeForSource = (source) => (
  String(source || '').startsWith('EMAIL_SUBSCRIBERS')
  || String(source || '').startsWith('WHATSAPP_SUBSCRIBERS')
    ? 'NEWSLETTER' : 'MARKETING');
// Resolved in config (see storefrontBaseUrl): STOREFRONT_BASE_URL itself is
// unset in both deployments and defaults to localhost.
const STOREFRONT_URL = storefrontBaseUrl;
const sleep = (ms) => (ms > 0 ? new Promise((r) => { setTimeout(r, ms); }) : Promise.resolve());

export class MarketingCampaignService {
  constructor({
    repository = marketingCampaignRepository,
    communications = communicationService,
    commRepository = communicationRepository,
    consent = consentService,
  } = {}) {
    this.repository = repository;
    this.communications = communications;
    this.commRepository = commRepository;
    this.consent = consent;
  }

  // ================= audience lists =================================
  listAudienceLists(brandId) { return this.repository.listLists(brandId); }

  /**
   * Parse and stage an uploaded file as a reusable list. NOTHING becomes
   * audience here: the list stays unconfirmed until the admin has seen the
   * valid / invalid / duplicate breakdown.
   */
  async uploadList(brandId, { buffer, filename, name, staffId }) {
    if (!buffer?.length) throw new AppError('VALIDATION_ERROR', 'No file was uploaded.', 400);
    let parsed;
    try {
      parsed = parseAudienceFile(buffer, filename);
    } catch (error) {
      throw new AppError(error.message || 'AUDIENCE_FILE_UNREADABLE',
        error.userMessage || 'That file could not be read. Save it as .csv or .xlsx and try again.', 400);
    }
    const listId = await this.repository.insertList({
      brandId,
      name: trimOrNull(name, 160) || trimOrNull(filename, 160) || 'Imported list',
      filename: String(filename || 'upload').slice(0, 255),
      counts: parsed.counts, rows: parsed.rows, staffId,
    });
    return this.listPreview(listId, brandId);
  }

  async listPreview(listId, brandId) {
    const record = await this.repository.listById(listId, brandId);
    if (!record) throw new AppError('AUDIENCE_LIST_NOT_FOUND', 'Audience list not found.', 404);
    const samples = await this.repository.listSample(listId);
    return {
      listId,
      name: record.name,
      filename: record.filename,
      confirmed: Boolean(record.confirmed_at),
      counts: {
        total: Number(record.total_rows),
        valid: Number(record.valid_rows),
        invalid: Number(record.invalid_rows),
        duplicate: Number(record.duplicate_rows),
        missingPhone: Number(record.missing_phone_rows),
        missingEmail: Number(record.missing_email_rows),
        invalidPhone: Number(record.invalid_phone_rows),
        invalidEmail: Number(record.invalid_email_rows),
        existingCustomers: Number(record.existing_customer_rows),
        newExternalContacts: Number(record.valid_rows) - Number(record.existing_customer_rows),
      },
      samples,
      // Said out loud so nobody reads "valid" as "will be sent".
      note: 'Valid means the phone or email is well-formed. Whether each contact may be messaged is decided by their marketing consent when the campaign runs.',
    };
  }

  async confirmList(listId, brandId) {
    if (!await this.repository.confirmList(listId, brandId)) {
      throw new AppError('LIST_NOT_CONFIRMABLE', 'That list does not exist or is already confirmed.', 409);
    }
    return this.listPreview(listId, brandId);
  }

  async discardList(listId, brandId) {
    if (!await this.repository.discardList(listId, brandId)) {
      throw new AppError('LIST_NOT_DISCARDABLE', 'A confirmed list cannot be discarded.', 409);
    }
    return { discarded: true };
  }

  // ================= campaigns ======================================
  async list(brandId) {
    const rows = await this.repository.list(brandId);
    const channels = await this.repository.channels(rows.map((r) => r.id));
    return rows.map((r) => this.#dto(r, channels.filter((c) => c.campaign_id === r.id)));
  }

  /** What the builder offers: campaign types and the triggers that can fire today. */
  async options() {
    const types = await this.repository.types();
    return {
      types: types.map((t) => ({
        key: t.type_key, label: t.label, description: t.description,
        suggestedTrigger: t.suggested_trigger, contentFields: parseJson(t.content_fields) || [],
      })),
      triggers: availableTriggers(),
      audienceSources: AUDIENCE_SOURCE_TYPES,
      registeredUserFilters: REGISTERED_USER_FILTERS,
    };
  }

  async get(id, brandId) {
    const campaign = await this.#require(id, brandId);
    const [snapshot, reasons, delivery, funnel, runs] = await Promise.all([
      this.repository.snapshotCounts(id),
      this.repository.suppressionReasons(id),
      this.repository.delivery(id),
      this.repository.funnel(id),
      this.repository.runsFor(id),
    ]);
    let reminders = null;
    if (campaign.trigger_event === 'cart.abandoned') {
      const { abandonedCartRepository } = await import('../abandonedCart/repository.js');
      reminders = await abandonedCartRepository.campaignStats(id);
    }
    return { ...campaign, runs, report: { snapshot, reasons, delivery, funnel, reminders } };
  }

  #dto(row, channels) {
    const trigger = triggerOf(row);
    return {
      ...row,
      trigger_config: parseJson(row.trigger_config) || null,
      audience_sources: parseJson(row.audience_sources) || [],
      channels: channels.map((c) => ({
        channel: c.channel, templateKey: c.template_key,
        providerTemplateRef: c.provider_template_ref || null,
        variableMapping: parseJson(c.variable_mapping) || null,
      })),
      trigger: trigger ? { key: trigger.key, label: trigger.label, kind: trigger.kind, perCustomer: Boolean(trigger.perCustomer) } : null,
    };
  }

  async recipients(id, brandId, { page = 1, pageSize = 50, channel = null } = {}) {
    await this.#require(id, brandId);
    const limit = Math.min(Math.max(Number(pageSize) || 50, 1), 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
    return this.repository.recipients(id, { limit, offset, channel: CHANNELS.includes(channel) ? channel : null });
  }

  /** Cart Recovery page: every abandoned-cart reminder sent by this brand's cart campaigns. */
  async cartReminderLog(brandId, { page = 1, pageSize = 50, campaignId = null } = {}) {
    const campaigns = (await this.repository.list(brandId)).filter((c) => c.trigger_event === 'cart.abandoned');
    const ids = campaignId ? campaigns.filter((c) => c.id === campaignId).map((c) => c.id) : campaigns.map((c) => c.id);
    if (!ids.length) return { total: 0, reminders: [] };
    const { abandonedCartService } = await import('../abandonedCart/service.js');
    return abandonedCartService.reminderLog({ campaignIds: ids, page, pageSize });
  }

  async #require(id, brandId) {
    const row = await this.repository.byId(id, brandId);
    if (!row) throw new AppError('MARKETING_CAMPAIGN_NOT_FOUND', 'Campaign not found.', 404);
    return this.#dto(row, await this.repository.channels(id));
  }

  #cleanSources(sources) {
    if (!Array.isArray(sources)) throw new AppError('VALIDATION_ERROR', 'audienceSources must be an array.', 400);
    return sources.map((s) => {
      if (!AUDIENCE_SOURCE_TYPES.includes(s?.type)) {
        throw new AppError('VALIDATION_ERROR', `Unknown audience source "${s?.type}".`, 400);
      }
      if (s.type === 'REGISTERED_USERS') {
        const filter = s.filter || 'ALL';
        if (!REGISTERED_USER_FILTERS.includes(filter)) {
          throw new AppError('VALIDATION_ERROR', `Unknown registered-user filter "${filter}".`, 400);
        }
        return { type: s.type, filter };
      }
      if (s.type === 'LIST') {
        if (!s.listId) throw new AppError('VALIDATION_ERROR', 'A LIST source needs a listId.', 400);
        return { type: 'LIST', listId: String(s.listId) };
      }
      if (s.type === 'SEGMENT') {
        if (!s.segmentId) throw new AppError('VALIDATION_ERROR', 'Choose a customer segment.', 400);
        return { type: 'SEGMENT', segmentId: String(s.segmentId) };
      }
      return { type: s.type };
    });
  }

  /** Content fields shared by every campaign type. */
  #clean(input) {
    const out = {};
    if (input.name !== undefined) {
      const name = trimOrNull(input.name, 160);
      if (!name || name.length < 2) throw new AppError('VALIDATION_ERROR', 'A campaign name is required.', 400);
      out.name = name;
    }
    if (input.audienceSources !== undefined) out.audience_sources = JSON.stringify(this.#cleanSources(input.audienceSources));
    if (input.offerName !== undefined) out.offer_name = trimOrNull(input.offerName, 160);
    if (input.offerDetails !== undefined) out.offer_details = trimOrNull(input.offerDetails, 500);
    if (input.collectionSlug !== undefined) out.collection_slug = trimOrNull(input.collectionSlug, 160);
    if (input.ctaLabel !== undefined) out.cta_label = trimOrNull(input.ctaLabel, 40);
    if (input.emailSubject !== undefined) out.email_subject = trimOrNull(input.emailSubject, 240);
    if (input.batchSize !== undefined) {
      const n = Number(input.batchSize);
      if (!Number.isFinite(n) || n < 1) throw new AppError('VALIDATION_ERROR', 'batchSize must be a positive number.', 400);
      // Clamped, not refused: the admin's ceiling cannot exceed the provider's.
      out.batch_size = Math.min(Math.trunc(n), MAX_BATCH_SIZE);
    }
    // A campaign image and a CTA both end up in front of a customer, so they
    // must be absolute https URLs — a relative path or an http link renders as
    // a broken image or an insecure redirect in WhatsApp.
    for (const [field, column] of [['imageUrl', 'image_url'], ['ctaUrl', 'cta_url']]) {
      if (input[field] === undefined) continue;
      const value = trimOrNull(input[field], 1024);
      if (value && !/^https:\/\/[^\s]+$/i.test(value)) {
        throw new AppError('VALIDATION_ERROR', `${field} must be an absolute https:// URL.`, 400);
      }
      out[column] = value;
    }
    return out;
  }

  async #cleanType(key) {
    const type = key ? await this.repository.typeByKey(String(key)) : null;
    if (!type || !type.is_active) throw new AppError('VALIDATION_ERROR', `Unknown campaign type "${key}".`, 400);
    return type;
  }

  /** [{ channel, templateKey, providerTemplateRef? }] — one entry per channel. */
  #cleanChannels(channels) {
    if (!Array.isArray(channels)) throw new AppError('VALIDATION_ERROR', 'channels must be an array.', 400);
    const seen = new Set();
    return channels.map((c) => {
      if (!CHANNELS.includes(c?.channel)) throw new AppError('VALIDATION_ERROR', `Unknown channel "${c?.channel}".`, 400);
      if (seen.has(c.channel)) throw new AppError('VALIDATION_ERROR', `${c.channel} is listed twice.`, 400);
      seen.add(c.channel);
      const templateKey = trimOrNull(c.templateKey, 80);
      if (!templateKey) throw new AppError('VALIDATION_ERROR', `Choose a template for ${c.channel}.`, 400);
      return { channel: c.channel, templateKey, providerTemplateRef: trimOrNull(c.providerTemplateRef, 120) };
    });
  }

  /** { key: 'send_now'|'scheduled'|<event>, scheduledAt?, config? } -> row columns */
  async #cleanTrigger(trigger) {
    const def = TRIGGERS[trigger?.key];
    if (!def || !def.available) throw new AppError('VALIDATION_ERROR', `Trigger "${trigger?.key}" is not available.`, 400);
    const out = {
      trigger_type: def.type,
      trigger_event: def.type === 'EVENT' ? def.key : null,
      trigger_config: null,
      scheduled_at: null,
    };
    if (def.type === 'SCHEDULED') {
      const at = trigger.scheduledAt ? new Date(trigger.scheduledAt) : null;
      if (!at || Number.isNaN(at.getTime())) throw new AppError('VALIDATION_ERROR', 'Choose the date and time to send.', 400);
      out.scheduled_at = at;
    }
    if (def.configSchema) {
      const parsed = def.configSchema.safeParse(trigger.config || {});
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 400);
      }
      const config = parsed.data;
      if (config.couponCode) {
        // A dead code in a marketing message is worse than no code.
        const code = config.couponCode.toUpperCase();
        const coupon = await promotionRepository.couponByCode(null, code);
        if (!coupon) throw new AppError('COUPON_NOT_FOUND', `No promotion coupon "${code}".`, 400);
        config.couponCode = coupon.code_display || code;
      } else {
        config.couponCode = null;
      }
      out.trigger_config = JSON.stringify(config);
    }
    return out;
  }

  async create(brandId, input, staffId) {
    const clean = this.#clean(input);
    if (!clean.name) throw new AppError('VALIDATION_ERROR', 'A campaign name is required.', 400);
    const type = await this.#cleanType(input.campaignType || 'CUSTOM');
    clean.campaign_type = type.type_key;
    Object.assign(clean, await this.#cleanTrigger(input.trigger || { key: type.suggested_trigger }));
    const row = await this.repository.insert(brandId, clean, staffId);
    if (input.channels !== undefined) await this.repository.replaceChannels(row.id, this.#cleanChannels(input.channels));
    return this.#require(row.id, brandId);
  }

  async update(id, brandId, patch) {
    const campaign = await this.#require(id, brandId);
    if (!EDITABLE.includes(campaign.status)) {
      throw new AppError('CAMPAIGN_NOT_EDITABLE',
        campaign.status === 'ACTIVE' || campaign.status === 'SCHEDULED'
          ? 'Pause this campaign before changing it.'
          : 'A completed or cancelled campaign is a record of what was sent and cannot be changed.', 409);
    }
    const clean = this.#clean(patch);
    if (patch.campaignType !== undefined) clean.campaign_type = (await this.#cleanType(patch.campaignType)).type_key;
    if (patch.trigger !== undefined) Object.assign(clean, await this.#cleanTrigger(patch.trigger));
    await this.repository.update(id, brandId, clean);
    if (patch.channels !== undefined) await this.repository.replaceChannels(id, this.#cleanChannels(patch.channels));
    return this.#require(id, brandId);
  }

  /**
   * Copy a campaign into a new DRAFT: type, channels and templates, audience,
   * trigger and content. How a recurring launch is sent — duplicate last
   * time's campaign, change the image and link, activate. The original stays
   * an untouched record of what it sent. A one-off schedule is not copied
   * (its time has usually passed); the copy is set to Send now.
   */
  async duplicate(id, brandId, staffId) {
    const source = await this.#require(id, brandId);
    const oneOff = source.trigger_type !== 'EVENT';
    const copy = await this.create(brandId, {
      name: `${source.name} (copy)`.slice(0, 160),
      campaignType: source.campaign_type,
      channels: source.channels.map((c) => ({ channel: c.channel, templateKey: c.templateKey, providerTemplateRef: c.providerTemplateRef })),
      trigger: oneOff ? { key: 'send_now' } : { key: source.trigger_event, config: source.trigger_config || {} },
      audienceSources: source.audience_sources,
      offerName: source.offer_name, offerDetails: source.offer_details,
      collectionSlug: source.collection_slug, imageUrl: source.image_url,
      ctaLabel: source.cta_label, ctaUrl: source.cta_url, emailSubject: source.email_subject,
      ...(source.batch_size ? { batchSize: Number(source.batch_size) } : {}),
    }, staffId);
    log.info('campaign_duplicated', { from: id, to: copy.id });
    return copy;
  }

  async remove(id, brandId) {
    const campaign = await this.#require(id, brandId);
    const runs = await this.repository.runsFor(id);
    if (campaign.status !== 'DRAFT' || runs.length || Number(campaign.reminder_count || 0)) {
      throw new AppError('CAMPAIGN_NOT_DELETABLE', 'Only a draft that has never run can be deleted. Cancel it instead.', 409);
    }
    return { deleted: await this.repository.remove(id, brandId) };
  }

  // ================= audience resolution ============================
  /**
   * Resolve every configured source into (channel, contactKey) pairs and
   * deduplicate them in memory before they reach the database. The UNIQUE key
   * is still the guarantee; this just keeps the write small.
   */
  #sources(campaign) {
    if (!campaign.audience_sources) return [];
    return typeof campaign.audience_sources === 'string' ? JSON.parse(campaign.audience_sources) : campaign.audience_sources;
  }

  async #resolveAudience(campaign) {
    const sources = this.#sources(campaign);
    const channels = campaign.channels.map((c) => c.channel);
    const byKey = new Map();
    const add = (channel, contactKey, displayName, source, customerId = null) => {
      if (!channels.includes(channel) || !contactKey) return;
      const k = `${channel}|${contactKey}`;
      // First source to mention a contact owns the attribution; a later
      // duplicate is dropped rather than overwriting it.
      if (!byKey.has(k)) byKey.set(k, { channel, contactKey, displayName: displayName || null, source, customerId });
    };

    for (const source of sources) {
      if (source.type === 'REGISTERED_USERS') {
        // eslint-disable-next-line no-await-in-loop
        const rows = await this.repository.registeredUsers(campaign.brand_id, source.filter || 'ALL');
        for (const r of rows) {
          add(r.contact_type === 'EMAIL' ? 'EMAIL' : 'WHATSAPP', r.contact_key, r.display_name, `REGISTERED_USERS:${source.filter || 'ALL'}`, r.customer_id);
        }
      } else if (source.type === 'SEGMENT') {
        // eslint-disable-next-line no-await-in-loop
        const ids = await segmentService.memberIds(source.segmentId);
        // eslint-disable-next-line no-await-in-loop
        const rows = await this.repository.customerContacts(campaign.brand_id, ids);
        for (const r of rows) {
          add(r.contact_type === 'EMAIL' ? 'EMAIL' : 'WHATSAPP', r.contact_key, r.display_name, `SEGMENT:${source.segmentId}`, r.customer_id);
        }
      } else if (source.type === 'EMAIL_SUBSCRIBERS' || source.type === 'WHATSAPP_SUBSCRIBERS') {
        const channel = source.type === 'EMAIL_SUBSCRIBERS' ? 'EMAIL' : 'WHATSAPP';
        // eslint-disable-next-line no-await-in-loop
        const rows = await this.repository.subscribers(campaign.brand_id, channel);
        for (const r of rows) add(channel, r.contact_key, r.display_name, source.type, r.customer_id);
      } else if (source.type === 'LIST') {
        // eslint-disable-next-line no-await-in-loop
        const rows = await this.repository.listContacts(source.listId);
        for (const r of rows) {
          add('EMAIL', r.email, r.display_name, `LIST:${source.listId}`);
          add('WHATSAPP', r.phone_e164, r.display_name, `LIST:${source.listId}`);
        }
      }
    }
    return [...byKey.values()];
  }

  /**
   * What the admin sees before launching: how big the audience is, and how
   * much of it is actually reachable once consent is applied. This does the
   * real consent lookups — it is a preview of the decision, not an estimate.
   */
  async audiencePreview(id, brandId) {
    const campaign = await this.#require(id, brandId);
    const resolved = await this.#resolveAudience(campaign);
    const counts = {
      total: resolved.length, emailEligible: 0, whatsappEligible: 0,
      suppressed: 0, bySource: {},
    };
    const suppressedReasons = {};
    const eligibleContacts = new Set();
    // People, not messages: contacts belonging to one customer — or the same
    // address on two customer accounts — are one person.
    const personOf = new Map(); // contactKey|customerId -> person id
    const people = new Map(); // person id -> { email, whatsapp, disabled }
    const personFor = (r) => {
      const ids = [r.customerId && `c:${r.customerId}`, `k:${r.contactKey}`].filter(Boolean);
      let pid = ids.map((i) => personOf.get(i)).find(Boolean);
      if (!pid) { pid = ids[0]; people.set(pid, { email: false, whatsapp: false, disabled: false, capped: false }); }
      for (const i of ids) personOf.set(i, pid);
      return people.get(pid);
    };
    for (const r of resolved) {
      const person = personFor(r);
      counts.bySource[r.source] = (counts.bySource[r.source] || 0) + 1;
      // eslint-disable-next-line no-await-in-loop
      const gate = await this.consent.isMarketable({
        contactKey: r.contactKey, channel: r.channel, purpose: purposeForSource(r.source),
      });
      // eslint-disable-next-line no-await-in-loop
      if (gate.marketable && await this.repository.recentlyMarketed(r.contactKey, r.channel, FREQUENCY_CAP_HOURS)) {
        person.capped = true;
        counts.frequencyCapped = (counts.frequencyCapped || 0) + 1;
        suppressedReasons.FREQUENCY_CAP = (suppressedReasons.FREQUENCY_CAP || 0) + 1;
        continue;
      }
      if (!gate.marketable) {
        person.disabled = true;
        counts.suppressed += 1;
        const reason = gate.reason || 'No marketing consent';
        suppressedReasons[reason] = (suppressedReasons[reason] || 0) + 1;
        continue;
      }
      if (r.channel === 'EMAIL') { counts.emailEligible += 1; person.email = true; } else { counts.whatsappEligible += 1; person.whatsapp = true; }
      eligibleContacts.add(r.contactKey);
    }
    const peopleList = [...people.values()];
    const registeredSources = this.#sources(campaign).filter((s) => s.type === 'REGISTERED_USERS');
    let registeredTotal = null;
    if (registeredSources.length) {
      const totals = await Promise.all(registeredSources.map((s) => this.repository.registeredCustomerCount(campaign.brand_id, s.filter || 'ALL')));
      registeredTotal = Math.max(...totals);
    }
    const registeredReached = new Set(resolved.filter((r) => r.customerId && r.source.startsWith('REGISTERED_USERS')).map((r) => r.customerId)).size;
    counts.people = {
      // Everyone the sources name, after merging duplicate accounts.
      total: peopleList.length,
      emailEligible: peopleList.filter((p) => p.email).length,
      whatsappEligible: peopleList.filter((p) => p.whatsapp).length,
      bothEligible: peopleList.filter((p) => p.email && p.whatsapp).length,
      // Has a reachable contact but turned marketing off (or is suppressed) on
      // at least one channel.
      disabled: peopleList.filter((p) => p.disabled).length,
      // Reachable, but already received marketing on that channel within the
      // frequency cap — held back for this campaign.
      frequencyCapped: peopleList.filter((p) => p.capped).length,
      frequencyCapHours: FREQUENCY_CAP_HOURS,
      finalSendable: peopleList.filter((p) => p.email || p.whatsapp).length,
      registeredCustomers: registeredTotal,
      // Registered customers with no verified email or phone on an enabled
      // channel: nothing can be sent to them.
      missingContact: registeredTotal === null ? null : Math.max(0, registeredTotal - registeredReached),
    };
    return {
      ...counts,
      suppressedReasons,
      // The number that matters: how many messages will actually be attempted.
      finalSendable: counts.emailEligible + counts.whatsappEligible,
      distinctPeople: eligibleContacts.size,
    };
  }

  // ================= readiness ======================================
  /**
   * Everything that would stop this campaign from sending correctly, in words
   * an admin can act on. Activation is refused while any blocker remains.
   */
  async readiness(id, brandId) {
    const campaign = await this.#require(id, brandId);
    const blockers = [];
    const trigger = triggerOf(campaign);
    const channels = campaign.channels.map((c) => c.channel);

    if (!trigger || !TRIGGERS[trigger.key]?.available) {
      blockers.push({ code: 'TRIGGER_NOT_AVAILABLE', message: 'Choose how this campaign is triggered.' });
    }
    if (!channels.length) blockers.push({ code: 'NO_CHANNEL', message: 'Choose WhatsApp, Email, or both.' });
    if (!trigger?.perCustomer && !this.#sources(campaign).length) {
      blockers.push({ code: 'NO_AUDIENCE_SOURCE', message: 'Choose who receives this campaign.' });
    }
    if (campaign.trigger_type === 'SCHEDULED' && campaign.status === 'DRAFT'
        && (!campaign.scheduled_at || new Date(campaign.scheduled_at) <= new Date())) {
      blockers.push({ code: 'SCHEDULE_IN_PAST', message: 'Choose a send time in the future.' });
    }

    // Variables a message needs, filled from this campaign. Per-customer events
    // (abandoned cart) fill theirs from the event itself at send time.
    const sample = trigger?.perCustomer ? null : await this.#variablesFor(campaign, { display_name: 'there' });

    for (const ch of campaign.channels) {
      const { channel, templateKey } = ch;
      // eslint-disable-next-line no-await-in-loop
      const template = await this.commRepository.activeTemplate(null, templateKey, channel);
      if (!template) {
        // A WhatsApp row kept DRAFT because Meta is still reviewing it must say so.
        // eslint-disable-next-line no-await-in-loop
        const [latest] = await query(
          `SELECT status, provider_template_ref FROM communication_templates
            WHERE brand_id = ? AND template_key = ? AND channel = ?
            ORDER BY (status = 'DRAFT') DESC, version DESC LIMIT 1`, [campaign.brand_id, templateKey, channel]);
        const ref = ch.providerTemplateRef || latest?.provider_template_ref;
        if (channel === 'WHATSAPP' && ref && META_TEMPLATE_CONTRACT[ref]?.pendingApproval) {
          blockers.push({ code: 'META_TEMPLATE_PENDING_APPROVAL', channel, message: `"${ref}" is still awaiting Meta approval. WhatsApp cannot send on it yet.` });
        } else {
          blockers.push({ code: 'TEMPLATE_NOT_ACTIVE', channel, message: `The ${channel === 'EMAIL' ? 'email' : 'WhatsApp'} template "${templateKey}" is not active.` });
        }
        continue;
      }
      if (template.classification !== 'MARKETING') {
        blockers.push({ code: 'TEMPLATE_NOT_MARKETING', channel, message: `Template "${templateKey}" is ${template.classification}, not MARKETING.` });
      }
      let headerImageVar = null;
      if (channel === 'WHATSAPP') {
        // WhatsApp sends only on a template name Meta has approved.
        const ref = ch.providerTemplateRef || template.provider_template_ref;
        if (!ref) {
          blockers.push({ code: 'META_TEMPLATE_MISSING', channel, message: 'No Meta-approved WhatsApp template name is configured.' });
        } else if (!META_TEMPLATE_CONTRACT[ref]) {
          blockers.push({ code: 'META_TEMPLATE_NOT_APPROVED', channel, message: `"${ref}" is not a known Meta-approved template.` });
        } else if (META_TEMPLATE_CONTRACT[ref].pendingApproval) {
          blockers.push({ code: 'META_TEMPLATE_PENDING_APPROVAL', channel, message: `"${ref}" is still awaiting Meta approval. WhatsApp cannot send on it yet.` });
        } else {
          headerImageVar = META_TEMPLATE_CONTRACT[ref].headerImage || null;
        }
      }
      if (sample) {
        const schema = parseJson(template.variable_schema) || {};
        const missing = Object.entries(schema)
          .filter(([name, def]) => (def?.required || name === headerImageVar) && !String(sample[name] ?? '').trim())
          .map(([name]) => name);
        if (missing.length && !(campaign.campaign_type === 'NEW_COLLECTION' && missing.every((m) => /image/i.test(m)))) {
          blockers.push({ code: 'TEMPLATE_VARIABLE_MISSING', channel, message: `This template needs: ${missing.join(', ')}.` });
        }
        if (channel === 'WHATSAPP' && headerImageVar && !String(sample[headerImageVar] ?? '').trim() && campaign.campaign_type !== 'NEW_COLLECTION') {
          blockers.push({ code: 'OFFER_IMAGE_MISSING', channel, message: 'This WhatsApp template shows an image. Add campaign artwork.' });
        }
      }
    }

    if (campaign.campaign_type === 'NEW_COLLECTION') {
      if (!campaign.collection_slug) {
        blockers.push({ code: 'COLLECTION_MISSING', message: 'Select the collection this campaign is for.' });
      } else {
        // The collection has to exist and have a picture, or the message goes
        // out with no image and a link to nowhere (production, 2026-09-17).
        const resolved = await this.#collection(campaign.collection_slug);
        if (!resolved) {
          blockers.push({ code: 'COLLECTION_NOT_FOUND', message: `No active collection "${campaign.collection_slug}".` });
        } else if (!campaign.image_url && !resolved.image) {
          blockers.push({
            code: 'COLLECTION_IMAGE_MISSING',
            message: `"${resolved.name}" has no photographed product and the campaign has no image. Upload campaign artwork or add product photos.`,
          });
        }
      }
    }
    return { ready: blockers.length === 0, blockers, channels };
  }

  // ================= content ========================================
  async #variablesFor(campaign, recipient) {
    const base = {
      customerName: trimOrNull(recipient.display_name, 60) || 'there',
      offerName: campaign.offer_name || campaign.name,
      offerDetails: campaign.offer_details || '',
      ctaLabel: campaign.cta_label || 'Shop Now',
      // Never an empty link: an offer with no specific landing page sends the
      // customer to the storefront rather than to a "Shop Now" that goes nowhere.
      ctaUrl: campaign.cta_url || STOREFRONT_URL,
      imageUrl: campaign.image_url || '',
    };
    if (campaign.campaign_type === 'NEW_COLLECTION') {
      const resolved = await this.#collection(campaign.collection_slug);
      // The campaign's own artwork wins when the admin uploaded some;
      // otherwise the collection's own image is used. Never a constant, so a
      // different collection next month changes the message with no code edit.
      base.collectionName = resolved?.name || campaign.name;
      base.collectionImageUrl = campaign.image_url || resolved?.image || '';
      base.collectionSlug = campaign.collection_slug;
      base.imageUrl = base.collectionImageUrl;
      base.ctaUrl = campaign.cta_url || resolved?.url || '';
    }
    return base;
  }

  /**
   * The purpose this contact may actually be messaged under on this channel,
   * or null. MARKETING is preferred when both are held, because it is the
   * broader permission.
   */
  async #grantedPurpose(contactKey, channel) {
    for (const purpose of ['MARKETING', 'NEWSLETTER']) {
      // eslint-disable-next-line no-await-in-loop
      const gate = await this.consent.isMarketable({ contactKey, channel, purpose });
      if (gate.marketable) return purpose;
    }
    return null;
  }

  /**
   * The collection as the storefront shows it — same name, same thumbnail —
   * read through the catalog service rather than a query of our own. The
   * query this replaced joined a table that does not exist
   * (`collection_products`; the real one is `product_collections`) and
   * swallowed the error, so every New Collection message went out with no
   * image and an empty link. Errors now propagate.
   */
  async #collection(slug) {
    if (!slug) return null;
    const collections = await catalogService.listCollections();
    const row = collections.find((c) => c.slug === slug);
    if (!row) return null;
    return {
      name: row.name,
      image: row.thumbnailUrl || null,
      url: `${STOREFRONT_URL}/collections/${row.slug}`,
    };
  }

  /** The greeting name for a test address: the matching customer's, else neutral. */
  async #testGreeting(email, phone) {
    const keys = [email, phone].filter(Boolean);
    if (!keys.length) return 'there';
    const rows = await query(
      `SELECT c.first_name FROM customer_contacts cc JOIN customers c ON c.id = cc.customer_id
        WHERE cc.normalized_value IN (${keys.map(() => '?').join(',')}) AND c.first_name <> '' LIMIT 1`, keys);
    return String(rows[0]?.first_name || '').trim() || 'there';
  }

  // ================= test send ======================================
  /**
   * A real send to one address, through the SAME path as a launch. A test that
   * used a different path would prove nothing about the campaign.
   */
  async sendTest(id, brandId, { email: rawEmail = null, phone: rawPhone = null, contact = null }) {
    const campaign = await this.#require(id, brandId);
    if (triggerOf(campaign)?.perCustomer) {
      // A per-customer event needs that customer's own data (their cart), so a
      // test is sent for one named customer through the event's real path.
      if (campaign.trigger_event !== 'cart.abandoned') {
        throw new AppError('TEST_NOT_SUPPORTED', 'Test sends for this trigger are not available yet.', 409);
      }
      const { abandonedCartService } = await import('../abandonedCart/service.js');
      return abandonedCartService.sendTestReminder(id, { contact: contact || rawEmail || rawPhone });
    }
    if (!rawEmail && !rawPhone) throw new AppError('VALIDATION_ERROR', 'Give a test email address or phone number.', 400);
    // Normalised exactly as the audience importer and the customer ledger store
    // them. A phone typed as 9319987171 used to be handed to WhatsApp as-is
    // and rejected as RECIPIENT_INVALID (production, 2026-09-17).
    const email = rawEmail ? String(rawEmail).trim().toLowerCase() : null;
    const phone = rawPhone ? normalizeIndianMobile(rawPhone) : null;
    if (rawPhone && !phone) {
      throw new AppError('VALIDATION_ERROR', 'That is not a valid Indian mobile number. Use 10 digits, optionally with +91.', 400);
    }
    const variables = await this.#variablesFor(campaign, { display_name: await this.#testGreeting(email, phone) });

    const results = [];
    for (const { channel, templateKey } of campaign.channels) {
      const contactKey = channel === 'EMAIL' ? email : phone;
      if (!contactKey) continue;
      // Unique per test, so a second test is a second message rather than a
      // silent de-duplicate against the first.
      const businessEventId = `${campaignEventPrefix(id)}test:${channel}:${Date.now()}`;
      // A test address has no audience source to derive a purpose from, so use
      // whichever permission it actually holds. Checking only MARKETING would
      // suppress a tester who subscribed through the storefront newsletter —
      // which grants NEWSLETTER — and the test would look like a delivery
      // failure rather than a consent decision.
      // eslint-disable-next-line no-await-in-loop
      const granted = await this.#grantedPurpose(contactKey, channel);
      if (!granted) {
        results.push({ channel, queued: false, error: 'NO_CONSENT', message: `${contactKey} has no marketing or newsletter consent on ${channel}.` });
        continue;
      }
      try {
        // eslint-disable-next-line no-await-in-loop
        await this.communications.enqueue({
          businessEventId, policyKey: templateKey, classification: 'MARKETING',
          channel, purpose: granted, templateKey,
          recipient: { customerId: null, contactKey }, variables,
        });
        results.push({ channel, queued: true, purpose: granted });
      } catch (error) {
        results.push({ channel, queued: false, error: error.code || 'ERROR', message: error.message });
      }
    }
    if (!results.length) throw new AppError('VALIDATION_ERROR', 'No enabled channel matches the test contact given.', 400);
    log.info('campaign_test_queued', { campaignId: id, results });
    return {
      results,
      note: 'Test messages pass the same consent check as the campaign, so a test address that has unsubscribed will be suppressed. Check the actual inbox/phone to confirm delivery.',
    };
  }

  // ================= lifecycle ======================================
  /**
   * Activate a DRAFT campaign.
   *   Send now   → ACTIVE, and its one run starts immediately.
   *   Schedule   → SCHEDULED; the worker starts the run when the time comes.
   *   Event      → ACTIVE; each matching event starts a run.
   * Nothing is sent inline: a run writes its audience snapshot and the worker
   * sends it in batches.
   */
  async activate(id, brandId) {
    const campaign = await this.#require(id, brandId);
    if (campaign.status !== 'DRAFT') {
      throw new AppError('CAMPAIGN_NOT_DRAFT',
        campaign.status === 'PAUSED' ? 'This campaign is paused. Resume it instead.' : 'This campaign has already been activated.', 409);
    }
    const readiness = await this.readiness(id, brandId);
    if (!readiness.ready) {
      throw new AppError('CAMPAIGN_NOT_READY', 'This campaign is not ready to activate.', 409, { blockers: readiness.blockers });
    }
    if (campaign.trigger_type === 'SCHEDULED') {
      if (!await this.repository.transition(id, brandId, ['DRAFT'], 'SCHEDULED')) throw this.#raced();
      log.info('campaign_scheduled', { campaignId: id, at: campaign.scheduled_at });
      return { status: 'SCHEDULED', scheduledAt: campaign.scheduled_at };
    }
    if (!await this.repository.transition(id, brandId, ['DRAFT'], 'ACTIVE', { started_at: new Date() })) throw this.#raced();
    if (campaign.trigger_type === 'SEND_NOW') {
      const run = await this.#startRun({ ...campaign, status: 'ACTIVE' }, 'send_now');
      return { status: 'ACTIVE', ...run };
    }
    return { status: 'ACTIVE' };
  }

  /** Kept for API compatibility: launching is activating. */
  launch(id, brandId) { return this.activate(id, brandId); }

  #raced() {
    return new AppError('CAMPAIGN_STATE_CHANGED', 'This campaign was changed by someone else. Reload and try again.', 409);
  }

  /**
   * Start one execution. The UNIQUE (campaign, trigger key) row is taken
   * first, so a double click, a retried request or two workers cannot start
   * the same run twice.
   */
  async #startRun(campaign, triggerKey, context = null) {
    const run = await this.repository.createRun(campaign.id, triggerKey, {
      context,
      config: { channels: campaign.channels, audienceSources: this.#sources(campaign), campaignType: campaign.campaign_type },
    });
    if (!run.created) {
      throw new AppError('CAMPAIGN_ALREADY_RUN', 'This campaign has already run for this trigger.', 409);
    }
    const resolved = await this.#resolveAudience(campaign);
    const snapshot = resolved.length ? await this.repository.insertRecipients(campaign.id, run.id, resolved) : 0;
    log.info('campaign_run_started', { campaignId: campaign.id, runId: run.id, triggerKey, resolved: resolved.length, snapshot });
    if (!snapshot) await this.#finishRun(campaign, run.id);
    return { runId: run.id, resolved: resolved.length, snapshot, deduplicated: resolved.length - snapshot };
  }

  async #finishRun(campaign, runId) {
    await this.repository.completeRun(runId);
    // A one-off campaign is done when its run is; an event campaign stays live.
    if (ONE_OFF_TRIGGERS.includes(campaign.trigger_type)) {
      await this.repository.transition(campaign.id, campaign.brand_id, ['ACTIVE'], 'COMPLETED', { finished_at: new Date() });
      return true;
    }
    return false;
  }

  async pause(id, brandId) {
    const campaign = await this.#require(id, brandId);
    if (!['ACTIVE', 'SCHEDULED'].includes(campaign.status)
        || !await this.repository.transition(id, brandId, [campaign.status], 'PAUSED', { paused_from: campaign.status })) {
      throw new AppError('CAMPAIGN_NOT_PAUSABLE', 'Only an active or scheduled campaign can be paused.', 409);
    }
    await this.repository.setRunsStatus(id, ['RUNNING'], 'PAUSED');
    return { status: 'PAUSED' };
  }

  async resume(id, brandId) {
    const campaign = await this.#require(id, brandId);
    const back = campaign.paused_from === 'SCHEDULED' ? 'SCHEDULED' : 'ACTIVE';
    if (campaign.status !== 'PAUSED'
        || !await this.repository.transition(id, brandId, ['PAUSED'], back, { paused_from: null })) {
      throw new AppError('CAMPAIGN_NOT_RESUMABLE', 'Only a paused campaign can be resumed.', 409);
    }
    await this.repository.setRunsStatus(id, ['PAUSED'], 'RUNNING');
    return { status: back };
  }

  /**
   * Cancel what has NOT gone out. Messages already handed to the engine are
   * not recalled — they may already be delivered.
   */
  async cancel(id, brandId) {
    if (!await this.repository.transition(id, brandId, ['DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED'], 'CANCELLED', { finished_at: new Date() })) {
      throw new AppError('CAMPAIGN_NOT_CANCELLABLE', 'This campaign cannot be cancelled.', 409);
    }
    await this.repository.setRunsStatus(id, ['RUNNING', 'PAUSED'], 'CANCELLED');
    const res = await this.repository.cancelPending(id);
    return { status: 'CANCELLED', cancelledPending: Number(res?.affectedRows || 0) };
  }

  // ================= the worker =====================================
  /** One pass: start scheduled campaigns that are due, then send a batch of every live run. Never throws. */
  async runDue({ now = new Date(), maxRuns = 5 } = {}) {
    const summary = { started: 0, campaigns: 0, queued: 0, suppressed: 0, failed: 0, finished: 0 };
    const due = await this.repository.dueScheduled({ limit: maxRuns, now });
    for (const row of due) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (!await this.repository.transition(row.id, row.brand_id, ['SCHEDULED'], 'ACTIVE', { started_at: now })) continue;
        // eslint-disable-next-line no-await-in-loop
        const campaign = await this.#require(row.id, row.brand_id);
        // eslint-disable-next-line no-await-in-loop
        await this.#startRun(campaign, `scheduled:${new Date(row.scheduled_at).toISOString()}`);
        summary.started += 1;
      } catch (err) {
        log.error('campaign_schedule_start_failed', { campaignId: row.id, error: err.message });
      }
    }
    const runs = await this.repository.runningRuns({ limit: maxRuns });
    for (const row of runs) {
      summary.campaigns += 1;
      // eslint-disable-next-line no-await-in-loop
      const one = await this.#require(row.id, row.brand_id)
        .then((campaign) => this.#runBatch(campaign, row.run_id))
        .catch((err) => {
          log.error('campaign_batch_failed', { campaignId: row.id, runId: row.run_id, error: err.message });
          return { queued: 0, suppressed: 0, failed: 0, finished: false };
        });
      summary.queued += one.queued;
      summary.suppressed += one.suppressed;
      summary.failed += one.failed;
      if (one.finished) summary.finished += 1;
    }
    return summary;
  }

  async #runBatch(campaign, runId) {
    const size = Math.min(Number(campaign.batch_size) || DEFAULT_BATCH_SIZE, MAX_BATCH_SIZE);
    const templateFor = Object.fromEntries(campaign.channels.map((c) => [c.channel, c.templateKey]));
    const batch = await this.repository.claimBatch(runId, size);
    const out = { queued: 0, suppressed: 0, failed: 0, finished: false };

    for (const recipient of batch) {
      const templateKey = templateFor[recipient.channel];
      if (!templateKey) {
        // The channel was removed from the campaign after the snapshot.
        // eslint-disable-next-line no-await-in-loop
        await this.repository.setRecipientState(recipient.id, 'CANCELLED', 'Channel no longer part of the campaign');
        continue;
      }
      const purpose = purposeForSource(recipient.source);
      // eslint-disable-next-line no-await-in-loop
      const gate = await this.consent.isMarketable({ contactKey: recipient.contact_key, channel: recipient.channel, purpose });
      if (!gate.marketable) {
        // eslint-disable-next-line no-await-in-loop
        await this.repository.setRecipientState(recipient.id, 'SUPPRESSED', gate.reason || 'No marketing consent');
        out.suppressed += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      if (await this.repository.recentlyMarketed(recipient.contact_key, recipient.channel, FREQUENCY_CAP_HOURS)) {
        // eslint-disable-next-line no-await-in-loop
        await this.repository.setRecipientState(recipient.id, 'SUPPRESSED', 'FREQUENCY_CAP');
        out.suppressed += 1;
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const variables = await this.#variablesFor(campaign, recipient);
      try {
        // eslint-disable-next-line no-await-in-loop
        const message = await this.communications.enqueue({
          // The recipient row id makes this idempotent: re-running a batch
          // cannot enqueue the same person twice.
          businessEventId: `${campaignEventPrefix(campaign.id)}${recipient.id}`,
          policyKey: templateKey, classification: 'MARKETING',
          // The engine re-checks consent immediately before sending, with this purpose.
          channel: recipient.channel, purpose, templateKey,
          recipient: { customerId: recipient.customer_id || null, contactKey: recipient.contact_key },
          variables,
        });
        // eslint-disable-next-line no-await-in-loop
        await this.repository.setRecipientState(recipient.id, 'QUEUED', null, message?.id || null);
        out.queued += 1;
      } catch (error) {
        // One bad contact must not fail the campaign: record why and move on.
        // eslint-disable-next-line no-await-in-loop
        await this.repository.setRecipientState(recipient.id, 'FAILED', error.code || error.message);
        out.failed += 1;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(PER_MESSAGE_DELAY_MS);
    }

    if (await this.repository.pendingCount(runId) === 0) {
      await this.#finishRun(campaign, runId);
      out.finished = true;
    }
    return out;
  }
}

export const marketingCampaignService = new MarketingCampaignService();
