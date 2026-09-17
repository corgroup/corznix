import { AppError } from '../../utils/errors.js';

// Provider-neutral shipment states, in nominal forward order. The rank powers
// stale / out-of-order event rejection; the graph allows the non-linear
// exception + RTO branches.
export const SHIPMENT_STATUS = Object.freeze([
  'DRAFT', 'READY_TO_BOOK', 'BOOKING_PENDING', 'BOOKED', 'PICKUP_PENDING', 'PICKED_UP',
  'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED',
  'DELIVERY_EXCEPTION', 'RTO_IN_TRANSIT', 'RTO_RETURNED', 'FAILED', 'CANCELLED', 'LOST',
]);

const RANK = Object.freeze({
  DRAFT: 0, READY_TO_BOOK: 1, BOOKING_PENDING: 2, BOOKED: 3, PICKUP_PENDING: 4, PICKED_UP: 5,
  IN_TRANSIT: 6, OUT_FOR_DELIVERY: 7, DELIVERED: 9,
  DELIVERY_EXCEPTION: 6, RTO_IN_TRANSIT: 7, RTO_RETURNED: 9, FAILED: 9, CANCELLED: 9, LOST: 9,
});

// Allowed transitions for events arriving after a shipment is booked.
//
// DELIVERED is reachable from every state where the parcel is DEMONSTRABLY in
// the carrier's network — picked up, in transit, out for delivery, or sitting
// on a delivery exception. It used to be reachable only from OUT_FOR_DELIVERY,
// and that stranded real parcels: the source material is explicit that not
// every intermediate stage is guaranteed to be emitted (Dev_API.docx "Package
// Lifecycle"), and a Dispatched push can simply be lost, since webhook
// delivery is at best at-least-once. When either happened the DELIVERED scan
// was refused as an invalid transition and dropped as IGNORED with no error
// code, so the shipment sat at IN_TRANSIT forever: fulfilment never closed,
// the order never reached COMPLETED, no delivery notification went out, COD
// was never reconciled as collected, and the customer's return window never
// opened.
//
// BOOKED and PICKUP_PENDING deliberately keep NO such edge. A shipment in
// either state has never been collected, so "delivered" is not a missing scan,
// it is a contradiction — and it is precisely what a recycled or mismatched
// AWB looks like. Honouring it would complete an order that never shipped and
// mark its COD collected. Two consecutive lost scans is the only honest way to
// land there, and that case still recovers: trackReconciliation replays the
// carrier's FULL scan history, which supplies the missing pickup/transit scans
// and walks the shipment forward properly.
//
// RTO_IN_TRANSIT keeps no edge either: a parcel travelling back to us is not
// "delivered to the customer", and Delhivery's own "DL + RTO" scan already
// normalises to RTO_RETURNED (statusMap.js).
const GRAPH = Object.freeze({
  BOOKED: ['PICKUP_PENDING', 'PICKED_UP', 'IN_TRANSIT', 'CANCELLED'],
  PICKUP_PENDING: ['PICKED_UP', 'IN_TRANSIT', 'CANCELLED'],
  PICKED_UP: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'],
  IN_TRANSIT: ['OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_EXCEPTION', 'RTO_IN_TRANSIT', 'LOST'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_EXCEPTION', 'RTO_IN_TRANSIT'],
  DELIVERY_EXCEPTION: ['IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_IN_TRANSIT', 'LOST'],
  RTO_IN_TRANSIT: ['RTO_RETURNED', 'LOST'],
  DELIVERED: [],
  RTO_RETURNED: [],
  CANCELLED: [],
  FAILED: [],
  LOST: [],
});

export function isTerminalShipmentStatus(status) {
  return ['DELIVERED', 'RTO_RETURNED', 'CANCELLED', 'FAILED', 'LOST'].includes(status);
}

/**
 * Decide what a normalised event does to a shipment.
 * @returns {'apply'|'stale'|'invalid'}
 */
export function classifyTransition(from, to) {
  if (from === to) return 'stale';
  if (!(from in GRAPH)) return 'invalid';
  if (GRAPH[from].includes(to)) return 'apply';
  // A lower/equal-rank target that isn't an allowed edge is a late/duplicate
  // scan — store it, change nothing. A forward target that isn't allowed is a
  // genuine protocol violation.
  return RANK[to] <= RANK[from] ? 'stale' : 'invalid';
}

export function assertShipmentBookable(shipment) {
  if (shipment.booking_status === 'BOOKED') return; // idempotent replay handled by the caller
  if (!['NOT_READY', 'READY', 'FAILED'].includes(shipment.booking_status) || !['DRAFT', 'READY_TO_BOOK'].includes(shipment.status)) {
    throw new AppError('SHIPMENT_NOT_READY_TO_BOOK', `Shipment is ${shipment.status} / ${shipment.booking_status} and cannot be booked.`, 409);
  }
  if (shipment.booking_status === 'NOT_READY') {
    throw new AppError('SHIPMENT_NOT_READY_TO_BOOK', 'Shipment package metadata is incomplete.', 409);
  }
}
