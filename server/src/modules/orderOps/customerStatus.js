// The customer-facing order status.
//
// The warehouse has many internal states — WAREHOUSE_CONFIRMED, MANIFESTING,
// label fetched, label printed, PICKUP_PENDING, booking reconciliation. None
// of those are the customer's business, and showing them would ask a shopper
// to understand CORCOTTON's logistics architecture.
//
// Six statuses reach the customer, and nothing else:
//   CONFIRMED -> PROCESSING -> READY_FOR_SHIPMENT -> IN_TRANSIT
//             -> OUT_FOR_DELIVERY -> DELIVERED
// plus the terminal exceptions the customer genuinely needs to see.
//
// The mapping is deliberately CONSERVATIVE at the shipping boundary: a parcel
// only becomes IN_TRANSIT on an authoritative carrier scan. "Ready for
// shipment" is as far as a CORCOTTON-side action can move it — telling a
// customer their order has shipped before a carrier has touched it is a lie
// that costs support tickets.

export const CUSTOMER_STATUSES = Object.freeze([
  'CONFIRMED', 'PROCESSING', 'READY_FOR_SHIPMENT', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED',
]);

export const CUSTOMER_STATUS_LABEL = Object.freeze({
  PENDING: 'Order received',
  CONFIRMED: 'Confirmed',
  PROCESSING: 'Processing',
  READY_FOR_SHIPMENT: 'Ready for shipment',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  DELIVERY_DELAYED: 'Delivery delayed',
  RETURNING: 'Returning to seller',
  CANCELLED: 'Cancelled',
});

const CARRIER_TO_CUSTOMER = Object.freeze({
  // Everything up to and including an accepted pickup request is still
  // "packed and waiting" from the customer's point of view.
  DRAFT: null,
  READY_TO_BOOK: null,
  BOOKING_PENDING: null,
  BOOKED: 'READY_FOR_SHIPMENT',
  PICKUP_PENDING: 'READY_FOR_SHIPMENT',
  // The carrier physically has it.
  PICKED_UP: 'IN_TRANSIT',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  DELIVERY_EXCEPTION: 'DELIVERY_DELAYED',
  RTO_IN_TRANSIT: 'RETURNING',
  RTO_RETURNED: 'RETURNING',
});

const RANK = Object.freeze({
  PENDING: 0, CONFIRMED: 1, PROCESSING: 2, READY_FOR_SHIPMENT: 3,
  IN_TRANSIT: 4, OUT_FOR_DELIVERY: 5, DELIVERED: 6,
});

/**
 * Reduce an order + its shipments to the one status a customer sees.
 *
 * On a split shipment the customer sees the LEAST advanced live parcel — an
 * order is not "delivered" while half of it is still in a van.
 *
 * @param {{status:string}} order
 * @param {Array<{status:string}>} shipments
 */
export function customerOrderStatus(order, shipments = []) {
  const status = order?.status || order?.order_status;
  if (status === 'CANCELLED') return 'CANCELLED';

  const live = shipments.filter((s) => !['CANCELLED', 'FAILED', 'LOST'].includes(s.status));
  const mapped = live.map((s) => CARRIER_TO_CUSTOMER[s.status]).filter(Boolean);

  const exception = mapped.find((m) => m === 'DELIVERY_DELAYED' || m === 'RETURNING');
  if (exception) return exception;

  if (mapped.length && mapped.length === live.length) {
    // Least advanced parcel wins.
    return mapped.reduce((lowest, m) => (RANK[m] < RANK[lowest] ? m : lowest), mapped[0]);
  }

  if (status === 'COMPLETED') return 'DELIVERED';
  if (status === 'PROCESSING') return 'PROCESSING';
  if (status === 'CONFIRMED') return 'CONFIRMED';
  return 'PENDING';
}

const DEAD_SHIPMENT = ['CANCELLED', 'FAILED', 'LOST'];
const iso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * When the order reached a step, from recorded facts only — never guessed.
 *
 * The first two steps are CORCOTTON's own timestamps on the order. The
 * shipping steps come from applied carrier events: a parcel reached a step at
 * its first event FOR that step, and the ORDER reached it when its last moving
 * parcel did (the same least-advanced rule the status uses). A step a carrier
 * skipped (delivered with no out-for-delivery scan) or with no record returns
 * null — the page shows no time rather than borrowing a later one.
 *
 * @param {string} key a CUSTOMER_STATUSES entry
 * @param {{confirmedAt?:string, processingStartedAt?:string, completedAt?:string}} order
 * @param {Array<{status:string, timeline?:Array<{status:string, at:string}>}>} shipments
 */
