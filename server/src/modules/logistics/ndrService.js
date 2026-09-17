import { randomUUID } from 'node:crypto';
import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { query } from '../../database/connection/pool.js';
import { orderOpsRepository } from '../orderOps/repository.js';
import { shippingService } from '../shipping/service.js';

const log = logger('ndr');

// Phase 2 · Slice 18 — NDR (Non-Delivery Report) actions.
//
// A failed delivery attempt is a DELIVERY_EXCEPTION shipment_event (carrying
// status_type / nsl_code). In response the operator instructs the carrier via
// POST /api/p/update:
//
//   RE_ATTEMPT  — retry delivery (forward). Capped per shipment
//                 (Dev_API.docx: "attempt 1-2").
//   RESCHEDULE  — reschedule a reverse pickup (PICKUP_RESCHEDULE).
//
// The submit is ASYNC — it returns a UPL id polled through
// GET /api/cmu/get_bulk_upl/{UPL_ID}. There is NO auto-submit by default: the
// NSL reason often needs a human (wrong address, customer unreachable, refused)
// and an address fix is a separate editShipment call. The confirmed NSL
// eligibility lists (Dev_API.docx #16) are surfaced as advisory hints only.

// Dev_API.docx #16 — NSLs eligible for each action.
const RE_ATTEMPT_NSL = new Set(['EOD-74', 'EOD-15', 'EOD-104', 'EOD-43', 'EOD-86', 'EOD-11', 'EOD-69', 'EOD-6']);
const RESCHEDULE_NSL = new Set(['EOD-777', 'EOD-21']);

const OPEN_STATUSES = ['PENDING', 'SUBMITTED', 'UNKNOWN'];

export class NdrService {
  constructor({
    repository = orderOpsRepository,
    orchestrator = shippingService.orchestrator,
    db = query,
    maxReattempts = Number(env.NDR_MAX_REATTEMPTS) || 2,
    now = () => new Date(),
  } = {}) {
    this.repository = repository;
    this.orchestrator = orchestrator;
    this.db = db;
    this.maxReattempts = maxReattempts;
    this.now = now;
  }

  nslHint(nsl) {
    const code = String(nsl ?? '').trim().toUpperCase();
    if (RE_ATTEMPT_NSL.has(code)) return 'RE_ATTEMPT';
    if (RESCHEDULE_NSL.has(code)) return 'RESCHEDULE';
    return null;
  }

