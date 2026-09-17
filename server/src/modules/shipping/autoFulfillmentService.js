import { env } from '../../config/index.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { logger } from '../../utils/logger.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { orderOpsRepository } from '../orderOps/repository.js';
import { shipmentBookingService, shipmentLabelService } from '../orderOps/service.js';
import { shipmentPackageService } from '../orderOps/shipmentCancellationService.js';
import { warehousePickupService } from './pickupService.js';
import { notificationService } from '../notifications/service.js';

const log = logger('auto-fulfillment');
const audit = new StaffAuditRepository();

// Phase 2 — automated shipment workflow.
//
// After an order is confirmed and PROCESSING, this drives the forward chain
// with NO admin click per order:
//
//   confirm package (from catalog weight) → book (manifest → AWB) → fetch label
//   → request pickup (warehouse-level) → notify warehouse staff
//
// It only calls the EXISTING per-step services, so booking idempotency
// (shipment_booking_attempts), UNKNOWN-safety, the label ≥ AWB gate and the
// warehouse-level pickup dedupe all still apply. The admin can still run every
// step manually, and a failed/blocked automation is visible + retryable.
const STEPS = ['PACKAGE', 'BOOK', 'LABEL', 'PICKUP', 'NOTIFY'];
const MAX_ATTEMPTS = 6;
const RETRY_BACKOFF_MS = [0, 60_000, 300_000, 900_000, 3_600_000, 10_800_000];

export class AutoFulfillmentService {
  constructor({
    repository = orderOpsRepository,
    booking = shipmentBookingService,
    label = shipmentLabelService,
    pkg = shipmentPackageService,
    pickup = warehousePickupService,
    notifications = notificationService,
    now = () => new Date(),
    automationEnabled = env.SHIPMENT_AUTOMATION_ENABLED !== false,
    automationMode = env.SHIPMENT_AUTOMATION_MODE || 'AUTO',
  } = {}) {
    this.automationEnabled = automationEnabled;
    this.automationMode = automationMode;
    this.repository = repository;
    this.booking = booking;
    this.label = label;
    this.pkg = pkg;
    this.pickup = pickup;
    this.notifications = notifications;
    this.now = now;
  }

  get enabled() {
    return this.automationEnabled !== false && this.automationMode !== 'MANUAL';
  }

  /** Queue every INITIAL shipment of an order for automation. Called on PROCESSING. */
  async queueForOrder(orderId, { trigger = 'ORDER_PROCESSING' } = {}) {
    const shipments = await query(
      `SELECT s.id FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
        WHERE f.order_id = ? AND f.fulfillment_type = 'INITIAL' AND s.status NOT IN ('CANCELLED', 'DELIVERED')`,
      [orderId],
    );
    for (const s of shipments) {
      await query(
        `UPDATE shipments SET auto_fulfillment_status = 'QUEUED', auto_fulfillment_step = NULL,
           auto_fulfillment_error = NULL, auto_fulfillment_next_at = NOW(3), auto_fulfillment_updated_at = NOW(3)
         WHERE id = ? AND auto_fulfillment_status IN ('IDLE', 'FAILED', 'BLOCKED')`,
        [s.id],
      );
    }
    log.info('queued_for_order', { orderId, shipments: shipments.length, trigger });
    if (this.enabled) {
      for (const s of shipments) this.runForShipment(s.id, { trigger }).catch(() => {});
    }
    return { queued: shipments.length };
  }

