// The ONE place that decides what a warehouse operator does next on an order.
//
// The CMS must not carry its own copy of this graph. It renders whatever
// `nextOperatorAction` says, so the domain rules live here and drift is
// impossible by construction — a lesson from the fulfilment page, which had
// grown a second, silently divergent transition table.
//
// This is deliberately a SEQUENCE, not the set of everything the backend would
// technically permit. Exception actions (hold, cancel, reconcile, NDR, retry a
// failed label) stay available as secondary actions computed elsewhere; they
// are not the operator's "next step" and must not compete with it.

/** Carrier states in which the parcel has left the warehouse's hands. */
const IN_CARRIER_HANDS = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_IN_TRANSIT', 'RTO_RETURNED'];
const DEAD = ['CANCELLED', 'FAILED', 'LOST'];

export const OPERATOR_ACTIONS = Object.freeze({
  CONFIRM_ORDER: {
    label: 'Confirm order',
    stage: 'Placed',
    hint: 'Accept this order and allocate it to a warehouse.',
    confirm: false,
  },
  START_PREPARING: {
    label: 'Start preparing',
    stage: 'Confirmed',
    hint: 'This order has been assigned to your warehouse. Pick, verify and pack it.',
    confirm: false,
  },
  MANIFEST_SHIPMENT: {
    label: 'Manifest shipment',
    stage: 'Preparing',
    hint: 'Enter the packed weight and box size to create the shipment and get an AWB.',
    // Opens the manifest form, which IS the confirmation step.
    confirm: false,
    form: 'MANIFEST',
  },
  READY_FOR_PICKUP: {
    label: 'Ready for pickup',
    stage: 'Ready to ship',
    hint: 'Print the label, attach it to the parcel, then ask the carrier to collect it.',
    confirm: true,
    form: 'PICKUP',
  },
});

/**
 * @param {object} input
 * @param {object} input.order            raw orders row projection ({ status })
 * @param {Array}  input.shipments        the DTOs already assembled by getOrder
 * @param {boolean} input.isOwnerDelivery store-operated last mile — never carrier-booked
 * @returns {{action:string|null,label:string|null,stage:string,hint:string,shipmentId:string|null,waitingOn:string|null}}
 */
export function nextOperatorAction({ order, shipments = [], isOwnerDelivery = false }) {
  const none = (stage, hint, waitingOn = null) => ({
    action: null, label: null, stage, hint, shipmentId: null, waitingOn,
  });
  const step = (action, shipmentId = null, overrides = {}) => ({
    action,
    label: OPERATOR_ACTIONS[action].label,
    stage: OPERATOR_ACTIONS[action].stage,
    hint: OPERATOR_ACTIONS[action].hint,
    form: OPERATOR_ACTIONS[action].form || null,
    confirm: OPERATOR_ACTIONS[action].confirm,
    shipmentId,
    waitingOn: null,
    ...overrides,
  });

  const status = order?.status || order?.order_status;

  if (status === 'CANCELLED') return none('Cancelled', 'This order was cancelled. Inventory was restored and any shipment voided.');
  if (status === 'COMPLETED') return none('Delivered', 'Every parcel in this order has been delivered.');
  if (status === 'PLACED') return step('CONFIRM_ORDER');
  if (status === 'CONFIRMED') return step('START_PREPARING');

  if (isOwnerDelivery) {
    return none('Owner delivery', 'The store delivers this order itself — do not book a carrier.');
  }

  // PROCESSING: work the shipments in order. One parcel at a time keeps the
  // primary action unambiguous even on a split fulfilment.
  const live = shipments.filter((s) => !DEAD.includes(s.status));
  if (!live.length) {
    return none('Preparing', 'No shipment to work yet — a draft shipment is created per fulfilment.', 'SHIPMENT');
  }

  const notBooked = live.find((s) => s.bookingStatus !== 'BOOKED');
  if (notBooked) {
    if (notBooked.bookingStatus === 'UNKNOWN') {
      return none('Preparing', 'A booking attempt for this parcel had an unknown outcome. Reconcile it with the carrier before trying again.', 'RECONCILE');
    }
    return step('MANIFEST_SHIPMENT', notBooked.id);
  }

  // Booked. A label still being fetched is a wait, not an operator action —
  // and a FAILED label is a retry, which is an exception, not the next step.
  const labelPending = live.find((s) => s.labelStatus !== 'AVAILABLE' && !IN_CARRIER_HANDS.includes(s.status));
  if (labelPending) {
    return none(
      'Ready to ship',
      labelPending.labelStatus === 'FAILED'
        ? 'The carrier did not return a shipping label. Retry it from the shipment before requesting pickup.'
        : 'Waiting for the carrier to return the shipping label.',
      'LABEL',
    );
  }

  const awaitingPickup = live.find((s) => !s.pickupRequestedAt && !IN_CARRIER_HANDS.includes(s.status));
  if (awaitingPickup) return step('READY_FOR_PICKUP', awaitingPickup.id);

  if (live.some((s) => s.pickupRequestedAt && !IN_CARRIER_HANDS.includes(s.status))) {
    return none('Ready for pickup', 'Awaiting carrier collection. The next update comes from the carrier.', 'CARRIER');
  }

  const furthest = live.find((s) => IN_CARRIER_HANDS.includes(s.status));
  if (furthest) {
    const stage = furthest.status === 'OUT_FOR_DELIVERY' ? 'Out for delivery'
      : furthest.status === 'DELIVERED' ? 'Delivered'
        : String(furthest.status).startsWith('RTO') ? 'Returning to origin' : 'In transit';
    return none(stage, 'The carrier has the parcel. Tracking updates arrive automatically.', 'CARRIER');
  }

  return none('Preparing', 'Nothing to do on this order right now.');
}

// The compact progress rail. Orientation only — never interactive.
export const OPERATOR_STAGES = Object.freeze([
  'Confirmed', 'Preparing', 'Ready to ship', 'Ready for pickup', 'In transit', 'Delivered',
]);

/** Which rail stage an order currently sits at, and how far it has come. */
export function operatorProgress({ order, shipments = [], next }) {
  const status = order?.status || order?.order_status;
  if (status === 'PLACED') return { stages: OPERATOR_STAGES, currentIndex: -1, cancelled: false };
  if (status === 'CANCELLED') return { stages: OPERATOR_STAGES, currentIndex: -1, cancelled: true };

  const live = shipments.filter((s) => !DEAD.includes(s.status));
  const reached = (i) => i;
  if (live.some((s) => s.status === 'DELIVERED')) return { stages: OPERATOR_STAGES, currentIndex: reached(5), cancelled: false };
  if (live.some((s) => IN_CARRIER_HANDS.includes(s.status))) return { stages: OPERATOR_STAGES, currentIndex: reached(4), cancelled: false };
  if (live.some((s) => s.pickupRequestedAt)) return { stages: OPERATOR_STAGES, currentIndex: reached(3), cancelled: false };
  if (live.length && live.every((s) => s.bookingStatus === 'BOOKED')) return { stages: OPERATOR_STAGES, currentIndex: reached(2), cancelled: false };
  if (status === 'PROCESSING') return { stages: OPERATOR_STAGES, currentIndex: reached(1), cancelled: false };
  void next;
  return { stages: OPERATOR_STAGES, currentIndex: reached(0), cancelled: false };
}
