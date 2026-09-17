import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { inventoryService } from '../inventory/service.js';
import { inventoryQuarantineService } from '../inventoryQuarantine/service.js';
import { warehouseRepository } from '../warehouses/repository.js';
import { warehouseSnapshot } from '../warehouses/service.js';
import { returnsRepository } from './repository.js';
import { returnPolicyService } from './returnPolicyService.js';
import { replacementService } from './replacementService.js';
import { reverseShipmentService } from './reverseShipmentService.js';
import { differentStyleExchangeService } from './differentStyleExchangeService.js';
import { refundService } from './refundService.js';
import { notificationService } from '../notifications/service.js';
import { assertReturnTransition } from './stateMachine.js';

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/**
 * Staff-driven return / replacement lifecycle — every move is a named action
 * that validates the current state (§32). No PATCH status anywhere. 8F-2
 * covers RETURN + REPLACEMENT; exchanges arrive in 8F-3/8F-4, financial
 * resolution in 8F-6.
 */
export class ReturnLifecycleService {
  constructor({
    repository = returnsRepository, inventory = inventoryService,
    reverseShipments = reverseShipmentService, replacements = replacementService,
    differentStyleExchange = differentStyleExchangeService, refunds = refundService,
    transaction = withTransaction,
  } = {}) {
    this.repository = repository;
    this.inventory = inventory;
    this.reverseShipments = reverseShipments;
    this.replacements = replacements;
    this.differentStyleExchange = differentStyleExchange;
    this.refunds = refunds;
    this.transaction = transaction;
  }

