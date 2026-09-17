import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { increment, observe } from '../../utils/metrics.js';
import { platformRepository as R } from './repository.js';
import { OUTCOME_CLASS, classifyProviderError, newCorrelationId } from './providerAttempts.js';
import { normalizeErrorCode } from './normalizedErrors.js';
import { raiseProviderUnknown } from './reconciliationBridge.js';

const log = logger('outbox');
const STALE_LOCK_MS = 5 * 60 * 1000;

// Wave 8I-4 — a MySQL transactional outbox (§50, no Kafka, no Redis). A
// business transaction writes its domain rows AND a `platform_outbox` row in
// the SAME transaction; a worker later claims and executes the side effect
// with retry classification + bounded backoff + a dead-letter state.

const BACKOFF_BASE_MS = 2000;
const BACKOFF_CAP_MS = 15 * 60 * 1000;

/** @type {Map<string, (payload:object, ctx:object) => Promise<void>>} */
const handlers = new Map();

export function registerOutboxHandler(eventType, fn) { handlers.set(eventType, fn); }
export function _resetOutboxHandlers() { handlers.clear(); }

/** Bounded exponential backoff with full jitter (§59). */
export function backoffMs(attempt) {
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(Math.random() * ceiling) + 500;
}

/**
 * Enqueue inside an EXISTING transaction (§51). Pass the same `tx` connection
 * the domain write used so the event and the business row commit atomically.
 */
export function enqueue(tx, { brandId, eventType, aggregateType, aggregateId, payload, correlationId }) {
  if (!eventType) throw new Error('enqueue: eventType is required');
  // Required, not defaulted. An AMBIGUOUS outcome on this event has to be
  // filed as a reconciliation exception, and those belong to exactly one
  // company -- so an event with no company is one whose unknown provider
  // outcome could never be recorded. Refuse it at the door instead.
  if (!brandId) throw new Error('enqueue: brandId is required');
  return R.insertOutbox(tx, {
    brandId, eventType, aggregateType, aggregateId, payload,
    correlationId: correlationId || newCorrelationId('ob'),
  });
}

async function settle(row, resultStatus, { outcomeClass, errorCode, nextAttemptAt } = {}) {
  await R.finishOutbox(row.id, {
    status: resultStatus, outcomeClass: outcomeClass ?? null,
    lastErrorCode: errorCode ?? null, nextAttemptAt: nextAttemptAt ?? null,
  });
}

/** Process one claimed row. Never throws — classification decides the next state. */
export async function processClaimed(id) {
  const row = await R.outboxById(id);
  if (!row || row.status !== 'PROCESSING') return { id, skipped: true };
  const handler = handlers.get(row.event_type);
  const ctx = { correlationId: row.correlation_id, attempt: row.attempt_count, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id };

  if (!handler) {
    await settle(row, 'DEAD', { outcomeClass: OUTCOME_CLASS.NON_RETRYABLE, errorCode: 'NO_HANDLER' });
    return { id, status: 'DEAD', reason: 'no handler' };
  }

  const started = Date.now();
  try {
    await handler(row.payload_json ?? {}, ctx);
    observe('outbox_process_ms', Date.now() - started, { eventType: row.event_type });
    increment('outbox_processed_total', { result: 'PROCESSED' });
    await settle(row, 'PROCESSED', { outcomeClass: OUTCOME_CLASS.SUCCESS });
    return { id, status: 'PROCESSED' };
  } catch (err) {
    const cls = classifyProviderError(err);
    const errorCode = normalizeErrorCode(err);
    increment('outbox_processed_total', { result: cls });
    log.warn('event_failed', { id, eventType: row.event_type, correlationId: row.correlation_id, class: cls, errorCode, attempt: row.attempt_count });

    if (cls === OUTCOME_CLASS.AMBIGUOUS) {
      // §58 — request may have reached the provider. Do NOT retry. Hand to
      // Wave 8H reconciliation.
      await settle(row, 'RECONCILIATION_REQUIRED', { outcomeClass: cls, errorCode });
      try {
        await raiseProviderUnknown({
          brandId: row.brand_id,
          capability: row.payload_json?.capability || 'platform', providerKey: row.payload_json?.providerKey || row.event_type,
          operation: row.event_type, resourceType: row.aggregate_type, resourceId: row.aggregate_id,
          correlationId: row.correlation_id,
        });
      } catch (raiseErr) {
        // Still best-effort -- the event is already parked in
        // RECONCILIATION_REQUIRED, so failing here must not re-throw. But it
        // is never silent: a swallowed raise means an unknown provider
        // outcome exists that nobody is tracking, which is exactly the thing
        // this path was built to prevent.
        log.error('reconciliation_raise_failed', {
          id, eventType: row.event_type, correlationId: row.correlation_id,
          errorCode: raiseErr?.code || 'UNKNOWN', message: raiseErr?.message,
        });
      }
      return { id, status: 'RECONCILIATION_REQUIRED' };
    }

    if (cls === OUTCOME_CLASS.NON_RETRYABLE) {
      await settle(row, 'DEAD', { outcomeClass: cls, errorCode });
      return { id, status: 'DEAD' };
    }

    // SAFE_RETRY — bounded.
    if (row.attempt_count >= row.max_attempts) {
      await settle(row, 'DEAD', { outcomeClass: cls, errorCode });
      return { id, status: 'DEAD', reason: 'max attempts' };
    }
    const next = new Date(Date.now() + backoffMs(row.attempt_count));
    await settle(row, 'FAILED', { outcomeClass: cls, errorCode, nextAttemptAt: next });
    return { id, status: 'FAILED', nextAttemptAt: next };
  }
}

