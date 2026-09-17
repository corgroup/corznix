import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { inventoryService } from '../inventory/service.js';
import { fulfillmentService } from '../fulfillment/service.js';
import { fulfillmentRepository } from '../fulfillment/repository.js';
import { invoiceService } from '../documents/service.js';
import { notificationService } from '../notifications/service.js';
import { orderContactFrom } from '../notifications/recipients.js';
import { cancellationRefundService } from './cancellationRefundService.js';
import { shipmentProviderCancellationService } from './shipmentCancellationService.js';
import { staffNotificationService } from '../staffNotifications/service.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { isTerminalShipmentStatus } from '../shipping/shipmentLifecycle.js';
import { orderOpsRepository } from './repository.js';

const audit = new StaffAuditRepository();

// WP-09 — order cancellation cascade (GAP-ORD-04 / GAP-INV-01 / GAP-SHIP-07).
//
// The "who may cancel, and until which state" policy is a business decision
// (audit external-input register). Until it lands, the conservative default:
// staff with orders.manage may cancel an order while NOTHING has shipped.
const CANCELLABLE_ORDER_STATUSES = ['PLACED', 'CONFIRMED', 'PROCESSING'];
const SHIPPED_FULFILMENT_STATUSES = ['FULFILLED', 'PARTIALLY_FULFILLED'];
// A shipment past BOOKED means goods have physically moved — never cancel then.
const MOVED_SHIPMENT_STATUSES = ['PICKUP_PENDING', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_IN_TRANSIT', 'RTO_RETURNED', 'LOST'];

const iso = (v) => (v ? new Date(v).toISOString() : null);

class OrderCancellationService {
  /**
   * Atomically cancel an order: restore inventory (+ movement), cancel its
   * fulfilments via the state machine, locally cancel its shipments, issue a
   * credit note if an invoice exists, then (post-commit) notify the customer.
   * The refund to the original payment method runs after the commit, in
   * cancellationRefundService — isolated, so a provider outage leaves a
   * cancelled order with an unsettled refund and a CRITICAL staff task, never
   * an order that failed to cancel. `refundExecution: false` records what is
   * owed without calling the provider (the refund gate's own harness uses it).
   */
  async cancel(orderIdOrNumber, {
    reason = null, actor = {}, expectedUpdatedAt = null, refundExecution = true, refundTo = 'ORIGINAL_PAYMENT',
  } = {}) {
    const result = await withTransaction(async (c) => {
      const order = await orderOpsRepository.lockOrder(c, orderIdOrNumber);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
      if (order.order_status === 'CANCELLED') {
        return { alreadyCancelled: true, order };
      }
      if (!CANCELLABLE_ORDER_STATUSES.includes(order.order_status)) {
        throw new AppError('ORDER_NOT_CANCELLABLE', `An order in ${order.order_status} cannot be cancelled.`, 409);
      }
      if (expectedUpdatedAt && iso(order.updated_at) !== iso(expectedUpdatedAt)) {
        throw new AppError('ORDER_MODIFIED', 'This order changed since it was loaded. Reload and try again.', 409);
      }

      const fulfilments = await fulfillmentRepository.fulfillmentsForOrder(c, order.id);
      if (fulfilments.some((f) => SHIPPED_FULFILMENT_STATUSES.includes(f.status))) {
        throw new AppError('ORDER_ALREADY_SHIPPED', 'This order has a fulfilment that is already (partly) shipped.', 409);
      }
      const shipments = await orderOpsRepository.shipmentsForOrder(order.id);
      if (shipments.some((s) => MOVED_SHIPMENT_STATUSES.includes(s.status))) {
        throw new AppError('ORDER_ALREADY_SHIPPED', 'This order has a shipment that is already in motion.', 409);
      }

      // 1. order status + lifecycle stamp
      await orderOpsRepository.setOrderStatus(c, order.id, 'CANCELLED', {
        cancelled_at: new Date(),
        cancellation_reason: reason,
        cancelled_by_staff_id: actor.id ?? null,
        fulfillment_status: 'CANCELLED',
      });

      // 2. inventory — release the reservation or restore consumed on-hand
      const inventoryOutcome = await inventoryService.releaseForCancelledOrder({ order, connection: c });

      // 3. fulfilments -> CANCELLED (state machine; FULFILLED is already ruled out)
      const cancelledFulfilments = [];
      for (const f of fulfilments) {
        if (['CANCELLED', 'FULFILLED'].includes(f.status)) continue;
        await fulfillmentService.transitionStatus(f.id, 'CANCELLED', {
          detail: { via: 'ORDER_CANCELLATION', actorStaffId: actor.id ?? null, reason },
          connection: c,
        });
        cancelledFulfilments.push(f.fulfillment_number || f.id);
      }

      // 4. shipments -> local CANCELLED. A BOOKED one also has to be voided
      //    with the carrier, and that call happens AFTER this transaction (see
      //    below): an AWB marked cancelled only in our database leaves a live
      //    parcel the courier will still collect.
      const cancelledShipments = [];
      const bookedAwbs = [];
      for (const s of shipments) {
        if (isTerminalShipmentStatus(s.status)) continue;
        if (s.booking_status === 'BOOKED' && s.tracking_number) {
          bookedAwbs.push({ shipmentId: s.id, awb: s.tracking_number, shipmentNumber: s.shipment_number || s.id });
        }
        await orderOpsRepository.updateShipment(c, s.id, {
          status: 'CANCELLED', booking_status: 'CANCELLED', cancelled_at: new Date(),
        });
        cancelledShipments.push(s.shipment_number || s.id);
      }

      // 5. credit note — only if an invoice was issued (CONFIRMED/PROCESSING)
      let creditNote = null;
      if (['CONFIRMED', 'PROCESSING'].includes(order.order_status)) {
        creditNote = await invoiceService.issueCreditNoteForOrder(order.id, { reason, connection: c })
          .catch((err) => { if (err?.code === 'INVOICE_NOT_FOUND') return null; throw err; });
      }

      const onlinePaidMinor = Number(order.online_paid_minor || 0);
      // A partial-COD advance the customer was told is non-refundable is kept.
      // The figure is the one snapshot on the order at checkout, never the
      // current policy — a band edited later must not change what an existing
      // customer is owed. Clamped so it can never exceed what was actually
      // paid, and so a refund can never come out negative.
      const nonRefundableMinor = Math.min(Number(order.non_refundable_advance_minor || 0), onlinePaidMinor);
      const refundableMinor = Math.max(0, onlinePaidMinor - nonRefundableMinor);
      return {
        order,
        priorStatus: order.order_status,
        inventoryOutcome,
        cancelledFulfilments,
        cancelledShipments,
        bookedAwbs,
        creditNoteNumber: creditNote?.credit_note_number || null,
        refund: refundableMinor > 0
          ? {
            required: true,
            amountMinor: refundableMinor,
            nonRefundableWithheldMinor: nonRefundableMinor,
            note: nonRefundableMinor > 0
              ? 'Prepaid amount is owed to the customer, less the non-refundable COD advance disclosed at checkout. Process via the payments/refund domain.'
              : 'Prepaid amount is owed to the customer. Process via the payments/refund domain.',
          }
          : { required: false, amountMinor: 0, nonRefundableWithheldMinor: nonRefundableMinor },
      };
    });

    if (result.alreadyCancelled) {
      return { orderId: result.order.id, orderNumber: result.order.order_number, status: 'CANCELLED', alreadyCancelled: true };
    }

    await audit.log({
      staffUserId: actor.id ?? null, actorEmail: actor.email ?? null, ipAddress: actor.ip ?? null, requestId: actor.requestId ?? null,
      action: 'ORDER_CANCELLED', resourceType: 'order', resourceId: result.order.id,
      metadata: {
        reason, priorStatus: result.priorStatus,
        inventory: result.inventoryOutcome.mode,
        fulfilmentsCancelled: result.cancelledFulfilments.length,
        shipmentsCancelled: result.cancelledShipments.length,
        creditNote: result.creditNoteNumber,
        refundRequiredMinor: result.refund.amountMinor,
      },
    });

    // The order's own checkout contact has to travel with the event, exactly
    // like every other order notification: without it WhatsApp finds no
    // verified phone for the customer and the message is dropped with no row
    // and no trace. Verified on production — a cancellation sent the email and
    // silently sent no WhatsApp, with the order_canceled template ACTIVE.
    await notificationService.emit('ORDER_CANCELLED', {
      customerId: result.order.customer_id,
      orderId: result.order.id,
      orderNumber: result.order.order_number,
      reason,
      shippingAddressSnapshot: result.order.shipping_address_snapshot || null,
      customerName: orderContactFrom(result.order.shipping_address_snapshot || null)?.name || null,
    }).catch(() => {});

    await staffNotificationService.record({
      category: 'ORDER', eventKey: 'ORDER_CANCELLED', severity: 'WARNING',
      title: `Order ${result.order.order_number} cancelled`,
      body: result.refund.amountMinor
        ? `Refund of ₹${(Number(result.refund.amountMinor) / 100).toLocaleString('en-IN')} required`
        : (reason || 'Cancelled by staff'),
      link: `/orders/${result.order.id}`, entityType: 'order', entityId: result.order.id,
      dedupeKey: `order_cancelled:${result.order.id}`,
    }).catch(() => {});

    // Void the AWB with the carrier. Post-commit and isolated, like the
    // refund: the order IS cancelled, and a carrier that will not answer must
    // not undo that — but a parcel the courier still collects is worse than a
    // loud failure, so anything other than a clean cancellation raises a
    // CRITICAL staff task naming the AWB.
    const carrierCancellations = [];
    for (const booked of result.bookedAwbs || []) {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await shipmentProviderCancellationService
        // The row was flipped to CANCELLED inside the transaction above, so the
        // carrier call must not treat that as "already done" — that short
        // circuit is what left a live AWB on a cancelled order.
        .cancel({ shipmentId: booked.shipmentId, reason: reason || 'Order cancelled', actor, awb: booked.awb, allowLocallyCancelled: true })
        .then((r) => ({ ...booked, status: r.carrierCalled ? 'CANCELLED' : 'NOT_CANCELLED', error: r.carrierCalled ? undefined : 'CARRIER_NOT_CALLED' }))
        .catch((err) => ({ ...booked, status: 'NOT_CANCELLED', error: err?.code || err?.message || 'PROVIDER_CANCEL_FAILED' }));
      carrierCancellations.push(outcome);
      if (outcome.status !== 'CANCELLED') {
        // eslint-disable-next-line no-await-in-loop
        await staffNotificationService.record({
          category: 'LOGISTICS', eventKey: 'AWB_STILL_LIVE_AFTER_CANCELLATION', severity: 'CRITICAL',
          title: `AWB ${booked.awb} is still live after cancelling ${result.order.order_number}`,
          body: `The carrier did not cancel it (${outcome.error}). Cancel it in the carrier panel, or the parcel will still be collected.`,
          link: `/orders/${result.order.id}`, entityType: 'shipment', entityId: booked.shipmentId,
          dedupeKey: `awb_live_after_cancel:${booked.shipmentId}`,
        }).catch(() => {});
      }
    }

    // Store credit the customer spent on this order comes back regardless of
    // where any money refund goes — it was never a payment at a gateway.
    const storeCreditReturned = await cancellationRefundService
      .reverseStoreCreditSpent(result.order)
      .catch((err) => ({ status: 'ERROR', amountMinor: 0, error: err?.code || err?.message || 'CREDIT_REVERSAL_FAILED' }));

    // The refund itself, to the method the customer paid with. Post-commit and
    // isolated: the cancellation is already true, and a provider that is down
    // must not undo it — a refund left unsettled raises a CRITICAL staff task
    // of its own and can be retried from the order.
    //
    // Where the money goes is decided by WHO cancelled, and nowhere else:
    // staff cancelling in the CMS pay back the method the customer used;
    // a customer cancelling their own order takes store credit, which is
    // instant. Callers do not get to choose — `refundTo` is set from the
    // authenticated actor at the route.
    let refundOutcome = null;
    if (result.refund.required && refundExecution !== false) {
      const run = refundTo === 'STORE_CREDIT'
        ? cancellationRefundService.creditCancelledOrderToStoreCredit(result.order.id)
        : cancellationRefundService.refundCancelledOrder(result.order.id);
      refundOutcome = await run
        .catch((err) => ({ status: 'ERROR', refund: null, error: err?.code || err?.message || 'REFUND_FAILED' }));
    }

    return {
      refund: { ...result.refund, outcome: refundOutcome },
      orderId: result.order.id,
      orderNumber: result.order.order_number,
      status: 'CANCELLED',
      priorStatus: result.priorStatus,
      inventory: result.inventoryOutcome,
      fulfilmentsCancelled: result.cancelledFulfilments,
      shipmentsCancelled: result.cancelledShipments,
      carrierCancellations,
      storeCreditReturned,
      creditNoteNumber: result.creditNoteNumber,
    };
  }
}

export const orderCancellationService = new OrderCancellationService();
