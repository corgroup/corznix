// What the CUSTOMER is allowed to do with an order, decided by the backend.
//
// The storefront must not infer these from a status string. `order_status`
// alone cannot answer them: it stays PROCESSING from picking right through
// out-for-delivery, so a status-based guess would offer "Cancel" while the
// courier is at the customer's door.
//
// Each flag therefore reads the real state it depends on:
//   canCancel   — order status AND whether any parcel has physically left
//   canReturn   — the existing per-line return eligibility engine
//   canExchange — the same engine, for the exchange/replacement actions
//
// Nothing here re-implements eligibility. Return/exchange come straight from
// returnEligibilityService, which already owns the delivery date, the policy
// window and the remaining quantity.

// Deliberately the SAME list cancellationService enforces
// (MOVED_SHIPMENT_STATUSES). If this flag were more permissive the storefront
// would offer a Cancel button the API then refuses — the exact disagreement
// these flags exist to prevent. Note it starts at PICKUP_PENDING, not
// PICKED_UP: once the day's pickup is raised the parcel is committed.
const WITH_CARRIER = ['PICKUP_PENDING', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'RTO_IN_TRANSIT', 'RTO_RETURNED', 'LOST'];
// LOST is deliberately NOT here: a lost parcel has physically moved, and
// cancellationService refuses it. Only a never-dispatched shipment is "dead".
const DEAD_SHIPMENT = ['CANCELLED', 'FAILED'];

const deny = (reasonCode, reason) => ({ allowed: false, reasonCode, reason });
const allow = () => ({ allowed: true, reasonCode: null, reason: null });

/**
 * @param {{status:string}} order          orders row projection
 * @param {Array<{status:string}>} shipments
 * @returns {{allowed:boolean, reasonCode:string|null, reason:string|null}}
 */
export function cancelEligibility(order, shipments = []) {
  const status = order?.status || order?.order_status;
  if (status === 'CANCELLED') return deny('ALREADY_CANCELLED', 'This order is already cancelled.');
  if (status === 'COMPLETED') return deny('ORDER_COMPLETED', 'This order has been delivered. Start a return instead.');
  if (!['PLACED', 'CONFIRMED', 'PROCESSING'].includes(status)) {
    return deny('NOT_CANCELLABLE', `An order in ${status} cannot be cancelled.`);
  }

  const live = shipments.filter((s) => !DEAD_SHIPMENT.includes(s.status));
  if (live.some((s) => s.status === 'DELIVERED')) {
    return deny('ALREADY_DELIVERED', 'This order has been delivered. Start a return instead.');
  }
  // The gap a status-only check misses: order_status is still PROCESSING here.
  const inHand = live.find((s) => WITH_CARRIER.includes(s.status));
  if (inHand) {
    const message = inHand.status === 'OUT_FOR_DELIVERY'
      ? 'Your order is out for delivery and can no longer be cancelled. You can refuse it at the door, or return it after delivery.'
      : inHand.status === 'PICKUP_PENDING'
        ? 'Your order is packed and booked for collection, so it can no longer be cancelled. You can return it after delivery.'
        : 'Your order is with the delivery partner and can no longer be cancelled. You can return it after delivery.';
    return deny('WITH_CARRIER', message);
  }
  // Mirrors the service's other guard: a fulfilment already (partly) shipped.
  if (shipments.some((s) => s.bookingStatus === 'BOOKED' && s.status === 'DELIVERED')) {
    return deny('ALREADY_DELIVERED', 'This order has been delivered. Start a return instead.');
  }
  return allow();
}

/**
 * Return / exchange, derived from the per-line engine rather than re-decided.
 *
 * @param {{status:string}} order
 * @param {{items?: Array<{eligible:boolean, allowedActions:string[], reasonCode:string|null}>}} eligibility
 *        the shape returned by returnEligibilityService.forOrder()
 */
export function returnExchangeEligibility(order, eligibility, shipments = []) {
  const status = order?.status || order?.order_status;
  const lines = eligibility?.items || [];
  // "Not delivered yet" is true of a parcel still being packed and of one the
  // courier is carrying up the stairs, and those deserve different sentences.
  const outForDelivery = shipments.some((s) => s.status === 'OUT_FOR_DELIVERY');

  if (status === 'CANCELLED') {
    const d = deny('ORDER_CANCELLED', 'This order was cancelled, so there is nothing to return or exchange.');
    return { canReturn: d, canExchange: d };
  }
  if (!lines.length) {
    const d = deny('NO_ELIGIBLE_ITEMS', 'No items on this order can be returned or exchanged.');
    return { canReturn: d, canExchange: d };
  }

  const has = (action) => lines.some((l) => l.eligible && (l.allowedActions || []).includes(action));
  // The most informative reason across the lines — every line blocked for the
  // same cause is the common case (nothing delivered yet, window expired).
  const blockedBy = (() => {
    const codes = [...new Set(lines.map((l) => l.reasonCode).filter(Boolean))];
    return codes.length === 1 ? codes[0] : null;
  })();
  const explain = {
    NOT_DELIVERED: outForDelivery
      ? 'Your order is out for delivery. After delivery, you can return, replace, or exchange the order.'
      : 'You can request this once your order has been delivered.',
    WINDOW_EXPIRED: 'The return window for this order has closed.',
    FULLY_CONSUMED: 'A request has already been raised for every item on this order.',
  };
  const refuse = (what) => deny(
    (blockedBy === 'NOT_DELIVERED' && outForDelivery) ? 'OUT_FOR_DELIVERY' : blockedBy || 'NOT_ELIGIBLE',
    (blockedBy && explain[blockedBy]) || `No items on this order are eligible for ${what}.`,
  );

  const EXCHANGE_ACTIONS = ['REPLACEMENT', 'SAME_STYLE_EXCHANGE', 'DIFFERENT_STYLE_EXCHANGE'];
  return {
    canReturn: has('RETURN') ? allow() : refuse('a return'),
    canExchange: EXCHANGE_ACTIONS.some(has) ? allow() : refuse('an exchange'),
  };
}

/** All three flags for one order. */
export function orderActionFlags({ order, shipments = [], returnEligibility = null }) {
  return {
    canCancel: cancelEligibility(order, shipments),
    ...returnExchangeEligibility(order, returnEligibility, shipments),
  };
}