const LOCK_ERRORS = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/** Claim (in a transaction, SKIP LOCKED) then process a batch of due rows. */
export async function processDue({ workerId = 'worker-local', batch = 10, staleMs = STALE_LOCK_MS, reclaim = Math.random() < 0.15 } = {}) {
  // Recover rows orphaned by a crashed worker — opportunistic, its own short
  // transaction, and lock-contention here is harmless (another worker will do
  // it) so it is never allowed to fail the drain.
  if (reclaim) {
    try { await withTransaction((tx) => R.reclaimStaleOutbox(tx, staleMs)); }
    catch (err) { if (!LOCK_ERRORS.has(err.code)) throw err; }
  }
  const ids = await withTransaction((tx) => R.claimOutbox(tx, workerId, batch));
  const out = [];
  for (const id of ids) out.push(await processClaimed(id));
  return out;
}

export const outboxService = {
  list(params) {
    return R.listOutbox({
      status: params.status || null,
      offset: Math.max(0, Number(params.offset) || 0),
      limit: Math.min(200, Number(params.limit) || 50),
    });
  },
  async retry(id) {
    const row = await R.outboxById(id);
    if (!row) throw new AppError('OUTBOX_EVENT_NOT_FOUND', 'No such outbox event.', 404);
    if (['PROCESSED', 'CANCELLED'].includes(row.status)) throw new AppError('OUTBOX_NOT_RETRYABLE', `A ${row.status} event cannot be retried.`, 409);
    if (row.status === 'RECONCILIATION_REQUIRED') throw new AppError('OUTBOX_AMBIGUOUS', 'This event has an unknown provider outcome — resolve it through reconciliation, not a blind retry.', 409);
    await R.finishOutbox(id, { status: 'PENDING', outcomeClass: null, lastErrorCode: row.last_error_code, nextAttemptAt: new Date() });
    return { id, status: 'PENDING' };
  },
  async cancel(id) {
    const row = await R.outboxById(id);
    if (!row) throw new AppError('OUTBOX_EVENT_NOT_FOUND', 'No such outbox event.', 404);
    if (['PROCESSED', 'CANCELLED'].includes(row.status)) throw new AppError('OUTBOX_NOT_CANCELLABLE', `A ${row.status} event cannot be cancelled.`, 409);
    await R.finishOutbox(id, { status: 'CANCELLED', outcomeClass: null, lastErrorCode: row.last_error_code, nextAttemptAt: null });
    return { id, status: 'CANCELLED' };
  },
};
