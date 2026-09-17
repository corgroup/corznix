import { createHash } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { increment } from '../../utils/metrics.js';
import { platformRepository as R } from './repository.js';
import { providerDescriptor } from './capabilities.js';
import { newCorrelationId } from './providerAttempts.js';
import { NORMALIZED_ERROR } from './normalizedErrors.js';

const log = logger('webhook-inbox');

// Wave 8I-3 — one operational path for every inbound provider webhook:
//
//   provider -> verify authenticity -> persist inbox event -> dedupe ->
//   provider parser -> normalized event -> domain applier -> business
//   transition
//
// A webhook NEVER updates a business table directly (§38). The domain applier
// is registered by the owning module and is the only thing allowed to move
// business state; this service just verifies, de-duplicates, normalizes and
// records. Raw payloads are not stored — a sha256 digest + a small non-secret
// summary only (§40/§47).

const key = (capability, providerKey) => `${capability}:${providerKey}`;

/** @type {Map<string, (rawBody: string, headers: object) => boolean>} */
const verifiers = new Map();
/** @type {Map<string, (payload: object) => object>} */
const parsers = new Map();
/** @type {Map<string, (event: object) => Promise<'APPLIED'|'IGNORED'>>} */
const appliers = new Map();

export function registerWebhookVerifier(capability, providerKey, fn) { verifiers.set(key(capability, providerKey), fn); }
export function registerWebhookParser(capability, providerKey, fn) { parsers.set(key(capability, providerKey), fn); }
/** The owning domain registers exactly one applier per capability (§38). */
export function registerWebhookApplier(capability, fn) { appliers.set(capability, fn); }

export function _resetWebhookRegistries() { verifiers.clear(); parsers.clear(); appliers.clear(); }

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

function normalizedEventFromRow(row) {
  const s = row.safe_summary_json ?? {};
  return {
    capability: row.capability,
    providerKey: row.provider_key,
    providerEventId: row.provider_event_id,
    normalizedEventType: row.normalized_event_type,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    correlationId: row.correlation_id,
    summary: s,
    replay: true,
  };
}

async function runApplier(capability, event) {
  const applier = appliers.get(capability);
  if (!applier) return { decision: 'IGNORED', errorCode: null, reason: 'no domain applier registered' };
  try {
    const decision = await applier(event);
    return { decision: decision === 'APPLIED' ? 'APPLIED' : 'IGNORED', errorCode: null };
  } catch (err) {
    return { decision: 'FAILED', errorCode: err?.code || NORMALIZED_ERROR.PROVIDER_VALIDATION_FAILED, reason: err?.message };
  }
}

