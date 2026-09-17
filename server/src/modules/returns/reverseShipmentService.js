import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { mockReverseLogisticsAdapter } from './providers/mockReverseLogisticsAdapter.js';
import { reverseShipmentRepository } from './reverseShipmentRepository.js';
import { returnQcService } from './returnQcService.js';

const sha256 = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

// Monotonic rank ladder — a stale / out-of-order scan is stored for
// traceability but never regresses state (§81).
const REVERSE_RANK = Object.freeze({
  PENDING: 0, MANUAL_RETURN_LOGISTICS_REQUIRED: 0, UNKNOWN: 0,
  BOOKED: 1, PICKUP_SCHEDULED: 2, PICKED_UP: 3, IN_TRANSIT: 4, RECEIVED: 5,
  CANCELLED: 9, FAILED: 9,
});
const REVERSE_TIMESTAMP = { PICKED_UP: 'picked_up_at', RECEIVED: 'received_at', CANCELLED: 'cancelled_at' };
const IN_MOTION = ['PICKED_UP', 'IN_TRANSIT', 'RECEIVED'];

// Customer-facing labels — the carrier's internal vocabulary never leaks (§82).
const CUSTOMER_LABEL = Object.freeze({
  PENDING: 'Pickup Requested',
  MANUAL_RETURN_LOGISTICS_REQUIRED: 'Manual Pickup Being Arranged',
  BOOKED: 'Pickup Scheduled',
  PICKUP_SCHEDULED: 'Pickup Scheduled',
  PICKED_UP: 'Picked Up',
  IN_TRANSIT: 'Return In Transit',
  RECEIVED: 'Received at Warehouse',
  CANCELLED: 'Pickup Cancelled',
  FAILED: 'Pickup Failed',
  UNKNOWN: 'Pickup Requested',
});

/**
 * Provider-neutral REVERSE (customer -> warehouse) logistics (§67-84).
 *
 * checkServiceability -> book -> ingest tracking (webhook / poll) -> received,
 * with a hard serviceability gate (§72), a frozen provider snapshot (§73),
 * commit-before-provider-call booking (§74), UNKNOWN reconciliation (§75),
 * booking idempotency (§76), state-aware cancellation (§77), tracking
 * normalisation (§78) and an authenticity-checked, deduplicating webhook
 * inbox (§79/§80).
 *
 * REAL_REVERSE_PROVIDER_CALLS stays 0 — the mock never touches the network.
 */
export class ReverseShipmentService {
  constructor({ repository = reverseShipmentRepository, transaction = withTransaction, adapter = mockReverseLogisticsAdapter } = {}) {
    this.repository = repository;
    this.transaction = transaction;
    this.adapter = adapter;
  }

  dto(s) {
    return {
      id: s.id,
      shipmentNumber: s.shipment_number,
      direction: s.direction,
      status: s.status,
      providerCode: s.provider_code ?? null,
      reverseAwb: s.reverse_awb ?? null,
      destinationWarehouseId: s.destination_warehouse_id,
      pickupAddress: parse(s.pickup_address_snapshot_json),
      serviceable: s.serviceable == null ? null : Boolean(s.serviceable),
      providerSnapshot: parse(s.provider_snapshot_json),
      bookedAt: s.booked_at ?? null,
      pickedUpAt: s.picked_up_at ?? null,
      receivedAt: s.received_at ?? null,
    };
  }