  /** Drive one shipment as far through the chain as it can go right now. */
  async runForShipment(shipmentId, { trigger = 'WORKER', actor = null, maxSteps = STEPS.length + 1 } = {}) {
    if (!this.enabled && trigger !== 'MANUAL') return { skipped: 'AUTOMATION_DISABLED' };

    let executed = 0;
    for (let i = 0; i < maxSteps; i += 1) {
      const shipment = await this.repository.shipment(shipmentId);
      if (!shipment) return { error: 'SHIPMENT_NOT_FOUND' };

      const step = this.#nextStep(shipment);
      if (!step) {
        await this.#mark(shipmentId, { status: 'DONE', step: null, error: null });
        return { done: true, executed, finalStatus: shipment.status, awb: shipment.tracking_number };
      }

      await this.#mark(shipmentId, { status: 'RUNNING', step });
      try {
        await this.#execute(step, shipment, actor);
        executed += 1;
      } catch (error) {
        const blocked = error?.code && ['MISSING_SHIPPING_WEIGHT', 'WAREHOUSE_NOT_REGISTERED_WITH_PROVIDER', 'SHIPMENT_NOT_READY_TO_BOOK', 'COD_SPLIT_INVARIANT_FAILED'].includes(error.code);
        const unknown = error?.code === 'BOOKING_RECONCILIATION_REQUIRED' || error?.code === 'PICKUP_REQUEST_UNKNOWN';
        const attempts = Number(shipment.auto_fulfillment_attempts || 0) + 1;
        const nextAt = new Date(this.now().getTime() + (RETRY_BACKOFF_MS[Math.min(attempts, RETRY_BACKOFF_MS.length - 1)] || 0));
        const status = blocked || unknown ? 'BLOCKED' : (attempts >= MAX_ATTEMPTS ? 'FAILED' : 'QUEUED');
        await this.#mark(shipmentId, {
          status, step, error: `${error.code || 'ERROR'}: ${String(error.message || '').slice(0, 200)}`,
          attempts, nextAt: status === 'QUEUED' ? nextAt : null,
        });
        log.warn('step_failed', { shipmentId, step, code: error?.code, status, attempts, trigger });
        await audit.log({
          staffUserId: actor?.id || null, actorEmail: actor?.email || 'system:auto-fulfillment',
          action: 'AUTO_FULFILLMENT_STEP_FAILED', resourceType: 'shipment', resourceId: shipmentId,
          metadata: { step, code: error?.code || 'ERROR', status },
        });
        return { blocked: status === 'BLOCKED', failed: status === 'FAILED', step, error: error?.code || 'ERROR' };
      }
    }
    return { paused: true, executed };
  }

  #nextStep(s) {
    if (['CANCELLED', 'DELIVERED', 'RTO_RETURNED', 'LOST'].includes(s.status)) return null;
    if (s.booking_status === 'UNKNOWN') return null; // reconcile first (BLOCKED), never auto-retry create
    if (s.booking_status === 'BOOKED') {
      if (s.label_status !== 'AVAILABLE') return 'LABEL';
      if (!s.pickup_requested_at) return 'PICKUP';
      if (s.auto_fulfillment_step !== 'NOTIFY' && s.auto_fulfillment_status !== 'DONE') return 'NOTIFY';
      return null;
    }
    // pre-booking
    const pkg = parseJson(s.package_snapshot_json);
    if (s.booking_status === 'NOT_READY' || !pkg?.packageConfirmed) return 'PACKAGE';
    if (['READY', 'FAILED'].includes(s.booking_status)) return 'BOOK';
    return null;
  }

  async #execute(step, shipment, actor) {
    switch (step) {
      case 'PACKAGE': {
        const calc = await this.pkg.calculatedItemWeightGrams(shipment.id);
        if (calc.grams == null) {
          const e = new Error('One or more SKUs in this shipment have no shipping weight configured.');
          e.code = 'MISSING_SHIPPING_WEIGHT'; throw e;
        }
        const dims = await productDimsForShipment(shipment.id);
        await withTransaction((c) => this.repository.updateShipment(c, shipment.id, {
          package_snapshot_json: JSON.stringify({
            weightGrams: calc.grams,
            lengthMm: dims.lengthMm, widthMm: dims.widthMm, heightMm: dims.heightMm,
            calculatedItemWeightGrams: calc.grams, calculatedWeightComplete: calc.complete,
            packageConfirmed: true, source: 'AUTO', confirmedAt: this.now().toISOString(),
          }),
          booking_status: shipment.booking_status === 'NOT_READY' ? 'READY' : shipment.booking_status,
        }));
        return;
      }
      case 'BOOK':
        // Fixed idempotency key per shipment — a retry resumes, never a 2nd AWB.
        await this.booking.book({ shipmentId: shipment.id, idempotencyKey: `auto:${shipment.id}`, staffUserId: actor?.id || null });
        return;
      case 'LABEL':
        await this.label.fetchLabel({ shipmentId: shipment.id, staffUserId: actor?.id || null });
        return;
      case 'PICKUP': {
        let outcome = null;
        try {
          outcome = await this.pickup.requestForWarehouse({
            warehouseId: shipment.warehouse_id,
            providerCode: shipment.provider_code || 'DELHIVERY',
            pickupDate: nextBusinessDate(this.now()),
            staffUserId: actor?.id || null,
          });
        } catch (error) {
          // An open PUR already covers this shipment ⇒ done.
          if (error?.code === 'PICKUP_ALREADY_OPEN') { outcome = { mode: 'API', alreadyOpen: true }; }
          else throw error; // NO_SHIPMENTS_READY_FOR_PICKUP re-throws ⇒ QUEUED, retried by the worker
        }
        // AUTO / MANUAL_PANEL modes, or an accepted request: the shipment is
        // now "pickup handled" — stamp it so the chain moves to NOTIFY.
        if (!shipment.pickup_requested_at && (outcome?.mode === 'AUTO' || outcome?.mode === 'MANUAL_PANEL' || outcome?.alreadyOpen || outcome?.pickupRequestId)) {
          await withTransaction((c) => this.repository.updateShipment(c, shipment.id, {
            pickup_requested_at: this.now(),
            status: shipment.status === 'BOOKED' ? 'PICKUP_PENDING' : shipment.status,
          }));
        }
        return;
      }
      case 'NOTIFY': {
        const order = await this.repository.orderForShipment(shipment.id);
        await this.notifications.emit('WAREHOUSE_SHIPMENT_READY', {
          orderId: order?.id, orderNumber: order?.order_number,
          shipmentId: shipment.id, warehouseId: shipment.warehouse_id, awb: shipment.tracking_number,
        }).catch(() => {});
        await audit.log({
          staffUserId: actor?.id || null, actorEmail: actor?.email || 'system:auto-fulfillment',
          action: 'WAREHOUSE_SHIPMENT_READY', resourceType: 'shipment', resourceId: shipment.id,
          metadata: { warehouseId: shipment.warehouse_id, awb: shipment.tracking_number },
        });
        return;
      }
      default:
        throw new Error(`UNKNOWN_STEP:${step}`);
    }
  }

  async #mark(shipmentId, patch) {
    await this.repository.setAutoFulfillment(shipmentId, patch);
  }

  /** Worker tick — pick up QUEUED shipments whose retry time has arrived. */
  async runDueBatch({ batchSize = 10 } = {}) {
    if (!this.enabled) return 0;
    const rows = await query(
      `SELECT id FROM shipments
        WHERE auto_fulfillment_status = 'QUEUED'
          AND (auto_fulfillment_next_at IS NULL OR auto_fulfillment_next_at <= NOW(3))
        ORDER BY auto_fulfillment_next_at ASC LIMIT ?`,
      [batchSize],
    );
    for (const r of rows) {
      await this.runForShipment(r.id, { trigger: 'WORKER' }).catch((e) => log.error('worker_run_failed', { shipmentId: r.id, error: e.message }));
    }
    return rows.length;
  }
}

function parseJson(v) { try { return v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v); } catch { return null; } }

async function productDimsForShipment(shipmentId) {
  const rows = await query(
    `SELECT psp.length_mm, psp.width_mm, psp.height_mm
       FROM shipments sh
       JOIN fulfillment_items fi ON fi.fulfillment_id = sh.fulfillment_id
       JOIN skus s ON s.id = fi.sku_id
       JOIN product_variants v ON v.id = s.variant_id
       JOIN product_shipping_profiles psp ON psp.product_id = v.product_id
      WHERE sh.id = ? AND psp.length_mm IS NOT NULL
      ORDER BY (psp.length_mm * psp.width_mm * psp.height_mm) DESC LIMIT 1`,
    [shipmentId],
  );
  const r = rows[0];
  return { lengthMm: r?.length_mm ?? null, widthMm: r?.width_mm ?? null, heightMm: r?.height_mm ?? null };
}

function nextBusinessDate(from) {
  const d = new Date(from);
  d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1); // skip Sunday
  return d.toISOString().slice(0, 10);
}

export const autoFulfillmentService = new AutoFulfillmentService();
