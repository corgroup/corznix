import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { normalizeEmail, normalizePhone } from '../../utils/normalize.js';
import { CustomerContactRepository } from '../customers/repositories.js';
import { consentRepository } from './repository.js';

const contacts = new CustomerContactRepository();

export const CONSENT_CHANNELS = Object.freeze(['EMAIL', 'WHATSAPP']);
export const CONSENT_PURPOSES = Object.freeze(['MARKETING', 'NEWSLETTER']);
export const CONSENT_SOURCES = Object.freeze([
  'ACCOUNT_SETTINGS', 'CHECKOUT', 'FOOTER_NEWSLETTER', 'CMS_IMPORT', 'PROMOTION_FORM',
  'CONTACT_VERIFICATION', 'DOUBLE_OPT_IN', 'UNSUBSCRIBE_LINK', 'STAFF_RECORDED',
  'DEFAULT_ON_SIGNUP', 'DEFAULT_ON_BASELINE',
]);

const normalizeKey = (channel, contactKey) =>
  (channel === 'WHATSAPP' ? normalizePhone(contactKey) : normalizeEmail(contactKey));

/**
 * Channel + purpose aware consent (§30-36). The ledger (`consent_records`) is
 * the append-only audit authority; `consent_state` is the materialized fast
 * read, moved only forward by a strictly higher `seq` (§34/§35) so a
 * concurrent GRANT / REVOKE can never leave a contradictory state.
 *
 * This module knows nothing about auth OTP and must never gate it (§9).
 */
export class ConsentService {
  constructor({ repository = consentRepository, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.transaction = transaction;
  }

  #stateDto(row, fallback = { contactKey: null, channel: null, purpose: null }) {
    if (!row) return { ...fallback, effectiveAction: 'REVOKED', granted: false, sourceSeq: 0 };
    return {
      contactKey: row.contact_key,
      channel: row.channel,
      purpose: row.purpose,
      effectiveAction: row.effective_action,
      granted: row.effective_action === 'GRANTED',
      sourceSeq: Number(row.source_seq),
      updatedAt: row.updated_at,
    };
  }

  async record({
    contactKey, channel, purpose, action, source,
    customerId = null, subscriberId = null, noticeVersion = null, proofRef = null,
    metadata = null, occurredAt = null, connection = null,
  }) {
    if (!CONSENT_CHANNELS.includes(channel)) throw new AppError('VALIDATION_ERROR', `Unknown consent channel "${channel}".`, 400);
    if (!CONSENT_PURPOSES.includes(purpose)) throw new AppError('VALIDATION_ERROR', `Unknown consent purpose "${purpose}".`, 400);
    if (!['GRANTED', 'REVOKED'].includes(action)) throw new AppError('VALIDATION_ERROR', 'Consent action must be GRANTED or REVOKED.', 400);
    if (!CONSENT_SOURCES.includes(source)) throw new AppError('VALIDATION_ERROR', `Unknown consent source "${source}".`, 400);
    const key = normalizeKey(channel, contactKey);
    if (!key) throw new AppError('VALIDATION_ERROR', 'A valid contact endpoint is required.', 400);

    const run = async (tx) => {
      const { seq } = await this.repository.insertRecord(tx, {
        contactKey: key, channel, purpose, action, source, customerId, subscriberId,
        noticeVersion, proofRef, metadata, occurredAt,
      });
      await this.repository.upsertState(tx, { contactKey: key, channel, purpose, customerId, action, seq });

      // Marketing suppression side-effect (§41/§42): a REVOKE raises a
      // CONSENT_REVOKED suppression; a GRANT releases it.
      if (action === 'REVOKED') {
        if (!await this.repository.activeSuppression(tx, { contactKey: key, channel, reason: 'CONSENT_REVOKED' })) {
          await this.repository.addSuppression(tx, { contactKey: key, channel, reason: 'CONSENT_REVOKED', sourceSeq: seq });
        }
      } else {
        await this.repository.releaseSuppressions(tx, { contactKey: key, channel, reason: 'CONSENT_REVOKED' });
      }
      return this.#stateDto(await this.repository.state(tx, { contactKey: key, channel, purpose }));
    };
    return connection ? run(connection) : this.transaction(run);
  }

