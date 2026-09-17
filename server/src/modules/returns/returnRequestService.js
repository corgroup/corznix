import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { refundPayoutService, COD_PAYMENT_MODES } from './refundPayoutService.js';
import { AppError } from '../../utils/errors.js';
import { returnsRepository } from './repository.js';
import { returnEligibilityService, REQUEST_TYPES } from './returnEligibilityService.js';
import { notificationService } from '../notifications/service.js';
import { staffNotificationService } from '../staffNotifications/service.js';

const stamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

/**
 * Owns the return / replacement / exchange request lifecycle for the customer
 * surface (§21). Backend is the only authority; every mutation is a named
 * action that validates the current state (§32).
 *
 * 8F-1 scope: create / read / cancel. Approval, reverse pickup, QC and
 * financial resolution arrive in 8F-2..8F-6.
 */
export class ReturnRequestService {
  constructor({ repository = returnsRepository, eligibility = returnEligibilityService, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.eligibility = eligibility;
    this.transaction = transaction;
  }

  #customerTimeline(events) {
    // Normalised, safe labels only — no staff ids, warehouse ids, AWBs or
    // provider internals (§113/§116/§117).
    const LABEL = {
      RETURN_REQUEST_CREATED: 'Request Submitted',
      RETURN_APPROVED: 'Approved',
      RETURN_REJECTED: 'Rejected',
      RETURN_REQUEST_CANCELLED: 'Cancelled',
      REVERSE_PICKUP_PREPARED: 'Pickup Being Arranged',
      REVERSE_PICKUP_BOOKED: 'Pickup Scheduled',
      REVERSE_PICKUP_MANUAL_REQUIRED: 'Manual Pickup Being Arranged',
      REVERSE_PICKUP_NOT_SERVICEABLE: 'Manual Pickup Being Arranged',
      RETURN_RECEIVED: 'Received at Warehouse',
      RETURN_QC_PASSED: 'Quality Check Passed',
      RETURN_QC_FAILED: 'Quality Check Issue — Under Review',
      RETURN_RESOLUTION_PENDING: 'Processing Resolution',
      RETURN_MANUAL_REVIEW: 'Under Review',
      REPLACEMENT_RELEASED: 'Replacement Prepared',
      EXCHANGE_FULFILLMENT_RELEASED: 'Exchange Item Prepared',
      EXCHANGE_CREDIT_RESERVED: 'Exchange Value Reserved',
      EXCHANGE_CREDIT_CONSUMED: 'Exchange Applied to New Order',
      EXCHANGE_CANCELLED: 'Exchange Cancelled',
      EXCHANGE_EXPIRED: 'Exchange Expired',
      RETURN_COMPLETED: 'Completed',
    };
    return (events || [])
      .filter((e) => LABEL[e.event_type])
      .map((e) => ({ label: LABEL[e.event_type], at: e.created_at }));
  }