  /** Create the PENDING reverse shipment for a request. Idempotent (1 per request). */
  async ensureFor({ connection, returnRequestId, shipmentNumber, pickupAddressSnapshot, destinationWarehouseId, destinationWarehouseSnapshot }) {
    const existing = await this.repository.byRequest(connection, returnRequestId, { lock: true });
    if (existing) return existing;
    try {
      return await this.repository.insert(connection, {
        returnRequestId, shipmentNumber, pickupAddressSnapshot,
        destinationWarehouseId, destinationWarehouseSnapshot,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') return this.repository.byRequest(connection, returnRequestId, { lock: true });
      throw err;
    }
  }

  #buildRequest(shipment, simulate = null, qcSnapshot = null) {
    const pickup = parse(shipment.pickup_address_snapshot_json) || {};
    const warehouse = parse(shipment.destination_warehouse_snapshot_json) || {};
    return {
      clientReference: shipment.shipment_number,
      direction: 'RETURN',
      simulate: simulate || null,
      pickup: { postalCode: pickup.postalCode || null, name: [pickup.firstName, pickup.lastName].filter(Boolean).join(' ') || null },
      destination: { postalCode: warehouse.postalCode || warehouse.postal_code || null, name: warehouse.name || null },
      package: {},
      // Slice 19 — RVP QC 3.0. Only attach when a BUILT config exists; a
      // MANUAL_REVIEW snapshot means the pickup books without provider QC and
      // staff run QC by hand on receipt.
      ...(qcSnapshot?.buildStatus === 'BUILT' && Array.isArray(qcSnapshot.customQc) && qcSnapshot.customQc.length
        ? { qcType: 'param', customQc: qcSnapshot.customQc }
        : {}),
    };
  }

  /**
   * HARD serviceability gate (§72). If the provider cannot service the pickup
   * PIN, no CMS/business policy can force it — the shipment goes to
   * MANUAL_RETURN_LOGISTICS_REQUIRED. Also freezes the provider snapshot (§73).
   */
  async checkServiceability({ returnShipmentId, connection = null }) {
    const run = async (tx) => {
      const shipment = await this.repository.lockById(tx, returnShipmentId);
      if (!shipment) throw new AppError('REVERSE_SHIPMENT_NOT_FOUND', 'Reverse shipment not found.', 404);
      if (shipment.serviceability_checked_at && shipment.status !== 'PENDING') return this.dto(shipment);

      const pickup = parse(shipment.pickup_address_snapshot_json) || {};
      const check = await this.adapter.checkReverseServiceability({ pickupPostalCode: pickup.postalCode });
      const fields = {
        serviceable: check.serviceable ? 1 : 0,
        serviceability_checked_at: new Date(),
        provider_snapshot_json: JSON.stringify({
          providerCode: check.providerCode, selectedAt: new Date().toISOString(), via: 'MOCK',
        }),
      };
      if (!check.serviceable && shipment.status === 'PENDING') {
        fields.status = 'MANUAL_RETURN_LOGISTICS_REQUIRED';
      }
      await this.repository.update(tx, shipment.id, fields);
      return this.dto({ ...shipment, ...fields });
    };
    return connection ? run(connection) : this.transaction(run);
  }

  /**
   * Book a MOCK reverse pickup. DB phase 1 (intent) commits, provider call runs
   * outside any transaction (§74), DB phase 2 records the outcome. Idempotent on
   * `idempotencyKey` — a retry never creates a second reverse AWB (§76).
   */
  async book({ returnShipmentId, idempotencyKey, simulate = null }) {
    if (!idempotencyKey || String(idempotencyKey).length > 160) {
      throw new AppError('VALIDATION_ERROR', 'A valid reverse-booking idempotency key is required.', 400);
    }

    // Slice 19 — freeze the RVP QC config for this return BEFORE booking
    // (idempotent; never throws — a build failure records a MANUAL_REVIEW
    // snapshot). Runs outside the booking transaction.
    const preShipment = await this.repository.lockById(null, returnShipmentId);
    let qcSnapshot = null;
    if (preShipment?.return_request_id) {
      qcSnapshot = await returnQcService
        .freezeForRequest({ returnRequestId: preShipment.return_request_id, returnShipmentId })
        .catch((err) => { void err; return null; });
    }

    const intent = await this.transaction(async (tx) => {
      const shipment = await this.repository.lockById(tx, returnShipmentId);
      if (!shipment) throw new AppError('REVERSE_SHIPMENT_NOT_FOUND', 'Reverse shipment not found.', 404);
      if ([...IN_MOTION, 'BOOKED', 'PICKUP_SCHEDULED'].includes(shipment.status)) return { done: shipment };
      if (shipment.status === 'MANUAL_RETURN_LOGISTICS_REQUIRED') return { manual: shipment };
      if (shipment.status === 'CANCELLED') throw new AppError('REVERSE_SHIPMENT_CANCELLED', 'This reverse shipment is cancelled.', 409);
      if (shipment.serviceable === 0) {
        return { manual: shipment }; // hard gate — cannot be forced (§72)
      }
      if (shipment.serviceable == null) {
        throw new AppError('REVERSE_SERVICEABILITY_NOT_CHECKED', 'Check reverse serviceability before booking.', 409);
      }

      const request = this.#buildRequest(shipment, simulate, qcSnapshot);
      const requestHash = sha256({ ...request, simulate: undefined });
      const existing = await this.repository.attemptByKey(tx, idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This key was used for a different reverse booking.', 409);
        if (existing.status === 'SUCCEEDED') return { done: shipment };
        if (existing.status === 'UNKNOWN') return { reconcile: true };
        if (existing.status === 'PENDING') throw new AppError('REVERSE_BOOKING_IN_PROGRESS', 'A reverse booking is already in progress.', 409);
        await this.repository.completeAttempt(tx, existing.id, { status: 'PENDING' });
      }
      const attempt = existing || await this.repository.createAttempt(tx, {
        returnShipmentId: shipment.id, providerCode: 'MOCK', idempotencyKey, requestHash,
      });
      return { attemptId: attempt.id, request, shipmentId: shipment.id };
    });

    if (intent.done) return { shipment: this.dto(intent.done), realProviderCallPerformed: false };
    if (intent.manual) return { shipment: this.dto(intent.manual), manualLogisticsRequired: true, realProviderCallPerformed: false };
    if (intent.reconcile) throw new AppError('REVERSE_BOOKING_RECONCILIATION_REQUIRED', 'A previous reverse booking had an unknown outcome — reconcile before retrying.', 409);

    let result = null;
    let failure = null;
    try { result = await this.adapter.bookReturn(intent.request); } catch (error) { failure = error; }

    const outcome = await this.transaction(async (tx) => {
      if (result) {
        await this.repository.completeAttempt(tx, intent.attemptId, {
          status: 'SUCCEEDED', providerShipmentId: result.providerShipmentId, reverseAwb: result.reverseAwb, response: result,
        });
        await this.repository.update(tx, intent.shipmentId, {
          status: 'BOOKED', provider_code: result.providerCode, provider_shipment_id: result.providerShipmentId,
          reverse_awb: result.reverseAwb, tracking_url: result.trackingUrl || null,
          booking_idempotency_key: intent.request.clientReference, booked_at: new Date(),
          last_provider_status: result.status, last_event_at: new Date(),
        });
        await this.repository.insertEvent(tx, {
          returnShipmentId: intent.shipmentId, providerCode: result.providerCode,
          providerEventKey: `${result.providerShipmentId}:BOOKED`, providerStatus: result.status,
          normalizedStatus: 'BOOKED', occurredAt: new Date(), applied: true,
        });
        return { shipment: this.dto(await this.repository.lockById(tx, intent.shipmentId)) };
      }
      if (failure?.ambiguous) {
        await this.repository.completeAttempt(tx, intent.attemptId, {
          status: 'UNKNOWN', providerShipmentId: failure.providerShipmentId || null,
          reverseAwb: failure.reverseAwb || null, failureCode: failure.message,
        });
        await this.repository.update(tx, intent.shipmentId, { status: 'UNKNOWN' });
        return { reconcile: true };
      }
      await this.repository.completeAttempt(tx, intent.attemptId, { status: 'FAILED', failureCode: failure?.message || 'PROVIDER_ERROR' });
      await this.repository.update(tx, intent.shipmentId, { status: 'FAILED' });
      return { failed: true };
    });

    if (outcome.reconcile) throw new AppError('REVERSE_BOOKING_RECONCILIATION_REQUIRED', 'The reverse booking outcome is unknown — the provider may have created the pickup. Reconcile before retrying.', 409);
    if (outcome.failed) throw new AppError('REVERSE_PROVIDER_ERROR', 'The reverse pickup could not be booked.', 502);

    // Slice 19 — link the reverse AWB onto the frozen QC snapshot and record the
    // FE QC result the pickup produced (MOCK today; a real reverse scan / QC
    // webhook later). Best-effort — never fails a booked pickup.
    if (preShipment?.return_request_id && result?.reverseAwb) {
      await returnQcService.freezeForRequest({
        returnRequestId: preShipment.return_request_id, returnShipmentId, reverseAwb: result.reverseAwb,
      }).catch(() => {});
      if (result.qcResult?.answers && qcSnapshot?.buildStatus === 'BUILT') {
        await returnQcService.recordResult({
          returnRequestId: preShipment.return_request_id, answers: result.qcResult.answers, source: 'MOCK',
        }).catch(() => {});
      }
    }
    return { shipment: outcome.shipment, realProviderCallPerformed: false };
  }

  /**
   * Resolve an UNKNOWN booking (§75). The operator supplies the reconciled
   * provider outcome (in real life: a status lookup). No blind retry ever
   * creates a second AWB.
   */
  async reconcile({ returnShipmentId, providerOutcome }) {
    if (!['CONFIRMED', 'NOT_CREATED'].includes(providerOutcome)) {
      throw new AppError('VALIDATION_ERROR', 'providerOutcome must be CONFIRMED or NOT_CREATED.', 400);
    }
    return this.transaction(async (tx) => {
      const shipment = await this.repository.lockById(tx, returnShipmentId);
      if (!shipment) throw new AppError('REVERSE_SHIPMENT_NOT_FOUND', 'Reverse shipment not found.', 404);
      if (shipment.status !== 'UNKNOWN') return this.dto(shipment);
      const attempt = await this.repository.attemptByKey(tx, shipment.booking_idempotency_key || '__none__');

      if (providerOutcome === 'CONFIRMED') {
        const providerShipmentId = attempt?.provider_shipment_id || `mock-rev-${shipment.shipment_number.replace(/[^A-Za-z0-9]/g, '').toLowerCase()}`;
        const reverseAwb = attempt?.reverse_awb || `MOCKAWB${shipment.shipment_number.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
        if (attempt) await this.repository.completeAttempt(tx, attempt.id, { status: 'SUCCEEDED', providerShipmentId, reverseAwb });
        await this.repository.update(tx, shipment.id, {
          status: 'BOOKED', provider_code: 'MOCK', provider_shipment_id: providerShipmentId,
          reverse_awb: reverseAwb, booked_at: new Date(), reconciled_at: new Date(),
        });
      } else {
        if (attempt) await this.repository.completeAttempt(tx, attempt.id, { status: 'FAILED', failureCode: 'RECONCILED_NOT_CREATED' });
        await this.repository.update(tx, shipment.id, { status: 'PENDING', reconciled_at: new Date() });
      }
      return this.dto(await this.repository.lockById(tx, shipment.id));
    });
  }

  /** State-aware cancellation (§77). A picked-up parcel cannot be cancelled. */
  async cancelPickup({ returnShipmentId, reason = null }) {
    return this.transaction(async (tx) => {
      const shipment = await this.repository.lockById(tx, returnShipmentId);
      if (!shipment) throw new AppError('REVERSE_SHIPMENT_NOT_FOUND', 'Reverse shipment not found.', 404);
      if (shipment.status === 'CANCELLED') return this.dto(shipment);
      if (IN_MOTION.includes(shipment.status)) {
        throw new AppError('REVERSE_CANCEL_NOT_ALLOWED', `A reverse shipment in ${shipment.status} cannot be cancelled.`, 409);
      }
      if (shipment.provider_shipment_id) {
        const res = await this.adapter.cancelReturn({ providerShipmentId: shipment.provider_shipment_id, currentStatus: shipment.status });
        if (!res.cancelled) throw new AppError('REVERSE_CANCEL_NOT_ALLOWED', `Provider refused cancellation: ${res.reason}.`, 409);
      }
      await this.repository.update(tx, shipment.id, { status: 'CANCELLED', cancelled_at: new Date() });
      await this.repository.insertEvent(tx, {
        returnShipmentId: shipment.id, providerCode: shipment.provider_code || 'MOCK',
        providerEventKey: `${shipment.id}:CANCELLED:${randomUUID().slice(0, 8)}`,
        normalizedStatus: 'CANCELLED', occurredAt: new Date(), applied: true, remarks: reason,
      });
      return this.dto({ ...shipment, status: 'CANCELLED' });
    });
  }

  /** Ingest one already-normalized reverse tracking event. Dedupe + no-regress (§80/§81). */
  async ingestEvent({ returnShipmentId, providerCode = 'MOCK', providerEventKey, providerStatus = null, normalizedStatus, occurredAt, locationText = null, remarks = null }) {
    if (!(normalizedStatus in REVERSE_RANK)) {
      throw new AppError('INVALID_REVERSE_EVENT', `Unknown reverse status "${normalizedStatus}".`, 422);
    }
    if (!providerEventKey || !occurredAt) throw new AppError('INVALID_REVERSE_EVENT', 'providerEventKey and occurredAt are required.', 422);

    return this.transaction(async (tx) => {
      const shipment = await this.repository.lockById(tx, returnShipmentId);
      if (!shipment) throw new AppError('REVERSE_SHIPMENT_NOT_FOUND', 'Reverse shipment not found.', 404);
      if (await this.repository.eventByKey(tx, providerCode, providerEventKey)) {
        return { deduped: true, applied: false, status: shipment.status };
      }
      const advances = REVERSE_RANK[normalizedStatus] > REVERSE_RANK[shipment.status];
      try {
        await this.repository.insertEvent(tx, {
          returnShipmentId, providerCode, providerEventKey, providerStatus,
          normalizedStatus, occurredAt: new Date(occurredAt), locationText, remarks, applied: advances,
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return { deduped: true, applied: false, status: shipment.status };
        throw err;
      }
      if (!advances) return { deduped: false, applied: false, reason: 'STALE', status: shipment.status };
      const fields = { status: normalizedStatus, last_provider_status: providerStatus || normalizedStatus, last_event_at: new Date(occurredAt) };
      if (REVERSE_TIMESTAMP[normalizedStatus]) fields[REVERSE_TIMESTAMP[normalizedStatus]] = new Date(occurredAt);
      await this.repository.update(tx, returnShipmentId, fields);
      return { deduped: false, applied: true, status: normalizedStatus };
    });
  }

  /**
   * Webhook inbox (§79). Authenticity check -> raw persistence -> dedupe on
   * provider event id -> normalise (§78) -> apply. An unauthenticated or
   * duplicate payload is stored but produces no business effect (§80).
   */
  async ingestWebhook({ providerCode = 'MOCK', rawBody, signature }) {
    const raw = typeof rawBody === 'string' ? JSON.parse(rawBody) : rawBody;
    const signatureValid = this.adapter.verifyWebhookSignature(rawBody, signature);
    const parsed = this.adapter.parseEvent(raw);
    const providerEventId = parsed.providerEventId || sha256(raw).slice(0, 32);

    const inbox = await this.transaction(async (tx) => {
      const dupe = await this.repository.webhookByDedupe(tx, providerCode, providerEventId);
      if (dupe) return { id: dupe.id, duplicate: true };
      const id = randomUUID();
      const shipment = parsed.providerShipmentId
        ? await this.repository.byProviderRef(tx, parsed.providerShipmentId) : null;
      await this.repository.insertWebhook(tx, {
        id, providerCode, providerEventId, returnShipmentId: shipment?.id || null,
        signatureValid, rawPayload: raw, normalizedStatus: parsed.normalizedStatus,
        status: !signatureValid ? 'REJECTED' : shipment ? 'RECEIVED' : 'FAILED',
        error: !signatureValid ? 'BAD_SIGNATURE' : shipment ? null : 'SHIPMENT_NOT_FOUND',
      });
      return { id, duplicate: false, signatureValid, shipmentId: shipment?.id || null, parsed };
    });

    if (inbox.duplicate) return { deduped: true, applied: false, reason: 'DUPLICATE_WEBHOOK' };
    if (!inbox.signatureValid) return { deduped: false, applied: false, reason: 'BAD_SIGNATURE' };
    if (!inbox.shipmentId) return { deduped: false, applied: false, reason: 'SHIPMENT_NOT_FOUND' };
    if (!inbox.parsed.normalizedStatus) {
      await this.repository.markWebhook(null, inbox.id, { status: 'FAILED', error: 'UNMAPPED_SCAN' });
      return { deduped: false, applied: false, reason: 'UNMAPPED_SCAN' };
    }

    const applied = await this.ingestEvent({
      returnShipmentId: inbox.shipmentId,
      providerCode,
      providerEventKey: providerEventId,
      providerStatus: inbox.parsed.providerStatus,
      normalizedStatus: inbox.parsed.normalizedStatus,
      occurredAt: inbox.parsed.occurredAt || new Date(),
      locationText: inbox.parsed.locationText,
      remarks: inbox.parsed.remarks,
    });
    await this.repository.markWebhook(null, inbox.id, { status: 'PROCESSED' });
    return { deduped: applied.deduped, applied: applied.applied, status: applied.status, reason: applied.reason || null };
  }

  timeline(returnShipmentId) {
    return this.repository.events(returnShipmentId);
  }

  /** Customer-facing normalized timeline — no carrier vocabulary (§82). */
  async customerTimeline(returnShipmentId) {
    const events = await this.repository.events(returnShipmentId);
    return events
      .filter((e) => e.applied)
      .map((e) => ({
        status: CUSTOMER_LABEL[e.normalized_status] || e.normalized_status,
        at: e.occurred_at,
      }));
  }
}

export const reverseShipmentService = new ReverseShipmentService();
export { REVERSE_RANK, CUSTOMER_LABEL };
