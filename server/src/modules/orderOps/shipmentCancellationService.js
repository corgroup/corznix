import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { shippingService } from '../shipping/service.js';
import { raiseProviderUnknown } from '../platform/reconciliationBridge.js';
import { orderOpsRepository } from './repository.js';

// Phase 2 · Slice 15 — provider-side shipment cancellation.
//
// Cancels a REAL booked shipment at the carrier for the pre-handover window.
//   * eligible: booking_status = BOOKED and shipment status ∈ {BOOKED,
//     PICKUP_PENDING} — i.e. an AWB exists but no pickup scan yet.
//   * once PICKED_UP / IN_TRANSIT / OFD / DELIVERED / RTO / terminal ⇒
//     CANCEL_NOT_ALLOWED ("already handed to the courier", brief §32).
//   * provider says success ⇒ shipment locally CANCELLED + a CANCELLED event.
//     Inventory is NOT touched here — the operator then rebooks (new shipment)
//     or cancels the ORDER (WP-09 restores inventory, and now succeeds because
//     the shipment is no longer PICKUP_PENDING).
//   * provider timeout / ambiguous ⇒ CANCEL_UNKNOWN — nothing is marked
//     cancelled, a reconciliation exception is raised (brief §22).
const CANCELLABLE_SHIPMENT_STATUSES = ['BOOKED', 'READY_TO_BOOK', 'PICKUP_PENDING'];

