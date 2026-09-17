// WP-05 — the notification policy registry.
//
// The ONE place that maps a business event to its template, channel(s),
// deterministic identity, and variable set. Domain services never build an
// enqueue payload themselves — they call notificationService.emit(eventKey,
// context) and this decides the rest.
//
// A policy "lights up" per channel only when an ACTIVE communication template
// exists for (templateKey, channel) — see WP-07. Until then emit() records a
// per-channel TEMPLATE_NOT_AVAILABLE skip and the domain flow is unaffected.
// The template's existence IS the config: which of these actually send is
// decided by which templates the business authors + activates, not by a flag
// or a table.
//
// classification is TRANSACTIONAL for every lifecycle event — these are order
// execution facts, not marketing, so they correctly bypass the marketing
// consent gate (that split already exists in the communications engine).

/**
 * @typedef {Object} NotificationPolicy
 * @property {string} label           human name for the CMS catalogue
 * @property {string} description     one line: when it fires
 * @property {string} policyKey       stable policy id (part of the dedupe key)
 * @property {string} templateKey     communication_templates.template_key
 * @property {'TRANSACTIONAL'} classification
 * @property {Array<'EMAIL'|'WHATSAPP'>} channels
 * @property {Record<string,{required?:boolean,type?:'string'|'number'}>} variableSchema
 *           the canonical variable schema — the CMS pre-fills a new template's
 *           schema from this, and `variables()` must only ever return these keys
 * @property {(ctx: object) => string} businessEventId  deterministic per logical occurrence
 * @property {(ctx: object) => Record<string, string|number>} variables
 */

const STR = { required: true, type: 'string' };

/**
 * "12 Oct" from the chosen quote's transit estimate, or null when the quote
 * carried none — the courier promised nothing, so neither do we. Same shape as
 * logistics/applier.js#estimatedDeliveryText; the caller decides the fallback
 * wording, because an approved WhatsApp template cannot take a blank slot.
 */
