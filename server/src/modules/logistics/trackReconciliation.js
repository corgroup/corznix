import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { orderOpsRepository } from '../orderOps/repository.js';
import { shippingService } from '../shipping/service.js';
import { isTerminalShipmentStatus } from '../shipping/shipmentLifecycle.js';
import { newCorrelationId } from '../platform/providerAttempts.js';
import { mapDelhiveryStatus } from './statusMap.js';
import { scanPushIdempotencyKey } from './delhiveryScanPush.js';
import { logisticsWebhookApplier } from './applier.js';

const log = logger('track-reconciliation');

// Phase 2 · Slice 13 — track PULL + reconciliation.
//
// The Scan Push webhook (WP-01 / Slice 14) is best-effort: Delhivery's own
// requirement doc says a slow 200 means "scans missed". This is the backstop —
// it periodically pulls GET /api/v1/packages/json/ for in-flight shipments and
// feeds the carrier's own current status + scan history through the SAME
// normalization (mapDelhiveryStatus) and the SAME domain applier the webhook
// uses. Because the composite idempotency key is identical
// (scanPushIdempotencyKey), a status already ingested from the webhook is a
// no-op here, and vice versa.
//
// It also resolves a BOOKING_UNKNOWN shipment against the carrier: did the
// create actually land? If Delhivery has the shipment, adopt its AWB
// (booking_status -> BOOKED); if not, mark it FAILED so the operator can
// re-book. It NEVER creates a shipment and never invents an AWB.
const IN_FLIGHT_STATUSES = ['BOOKED', 'PICKUP_PENDING', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_EXCEPTION', 'RTO_IN_TRANSIT'];

export class TrackReconciliationService {
  constructor({
    repository = orderOpsRepository,
    orchestrator = shippingService.orchestrator,
    applier = logisticsWebhookApplier,
    now = () => new Date(),
    staleMinutes = Number(env.SHIPMENT_TRACK_PULL_STALE_MINUTES) || 180,
    batchSize = Number(env.SHIPMENT_TRACK_PULL_BATCH_SIZE) || 40,
    enabled = env.SHIPMENT_TRACK_PULL_ENABLED !== false,
    transaction = withTransaction,
    db = query,
  } = {}) {
    this.repository = repository;
    this.orchestrator = orchestrator;
    this.applier = applier;
    this.now = now;
    this.transaction = transaction;
    this.db = db;
    this.staleMinutes = staleMinutes;
    this.batchSize = Math.min(Math.max(batchSize, 1), 50); // doc: <= 50 waybills/call
    this.enabled = enabled;
  }

  #providerKeyFor(providerCode) {
    return providerCode === 'MOCK' ? 'MOCK' : 'DELHIVERY';
  }

  // Build the exact event shape the logistics webhook applier consumes, so a
  // pulled scan and a pushed scan travel the identical code path (completion
  // bridge, RTO bridge, customer notifications, OBSERVE mode all included).
  #toEvent(providerCode, awb, scan) {
    const mappedStatus = mapDelhiveryStatus({ statusType: scan.statusType, statusText: scan.statusText, instructions: scan.instructions });
    return {
      capability: 'logistics',
      providerKey: this.#providerKeyFor(providerCode),
      providerEventId: scanPushIdempotencyKey({
        awb,
        statusType: scan.statusType,
        statusText: scan.statusText,
        statusDateTime: scan.statusDateTime,
        nslCode: scan.nslCode,
      }),
      normalizedEventType: mappedStatus ?? 'UNMAPPED',
      resourceType: 'shipment',
      resourceId: awb,
      correlationId: newCorrelationId('trk'),
      summary: {
        awb,
        statusType: scan.statusType ?? null,
        statusText: scan.statusText ?? null,
        statusDateTime: scan.statusDateTime ?? null,
        locationText: scan.locationText ?? null,
        instructions: scan.instructions ?? null,
        nslCode: scan.nslCode ?? null,
        mappedStatus: mappedStatus ?? null,
        source: 'TRACK_PULL',
      },
    };
  }

  async #applyEntry(providerCode, entry) {
    const scans = [...(entry.history || []), entry.currentStatus]
      .filter((s) => s && s.statusText && s.statusDateTime)
      .sort((a, b) => new Date(a.statusDateTime) - new Date(b.statusDateTime));
    let applied = 0;
    for (const scan of scans) {
      const event = this.#toEvent(providerCode, entry.awb, scan);
      if (!event.providerEventId) continue; // no AWB + no timestamp — not actionable
      // eslint-disable-next-line no-await-in-loop
      const decision = await this.applier(event);
      if (decision === 'APPLIED') applied += 1;
    }
    return { scanned: scans.length, applied };
  }

  /**
   * Pull the carrier's view of ONE booked shipment and reconcile local state.
   * Never mutates anything itself — every state change goes through the applier
   * (and its transition guards).
   */
  async reconcileShipment(shipmentId, { trigger = 'MANUAL' } = {}) {
    const shipment = await this.repository.shipment(shipmentId);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);

    if (shipment.booking_status === 'UNKNOWN') {
      return this.reconcileBookingUnknown(shipmentId, { trigger });
    }
    if (!shipment.tracking_number) return { outcome: 'SKIPPED', reason: 'NO_AWB', status: shipment.status };
    if (isTerminalShipmentStatus(shipment.status)) {
      return { outcome: 'SKIPPED', reason: 'TERMINAL', status: shipment.status };
    }

    const providerCode = shipment.provider_code || 'DELHIVERY';
    let track;
    try {
      track = await this.orchestrator.trackShipment({ awb: shipment.tracking_number, providerCode });
    } catch (error) {
      // Provider unreachable / auth failure / unreadable body — surfaced to the
      // operator, nothing mutated. A failed pull is NEVER a status change.
      log.warn('track_pull_failed', { shipmentId, code: error?.message, trigger });
      return { outcome: 'PROVIDER_ERROR', reason: error?.message || 'TRACK_FAILED', status: shipment.status };
    }

    const entry = track.shipments.find((s) => s.awb === shipment.tracking_number) || track.shipments[0] || null;
    if (!entry) return { outcome: 'NOT_FOUND_AT_CARRIER', status: shipment.status };

    const { scanned, applied } = await this.#applyEntry(providerCode, entry);
    const after = await this.repository.shipment(shipmentId);
    return {
      outcome: applied > 0 ? 'RECONCILED' : 'NO_CHANGE',
      scanned,
      applied,
      status: after?.status ?? shipment.status,
      providerStatus: entry.currentStatus?.statusText ?? null,
    };
  }

  /**
   * Resolve a BOOKING_UNKNOWN shipment against the carrier.
   *   found (1 AWB)  -> adopt it, booking_status = BOOKED, then catch status up
   *   not found      -> booking_status = FAILED (operator re-books)
   *   >1 / error     -> left UNKNOWN for a human
   */
  async reconcileBookingUnknown(shipmentId, { trigger = 'MANUAL' } = {}) {
    const shipment = await this.repository.shipment(shipmentId);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
    if (shipment.booking_status !== 'UNKNOWN') {
      return this.reconcileShipment(shipmentId, { trigger });
    }

    const providerCode = shipment.provider_code || 'DELHIVERY';
    const order = await this.repository.orderForShipment(shipmentId);
    const orderRef = order?.order_number || null;

    // A candidate AWB from the ambiguous attempt (a lost-response create after
    // the carrier assigned one) lets us query unambiguously by waybill.
    const attempt = await this.db(
      `SELECT provider_shipment_id, tracking_number FROM shipment_booking_attempts
        WHERE shipment_id = ? AND status = 'UNKNOWN' ORDER BY created_at DESC LIMIT 1`,
      [shipmentId],
    ).then((r) => r[0] || null);
    const candidateAwb = attempt?.tracking_number || null;

    if (!candidateAwb && !orderRef) return { outcome: 'STILL_UNKNOWN', reason: 'NO_LOOKUP_KEY' };

    let track;
    try {
      track = candidateAwb
        ? await this.orchestrator.trackShipment({ awb: candidateAwb, providerCode })
        : await this.orchestrator.trackShipment({ orderReference: orderRef, providerCode });
    } catch (error) {
      log.warn('unknown_reconcile_pull_failed', { shipmentId, code: error?.message, trigger });
      return { outcome: 'STILL_UNKNOWN', reason: error?.message || 'TRACK_FAILED' };
    }

    const found = (track.shipments || []).filter((s) => s.awb);
    if (found.length === 0) {
      // The carrier has no shipment for this waybill / order ref — the create
      // did NOT succeed. Mark FAILED so the normal booking flow can retry.
      await this.transaction(async (c) => {
        await this.repository.updateShipment(c, shipmentId, { booking_status: 'FAILED' });
        await c.execute(
          `UPDATE shipment_booking_attempts SET status = 'FAILED', failure_code = 'RECONCILED_NOT_AT_CARRIER', completed_at = NOW(3)
            WHERE shipment_id = ? AND status = 'UNKNOWN'`,
          [shipmentId],
        );
      });
      log.info('unknown_reconciled_not_booked', { shipmentId, trigger });
      return { outcome: 'NOT_BOOKED', bookingStatus: 'FAILED' };
    }
    if (found.length > 1) {
      return { outcome: 'AMBIGUOUS_MULTIPLE', awbs: found.map((s) => s.awb) };
    }

    const entry = found[0];
    const externalId = attempt?.provider_shipment_id || entry.awb;
    const bookedAt = shipment.booked_at || this.now();
    await this.transaction(async (c) => {
      await this.repository.updateShipment(c, shipmentId, {
        provider_code: providerCode,
        external_shipment_id: externalId,
        tracking_number: entry.awb,
        tracking_url: `https://www.delhivery.com/track/package/${encodeURIComponent(entry.awb)}`,
        booking_status: 'BOOKED',
        status: ['DRAFT', 'READY_TO_BOOK', 'BOOKING_PENDING'].includes(shipment.status) ? 'BOOKED' : shipment.status,
        booked_at: bookedAt,
        last_provider_status: entry.currentStatus?.statusText || 'BOOKED',
        last_event_at: this.now(),
      });
      await c.execute(
        `UPDATE shipment_booking_attempts SET status = 'SUCCEEDED', tracking_number = ?, provider_shipment_id = ?, completed_at = NOW(3)
          WHERE shipment_id = ? AND status = 'UNKNOWN'`,
        [entry.awb, externalId, shipmentId],
      );
      await this.repository.insertEvent(c, {
        shipmentId, source: 'RECONCILE', providerCode,
        providerEventKey: `${externalId}:BOOKED:RECONCILED`,
        providerStatus: 'BOOKED', normalizedStatus: 'BOOKED', occurredAt: bookedAt, applied: true,
      });
    });
    log.info('unknown_reconciled_adopted_awb', { shipmentId, trigger });

    const reconciliation = await this.#applyEntry(providerCode, entry).catch(() => null);
    const after = await this.repository.shipment(shipmentId);
    return {
      outcome: 'BOOKED',
      awb: entry.awb,
      bookingStatus: 'BOOKED',
      status: after?.status ?? 'BOOKED',
      reconciliation,
    };
  }

  /** Worker tick — pull the carrier for booked shipments whose last event is stale. */
  async runDueBatch({ batchSize = this.batchSize } = {}) {
    if (!this.enabled) return { pulled: 0, disabled: true };
    const limit = Math.min(Math.max(Number(batchSize) || this.batchSize, 1), 50);
    const staleBefore = new Date(this.now().getTime() - this.staleMinutes * 60_000);
    const placeholders = IN_FLIGHT_STATUSES.map(() => '?').join(',');
    const rows = await this.db(
      `SELECT s.id, s.tracking_number, s.provider_code
         FROM shipments s
        WHERE s.booking_status = 'BOOKED'
          AND s.tracking_number IS NOT NULL
          AND s.provider_code IS NOT NULL AND s.provider_code <> 'MOCK'
          AND s.status IN (${placeholders})
          AND (s.last_event_at IS NULL OR s.last_event_at < ?)
        ORDER BY s.last_event_at IS NOT NULL, s.last_event_at ASC
        LIMIT ?`,
      [...IN_FLIGHT_STATUSES, staleBefore, limit],
    );
    if (!rows.length) return { pulled: 0 };

    // Group by provider, one pull per <=50 waybills.
    const byProvider = new Map();
    for (const r of rows) {
      const list = byProvider.get(r.provider_code) || [];
      list.push(r);
      byProvider.set(r.provider_code, list);
    }

    let applied = 0;
    let pulled = 0;
    for (const [providerCode, list] of byProvider) {
      const awbs = list.map((r) => r.tracking_number);
      let track;
      try {
        // eslint-disable-next-line no-await-in-loop
        track = await this.orchestrator.trackShipment({ awbNumbers: awbs, providerCode });
      } catch (error) {
        log.warn('batch_track_pull_failed', { providerCode, count: awbs.length, code: error?.message });
        continue;
      }
      const byAwb = new Map((track.shipments || []).map((s) => [s.awb, s]));
      for (const r of list) {
        const entry = byAwb.get(r.tracking_number);
        if (!entry) continue;
        pulled += 1;
        // eslint-disable-next-line no-await-in-loop
        const res = await this.#applyEntry(providerCode, entry).catch((e) => {
          log.error('batch_apply_failed', { shipmentId: r.id, code: e?.message });
          return { applied: 0 };
        });
        applied += res.applied;
      }
    }
    log.info('track_pull_batch', { candidates: rows.length, pulled, applied });
    return { pulled, applied };
  }
}

export const trackReconciliationService = new TrackReconciliationService();