function stepReachedAt(key, order, shipments) {
  if (key === 'CONFIRMED') return iso(order?.confirmedAt);
  if (key === 'PROCESSING') return iso(order?.processingStartedAt);
  // Only parcels that have actually moved decide shipping times — a
  // replacement parcel still being drafted has not reached any of them.
  const moving = shipments.filter((s) => !DEAD_SHIPMENT.includes(s.status) && CARRIER_TO_CUSTOMER[s.status]);
  if (!moving.length) return key === 'DELIVERED' ? iso(order?.completedAt) : null;
  let latest = null;
  for (const shipment of moving) {
    const hit = (shipment.timeline || []).find((event) => CARRIER_TO_CUSTOMER[event.status] === key);
    if (!hit?.at) return null;
    if (!latest || new Date(hit.at) > new Date(latest)) latest = hit.at;
  }
  return iso(latest);
}

/**
 * The customer's progress timeline. Steps the order has passed are `done`,
 * the current one is `current`, the rest are `todo` — and an exception
 * replaces nothing, it annotates. Reached steps carry `at` when it is known.
 */
export function customerTimeline(order, shipments = []) {
  const current = customerOrderStatus(order, shipments);
  if (current === 'CANCELLED') {
    return { current, label: CUSTOMER_STATUS_LABEL.CANCELLED, cancelled: true, steps: [] };
  }
  const exception = current === 'DELIVERY_DELAYED' || current === 'RETURNING' ? current : null;
  // An exception still sits somewhere on the line: a delayed parcel has been
  // in transit, a returning one has too.
  const effective = exception ? 'IN_TRANSIT' : current;
  const at = RANK[effective] ?? 0;
  return {
    current,
    label: CUSTOMER_STATUS_LABEL[current],
    cancelled: false,
    exception,
    steps: CUSTOMER_STATUSES.map((key) => {
      const state = RANK[key] < at ? 'done' : RANK[key] === at ? 'current' : 'todo';
      return {
        key,
        label: CUSTOMER_STATUS_LABEL[key],
        state,
        at: state === 'todo' ? null : stepReachedAt(key, order, shipments),
      };
    }),
  };
}

const ACTIVITY_LABEL = Object.freeze({
  READY_FOR_SHIPMENT: 'Packed and ready for courier pickup',
  IN_TRANSIT: 'In transit',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
  DELIVERY_DELAYED: 'Delivery delayed',
  RETURNING: 'Returning to seller',
});

/**
 * Everything that has happened to the order, newest first, in the customer's
 * words. Built only from recorded timestamps and applied carrier events;
 * internal warehouse states never appear. A carrier remark is kept only when
 * it adds something to the label.
 *
 * @param {{placedAt?:string, confirmedAt?:string, processingStartedAt?:string, cancelledAt?:string}} order
 * @param {Array<{shipmentNumber?:string, status:string, timeline?:Array<{status:string, at:string, location?:string, note?:string}>}>} shipments
 */
export function customerActivity(order, shipments = []) {
  const entries = [];
  const push = (key, label, at, extra = {}) => { if (at) entries.push({ key, label, at: iso(at), ...extra }); };
  push('PLACED', 'Order placed', order?.placedAt);
  push('CONFIRMED', 'Order confirmed', order?.confirmedAt);
  push('PROCESSING', 'We started preparing your order', order?.processingStartedAt);
  const moving = shipments.filter((s) => (s.timeline || []).some((e) => CARRIER_TO_CUSTOMER[e.status]));
  moving.forEach((shipment, index) => {
    let previous = null;
    for (const event of shipment.timeline || []) {
      const mapped = CARRIER_TO_CUSTOMER[event.status];
      if (!mapped || !event.at) continue;
      const location = event.location || null;
      // A carrier often repeats a scan at the same place; one line says it.
      if (previous && previous.mapped === mapped && previous.location === location) continue;
      previous = { mapped, location };
      const label = ACTIVITY_LABEL[mapped];
      const note = event.note && event.note.trim().toLowerCase() !== label.toLowerCase()
        && event.note.trim().toLowerCase() !== CUSTOMER_STATUS_LABEL[mapped].toLowerCase() ? event.note.trim() : null;
      push(`${shipment.shipmentNumber || index}:${mapped}:${iso(event.at)}`, label, event.at, {
        location,
        note,
        packageNumber: moving.length > 1 ? index + 1 : null,
      });
    }
  });
  push('CANCELLED', 'Order cancelled', order?.cancelledAt);
  return entries.sort((a, b) => new Date(b.at) - new Date(a.at));
}
