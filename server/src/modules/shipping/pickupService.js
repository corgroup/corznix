import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { shippingService } from './service.js';
import { warehouseProviderLocationRepository } from './warehouseProviderRepository.js';
import { assertPickupContact } from '../warehouses/pickupContact.js';

// Phase 2 · Slice 12 — carrier pickup (PUR).
//
// Pickup is WAREHOUSE-LEVEL, not per shipment (Dev_API.docx PUR Creation). One
// request covers every package ready at a location; a second request for the
// same warehouse/day is only allowed after the open one is closed.
//
// PICKUP_MODE per (warehouse, provider):
//   API          — CORCOTTON calls POST /fm/request/new/
//   AUTO         — the provider account is on auto-pickup; CORCOTTON never calls
//   MANUAL_PANEL — an operator raises it in the provider panel
//
// PICKUP_REQUESTED != PICKED_UP. An accepted request moves the covered
// shipments to PICKUP_PENDING; PICKED_UP only ever comes from an authoritative
// scan (Slice 14).
export class WarehousePickupService {
  constructor({ shipping = shippingService, providerLocations = warehouseProviderLocationRepository } = {}) {
    this.shipping = shipping;
    this.providerLocations = providerLocations;
  }

  /**
   * The pickup contact for a warehouse, or a refusal.
   *
   * A pickup agent who cannot reach the warehouse is a failed pickup, so an
   * incomplete contact stops the request here rather than being sent to the
   * carrier half-filled. The contact always comes from the ALLOCATED
   * warehouse record — never the customer, never a global default.
   */
  async #pickupContact(warehouseId) {
    const [warehouse] = await query(
      'SELECT id, code, name, postal_code, contact_name, contact_phone, contact_phone_alt FROM warehouses WHERE id = ? LIMIT 1',
      [warehouseId],
    );
    if (!warehouse) throw new AppError('WAREHOUSE_NOT_FOUND', 'Warehouse not found.', 404);
    return { warehouse, contact: assertPickupContact(warehouse, 'PICKUP') };
  }

  /**
   * A pickup can only be scheduled for today or later. The carrier rejects a
   * past date, so catching it here saves a round trip and — more usefully —
   * says which date to use instead. Compared on the LOCAL calendar day, not
   * UTC: between midnight and 05:30 IST a UTC comparison calls today
   * yesterday, the same trap that already produced a wrong pickup date once.
   */
  static #assertPickupDate(pickupDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pickupDate || ''))) {
      throw new AppError('VALIDATION_ERROR', 'pickupDate must be YYYY-MM-DD.', 400);
    }
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (pickupDate < today) {
      throw new AppError(
        'PICKUP_DATE_IN_THE_PAST',
        `A pickup cannot be scheduled for ${pickupDate}, which has already passed. Use ${today} or later.`,
        400, { pickupDate, earliest: today },
      );
    }
  }

  /** Shipments at a warehouse that are booked, labelled and not yet in a pickup. */
  async #readyShipments(warehouseId, providerCode) {
    return query(
      `SELECT s.id, s.shipment_number
         FROM shipments s
        WHERE s.warehouse_id = ?
          AND s.provider_code = ?
          AND s.booking_status = 'BOOKED'
          AND s.status IN ('BOOKED', 'READY_TO_BOOK')
          AND s.label_status = 'AVAILABLE'
          AND s.pickup_request_id IS NULL`,
      [warehouseId, providerCode],
    );
  }

  async requestForWarehouse({ warehouseId, providerCode = 'DELHIVERY', pickupDate, pickupTime = '14:00:00', staffUserId = null }) {
    WarehousePickupService.#assertPickupDate(pickupDate);
    const mapping = await this.providerLocations.activeIdentifier(warehouseId, providerCode);
    if (!mapping) {
      throw new AppError('WAREHOUSE_NOT_REGISTERED_WITH_PROVIDER', `No active ${providerCode} pickup location for this warehouse.`, 409);
    }
    // Refuse before anything is sent or recorded — in EVERY mode, because AUTO
    // and MANUAL_PANEL still end with a human arriving at this address
    // expecting someone to answer.
    const { warehouse, contact } = await this.#pickupContact(warehouseId);
    const mode = mapping.pickup_mode || 'MANUAL_PANEL';
    if (mode === 'AUTO') {
      return { mode: 'AUTO', message: 'This warehouse is on provider auto-pickup — no request is sent.' };
    }
    if (mode === 'MANUAL_PANEL') {
      return { mode: 'MANUAL_PANEL', message: 'Raise the pickup request in the provider panel.' };
    }

    // mode === 'API'
    const ready = await this.#readyShipments(warehouseId, providerCode);
    if (!ready.length) {
      throw new AppError('NO_SHIPMENTS_READY_FOR_PICKUP', 'No booked + labelled shipments are waiting for pickup at this warehouse.', 409);
    }

    const open = await query(
      `SELECT id FROM warehouse_pickup_requests
        WHERE warehouse_id = ? AND provider_code = ? AND pickup_date = ? AND status IN ('REQUESTED', 'ACCEPTED', 'UNKNOWN') LIMIT 1`,
      [warehouseId, providerCode, pickupDate],
    );
    if (open.length) {
      throw new AppError('PICKUP_ALREADY_OPEN', 'A pickup request for this warehouse and date is already open. Close it before raising another.', 409);
    }

    const idempotencyKey = `${warehouseId}:${providerCode}:${pickupDate}`;
    const id = randomUUID();
    try {
      await query(
        `INSERT INTO warehouse_pickup_requests
           (id, warehouse_id, provider_code, pickup_date, pickup_time, expected_package_count, status, idempotency_key, requested_by_staff_id)
         VALUES (?, ?, ?, ?, ?, ?, 'REQUESTED', ?, ?)`,
        [id, warehouseId, providerCode, pickupDate, pickupTime, ready.length, idempotencyKey, staffUserId],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        // The idempotency key is (warehouse, provider, date) and does NOT
        // include status, so a request that has already been COLLECTED still
        // occupies the day. That is the carrier's rule — one pickup per
        // location per day — not something to work around. But "already open"
        // would be a lie about a closed request, and would leave the operator
        // with no idea what to do, so say what actually happened and name the
        // next date that will work.
        const [existing] = await query(
          'SELECT status FROM warehouse_pickup_requests WHERE idempotency_key = ? LIMIT 1', [idempotencyKey],
        );
        const settled = existing && !['REQUESTED', 'ACCEPTED', 'UNKNOWN'].includes(existing.status);
        const next = new Date(`${pickupDate}T00:00:00`);
        next.setDate(next.getDate() + 1);
        const nextDate = next.toISOString().slice(0, 10);
        throw settled
          ? new AppError(
            'PICKUP_DAY_ALREADY_USED',
            `This warehouse's pickup for ${pickupDate} has already been ${String(existing.status).toLowerCase()}. The carrier allows one pickup per location per day — schedule this parcel for ${nextDate}.`,
            409,
            { pickupDate, nextAvailableDate: nextDate, existingStatus: existing.status },
          )
          : new AppError('PICKUP_ALREADY_OPEN', 'A pickup request for this warehouse and date already exists.', 409);
      }
      throw err;
    }

    let result = null;
    let failure = null;
    try {
      result = await this.shipping.orchestrator.requestPickup({
        providerCode,
        pickupLocationName: mapping.provider_location_identifier,
        pickupDate,
        pickupTime,
        expectedPackageCount: ready.length,
        // Delhivery's PUR Creation body carries only time/date/location/count
        // (Dev_API.docx) — the reachable contact is part of the REGISTERED
        // pickup location, not the request. These travel so an adapter whose
        // contract does accept them can use them; the Delhivery adapter
        // ignores them rather than inventing a field.
        pickupWarehouseName: warehouse.name,
        pickupPostalCode: warehouse.postal_code || null,
        pickupContactName: contact.name,
        pickupContactPhone: contact.phone,
        pickupContactPhoneAlt: contact.alt,
      });
    } catch (err) { failure = err; }

    if (result?.accepted) {
      await withTransaction(async (c) => {
        await c.execute(
          `UPDATE warehouse_pickup_requests SET status = 'ACCEPTED', provider_pickup_id = ?, response_json = ? WHERE id = ?`,
          [result.pickupId || null, JSON.stringify({ scheduledFor: result.scheduledFor }), id],
        );
        for (const s of ready) {
          await c.execute(
            `UPDATE shipments SET pickup_request_id = ?, pickup_requested_at = NOW(3),
               status = CASE WHEN status = 'BOOKED' THEN 'PICKUP_PENDING' ELSE status END, updated_at = NOW(3)
             WHERE id = ?`,
            [id, s.id],
          );
        }
      });
      return { mode: 'API', pickupRequestId: id, providerPickupId: result.pickupId || null, shipmentsCovered: ready.length, scheduledFor: result.scheduledFor };
    }

    const status = failure?.ambiguous ? 'UNKNOWN' : 'FAILED';
    await query(
      `UPDATE warehouse_pickup_requests SET status = ?, failure_code = ? WHERE id = ?`,
      [status, failure?.message || 'PROVIDER_ERROR', id],
    );
    if (status === 'UNKNOWN') {
      throw new AppError('PICKUP_REQUEST_UNKNOWN', 'The pickup request outcome is unknown — reconcile with the provider before retrying.', 409);
    }
    throw new AppError('PICKUP_REQUEST_FAILED', 'The provider rejected the pickup request.', 502, { providerReason: failure?.providerReason || null });
  }

  /**
   * "This parcel is packed, labelled and ready — please collect it."
   *
   * The operator acts on ONE order, but a carrier pickup is warehouse-level:
   * Delhivery's PUR Creation covers every package waiting at a location, and
   * only one request per warehouse per day may be open. `requestForWarehouse`
   * therefore refuses with PICKUP_ALREADY_OPEN once the day's request exists,
   * which is right for "raise the day's pickup" and wrong for "this parcel is
   * ready" — a parcel finished after that request could never be attached to
   * anything.
   *
   * So this joins rather than duplicates: it attaches the shipment to the open
   * request for its (warehouse, provider, date) when there is one, and only
   * creates and calls the provider when there is not. One provider call per
   * warehouse per day, no matter how many parcels are marked ready.
   *
   * The pickup mode is honoured, because two of the three must not call the
   * API at all:
   *   API          — request through the orchestrator
   *   AUTO         — the account is on auto-pickup; calling would be wrong
   *   MANUAL_PANEL — a human raises it in the provider's panel
   * In the latter two the parcel is still marked as awaiting collection, but no
   * pickup-request row is invented for a request nobody made.
   */
  async readyForPickup({ shipmentId, pickupDate, pickupTime = '14:00:00', staffUserId = null }) {
    WarehousePickupService.#assertPickupDate(pickupDate);

    const [shipment] = await query(
      `SELECT id, shipment_number, warehouse_id, provider_code, status, booking_status,
              tracking_number, label_status, pickup_request_id
         FROM shipments WHERE id = ? LIMIT 1`, [shipmentId]);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);

    // Preconditions, refused individually so the operator is told which one
    // failed rather than being handed a generic "not ready".
    if (shipment.booking_status !== 'BOOKED') {
      throw new AppError('SHIPMENT_NOT_BOOKED', 'Create the shipment with the carrier before marking it ready for pickup.', 409);
    }
    if (!shipment.tracking_number) {
      throw new AppError('SHIPMENT_AWB_MISSING', 'No AWB has been returned by the carrier for this shipment.', 409);
    }
    if (shipment.label_status !== 'AVAILABLE') {
      throw new AppError('SHIPMENT_LABEL_UNAVAILABLE', 'Fetch the shipping label before marking it ready for pickup.', 409);
    }
    if (shipment.pickup_request_id) {
      // Idempotent: a second click is not a second pickup.
      return { mode: 'API', alreadyReady: true, pickupRequestId: shipment.pickup_request_id, shipmentsCovered: 0 };
    }

    const providerCode = shipment.provider_code || 'DELHIVERY';
    const mapping = await this.providerLocations.activeIdentifier(shipment.warehouse_id, providerCode);
    if (!mapping) {
      throw new AppError('WAREHOUSE_NOT_REGISTERED_WITH_PROVIDER',
        `No active ${providerCode} pickup location for this warehouse.`, 409);
    }
    // The warehouse must be reachable before the parcel is declared ready —
    // in EVERY pickup mode, because AUTO and MANUAL_PANEL still end with a
    // human arriving at this address expecting someone to answer.
    await this.#pickupContact(shipment.warehouse_id);
    const mode = mapping.pickup_mode || 'MANUAL_PANEL';

    // The parcel is genuinely awaiting collection in every mode; only the way
    // the carrier is told differs.
    const markAwaitingCollection = () => query(
      `UPDATE shipments
          SET status = CASE WHEN status = 'BOOKED' THEN 'PICKUP_PENDING' ELSE status END,
              updated_at = NOW(3)
        WHERE id = ?`, [shipment.id]);

    if (mode === 'AUTO') {
      await markAwaitingCollection();
      return { mode: 'AUTO', shipmentsCovered: 1, message: 'This warehouse is on provider auto-pickup — no request is sent.' };
    }
    if (mode === 'MANUAL_PANEL') {
      await markAwaitingCollection();
      return { mode: 'MANUAL_PANEL', shipmentsCovered: 1, message: 'Raise the pickup request in the provider panel.' };
    }

    // mode === 'API' — join the day's open request if there is one.
    const [open] = await query(
      `SELECT id, provider_pickup_id FROM warehouse_pickup_requests
        WHERE warehouse_id = ? AND provider_code = ? AND pickup_date = ?
          AND status IN ('REQUESTED', 'ACCEPTED', 'UNKNOWN') LIMIT 1`,
      [shipment.warehouse_id, providerCode, pickupDate]);

    if (open) {
      await withTransaction(async (c) => {
        await c.execute(
          `UPDATE shipments SET pickup_request_id = ?, pickup_requested_at = NOW(3),
             status = CASE WHEN status = 'BOOKED' THEN 'PICKUP_PENDING' ELSE status END, updated_at = NOW(3)
           WHERE id = ?`, [open.id, shipment.id]);
        await c.execute(
          'UPDATE warehouse_pickup_requests SET expected_package_count = expected_package_count + 1 WHERE id = ?',
          [open.id]);
      });
      return {
        mode: 'API', joinedExisting: true, pickupRequestId: open.id,
        providerPickupId: open.provider_pickup_id || null, shipmentsCovered: 1,
      };
    }

    // Nothing open — raise the day's request, which sweeps in every other
    // parcel already waiting at this warehouse.
    return this.requestForWarehouse({
      warehouseId: shipment.warehouse_id, providerCode, pickupDate, pickupTime, staffUserId,
    });
  }

  async closeRequest({ pickupRequestId }) {
    const res = await query(
      `UPDATE warehouse_pickup_requests SET status = 'CLOSED', closed_at = NOW(3) WHERE id = ? AND status IN ('REQUESTED', 'ACCEPTED', 'UNKNOWN')`,
      [pickupRequestId],
    );
    if (!res.affectedRows) throw new AppError('PICKUP_REQUEST_NOT_OPEN', 'No open pickup request with that id.', 404);
    return { pickupRequestId, status: 'CLOSED' };
  }
}

export const warehousePickupService = new WarehousePickupService();
