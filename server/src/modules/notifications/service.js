import { logger } from '../../utils/logger.js';
import { communicationService } from '../communications/service.js';
import { NOTIFICATION_POLICIES } from './policies.js';
import { resolveRecipient, orderContactFrom } from './recipients.js';

// WP-05 — the communication trigger layer.
//
// Domain services emit a business event; this resolves the policy, resolves
// the recipient per channel, and hands off to the existing
// communicationService.enqueue (outbox, dedupe, backoff, consent split — all
// unchanged). It builds NO new delivery mechanism (WP-06) and seeds NO
// templates (WP-07).
//
// emit() NEVER throws. A domain flow that calls it must be completely
// unaffected by any notification failure — a missing template, an unverified
// contact, a provider outage, or a bug in a policy function. Call sites still
// wrap it in `.catch(() => {})` as defence in depth, matching the one
// pre-existing caller (support/adminService.js#notifySupportReply).

const log = logger('notifications');

// Codes that are an expected, benign state — logged at debug only, not as an
// error. TEMPLATE_NOT_AVAILABLE is the normal state for an event whose
// template WP-07 has not authored yet.
const QUIET_CODES = new Set(['TEMPLATE_NOT_AVAILABLE', 'TEMPLATE_CLASSIFICATION_MISMATCH', 'VALIDATION_ERROR']);

function sanitizeVariables(raw) {
  const out = {};
  for (const [key, value] of Object.entries(raw || {})) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'object') { log.warn('notification_variable_dropped_object', { key }); continue; }
    out[key] = value;
  }
  return out;
}

async function emitChannel(policy, channel, context, customerId, connection) {
  try {
    // The order's own checkout contact wins for transactional messages — see
    // recipients.js. Callers pass it as `orderContact` or as the raw
    // `shippingAddressSnapshot`; neither is required for account-level events.
    const orderContact = context.orderContact
      || orderContactFrom(context.shippingAddressSnapshot || context.shipping_address_snapshot || null);
    const recipient = await resolveRecipient(customerId, channel, {
      orderContact, classification: policy.classification,
    });
    // A message nobody could be sent left no trace at all, so "the customer
    // never got it" looked identical to "we never tried". Warn: for a
    // TRANSACTIONAL order event this almost always means the caller did not
    // pass the order's shipping snapshot, not that the customer is
    // uncontactable.
    if (!recipient) {
      log.warn('notification_no_recipient', {
        policyKey: policy.policyKey,
        channel,
        customerId,
        hadOrderContact: Boolean(orderContact && (channel === 'WHATSAPP' ? orderContact.phone : orderContact.email)),
      });
      return 'NO_VERIFIED_CONTACT';
    }
    const res = await communicationService.enqueue({
      businessEventId: policy.businessEventId(context),
      policyKey: policy.policyKey,
      classification: policy.classification,
      channel,
      templateKey: policy.templateKey,
      recipient,
      variables: sanitizeVariables(policy.variables(context)),
    }, connection);
    return res.created ? 'ENQUEUED' : 'DEDUPED';
  } catch (err) {
    if (!QUIET_CODES.has(err.code)) {
      log.error('notification_channel_failed', { policyKey: policy.policyKey, channel, code: err.code || null, error: err.message });
    } else {
      // Not an error — a template left DRAFT is a deliberate state, since a
      // WhatsApp starter cannot be activated until the business supplies the
      // provider-approved name and a human activates it in the CMS. But it was
      // logged NOWHERE, and the caller discards the return value, so an event
      // that never produced a message was indistinguishable from one that did.
      // That is how Order Confirmed / Processing / Ready for Shipment could be
      // "not working" with nothing anywhere to point at.
      log.warn('notification_channel_skipped', {
        policyKey: policy.policyKey, templateKey: policy.templateKey, channel, code: err.code,
      });
    }
    return err.code || 'ERROR';
  }
}

export const notificationService = {
  /**
   * Emit one lifecycle event. Idempotent per (businessEventId, policyKey,
   * recipient, channel) via the engine's dedupe. Returns a per-channel
   * summary for observability and tests; never throws.
   *
   * @param {string} eventKey  a key in NOTIFICATION_POLICIES
   * @param {object} context   at least { customerId }, plus whatever the
   *                           policy's businessEventId/variables read
   * @param {object} [connection]  optional txn connection for outbox atomicity
   */
  async emit(eventKey, context = {}, connection = null) {
    try {
      const policy = NOTIFICATION_POLICIES[eventKey];
      if (!policy) { log.warn('notification_no_policy', { eventKey }); return { eventKey, skipped: 'NO_POLICY' }; }
      const customerId = context.customerId ?? null;
      if (!customerId) { log.warn('notification_no_customer', { eventKey }); return { eventKey, skipped: 'NO_CUSTOMER' }; }

      const results = {};
      for (const channel of policy.channels) {
        // eslint-disable-next-line no-await-in-loop
        results[channel] = await emitChannel(policy, channel, context, customerId, connection);
      }
      return { eventKey, results };
    } catch (err) {
      log.error('notification_emit_crash', { eventKey, error: err.message });
      return { eventKey, skipped: 'CRASH' };
    }
  },
};
