import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { communicationRepository } from './repository.js';
import { renderTemplate } from './templateRenderer.js';
import { providerForChannel, providerByCode } from './providers.js';
import { consentService } from '../consent/service.js';

const BACKOFF_S = [30, 120, 600, 1800, 3600];
const recipientKey = (contactKey) => String(contactKey || '').trim().toLowerCase();
const dedupeKey = ({ businessEventId, policyKey, contactKey, channel }) =>
  `${businessEventId}|${policyKey}|${recipientKey(contactKey)}|${channel}`;

// Delivery rank — a normalized event can only move a message FORWARD (§140).
const RANK = { QUEUED: 0, SUPPRESSED: 0, SENDING: 1, UNKNOWN: 1, SENT: 2, FAILED: 2, DELIVERED: 3 };

/**
 * Communication orchestration (Wave 8G-7). Provider-neutral, MySQL outbox,
 * deterministic message identity. MARKETING consent is re-checked immediately
 * before the provider send. Auth OTP is not part of this system.
 */
export class CommunicationService {
  constructor({ repository = communicationRepository, consent = consentService } = {}) {
    this.repository = repository;
    this.consent = consent;
  }

  /**
   * Enqueue one logical message. Idempotent on
   * (business_event_id, policy, recipient, channel) — safe to call from a
   * domain transaction (pass `connection`) so the event + the communication
   * intent commit atomically (§130).
   */
  async enqueue({
    businessEventId, policyKey, classification, channel, purpose = null,
    templateKey, recipient, variables = {}, broadcastId = null,
  }, connection = null) {
    if (!businessEventId || !policyKey || !templateKey || !recipient?.contactKey) {
      throw new AppError('VALIDATION_ERROR', 'businessEventId, policyKey, templateKey and recipient.contactKey are required.', 400);
    }
    const template = await this.repository.activeTemplate(connection, templateKey, channel);
    if (!template) throw new AppError('TEMPLATE_NOT_AVAILABLE', `No ACTIVE ${channel} template "${templateKey}".`, 409);
    if (template.classification !== classification) {
      throw new AppError('TEMPLATE_CLASSIFICATION_MISMATCH', `Template "${templateKey}" is ${template.classification}, not ${classification}.`, 409);
    }
    const schema = typeof template.variable_schema === 'string' ? JSON.parse(template.variable_schema) : template.variable_schema;
    const renderedBody = renderTemplate(template.body_template, schema, variables, { channel });
    const renderedSubject = template.subject ? renderTemplate(template.subject, schema, variables, { channel }) : null;

    return this.repository.enqueueMessage(connection, {
      dedupeKey: dedupeKey({ businessEventId, policyKey, contactKey: recipient.contactKey, channel }),
      classification, channel, purpose, templateKey, templateVersion: Number(template.version),
      // Snapshotted at enqueue time (WP-06) — see 051_communication_provider_
      // template_ref.sql for why this must not be re-read from the template
      // row at dispatch time.
      providerTemplateRef: template.provider_template_ref ?? null,
      businessEventId, policyKey, broadcastId,
      recipientCustomerId: recipient.customerId ?? null,
      recipientContactKey: recipientKey(recipient.contactKey),
      variables, renderedSubject, renderedBody,
    });
  }