export class ShipmentProviderCancellationService {
  constructor({ repository = orderOpsRepository, shipping = shippingService, onUnknown = raiseProviderUnknown, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.shipping = shipping;
    this.onUnknown = onUnknown;
    this.transaction = transaction;
  }

  /**
   * @param {{ shipmentId: string, reason?: string|null, actor?: object,
   *           awb?: string|null, allowLocallyCancelled?: boolean }} input
   *   allowLocallyCancelled — the shipment row already says CANCELLED but the
   *   CARRIER was never told. That is not a no-op: the waybill is live and the
   *   courier will still collect the parcel. The order cancellation cascade
   *   cancels locally inside its transaction and then calls this, so without
   *   the flag it short-circuited on its own write and silently skipped the
   *   carrier — which is exactly how a cancelled order kept a live AWB.
   */
  async cancel({ shipmentId, reason = null, actor = {}, awb = null, allowLocallyCancelled = false }) {
    const shipment = await this.repository.shipment(shipmentId);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
    const trackingNumber = shipment.tracking_number || awb;
    const locallyCancelled = ['CANCELLED', 'FAILED'].includes(shipment.booking_status) || shipment.status === 'CANCELLED';
    const providerAlreadyTold = String(shipment.last_provider_status || '').toLowerCase() === 'cancelled';
    if (locallyCancelled && (providerAlreadyTold || !allowLocallyCancelled || !trackingNumber)) {
      return { shipmentId, cancelled: true, alreadyCancelled: true, carrierCalled: false };
    }
    if (!locallyCancelled && (shipment.booking_status !== 'BOOKED' || !trackingNumber)) {
      throw new AppError('SHIPMENT_NOT_BOOKED', 'Only a booked shipment (with an AWB) can be cancelled at the carrier.', 409);
    }
    if (!locallyCancelled && !CANCELLABLE_SHIPMENT_STATUSES.includes(shipment.status)) {
      throw new AppError('CANCEL_NOT_ALLOWED', 'This shipment has already been handed to the courier and can no longer be cancelled here.', 409);
    }

    const providerCode = shipment.provider_code;
    let result = null;
    let failure = null;
    try {
      result = await this.shipping.orchestrator.cancelShipment({
        awb: trackingNumber,
        providerCode,
      });
    } catch (error) { failure = error; }

    if (result?.cancelled) {
      await this.transaction(async (c) => {
        await this.repository.updateShipment(c, shipmentId, {
          status: 'CANCELLED', booking_status: 'CANCELLED', cancelled_at: new Date(),
          last_provider_status: 'Cancelled', last_event_at: new Date(),
        });
        await this.repository.insertEvent(c, {
          shipmentId, providerCode, providerEventKey: `${trackingNumber}:PROVIDER_CANCELLED`,
          providerStatus: 'Cancelled', normalizedStatus: 'CANCELLED', occurredAt: new Date(),
          remarks: reason || result.providerRemark || null, applied: true, source: providerCode,
        });
      });
      return { shipmentId, cancelled: true, carrierCalled: true, providerRemark: result.providerRemark || null, inventoryAction: 'PENDING_ORDER_DECISION' };
    }

    if (failure?.ambiguous) {
      await this.onUnknown({
        capability: 'logistics', providerKey: providerCode || 'DELHIVERY', operation: 'cancelShipment',
        resourceType: 'shipment', resourceId: shipmentId, correlationId: shipmentId,
        detail: { awb: trackingNumber, reason },
      }).catch(() => {});
      throw new AppError('CANCEL_UNKNOWN', 'The cancellation outcome is unknown — reconcile with the carrier before retrying. The shipment has NOT been marked cancelled.', 409);
    }
    if (failure?.notAllowed) {
      throw new AppError('CANCEL_NOT_ALLOWED', 'The carrier will not cancel this shipment (it may already be dispatched).', 409, { providerReason: failure.providerReason || null });
    }
    throw new AppError('PROVIDER_CANCEL_FAILED', 'The carrier rejected the cancellation.', 502, { providerReason: failure?.providerReason || null });
  }
}

export const shipmentProviderCancellationService = new ShipmentProviderCancellationService();

// Phase 2 · Slice 8 — fulfilment package confirmation (E2E spec §4/§26).
//
// The product shipping profile gives a calculated item weight; the operator
// confirms the ACTUAL packed weight + box dimensions before manifesting. The
// confirmed values are authoritative for the manifest (ShipmentBookingService
// #buildRequest reads shipments.package_snapshot_json). Nothing is defaulted —
// a missing calculated weight is surfaced, not invented.
export class ShipmentPackageService {
  constructor({ repository = orderOpsRepository, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.transaction = transaction;
  }

  async calculatedItemWeightGrams(shipmentId) {
    const rows = await this.repository.packageItemsForShipment(shipmentId);
    if (!rows.length) return { grams: null, complete: false, itemCount: 0 };
    let grams = 0;
    let complete = true;
    for (const r of rows) {
      const w = r.effective_weight_grams == null ? null : Number(r.effective_weight_grams);
      if (w == null) { complete = false; continue; }
      grams += w * Number(r.quantity);
    }
    return { grams: complete ? grams : (grams || null), complete, itemCount: rows.length };
  }

  async confirm({ shipmentId, weightGrams, lengthMm, widthMm, heightMm, staffUserId = null }) {
    const shipment = await this.repository.shipment(shipmentId);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
    if (shipment.booking_status === 'BOOKED') {
      throw new AppError('SHIPMENT_ALREADY_BOOKED', 'The package cannot be changed after the shipment is booked. Edit it at the carrier instead.', 409);
    }
    for (const [k, v] of Object.entries({ weightGrams, lengthMm, widthMm, heightMm })) {
      if (!Number.isInteger(v) || v <= 0) throw new AppError('VALIDATION_ERROR', `${k} must be a positive integer.`, 422);
    }
    const calc = await this.calculatedItemWeightGrams(shipmentId);
    const snapshot = {
      weightGrams, lengthMm, widthMm, heightMm,
      calculatedItemWeightGrams: calc.grams,
      calculatedWeightComplete: calc.complete,
      packageConfirmed: true,
      confirmedByStaffId: staffUserId,
      confirmedAt: new Date().toISOString(),
    };
    await this.transaction((c) => this.repository.updateShipment(c, shipmentId, {
      package_snapshot_json: JSON.stringify(snapshot),
      // Confirming the physical package clears the package-metadata gate.
      booking_status: shipment.booking_status === 'NOT_READY' ? 'READY' : shipment.booking_status,
    }));
    return { shipmentId, package: snapshot, bookingStatus: shipment.booking_status === 'NOT_READY' ? 'READY' : shipment.booking_status };
  }
}

export const shipmentPackageService = new ShipmentPackageService();