function expectedDeliveryText(shippingSnapshot) {
  const snap = typeof shippingSnapshot === 'string'
    ? (() => { try { return JSON.parse(shippingSnapshot); } catch { return null; } })()
    : shippingSnapshot;
  const days = Number(snap?.estimatedDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(Date.now() + days * 86400000).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// Printed in delivery_failed {{3}} so the customer has someone to call. Kept
// configurable rather than hardcoded into a template we cannot edit.
const SUPPORT_NUMBER = process.env.SUPPORT_CONTACT_NUMBER || '+91 92780 92710';

/** @type {Record<string, NotificationPolicy>} */
export const NOTIFICATION_POLICIES = {
  ORDER_PLACED: {
    label: 'Order placed',
    description: 'Fires once the order is finalised (payment settled / COD accepted).',
    policyKey: 'order.placed',
    templateKey: 'order.placed',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { orderNumber: STR },
    businessEventId: (c) => `order_placed:${c.orderId}`,
    variables: (c) => ({ orderNumber: c.orderNumber }),
  },
  PAYMENT_SUCCESSFUL: {
    label: 'Payment successful',
    description: 'Fires when an online payment is verified and the order is finalised. COD orders never fire this — no money has moved yet.',
    policyKey: 'payment.successful',
    templateKey: 'payment.successful',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    // payment_successful contract: customerName, paymentReference, amount,
    // paymentDate.
    variableSchema: {
      orderNumber: STR, amount: STR,
      customerName: { type: 'string' }, paymentReference: { type: 'string' }, paymentDate: { type: 'string' },
    },
    // One notification per ORDER, not per webhook. Cashfree retries and the
    // reconciliation path both land here; keying on the order means a replay
    // is deduped rather than messaging the customer twice about one payment.
    businessEventId: (c) => `payment_successful:${c.orderId}`,
    variables: (c) => ({
      customerName: c.customerName || 'there',
      paymentReference: c.paymentReference || c.orderNumber,
      amount: c.amount,
      paymentDate: c.paymentDate,
      orderNumber: c.orderNumber,
    }),
  },
  ORDER_CONFIRMED: {
    label: 'Order confirmed',
    description: 'Fires when staff confirm the order in the CMS (invoice issued, fulfilments built).',
    policyKey: 'order.confirmed',
    templateKey: 'order.confirmed',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    // order_management contract (providers.js): customerName, purchaseWording,
    // orderNumber, itemsSummary, expectedDate — five slots. This policy used to
    // supply orderNumber alone, so the other four went to Meta as empty
    // positional parameters and the message was never delivered intact. Every
    // slot now has a fallback: a neutral word renders; a blank does not.
    variableSchema: {
      orderNumber: STR,
      customerName: { type: 'string' }, purchaseWording: { type: 'string' },
      itemsSummary: { type: 'string' }, expectedDate: { type: 'string' },
    },
    businessEventId: (c) => `order_confirmed:${c.orderId}`,
    variables: (c) => ({
      customerName: c.customerName || 'there',
      purchaseWording: c.purchaseWording || 'order',
      orderNumber: c.orderNumber,
      itemsSummary: c.itemsSummary || 'your items',
      expectedDate: expectedDeliveryText(c.shippingSnapshot) || 'shortly',
    }),
  },
  ORDER_PROCESSING: {
    label: 'Order being prepared',
    description: 'Fires when the warehouse starts picking and packing the order (order -> PROCESSING).',
    policyKey: 'order.processing',
    templateKey: 'order.processing',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    variableSchema: { orderNumber: STR, customerName: { type: 'string' } },
    businessEventId: (c) => `order_processing:${c.orderId}`,
    // order_processing / order_ready_for_shipment contract: customerName, orderNumber.
    variables: (c) => ({ customerName: c.customerName || 'there', orderNumber: c.orderNumber }),
  },
  ORDER_READY_FOR_SHIPMENT: {
    label: 'Ready for shipment',
    description: 'Fires when a parcel is packed, labelled and handed to the carrier pickup queue.',
    policyKey: 'order.ready_for_shipment',
    templateKey: 'order.ready_for_shipment',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    // Deliberately NO awb/tracking variable. The carrier has not touched the
    // parcel yet, so a tracking link here would 404 or show nothing and read
    // as "shipped" — which it is not. Tracking arrives with ORDER_SHIPPED,
    // which fires on a real carrier scan.
    variableSchema: { orderNumber: STR, customerName: { type: 'string' } },
    businessEventId: (c) => `order_ready_for_shipment:${c.shipmentId}`,
    // order_processing / order_ready_for_shipment contract: customerName, orderNumber.
    variables: (c) => ({ customerName: c.customerName || 'there', orderNumber: c.orderNumber }),
  },
  ORDER_SHIPPED: {
    label: 'Order shipped',
    description: 'Fires on the first carrier scan showing the parcel picked up / in transit.',
    policyKey: 'order.shipped',
    templateKey: 'order.shipped',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    variableSchema: { orderNumber: STR, awb: STR, carrier: STR, customerName: { type: 'string' }, estimatedDelivery: { type: 'string' } },
    businessEventId: (c) => `order_shipped:${c.shipmentId}`,
    variables: (c) => ({
      // Names match META_TEMPLATE_CONTRACT.shipment_confirmation_1 exactly —
      // the adapter positions by name, not by insertion order.
      customerName: c.customerName || 'there',
      awb: c.awb || '',
      estimatedDelivery: c.estimatedDelivery || 'shortly',
      orderNumber: c.orderNumber, carrier: 'Delhivery',
    }),
  },
  ORDER_OUT_FOR_DELIVERY: {
    label: 'Out for delivery',
    description: 'Fires on the carrier scan showing the parcel is out for delivery today.',
    policyKey: 'order.out_for_delivery',
    templateKey: 'order.out_for_delivery',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    variableSchema: { orderNumber: STR, awb: STR, customerName: { type: 'string' }, deliveryWindow: { type: 'string' } },
    businessEventId: (c) => `order_out_for_delivery:${c.shipmentId}`,
    variables: (c) => ({
      // track_order contract: customerName, orderNumber, deliveryWindow.
      customerName: c.customerName || 'there',
      orderNumber: c.orderNumber,
      deliveryWindow: c.deliveryWindow || 'today',
      awb: c.awb || '',
    }),
  },
  ORDER_DELIVERY_ATTEMPT_FAILED: {
    label: 'Delivery attempt failed',
    description: 'Fires on a carrier DELIVERY_EXCEPTION scan (NDR) — a delivery attempt did not succeed.',
    policyKey: 'order.delivery_attempt_failed',
    templateKey: 'order.delivery_attempt_failed',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    variableSchema: { orderNumber: STR, awb: STR, reason: { type: 'string' }, customerName: { type: 'string' }, attemptDate: { type: 'string' }, supportNumber: { type: 'string' } },
    // Deterministic per (shipment, attempt) so each distinct failed attempt
    // can notify once — keyed on the scan's occurrence time.
    businessEventId: (c) => `order_delivery_attempt_failed:${c.shipmentId}:${c.occurredAt || ''}`,
    variables: (c) => ({
      // delivery_failed contract: customerName, attemptDate, supportNumber.
      customerName: c.customerName || 'there',
      attemptDate: c.attemptDate || c.occurredAt || 'today',
      supportNumber: c.supportNumber || SUPPORT_NUMBER,
      orderNumber: c.orderNumber, awb: c.awb || '',
      reason: c.reason || 'the courier could not complete delivery',
    }),
  },
  ORDER_DELIVERED: {
    label: 'Order delivered',
    description: 'Fires on the carrier DELIVERED scan (also unblocks returns + reviews).',
    policyKey: 'order.delivered',
    templateKey: 'order.delivered',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    variableSchema: { orderNumber: STR, customerName: STR },
    businessEventId: (c) => `order_delivered:${c.shipmentId}`,
    // delivery_confirmation contract: customerName, orderNumber.
    variables: (c) => ({ customerName: c.customerName || 'there', orderNumber: c.orderNumber }),
  },
  ORDER_COMPLETED: {
    label: 'Order completed',
    description: 'Fires when every parcel in the order has been delivered.',
    policyKey: 'order.completed',
    templateKey: 'order.completed',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { orderNumber: STR },
    businessEventId: (c) => `order_completed:${c.orderId}`,
    variables: (c) => ({ orderNumber: c.orderNumber }),
  },
  ORDER_CANCELLED: {
    label: 'Order cancelled',
    description: 'Fires when staff cancel a PLACED / CONFIRMED order.',
    policyKey: 'order.cancelled',
    templateKey: 'order.cancelled',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    // order_canceled contract: customerName, orderNumber. `reason` is EMAIL-only
    // copy; the approved WhatsApp template has no slot for it.
    variableSchema: { orderNumber: STR, reason: { type: 'string' }, customerName: { type: 'string' } },
    businessEventId: (c) => `order_cancelled:${c.orderId}`,
    variables: (c) => ({
      customerName: c.customerName || 'there',
      orderNumber: c.orderNumber,
      reason: c.reason || 'as requested',
    }),
  },

  // ---- WP-05b: returns + refunds ------------------------------------------
  RETURN_REQUESTED: {
    label: 'Return requested',
    description: 'Fires when a customer submits a return / replacement / exchange request.',
    policyKey: 'return.requested',
    templateKey: 'return.requested',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { requestNumber: STR, orderNumber: STR },
    businessEventId: (c) => `return_requested:${c.returnRequestId}`,
    variables: (c) => ({ requestNumber: c.requestNumber, orderNumber: c.orderNumber }),
  },
  RETURN_APPROVED: {
    label: 'Return approved',
    description: 'Fires when staff approve a return request.',
    policyKey: 'return.approved',
    templateKey: 'return.approved',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { requestNumber: STR, orderNumber: STR },
    businessEventId: (c) => `return_approved:${c.returnRequestId}`,
    variables: (c) => ({ requestNumber: c.requestNumber, orderNumber: c.orderNumber }),
  },
  RETURN_REJECTED: {
    label: 'Return declined',
    description: 'Fires when staff reject a return request (the Reject dialog promises this).',
    policyKey: 'return.rejected',
    templateKey: 'return.rejected',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { requestNumber: STR, orderNumber: STR, reason: { type: 'string' } },
    businessEventId: (c) => `return_rejected:${c.returnRequestId}`,
    variables: (c) => ({ requestNumber: c.requestNumber, orderNumber: c.orderNumber, reason: c.reason || 'after review' }),
  },
  RETURN_RECEIVED: {
    label: 'Return received',
    description: 'Fires when the returned item is checked in at the warehouse.',
    policyKey: 'return.received',
    templateKey: 'return.received',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    // return_confirmation contract: orderNumber, resolutionType, amount.
    variableSchema: {
      requestNumber: STR, orderNumber: STR,
      resolutionType: { type: 'string' }, amount: { type: 'string' },
    },
    businessEventId: (c) => `return_received:${c.returnRequestId}`,
    variables: (c) => ({
      orderNumber: c.orderNumber,
      // The resolution is not always decided at check-in; say "refund" only
      // when the caller actually knows, never as a default the customer
      // could hold us to.
      resolutionType: c.resolutionType || 'resolution',
      amount: c.amount || '',
      requestNumber: c.requestNumber,
    }),
  },
  REFUND_INITIATED: {
    label: 'Refund initiated',
    description: 'Fires when a refund is created for a return (before the provider confirms it).',
    policyKey: 'refund.initiated',
    templateKey: 'refund.initiated',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { requestNumber: STR, orderNumber: STR, amount: STR, method: STR },
    businessEventId: (c) => `refund_initiated:${c.refundAttemptId}`,
    variables: (c) => ({ requestNumber: c.requestNumber, orderNumber: c.orderNumber, amount: c.amount, method: c.method }),
  },
  REFUND_COMPLETED: {
    label: 'Refund completed',
    description: 'Fires when a refund is confirmed successful (provider or store credit).',
    policyKey: 'refund.completed',
    templateKey: 'refund.completed',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL', 'WHATSAPP'],
    // refund_confirmation contract: header {{1}} refundAmount; body
    // customerName, refundAmount, orderNumber. `amount`/`method` stay for the
    // existing email copy.
    variableSchema: {
      requestNumber: STR, orderNumber: STR, amount: STR, method: STR,
      customerName: { type: 'string' }, refundAmount: { type: 'string' },
    },
    businessEventId: (c) => `refund_completed:${c.refundAttemptId}`,
    variables: (c) => ({
      customerName: c.customerName || 'there',
      refundAmount: c.amount,
      orderNumber: c.orderNumber,
      requestNumber: c.requestNumber, amount: c.amount, method: c.method,
    }),
  },
  REFUND_FAILED: {
    label: 'Refund failed',
    description: 'Fires when a manual COD payout could not be completed. The customer is told so they can correct their details rather than waiting silently.',
    policyKey: 'refund.failed',
    templateKey: 'refund.failed',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { requestNumber: STR, orderNumber: STR, amount: STR, method: STR },
    // Keyed on the ATTEMPT PLUS the failure count would be ideal, but a failed
    // payout can be retried and fail again — the operator marking it failed a
    // second time is a new event the customer should hear about, so the key
    // carries the moment it happened.
    businessEventId: (c) => `refund_failed:${c.refundAttemptId}:${c.failedAt}`,
    variables: (c) => ({ requestNumber: c.requestNumber, orderNumber: c.orderNumber, amount: c.amount, method: c.method }),
  },

  // ---- account + money events that had no message at all -------------------
  CUSTOMER_WELCOME: {
    label: 'Welcome',
    description: 'Fires once, when a customer completes their profile and the account becomes usable.',
    policyKey: 'account.welcome',
    templateKey: 'account.welcome',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { customerName: { type: 'string' } },
    businessEventId: (c) => `account_welcome:${c.customerId}`,
    variables: (c) => ({ customerName: c.customerName || 'there' }),
  },
  PAYMENT_FAILED: {
    label: 'Payment failed',
    description: 'Fires when an online payment attempt is declined and no order was created — the cart is still there.',
    policyKey: 'payment.failed',
    templateKey: 'payment.failed',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    // `reason` is the gateway's customer-safe description, never a code.
    variableSchema: { amount: STR, reason: { type: 'string' } },
    // Keyed on the ATTEMPT: a retry that fails again is a new attempt and a new
    // message, while a duplicate webhook for the same failure is not.
    businessEventId: (c) => `payment_failed:${c.paymentAttemptId}`,
    variables: (c) => ({ amount: c.amount, reason: c.reason || 'your bank declined the payment' }),
  },
  STORE_CREDIT_GRANTED: {
    label: 'Store credit added',
    description: 'Fires when store credit is added to a customer — a cancellation, a refund taken as credit, or an exchange remainder.',
    policyKey: 'store_credit.granted',
    templateKey: 'store_credit.granted',
    classification: 'TRANSACTIONAL',
    channels: ['EMAIL'],
    variableSchema: { amount: STR, balance: STR, reason: { type: 'string' } },
    businessEventId: (c) => `store_credit_granted:${c.entryId}`,
    variables: (c) => ({ amount: c.amount, balance: c.balance, reason: c.reason || 'a recent order' }),
  },
};

// Still reserved — a policy + template + call site have NOT been added, with
// the reason each was left out of WP-05b:
//   PAYMENT_FAILED         — no order exists yet at webhook-failure time, the
//                            customer sees the failure live in checkout, and a
//                            late "payment failed" email after a successful
//                            retry is confusing. Needs a considered design.
//   RETURN_PICKED_UP       — reverse-shipment tracking is mock/manual today
//                            (08c) — nothing reliable to fire on.
//   RETURN_QC_PASSED/FAILED— internal QC; the customer-facing signal is the
//                            refund (REFUND_INITIATED/COMPLETED), not the QC.
//   REPLACEMENT_SHIPPED    — a replacement's shipment already flows through the
//   EXCHANGE_ORDER_CREATED   ORDER_SHIPPED / ORDER_PLACED paths once carrier
//                            booking is real (WP-02) — would double-notify.
export const RESERVED_NOTIFICATION_EVENTS = Object.freeze([
  'PAYMENT_FAILED', 'RETURN_PICKED_UP', 'RETURN_QC_PASSED', 'RETURN_QC_FAILED',
  'REPLACEMENT_SHIPPED', 'EXCHANGE_ORDER_CREATED',
]);