  // ---- worker: send due messages ---------------------------------
  async dispatchDue({ limit = 20, now = new Date() } = {}) {
    const ids = await withTransaction((tx) => this.repository.claimDue(tx, limit));
    const summary = { sent: 0, suppressed: 0, failed: 0, unknown: 0, skipped: 0 };
    for (const id of ids) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await this.#dispatchOne(id, now).catch((e) => ({ result: 'error', error: e.message }));
      if (summary[outcome.result] != null) summary[outcome.result] += 1;
      else summary.skipped += 1;
    }
    return summary;
  }

  async #dispatchOne(id, now) {
    // Phase 1 (own txn): re-check the gate + move QUEUED -> SENDING.
    const prep = await withTransaction(async (tx) => {
      const m = await this.repository.messageById(tx, id, { lock: true });
      if (!m || !['QUEUED', 'FAILED'].includes(m.status)) return { result: 'skipped' };

      if (m.classification === 'MARKETING') {
        // §132 — consent re-checked IMMEDIATELY BEFORE send. An unsubscribe
        // after enqueue lands here as SUPPRESSED, never a send.
        const gate = await this.consent.isMarketable({ contactKey: m.recipient_contact_key, channel: m.channel, purpose: m.purpose });
        if (!gate.marketable) {
          await this.repository.transition(tx, id, {
            fromVersion: m.status_version, toStatus: 'SUPPRESSED',
            patch: { suppressed_reason: gate.reason, locked_at: null },
          });
          await this.repository.recordEvent(tx, id, { eventType: 'SUPPRESSED', fromStatus: m.status, toStatus: 'SUPPRESSED', detail: { reason: gate.reason } });
          return { result: 'suppressed' };
        }
      } else if (!m.recipient_contact_key) {
        await this.repository.transition(tx, id, { fromVersion: m.status_version, toStatus: 'SUPPRESSED', patch: { suppressed_reason: 'INVALID_CHANNEL', locked_at: null } });
        return { result: 'suppressed' };
      }

      const providerCode = m.provider_code || providerForChannel(m.channel).code;
      const moved = await this.repository.transition(tx, id, {
        fromVersion: m.status_version, toStatus: 'SENDING',
        patch: { provider_code: providerCode, attempt_count: Number(m.attempt_count) + 1, locked_at: null },
      });
      if (!moved) return { result: 'skipped' };
      await this.repository.recordEvent(tx, id, { eventType: 'SENDING', fromStatus: m.status, toStatus: 'SENDING' });
      return { result: 'go', message: { ...m, provider_code: providerCode, status_version: Number(m.status_version) + 1, attempt_count: Number(m.attempt_count) + 1 } };
    });
    if (prep.result !== 'go') return prep;

    const m = prep.message;
    const provider = providerByCode(m.provider_code);
    let sendOutcome;
    try {
      sendOutcome = await provider.send({
        channel: m.channel, to: m.recipient_contact_key, subject: m.rendered_subject, body: m.rendered_body,
        // Snapshotted on the message at enqueue time (WP-06) — required by
        // the real WhatsApp adapter, unused by Email.
        providerTemplateRef: m.provider_template_ref ?? null, variables: m.variables_json,
        // Selects the sending mailbox (support@ vs orders@) — see
        // senderPurposeFor in providers.js. Unused by WhatsApp.
        templateKey: m.template_key,
        // Marketing email gets an unsubscribe footer and List-Unsubscribe.
        classification: m.classification,
      });
    } catch (err) {
      sendOutcome = { outcome: 'FAILED', retryable: true, error: err.message?.slice(0, 200) || 'SEND_ERROR' };
    }

    // Phase 2 (own txn): record the send result.
    return withTransaction(async (tx) => {
      const fresh = await this.repository.messageById(tx, id, { lock: true });
      if (!fresh || fresh.status !== 'SENDING') return { result: 'skipped' };
      if (sendOutcome.outcome === 'ACCEPTED') {
        await this.repository.transition(tx, id, {
          fromVersion: fresh.status_version, toStatus: 'SENT',
          patch: { provider_message_id: sendOutcome.providerMessageId, sent_at: now, last_error: null },
        });
        await this.repository.recordEvent(tx, id, { eventType: 'SENT', fromStatus: 'SENDING', toStatus: 'SENT' });
        return { result: 'sent' };
      }
      if (sendOutcome.outcome === 'AMBIGUOUS') {
        // Request may have been accepted — do NOT resend blindly (§137).
        await this.repository.transition(tx, id, { fromVersion: fresh.status_version, toStatus: 'UNKNOWN', patch: { last_error: 'PROVIDER_TIMEOUT_AMBIGUOUS' } });
        await this.repository.recordEvent(tx, id, { eventType: 'UNKNOWN', fromStatus: 'SENDING', toStatus: 'UNKNOWN' });
        return { result: 'unknown' };
      }
      const attempt = Number(fresh.attempt_count);
      const nextAt = new Date(now.getTime() + (BACKOFF_S[Math.min(attempt, BACKOFF_S.length - 1)] * 1000));
      await this.repository.transition(tx, id, {
        fromVersion: fresh.status_version, toStatus: 'FAILED',
        patch: { last_error: sendOutcome.error || 'SEND_FAILED', next_attempt_at: attempt < Number(fresh.max_attempts) ? nextAt : null, failed_at: now },
      });
      await this.repository.recordEvent(tx, id, { eventType: 'FAILED', fromStatus: 'SENDING', toStatus: 'FAILED', detail: { error: sendOutcome.error } });
      return { result: 'failed' };
    });
  }

  // ---- provider delivery webhook -------------------------------
  async handleWebhook({ providerCode, rawEvent }) {
    const provider = providerByCode(providerCode);
    if (!provider) throw new AppError('UNKNOWN_PROVIDER', 'Unknown provider.', 404);
    const norm = provider.normalizeWebhook(rawEvent);
    if (!norm) return { ok: true, ignored: 'UNPARSEABLE' };

    return withTransaction(async (tx) => {
      const row = await this.repository.messageByProviderRef(tx, norm.providerCode, norm.providerMessageId);
      if (!row) return { ok: true, ignored: 'NO_MATCH' };
      const m = await this.repository.messageById(tx, row.id, { lock: true });

      // Dedupe on (message_id, provider_event_key) — a replayed webhook is a
      // no-op (§140).
      const fresh = await this.repository.recordEvent(tx, m.id, {
        eventType: 'PROVIDER_WEBHOOK', fromStatus: m.status, toStatus: norm.normalizedStatus,
        providerEventKey: norm.providerEventKey, detail: { via: 'webhook' },
      });
      if (!fresh) return { ok: true, deduped: true, status: m.status };

      // Monotonic — never regress DELIVERED -> SENT (§140).
      if (RANK[norm.normalizedStatus] <= RANK[m.status] && m.status !== 'SENDING' && m.status !== 'UNKNOWN') {
        return { ok: true, noRegression: true, status: m.status };
      }
      const patch = {};
      if (norm.normalizedStatus === 'DELIVERED') patch.delivered_at = norm.occurredAt;
      if (norm.normalizedStatus === 'SENT') patch.sent_at = norm.occurredAt;
      if (norm.normalizedStatus === 'FAILED') { patch.failed_at = norm.occurredAt; patch.next_attempt_at = null; }
      await this.repository.transition(tx, m.id, { fromVersion: m.status_version, toStatus: norm.normalizedStatus, patch });
      return { ok: true, status: norm.normalizedStatus };
    });
  }

}

export const communicationService = new CommunicationService();

// Background worker — drains the outbox on a timer. Opt out with
// COMMUNICATION_WORKER_ENABLED=false (verifications set this). Mirrors the
// order-finalization worker: returns a stop() function.
export function startCommunicationWorker({ intervalMs = 5000 } = {}) {
  if (process.env.COMMUNICATION_WORKER_ENABLED === 'false') return () => {};
  const timer = setInterval(() => {
    communicationService.dispatchDue({ limit: 25 }).catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