  #financialSummary(refund, resolution, payout = null) {
    if (!refund && !resolution) return null;
    const method = refund?.method || resolution?.refund?.method || null;
    const status = refund?.status || resolution?.refund?.status || resolution?.financial || null;
    const amountMinor = refund ? Number(refund.amount_minor) : resolution?.refund?.amountMinor ?? null;
    const CUSTOMER_STATUS = {
      SUCCEEDED: 'Refund Completed', PENDING: 'Refund Processing', PROCESSING: 'Refund Processing',
      UNKNOWN: 'Refund Processing', FAILED: 'Refund Issue — Under Review', BLOCKED: 'Refund Pending Review',
      STORE_CREDIT: 'Store Credit Issued', REFUND_PENDING: 'Refund Processing',
    };
    // COD_PAYOUT is an internal routing decision; the customer only needs to
     // know the money is going to the UPI id or bank account they gave us.
    const CUSTOMER_METHOD = {
      STORE_CREDIT: 'STORE_CREDIT', ORIGINAL_PAYMENT: 'ORIGINAL_PAYMENT',
      COD_PAYOUT: payout?.method === 'UPI' ? 'UPI' : 'BANK_ACCOUNT',
      COD_BLOCKED: 'PENDING_DETAILS', BLOCKED: 'PENDING_REVIEW',
    };
    return {
      method: CUSTOMER_METHOD[method] ?? method ?? null,
      label: CUSTOMER_STATUS[status] || 'Refund Pending',
      amountMinor,
      // Masked destination so the customer can confirm where it is going.
      destination: payout,
    };
  }

  #requestDto(request, items, events, reverseTimeline = [], refund = null, payout = null) {
    const resolution = parse(request.resolution_json);
    return {
      id: request.id,
      requestNumber: request.request_number,
      orderId: request.order_id,
      requestType: request.request_type,
      status: request.status,
      reasonCode: request.reason_code ?? null,
      customerNote: request.customer_note ?? null,
      returnWarehouseId: request.return_warehouse_id ?? null,
      canCancel: this.eligibility.canCancel(request.status),
      eligibilitySnapshot: parse(request.eligibility_snapshot_json),
      requestedAt: request.requested_at,
      approvedAt: request.approved_at ?? null,
      cancelledAt: request.cancelled_at ?? null,
      completedAt: request.completed_at ?? null,
      items: (items || []).map((item) => ({
        orderItemId: item.order_item_id,
        skuId: item.sku_id,
        fulfillmentId: item.fulfillment_id ?? null,
        quantity: Number(item.quantity),
        reasonCode: item.reason_code ?? null,
        itemNote: item.item_note ?? null,
        unitPriceMinor: Number(item.unit_price_minor),
        eligibleValueMinor: Number(item.eligible_value_minor),
        deliveredAt: item.delivered_at ?? null,
        returnDeadline: item.return_deadline ?? null,
        target: item.target_sku_id
          ? {
            productId: item.target_product_id,
            variantId: item.target_variant_id,
            skuId: item.target_sku_id,
            unitPriceMinor: item.target_unit_price_minor == null ? null : Number(item.target_unit_price_minor),
          }
          : null,
      })),
      // Normalised, safe customer-facing timeline (§113) — no internals.
      timeline: this.#customerTimeline(events),
      // Normalised reverse-pickup tracking — no carrier vocabulary (§82/§117).
      reverseTracking: (reverseTimeline || []).map((e) => ({ status: e.normalized_status, at: e.occurred_at })),
      financialSummary: this.#financialSummary(refund, resolution, payout),
    };
  }

  async #assemble(request, connection = null) {
    const [items, events] = await Promise.all([
      this.repository.requestItems(request.id, connection),
      this.repository.requestEvents(request.id, connection),
    ]);
    // Reverse tracking + refund summary are read outside any transaction — a
    // fresh assemble after commit is fine.
    const [reverseTimeline, refund, payout] = connection ? [[], null, null] : await Promise.all([
      this.repository.adminReverseTimeline(request.id),
      this.repository.adminRefundAttempt(request.id),
      // Masked only — the customer sees where their refund is going, never
      // the full account number they typed.
      refundPayoutService.findMasked(request.id),
    ]);
    return this.#requestDto(request, items, events, reverseTimeline, refund, payout);
  }

  async getRequest(customerId, idOrNumber) {
    const request = await this.repository.ownedRequest(customerId, idOrNumber);
    if (!request) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);
    return this.#assemble(request);
  }

  async listRequests(customerId) {
    const rows = await this.repository.listOwned(customerId);
    return rows.map((r) => ({
      id: r.id,
      requestNumber: r.request_number,
      orderId: r.order_id,
      requestType: r.request_type,
      status: r.status,
      reasonCode: r.reason_code ?? null,
      canCancel: this.eligibility.canCancel(r.status),
      requestedAt: r.requested_at,
      updatedAt: r.updated_at,
    }));
  }

  /**
   * Create a return / replacement / exchange request. Persistently idempotent
   * on (order, idempotencyKey) — a client retry returns the original request,
   * never a duplicate (§24). The order row lock serializes concurrent creates
   * so the last eligible unit can be claimed exactly once (§19, §20).
   */
  async createRequest({
    customerId, orderId, requestType, reasonCode = null, customerNote = null,
    items = [], idempotencyKey, refundPayout = null,
  }) {
    if (!customerId) throw new AppError('VALIDATION_ERROR', 'Authentication required.', 401);
    if (!REQUEST_TYPES.includes(requestType)) {
      throw new AppError('VALIDATION_ERROR', `Unknown request type "${requestType}".`, 400);
    }
    if (!idempotencyKey || String(idempotencyKey).length < 8 || String(idempotencyKey).length > 120) {
      throw new AppError('VALIDATION_ERROR', 'A valid idempotency key (8-120 chars) is required.', 400);
    }
    if (!Array.isArray(items) || items.length === 0) {
      throw new AppError('VALIDATION_ERROR', 'At least one item is required.', 400);
    }
    const seen = new Set();
    for (const item of items) {
      if (!item?.orderItemId) throw new AppError('VALIDATION_ERROR', 'Each item needs an orderItemId.', 400);
      if (seen.has(item.orderItemId)) {
        throw new AppError('VALIDATION_ERROR', 'The same order item appears more than once.', 400);
      }
      seen.add(item.orderItemId);
    }

    let notifyCtx = null;
    const run = async (tx) => {
      const order = await this.repository.lockOwnedOrder(tx, customerId, orderId);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);

      const scopedKey = `ret:${order.id}:${idempotencyKey}`;
      const replay = await this.repository.requestByIdempotencyKey(tx, scopedKey);
      if (replay) {
        if (replay.customer_id !== customerId) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
        return this.#assemble(replay, tx);
      }

      const assessment = await this.eligibility.assessForRequest({
        connection: tx, order, requestedAction: requestType, lines: items,
      });

      const eligibilitySnapshot = {
        assessedAt: new Date().toISOString(),
        orderNumber: order.order_number,
        orderStatusAtRequest: order.order_status,
        requestType,
        policy: assessment.policy,
        lines: assessment.lines.map((line) => ({
          orderItemId: line.orderItemId,
          skuId: line.skuId,
          fulfillmentId: line.fulfillmentId,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          eligibleValueMinor: line.eligibleValueMinor,
          deliveredAt: line.deliveredAt,
          returnDeadline: line.returnDeadline,
          targetSkuId: line.targetSkuId ?? null,
          targetUnitPriceMinor: line.targetUnitPriceMinor ?? null,
          priceDifferenceMinor: line.priceDifferenceMinor ?? null,
          pricePolicyOutcome: line.pricePolicyOutcome ?? null,
        })),
        totalEligibleValueMinor: assessment.lines.reduce((sum, l) => sum + l.eligibleValueMinor, 0),
      };

      const [returnBrand] = await tx.execute('SELECT order_prefix FROM brands WHERE id = ?', [order.brand_id]).then((r) => r[0]);
      const requestNumber = `${returnBrand?.order_prefix || 'ORD'}-RET-${stamp()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
      let request;
      try {
        request = await this.repository.insertRequest(tx, {
          requestNumber,
          customerId,
          orderId: order.id,
          requestType,
          reasonCode,
          customerNote,
          eligibilitySnapshot,
          idempotencyKey: scopedKey,
          createdBy: 'CUSTOMER',
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          const raced = await this.repository.requestByIdempotencyKey(tx, scopedKey);
          if (raced) return this.#assemble(raced, tx);
        }
        throw err;
      }

      // A COD order has no instrument to refund to, so the destination the
      // customer nominated is stored in the SAME transaction as the request:
      // a return must never exist without the means to pay it back.
      if (COD_PAYMENT_MODES.includes(order.payment_mode) && requestType === 'RETURN') {
        if (!refundPayout) {
          throw new AppError('REFUND_PAYOUT_REQUIRED', 'Choose how you would like the refund paid.', 400);
        }
        await refundPayoutService.submit(tx, {
          returnRequestId: request.id, customerId, brandId: order.brand_id, payout: refundPayout,
        });
      }

      for (const line of assessment.lines) {
        await this.repository.insertRequestItem(tx, request.id, line);
      }
      await this.repository.recordEvent(tx, request.id, {
        eventType: 'RETURN_REQUEST_CREATED',
        toStatus: 'REQUESTED',
        actorType: 'CUSTOMER',
        actorId: customerId,
        detail: { requestType, lineCount: assessment.lines.length, totalEligibleValueMinor: eligibilitySnapshot.totalEligibleValueMinor },
      });

      notifyCtx = { customerId, returnRequestId: request.id, requestNumber: request.request_number, orderNumber: order.order_number };
      return this.#assemble(request, tx);
    };

    const result = await this.transaction(run);
    // WP-05b — "we've received your return request" confirmation. Post-commit,
    // isolated, deduped on return_requested:<id>.
    if (notifyCtx) await notificationService.emit('RETURN_REQUESTED', notifyCtx).catch(() => {});
    if (notifyCtx) {
      await staffNotificationService.record({
        category: 'RETURN', eventKey: 'RETURN_REQUESTED', severity: 'INFO',
        title: `Return requested · ${notifyCtx.requestNumber}`,
        body: `Order ${notifyCtx.orderNumber} — needs review`,
        link: `/returns/${notifyCtx.returnRequestId}`, entityType: 'return_request', entityId: notifyCtx.returnRequestId,
        dedupeKey: `return_requested:${notifyCtx.returnRequestId}`,
      }).catch(() => {});
    }
    return result;
  }

  /** Named cancel action — state-aware (§25). Idempotent once CANCELLED. */
  async cancelRequest({ customerId, requestId }) {
    const owned = await this.repository.ownedRequest(customerId, requestId);
    if (!owned) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);

    return this.transaction(async (tx) => {
      const request = await this.repository.lockRequest(tx, owned.id);
      if (!request) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);
      if (request.status === 'CANCELLED') return this.#assemble(request, tx);
      if (!this.eligibility.canCancel(request.status)) {
        throw new AppError('RETURN_REQUEST_NOT_CANCELLABLE',
          `A request in ${request.status} can no longer be cancelled.`, 409);
      }
      await this.repository.setRequestStatus(tx, request.id, 'CANCELLED', { cancelled_at: new Date() });
      await this.repository.recordEvent(tx, request.id, {
        eventType: 'RETURN_REQUEST_CANCELLED',
        fromStatus: request.status,
        toStatus: 'CANCELLED',
        actorType: 'CUSTOMER',
        actorId: customerId,
      });
      return this.#assemble({ ...request, status: 'CANCELLED', cancelled_at: new Date() }, tx);
    });
  }
}

function parse(value) {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export const returnRequestService = new ReturnRequestService();