  async #load(tx, requestId) {
    const request = await this.repository.lockRequest(tx, requestId)
      || await this.repository.requestById(requestId, tx);
    if (!request) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);
    // lockRequest matches only by uuid; requestById also by number — re-lock by id.
    return this.repository.lockRequest(tx, request.id);
  }

  async #move(tx, request, toStatus, event, extra = {}) {
    assertReturnTransition(request.status, toStatus);
    await this.repository.setRequestStatus(tx, request.id, toStatus, extra);
    await this.repository.recordEvent(tx, request.id, {
      fromStatus: request.status, toStatus, ...event,
    });
    return { ...request, status: toStatus, ...extra };
  }

  // WP-05b — post-commit customer notification. Never throws; an extra
  // order lookup here is fine (out of any transaction).
  async #notify(eventKey, request, extra = {}) {
    try {
      const order = await this.repository.orderById(request.order_id);
      await notificationService.emit(eventKey, {
        customerId: request.customer_id,
        returnRequestId: request.id,
        requestNumber: request.request_number,
        orderNumber: order?.order_number || '',
        ...extra,
      });
    } catch { /* isolated — a notification failure never affects the lifecycle */ }
  }

  async #summary(requestId, connection = null) {
    const request = await this.repository.requestById(requestId, connection);
    const items = await this.repository.requestItems(request.id, connection);
    const reverse = await this.reverseShipments.repository.byRequest(connection, request.id);
    return {
      id: request.id,
      requestNumber: request.request_number,
      requestType: request.request_type,
      status: request.status,
      qcResult: request.qc_result ?? null,
      receivedAt: request.received_at ?? null,
      restockedAt: request.restocked_at ?? null,
      resolution: parse(request.resolution_json),
      reverseShipment: reverse ? this.reverseShipments.dto(reverse) : null,
      items: items.map((i) => ({
        orderItemId: i.order_item_id, skuId: i.sku_id, quantity: Number(i.quantity),
        restockedQuantity: Number(i.restocked_quantity), restockWarehouseId: i.restock_warehouse_id ?? null,
      })),
    };
  }

  async approve({ requestId, staffId = null }) {
    let transitioned = null;
    const result = await this.transaction(async (tx) => {
      const request = await this.#load(tx, requestId);
      if (request.status === 'APPROVED') {
        if (request.request_type === 'DIFFERENT_STYLE_EXCHANGE') {
          await this.differentStyleExchange.createForRequest({ connection: tx, request });
        }
        return this.#summary(request.id, tx);
      }
      await this.#move(tx, request, 'APPROVED',
        { eventType: 'RETURN_APPROVED', actorType: 'STAFF', actorId: staffId }, { approved_at: new Date() });
      // A different-style exchange reserves its exchange value at approval — the
      // reverse pickup of the original then runs in parallel (§50).
      if (request.request_type === 'DIFFERENT_STYLE_EXCHANGE') {
        await this.differentStyleExchange.createForRequest({ connection: tx, request: { ...request, status: 'APPROVED' } });
      }
      transitioned = request;
      return this.#summary(request.id, tx);
    });
    if (transitioned) await this.#notify('RETURN_APPROVED', transitioned);
    return result;
  }

  async reject({ requestId, staffId = null, reason = null }) {
    let transitioned = null;
    const result = await this.transaction(async (tx) => {
      const request = await this.#load(tx, requestId);
      if (request.status === 'REJECTED') return this.#summary(request.id, tx);
      await this.#move(tx, request, 'REJECTED',
        { eventType: 'RETURN_REJECTED', actorType: 'STAFF', actorId: staffId, detail: { reason } },
        { rejected_at: new Date() });
      transitioned = request;
      return this.#summary(request.id, tx);
    });
    if (transitioned) await this.#notify('RETURN_REJECTED', transitioned, { reason: reason || undefined });
    return result;
  }

  /** APPROVED -> PICKUP_PENDING; create the reverse shipment intent + route it to a return warehouse (§70). */
  preparePickup({ requestId, staffId = null }) {
    return this.transaction(async (tx) => {
      const request = await this.#load(tx, requestId);
      if (['PICKUP_PENDING', 'PICKUP_BOOKED'].includes(request.status)) return this.#summary(request.id, tx);
      assertReturnTransition(request.status, 'PICKUP_PENDING');

      const order = await this.repository.orderById(request.order_id, tx);
      const items = await this.repository.requestItems(request.id, tx);

      // Return-destination routing (§70) — policy-driven, never hardcoded.
      const policy = await returnPolicyService.get({ connection: tx });
      let wh = null;
      let warehouseId = null;
      if (policy.returnDestinationStrategy === 'ORIGIN_FULFILLMENT') {
        const originFul = await this.repository.fulfillmentForOrderItem(tx, items[0].order_item_id);
        warehouseId = originFul?.warehouse_id || null;
        wh = warehouseId ? await warehouseRepository.findById(warehouseId, tx) : null;
      }
      if (!wh) { wh = await this.#defaultWarehouse(tx); warehouseId = wh?.id; }
      if (!wh) throw new AppError('RETURN_WAREHOUSE_NOT_CONFIGURED', 'No return warehouse is configured.', 409);

      const shipment = await this.reverseShipments.ensureFor({
        connection: tx,
        returnRequestId: request.id,
        shipmentNumber: `RSHP-${request.request_number}`,
        pickupAddressSnapshot: parse(order.shipping_address_snapshot),
        destinationWarehouseId: warehouseId,
        destinationWarehouseSnapshot: warehouseSnapshot(wh),
      });

      // Hard serviceability gate (§72) — an unsupported pickup PIN routes the
      // whole request to manual logistics; no CMS override.
      const checked = await this.reverseShipments.checkServiceability({ returnShipmentId: shipment.id, connection: tx });
      if (checked.serviceable === false) {
        await this.#move(tx, request, 'MANUAL_RETURN_LOGISTICS_REQUIRED',
          { eventType: 'REVERSE_PICKUP_NOT_SERVICEABLE', actorType: 'SYSTEM', detail: { returnShipmentId: shipment.id, destinationWarehouseId: warehouseId } },
          { return_warehouse_id: warehouseId });
        return this.#summary(request.id, tx);
      }

      await this.#move(tx, request, 'PICKUP_PENDING',
        { eventType: 'REVERSE_PICKUP_PREPARED', actorType: 'STAFF', actorId: staffId, detail: { returnShipmentId: shipment.id, destinationWarehouseId: warehouseId } },
        { return_warehouse_id: warehouseId });
      return this.#summary(request.id, tx);
    });
  }

  async #defaultWarehouse(tx) {
    const rows = await tx.execute('SELECT * FROM warehouses WHERE is_default = 1 LIMIT 1');
    return rows[0][0] || (await tx.execute('SELECT * FROM warehouses ORDER BY priority, id LIMIT 1'))[0][0] || null;
  }

  /** PICKUP_PENDING -> PICKUP_BOOKED (mock reverse AWB). Idempotent per key. */
  async bookPickup({ requestId, staffId = null, idempotencyKey }) {
    const request = await this.repository.requestById(requestId);
    if (!request) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);
    const reverse = await this.reverseShipments.repository.byRequest(null, request.id);
    if (!reverse) throw new AppError('REVERSE_SHIPMENT_NOT_PREPARED', 'Prepare the pickup first.', 409);

    const booked = await this.reverseShipments.book({ returnShipmentId: reverse.id, idempotencyKey });

    return this.transaction(async (tx) => {
      const locked = await this.repository.lockRequest(tx, request.id);
      if (booked.manualLogisticsRequired) {
        if (locked.status !== 'MANUAL_RETURN_LOGISTICS_REQUIRED') {
          await this.#move(tx, locked, 'MANUAL_RETURN_LOGISTICS_REQUIRED',
            { eventType: 'REVERSE_PICKUP_MANUAL_REQUIRED', actorType: 'SYSTEM' });
        }
        return this.#summary(request.id, tx);
      }
      if (locked.status === 'PICKUP_PENDING') {
        await this.#move(tx, locked, 'PICKUP_BOOKED',
          { eventType: 'REVERSE_PICKUP_BOOKED', actorType: 'STAFF', actorId: staffId, detail: { reverseAwb: booked.shipment.reverseAwb } });
      }
      return this.#summary(request.id, tx);
    });
  }

  /** ... -> RECEIVED. Records receipt only — NEVER restocks (§38). Idempotent. */
  async markReceived({ requestId, staffId = null }) {
    let transitioned = null;
    const result = await this.transaction(async (tx) => {
      const request = await this.#load(tx, requestId);
      if (['RECEIVED', 'QC_PASSED', 'QC_FAILED', 'RESOLUTION_PENDING', 'COMPLETED'].includes(request.status)) {
        return this.#summary(request.id, tx);
      }
      assertReturnTransition(request.status, 'RECEIVED');
      const reverse = await this.reverseShipments.repository.byRequest(tx, request.id, { lock: true });
      if (reverse && reverse.status !== 'RECEIVED') {
        await this.reverseShipments.repository.update(tx, reverse.id, { status: 'RECEIVED', received_at: new Date() });
      }
      await this.#move(tx, request, 'RECEIVED',
        { eventType: 'RETURN_RECEIVED', actorType: 'STAFF', actorId: staffId }, { received_at: new Date() });
      transitioned = request;
      return this.#summary(request.id, tx);
    });
    if (transitioned) await this.#notify('RETURN_RECEIVED', transitioned);
    return result;
  }

  /**
   * RECEIVED -> QC_PASSED | QC_FAILED. QC PASS restocks each line exactly once
   * (RETURN_RESTOCKED, §40) via InventoryService; QC FAIL restocks nothing and
   * parks the request for manual review (§39). Idempotent — a repeat call with
   * the same result never double-restocks (§41).
   */
  recordQc({ requestId, staffId = null, result }) {
    if (!['PASS', 'FAIL'].includes(result)) throw new AppError('VALIDATION_ERROR', 'QC result must be PASS or FAIL.', 400);
    return this.transaction(async (tx) => {
      const request = await this.#load(tx, requestId);
      const target = result === 'PASS' ? 'QC_PASSED' : 'QC_FAILED';

      if (request.qc_result) {
        if (request.qc_result !== result) {
          throw new AppError('QC_ALREADY_RECORDED', `QC was already recorded as ${request.qc_result}.`, 409);
        }
        return this.#summary(request.id, tx); // idempotent — restock already applied
      }
      assertReturnTransition(request.status, target);

      const items = await this.repository.requestItems(request.id, tx);
      const warehouseId = request.return_warehouse_id
        || (await this.reverseShipments.repository.byRequest(tx, request.id))?.destination_warehouse_id;

      if (result === 'PASS') {
        if (!warehouseId) throw new AppError('RETURN_WAREHOUSE_NOT_CONFIGURED', 'No return warehouse to restock into.', 409);
        for (const item of items) {
          const toRestock = Number(item.quantity) - Number(item.restocked_quantity);
          if (toRestock <= 0) continue;
          await this.inventory.restockReturn({
            warehouseId, skuId: item.sku_id, quantity: toRestock,
            referenceId: request.id, reason: `RETURN ${request.request_number}`, connection: tx,
          });
          await this.repository.updateItemRestock(tx, item.id, {
            restockedQuantity: Number(item.quantity), restockWarehouseId: warehouseId,
          });
        }
        await this.#move(tx, request, 'QC_PASSED',
          { eventType: 'RETURN_QC_PASSED', actorType: 'STAFF', actorId: staffId },
          { qc_result: 'PASS', qc_recorded_at: new Date(), restocked_at: new Date() });
        await this.#move(tx, { ...request, status: 'QC_PASSED' }, 'RESOLUTION_PENDING',
          { eventType: 'RETURN_RESOLUTION_PENDING', actorType: 'SYSTEM',
            detail: { financial: 'PENDING_8F6' } },
          { resolution_json: JSON.stringify({ financial: 'PENDING_8F6', qc: 'PASS' }) });
      } else {
        // WP-12 / GAP-INV-03 — the failed units are physically at the return
        // warehouse. Park them in the non_sellable quarantine bucket (a batch
        // per line) so the physical count stays truthful; staff later RELEASE
        // (rework passed) or SCRAP them. Never restocks sellable stock.
        let quarantined = false;
        if (warehouseId) {
          for (const item of items) {
            const failedQty = Number(item.quantity) - Number(item.restocked_quantity);
            if (failedQty <= 0) continue;
            await inventoryQuarantineService.openFromReturnQc({
              warehouseId, skuId: item.sku_id, quantity: failedQty,
              returnRequestId: request.id, returnNumber: request.request_number,
              staffId, connection: tx,
            });
            quarantined = true;
          }
        }
        await this.#move(tx, request, 'QC_FAILED',
          { eventType: 'RETURN_QC_FAILED', actorType: 'STAFF', actorId: staffId, detail: { quarantined } },
          { qc_result: 'FAIL', qc_recorded_at: new Date() });
        await this.#move(tx, { ...request, status: 'QC_FAILED' }, 'RESOLUTION_PENDING',
          { eventType: 'RETURN_MANUAL_REVIEW', actorType: 'SYSTEM', detail: { reason: 'QC_FAIL', quarantined } },
          { resolution_json: JSON.stringify({ financial: 'BLOCKED_QC_FAIL', qc: 'FAIL', manualReview: true, quarantined }) });
      }
      return this.#summary(request.id, tx);
    });
  }

  /**
   * RESOLUTION_PENDING -> COMPLETED.
   *  - REPLACEMENT / SAME_STYLE_EXCHANGE + QC PASS: release the outgoing
   *    fulfillment first (§33).
   *  - RETURN + QC PASS: financial resolution via refundService (§85-102) —
   *    refund to original payment / store credit, plus a partial credit note.
   *  - QC FAIL: no refund; resolution stays BLOCKED (§39).
   */
  async completeResolution({ requestId, staffId = null, simulate = null }) {
    const pre = await this.repository.requestById(requestId);
    if (!pre) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);
    if (pre.status === 'COMPLETED') return this.#summary(pre.id);

    let outbound = null;
    if (['REPLACEMENT', 'SAME_STYLE_EXCHANGE'].includes(pre.request_type) && pre.qc_result === 'PASS') {
      outbound = await this.replacements.releaseFor(pre.id);
    }

    let refund = null;
    if (pre.request_type === 'RETURN' && pre.qc_result === 'PASS') {
      refund = await this.refunds.resolveForReturn({ returnRequestId: pre.id, simulate });
    }

    return this.transaction(async (tx) => {
      const request = await this.repository.lockRequest(tx, pre.id);
      if (request.status === 'COMPLETED') return this.#summary(request.id, tx);
      assertReturnTransition(request.status, 'COMPLETED');
      const resolution = parse(request.resolution_json) || {};
      await this.#move(tx, request, 'COMPLETED',
        { eventType: 'RETURN_COMPLETED', actorType: 'STAFF', actorId: staffId, detail: { outbound, refund: refund?.refund } },
        {
          completed_at: new Date(),
          resolution_json: JSON.stringify({ ...resolution, ...(refund?.resolution || {}), outbound, completedBy: staffId || 'SYSTEM' }),
        });
      return this.#summary(request.id, tx);
    });
  }
}

export const returnLifecycleService = new ReturnLifecycleService();