export const webhookInboxService = {
  /**
   * @param {{capability:string, providerKey:string, rawBody:string, headers:object, correlationId?:string}} input
   */
  async ingest({ capability, providerKey, rawBody, headers = {}, correlationId }) {
    const d = providerDescriptor(capability, providerKey);
    if (!d) throw new AppError('PROVIDER_NOT_FOUND', 'Unknown provider.', 404);
    if (!d.webhookCapable) throw new AppError('PROVIDER_NOT_WEBHOOK_CAPABLE', `${d.label} does not deliver webhooks.`, 400);
    const corr = correlationId || newCorrelationId('wh');
    const payloadSha = sha256(String(rawBody ?? ''));

    // 1. authenticity — BEFORE any business consideration (§41).
    const verifier = verifiers.get(key(capability, providerKey));
    const signatureValid = verifier ? Boolean(verifier(String(rawBody ?? ''), headers)) : null;
    if (signatureValid === false) {
      increment('webhook_signature_rejected_total', { capability, providerKey });
      log.warn('signature_rejected', { capability, providerKey, correlationId: corr });
      await R.insertInbox(null, {
        capability, providerKey, dedupeKey: `${capability}:${providerKey}:rejected:${payloadSha}`,
        signatureValid: false, payloadSha256: payloadSha, correlationId: corr,
        safeSummary: { rejected: true },
      });
      return { status: 'REJECTED', businessEffect: false };
    }

    // 2. parse — a parse failure is persisted, never silently dropped (§46).
    let payload;
    try { payload = JSON.parse(String(rawBody ?? '')); }
    catch {
      const { id } = await R.insertInbox(null, {
        capability, providerKey, dedupeKey: `${capability}:${providerKey}:unparseable:${payloadSha}`,
        signatureValid, payloadSha256: payloadSha, correlationId: corr, safeSummary: { parseError: true },
      });
      await R.markInbox(id, { processingStatus: 'FAILED', lastErrorCode: NORMALIZED_ERROR.PROVIDER_VALIDATION_FAILED, bumpAttempt: true });
      return { status: 'FAILED', id, businessEffect: false };
    }

    const parser = parsers.get(key(capability, providerKey));
    const parsed = parser ? parser(payload) : {};
    const providerEventId = parsed.providerEventId ?? payload.id ?? payload.event_id ?? null;
    const dedupeKey = `${capability}:${providerKey}:${providerEventId ?? payloadSha}`;

    // 3. persist + dedupe — a replayed provider event is ONE row (§42).
    const { id, created } = await R.insertInbox(null, {
      capability, providerKey, providerEventId, dedupeKey, signatureValid,
      normalizedEventType: parsed.normalizedEventType ?? null,
      resourceType: parsed.resourceType ?? null, resourceId: parsed.resourceId ?? null,
      payloadSha256: payloadSha, safeSummary: parsed.safeSummary ?? null, correlationId: corr,
    });
    if (!created) {
      const existing = await R.inboxById(id);
      return { status: 'DUPLICATE', id, businessEffect: false, priorStatus: existing?.processing_status };
    }

    // 4. hand the NORMALIZED event to the domain applier (§38).
    //
    // `attachment` is a deliberate exception to "nothing raw reaches storage":
    // a parser may surface a transient blob (e.g. a Delhivery EPOD image) for
    // its applier to persist in the RIGHT domain store with proper access
    // control. It is passed here in memory only — it is never part of the
    // inbox row (insertInbox above only ever gets `safeSummary`).
    const event = {
      capability, providerKey, providerEventId,
      normalizedEventType: parsed.normalizedEventType ?? null,
      resourceType: parsed.resourceType ?? null, resourceId: parsed.resourceId ?? null,
      correlationId: corr, summary: parsed.safeSummary ?? {},
      attachment: parsed.attachment ?? null,
    };
    const { decision, errorCode } = await runApplier(capability, event);
    await R.markInbox(id, { processingStatus: decision, lastErrorCode: errorCode, bumpAttempt: true });
    increment('webhook_processed_total', { capability, decision });
    if (decision === 'FAILED') log.error('applier_failed', { capability, providerKey, correlationId: corr, errorCode });
    return { status: decision, id, businessEffect: decision === 'APPLIED' };
  },

  list(params) {
    return R.listInbox({
      processingStatus: params.status || null, capability: params.capability || null,
      offset: Math.max(0, Number(params.offset) || 0), limit: Math.min(200, Number(params.limit) || 50),
    });
  },

  async detail(id) {
    const row = await R.inboxById(id);
    if (!row) throw new AppError('WEBHOOK_EVENT_NOT_FOUND', 'No such webhook event.', 404);
    // Raw payload is never returned — only the safe, normalized view (§47).
    return {
      id: row.id, capability: row.capability, providerKey: row.provider_key,
      providerEventId: row.provider_event_id, verificationStatus: row.verification_status,
      processingStatus: row.processing_status, normalizedEventType: row.normalized_event_type,
      resourceType: row.resource_type, resourceId: row.resource_id, attemptCount: row.attempt_count,
      lastErrorCode: row.last_error_code, correlationId: row.correlation_id,
      receivedAt: row.received_at, processedAt: row.processed_at, safeSummary: row.safe_summary_json ?? null,
      replayEligible: ['PENDING', 'FAILED', 'IGNORED'].includes(row.processing_status),
    };
  },

  /**
   * Re-run the SAME stored inbox event through its domain applier (§43/§44).
   * Idempotent — an already-applied event refuses; an applier that re-sees an
   * already-applied transition must return IGNORED, not duplicate it.
   */
  async replay(id) {
    const row = await R.inboxById(id);
    if (!row) throw new AppError('WEBHOOK_EVENT_NOT_FOUND', 'No such webhook event.', 404);
    if (['APPLIED', 'REPLAYED'].includes(row.processing_status)) {
      throw new AppError('WEBHOOK_ALREADY_APPLIED', 'That webhook event has already been applied.', 409);
    }
    if (row.verification_status === 'REJECTED') {
      throw new AppError('WEBHOOK_REJECTED', 'A rejected webhook event cannot be replayed.', 409);
    }
    const { decision, errorCode } = await runApplier(row.capability, normalizedEventFromRow(row));
    const status = decision === 'APPLIED' ? 'REPLAYED' : decision;
    await R.markInbox(id, { processingStatus: status, lastErrorCode: errorCode, bumpAttempt: true });
    return { status, id, businessEffect: decision === 'APPLIED' };
  },
};