  async #actions(shipmentId) {
    return this.db(
      'SELECT * FROM shipment_ndr_actions WHERE shipment_id = ? ORDER BY created_at DESC',
      [shipmentId],
    );
  }

  async #exceptionEvents(shipmentId) {
    return this.db(
      `SELECT nsl_code, status_type, provider_status, remarks, occurred_at
         FROM shipment_events
        WHERE shipment_id = ? AND normalized_status = 'DELIVERY_EXCEPTION'
        ORDER BY occurred_at DESC`,
      [shipmentId],
    );
  }

  /** The NDR picture for one shipment: is it in exception, what's allowed. */
  async contextForShipment(shipmentId) {
    const shipment = await this.repository.shipment(shipmentId);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);

    const [events, actions] = await Promise.all([this.#exceptionEvents(shipmentId), this.#actions(shipmentId)]);
    const latest = events[0] || null;
    const inException = shipment.status === 'DELIVERY_EXCEPTION';
    const attemptCount = events.length;
    const reattemptsUsed = actions.filter((a) => a.action === 'RE_ATTEMPT' && a.status !== 'FAILED' && a.status !== 'REJECTED').length;
    const pending = actions.find((a) => OPEN_STATUSES.includes(a.status)) || null;

    return {
      shipmentId,
      awb: shipment.tracking_number || null,
      shipmentStatus: shipment.status,
      inException,
      attemptCount,
      latestNslCode: latest?.nsl_code || null,
      latestReason: latest?.remarks || latest?.provider_status || null,
      latestAt: latest?.occurred_at || null,
      nslHint: this.nslHint(latest?.nsl_code),
      reattemptsUsed,
      maxReattempts: this.maxReattempts,
      pendingAction: pending ? this.#actionDto(pending) : null,
      canReAttempt: inException && !pending && reattemptsUsed < this.maxReattempts && Boolean(shipment.tracking_number),
      canReschedule: inException && !pending && Boolean(shipment.tracking_number),
      actions: actions.map((a) => this.#actionDto(a)),
    };
  }

  #actionDto(a) {
    return {
      id: a.id, action: a.action, status: a.status,
      triggerNslCode: a.trigger_nsl_code, attemptNumber: a.attempt_number == null ? null : Number(a.attempt_number),
      uplId: a.provider_upl_id, providerRemark: a.provider_remark,
      createdAt: a.created_at, submittedAt: a.submitted_at, resolvedAt: a.resolved_at,
    };
  }

  /** Instruct the carrier. Idempotent per (shipment, action, attempt). */
  async submitAction({ shipmentId, action, staffUserId = null, instructions = null }) {
    if (!['RE_ATTEMPT', 'RESCHEDULE'].includes(action)) {
      throw new AppError('NDR_ACTION_INVALID', 'action must be RE_ATTEMPT or RESCHEDULE.', 400);
    }
    const ctx = await this.contextForShipment(shipmentId);
    if (!ctx.awb) throw new AppError('SHIPMENT_NOT_BOOKED', 'This shipment has no AWB.', 409);
    if (!ctx.inException) throw new AppError('NDR_NOT_IN_EXCEPTION', 'This shipment is not in a delivery-exception state.', 409);
    if (ctx.pendingAction) throw new AppError('NDR_ACTION_IN_PROGRESS', 'An NDR action for this shipment is still being processed.', 409);
    if (action === 'RE_ATTEMPT' && ctx.reattemptsUsed >= this.maxReattempts) {
      throw new AppError('NDR_REATTEMPTS_EXHAUSTED', `The carrier allows at most ${this.maxReattempts} re-attempts. Let it RTO or contact the customer.`, 409);
    }

    const shipment = await this.repository.shipment(shipmentId);
    const providerCode = shipment.provider_code || 'DELHIVERY';
    const idempotencyKey = `ndr:${shipmentId}:${action}:${ctx.attemptCount}`;

    const existing = await this.db('SELECT * FROM shipment_ndr_actions WHERE idempotency_key = ? LIMIT 1', [idempotencyKey]).then((r) => r[0] || null);
    if (existing) {
      if (OPEN_STATUSES.includes(existing.status) || existing.status === 'ACCEPTED') return this.#actionDto(existing);
      // a prior FAILED/REJECTED attempt for this same exception — allow a retry
      await this.db("UPDATE shipment_ndr_actions SET status='PENDING', provider_remark=NULL WHERE id=?", [existing.id]);
    }

    const id = existing?.id || randomUUID();
    if (!existing) {
      await this.db(
        `INSERT INTO shipment_ndr_actions
          (id, shipment_id, awb, provider_code, action, trigger_nsl_code, attempt_number, status, idempotency_key, requested_by_staff_id, instructions)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
        [id, shipmentId, ctx.awb, providerCode, action, ctx.latestNslCode, ctx.attemptCount, idempotencyKey, staffUserId, instructions ? String(instructions).slice(0, 500) : null],
      ).catch((err) => { if (err.code !== 'ER_DUP_ENTRY') throw err; });
    }

    let result;
    try {
      result = await this.orchestrator.submitNdrAction({ awb: ctx.awb, action, providerCode });
    } catch (error) {
      const ambiguous = Boolean(error?.ambiguous);
      await this.db(
        'UPDATE shipment_ndr_actions SET status = ?, provider_remark = ?, submitted_at = NOW(3) WHERE id = ?',
        [ambiguous ? 'UNKNOWN' : 'FAILED', String(error?.providerReason || error?.message || 'PROVIDER_ERROR').slice(0, 500), id],
      );
      if (ambiguous) {
        log.warn('ndr_submit_ambiguous', { shipmentId, action, id });
        return { ...this.#actionDto({ id, action, status: 'UNKNOWN', trigger_nsl_code: ctx.latestNslCode, attempt_number: ctx.attemptCount }), reconcile: true };
      }
      throw new AppError('NDR_SUBMIT_FAILED', 'The carrier rejected the NDR action.', 502, { providerReason: error?.providerReason || null });
    }

    await this.db(
      `UPDATE shipment_ndr_actions
          SET status = 'SUBMITTED', provider_upl_id = ?, provider_response_json = ?, submitted_at = NOW(3)
        WHERE id = ?`,
      [result.uplId || null, JSON.stringify({ uplId: result.uplId, action: result.action }), id],
    );
    log.info('ndr_submitted', { shipmentId, action, uplId: result.uplId, id });
    return this.#actionDto({ id, action, status: 'SUBMITTED', trigger_nsl_code: ctx.latestNslCode, attempt_number: ctx.attemptCount, provider_upl_id: result.uplId });
  }

  /** Poll the carrier for one action's resolution. */
  async refreshAction(actionId) {
    const row = await this.db('SELECT * FROM shipment_ndr_actions WHERE id = ? LIMIT 1', [actionId]).then((r) => r[0] || null);
    if (!row) throw new AppError('NDR_ACTION_NOT_FOUND', 'NDR action not found.', 404);
    if (!['SUBMITTED', 'UNKNOWN'].includes(row.status) || !row.provider_upl_id) {
      return this.#actionDto(row);
    }

    let status;
    try {
      status = await this.orchestrator.getNdrStatus({ uplId: row.provider_upl_id, awb: row.awb, providerCode: row.provider_code });
    } catch (error) {
      await this.db('UPDATE shipment_ndr_actions SET polled_at = NOW(3) WHERE id = ?', [actionId]);
      log.warn('ndr_poll_failed', { actionId, code: error?.message });
      return this.#actionDto(row);
    }

    const map = { ACCEPTED: 'ACCEPTED', REJECTED: 'REJECTED', PENDING: 'SUBMITTED', UNKNOWN: 'UNKNOWN' };
    const next = map[status.state] || 'UNKNOWN';
    const terminal = next === 'ACCEPTED' || next === 'REJECTED';
    await this.db(
      `UPDATE shipment_ndr_actions
          SET status = ?, provider_remark = ?, polled_at = NOW(3), resolved_at = ${terminal ? 'NOW(3)' : 'resolved_at'}
        WHERE id = ?`,
      [next, status.providerRemark ? String(status.providerRemark).slice(0, 500) : row.provider_remark, actionId],
    );
    return this.#actionDto({ ...row, status: next, provider_remark: status.providerRemark || row.provider_remark });
  }

  /** Worker tick — poll every open action whose last poll is stale. */
  async runDuePoll({ batchSize = 25 } = {}) {
    const staleBefore = new Date(this.now().getTime() - (Number(env.NDR_POLL_INTERVAL_MS) || 900_000));
    const rows = await this.db(
      `SELECT id FROM shipment_ndr_actions
        WHERE status IN ('SUBMITTED', 'UNKNOWN') AND provider_upl_id IS NOT NULL
          AND (polled_at IS NULL OR polled_at < ?)
        ORDER BY polled_at IS NOT NULL, polled_at ASC LIMIT ?`,
      [staleBefore, batchSize],
    );
    for (const r of rows) {
      // eslint-disable-next-line no-await-in-loop
      await this.refreshAction(r.id).catch((e) => log.error('poll_tick_failed', { id: r.id, error: e.message }));
    }
    return { polled: rows.length };
  }
}

export const ndrService = new NdrService();
