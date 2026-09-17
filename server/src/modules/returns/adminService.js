import { AppError } from '../../utils/errors.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { refundPayoutService } from './refundPayoutService.js';
import { returnsRepository } from './repository.js';
import { reverseShipmentService } from './reverseShipmentService.js';
import { returnQcService } from './returnQcService.js';

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/**
 * CMS read models + warehouse-scope enforcement for the Returns & Exchanges
 * area (§103-110). Named actions themselves stay in returnLifecycleService /
 * refundService — this only assembles views and gates by warehouse scope.
 */
export class ReturnsAdminService {
  constructor({ repository = returnsRepository, reverseShipments = reverseShipmentService } = {}) {
    this.repository = repository;
    this.reverseShipments = reverseShipments;
  }

  async list({ staff, filters = {}, brandId = null }) {
    const scope = await warehouseScopeForStaff(staff, brandId);
    const rows = await this.repository.adminList({
      ...filters,
      warehouseIds: scope.all ? null : scope.warehouseIds,
      brandId,
    });
    return rows.map((r) => ({
      id: r.id,
      requestNumber: r.request_number,
      requestType: r.request_type,
      status: r.status,
      qcResult: r.qc_result ?? null,
      reasonCode: r.reason_code ?? null,
      customerId: r.customer_id,
      customerName: r.customer_name || null,
      orderId: r.order_id,
      orderNumber: r.order_number,
      unitCount: Number(r.unit_count),
      returnWarehouseId: r.return_warehouse_id ?? null,
      reverseStatus: r.reverse_status ?? null,
      refundStatus: r.refund_status ?? null,
      refundMethod: r.refund_method ?? null,
      requestedAt: r.requested_at,
      updatedAt: r.updated_at,
    }));
  }

  /** Resolve the warehouse a request is (or will be) associated with, for scope checks. */
  async #requestWarehouseId(tx, request) {
    if (request.return_warehouse_id) return request.return_warehouse_id;
    const items = await this.repository.requestItems(request.id);
    const originFul = items[0] ? await this.repository.fulfillmentForOrderItem(null, items[0].order_item_id) : null;
    return originFul?.warehouse_id ?? null;
  }

  async assertScope(staff, requestId) {
    const request = await this.repository.requestById(requestId);
    if (!request) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);
    const scope = await warehouseScopeForStaff(staff);
    if (scope.all) return request;
    const warehouseId = await this.#requestWarehouseId(null, request);
    // A warehouse-scoped staff member with no assignments has no access at all.
    if (!scope.warehouseIds.length || (warehouseId && !scope.warehouseIds.includes(warehouseId))) {
      throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this return\'s warehouse.', 403);
    }
    return request;
  }

  async detail({ staff, requestId }) {
    const request = await this.assertScope(staff, requestId);
    const [items, events, reverse, reverseTimeline, refund, creditNote, replacement, exchange] = await Promise.all([
      this.repository.requestItems(request.id),
      this.repository.requestEvents(request.id),
      this.repository.adminReverseShipment(request.id),
      this.repository.adminReverseTimeline(request.id),
      this.repository.adminRefundAttempt(request.id),
      this.repository.adminCreditNote(request.id),
      this.repository.adminReplacementFulfillment(request.id),
      this.repository.adminExchangeTransaction(request.id),
    ]);
    const order = await this.repository.orderById(request.order_id);
    const qcSnapshot = await returnQcService.snapshotForRequest(request.id).catch(() => null);

    return {
      id: request.id,
      qcSnapshot,
      requestNumber: request.request_number,
      requestType: request.request_type,
      status: request.status,
      qcResult: request.qc_result ?? null,
      reasonCode: request.reason_code ?? null,
      customerNote: request.customer_note ?? null,
      createdBy: request.created_by,
      customerId: request.customer_id,
      order: order ? { id: order.id, orderNumber: order.order_number, paymentMode: order.payment_mode, status: order.order_status } : null,
      returnWarehouseId: request.return_warehouse_id ?? null,
      eligibilitySnapshot: parse(request.eligibility_snapshot_json),
      resolution: parse(request.resolution_json),
      requestedAt: request.requested_at,
      approvedAt: request.approved_at ?? null,
      receivedAt: request.received_at ?? null,
      completedAt: request.completed_at ?? null,
      items: items.map((i) => ({
        orderItemId: i.order_item_id,
        skuId: i.sku_id,
        quantity: Number(i.quantity),
        restockedQuantity: Number(i.restocked_quantity),
        restockWarehouseId: i.restock_warehouse_id ?? null,
        reasonCode: i.reason_code ?? null,
        unitPriceMinor: Number(i.unit_price_minor),
        eligibleValueMinor: Number(i.eligible_value_minor),
        deliveredAt: i.delivered_at ?? null,
        returnDeadline: i.return_deadline ?? null,
        target: i.target_sku_id ? { skuId: i.target_sku_id, unitPriceMinor: i.target_unit_price_minor == null ? null : Number(i.target_unit_price_minor) } : null,
      })),
      reverseShipment: reverse ? {
        shipmentNumber: reverse.shipment_number,
        status: reverse.status,
        reverseAwb: reverse.reverse_awb ?? null,
        destinationWarehouseId: reverse.destination_warehouse_id,
        serviceable: reverse.serviceable == null ? null : Boolean(reverse.serviceable),
        pickupAddress: parse(reverse.pickup_address_snapshot_json),
        // Normalised customer-facing timeline — no carrier vocabulary (§117).
        timeline: reverseTimeline.map((e) => ({ status: e.normalized_status, at: e.occurred_at, location: e.location_text })),
      } : null,
      refund: refund ? {
        refundNumber: refund.refund_number,
        method: refund.method,
        status: refund.status,
        amountMinor: Number(refund.amount_minor),
        providerCode: refund.provider_code ?? null,
        failureCode: refund.failure_code ?? null,
        // Manual COD payout fields — what operations recorded, so the CMS can
        // show a real bank/UPI reference instead of an opaque 'SUCCEEDED'.
        payoutReference: refund.payout_reference ?? null,
        payoutNote: refund.payout_note ?? null,
        processingStartedAt: refund.processing_started_at ? new Date(refund.processing_started_at).toISOString() : null,
        completedAt: refund.completed_at ? new Date(refund.completed_at).toISOString() : null,
      } : null,
      // The destination the customer nominated, MASKED. The full account number
      // is never assembled into an API response — operations decrypt it only on
      // the dedicated payout path.
      refundPayout: await refundPayoutService.findMasked(requestId),
      creditNote: creditNote ? {
        creditNoteNumber: creditNote.credit_note_number,
        type: creditNote.credit_note_type,
        amountMinor: Number(creditNote.amount_minor),
        treatmentStatus: creditNote.treatment_status,
      } : null,
      replacementFulfillment: replacement ? { id: replacement.id, number: replacement.fulfillment_number, warehouseId: replacement.warehouse_id, status: replacement.status } : null,
      exchangeTransaction: exchange ? { id: exchange.id, number: exchange.transaction_number, status: exchange.status, newExchangeOrderId: exchange.new_exchange_order_id ?? null, eligibleValueMinor: Number(exchange.eligible_value_minor) } : null,
      auditTimeline: events.map((e) => ({
        eventType: e.event_type,
        fromStatus: e.from_status ?? null,
        toStatus: e.to_status ?? null,
        actorType: e.actor_type,
        detail: parse(e.detail_json),
        at: e.created_at,
      })),
    };
  }
}

export const returnsAdminService = new ReturnsAdminService();