  async effective({ contactKey, channel, purpose }) {
    const key = normalizeKey(channel, contactKey);
    return this.#stateDto(await this.repository.state(null, { contactKey: key, channel, purpose }),
      { contactKey: key, channel, purpose });
  }

  /**
   * Marketing send gate for one endpoint + channel + purpose (§42/§132).
   * GRANTED consent AND no active suppression.
   */
  async isMarketable({ contactKey, channel, purpose }) {
    const key = normalizeKey(channel, contactKey);
    if (!key) return { marketable: false, reason: 'INVALID_ENDPOINT' };
    const state = await this.repository.state(null, { contactKey: key, channel, purpose });
    if (!state || state.effective_action !== 'GRANTED') return { marketable: false, reason: 'NO_CONSENT' };
    const suppression = await this.repository.activeSuppression(null, { contactKey: key, channel });
    if (suppression) return { marketable: false, reason: `SUPPRESSED_${suppression.reason}` };
    return { marketable: true, reason: null };
  }

  /**
   * Default-ON marketing for a registered customer (owner decision,
   * 2026-09-17): each VERIFIED email / WhatsApp starts with MARKETING granted,
   * which the sign-in screen, checkout and every marketing email tell them.
   *
   * The one rule that makes this safe: a default is written ONLY when the
   * customer has never made a marketing decision on that channel — for that
   * address, or for any address on their account. Once they turn a channel
   * OFF it stays OFF on every later login until they turn it back on
   * themselves. Returns the channels granted by this call.
   */
  async applyDefaultMarketing(customerId, source = 'DEFAULT_ON_SIGNUP') {
    if (!['DEFAULT_ON_SIGNUP', 'DEFAULT_ON_BASELINE'].includes(source)) {
      throw new AppError('VALIDATION_ERROR', `Not a default-consent source: "${source}".`, 400);
    }
    const rows = await contacts.findForCustomer(customerId);
    const granted = [];
    for (const c of rows) {
      if (!c.is_verified) continue;
      const channel = c.contact_type === 'PHONE' ? 'WHATSAPP' : 'EMAIL';
      const key = normalizeKey(channel, c.normalized_value);
      if (!key) continue;
      // eslint-disable-next-line no-await-in-loop
      const decided = await this.repository.hasMarketingDecision({ customerId, contactKey: key, channel });
      if (decided) continue;
      // eslint-disable-next-line no-await-in-loop
      await this.record({ contactKey: key, channel, purpose: 'MARKETING', action: 'GRANTED', source, customerId });
      granted.push(channel);
    }
    return granted;
  }

  /** All marketing/newsletter consent states for a customer's verified endpoints. */
  async forCustomer(customerId) {
    const rows = await contacts.findForCustomer(customerId);
    const keys = [];
    const keyChannel = new Map();
    for (const c of rows) {
      if (!c.is_verified) continue;
      const channel = c.contact_type === 'PHONE' ? 'WHATSAPP' : 'EMAIL';
      const key = normalizeKey(channel, c.normalized_value);
      if (key) { keys.push(key); keyChannel.set(key, channel); }
    }
    const states = await this.repository.statesForKeys(keys);
    const stateByKp = new Map(states.map((s) => [`${s.contact_key}:${s.channel}:${s.purpose}`, s]));
    const out = [];
    for (const key of keys) {
      const channel = keyChannel.get(key);
      for (const purpose of CONSENT_PURPOSES) {
        out.push(this.#stateDto(stateByKp.get(`${key}:${channel}:${purpose}`), { contactKey: key, channel, purpose }));
      }
    }
    return out;
  }

  history(opts) { return this.repository.history(opts); }
  suppressionsForKey(contactKey) { return this.repository.suppressionsForKey(contactKey); }

  /** Link an anonymous consent history to a now-verified customer (§40). */
  async linkCustomer(contactKey, channel, customerId) {
    const key = normalizeKey(channel, contactKey);
    if (key) await this.repository.linkCustomerToState(key, customerId);
  }

  /** Staff-added suppression (manual compliance / hard bounce) — §141. */
  async suppress({ contactKey, channel, reason, notes = null, staffId = null }) {
    if (!['HARD_BOUNCE', 'MANUAL_COMPLIANCE'].includes(reason)) {
      throw new AppError('VALIDATION_ERROR', 'Staff may only add HARD_BOUNCE or MANUAL_COMPLIANCE suppressions.', 400);
    }
    const key = normalizeKey(channel, contactKey);
    if (!key) throw new AppError('VALIDATION_ERROR', 'A valid endpoint is required.', 400);
    return this.transaction(async (tx) => {
      if (await this.repository.activeSuppression(tx, { contactKey: key, channel, reason })) return { ok: true, existing: true };
      await this.repository.addSuppression(tx, { contactKey: key, channel, reason, notes, createdByStaffId: staffId });
      return { ok: true };
    });
  }

  async releaseSuppression({ contactKey, channel, reason, staffId = null }) {
    const key = normalizeKey(channel, contactKey);
    return this.transaction((tx) => this.repository.releaseSuppressions(tx, { contactKey: key, channel, reason, staffId }));
  }
}

export const consentService = new ConsentService();
