// Workflow buckets for the Orders workbench.
//
// An operator does not think in `order_status`; they think "what is waiting on
// me, and what is waiting on someone else". These buckets are that question,
// expressed as SQL over the order + its shipments.
//
// Each bucket is a WHERE fragment so the count and the page come from the same
// predicate — a tab whose badge disagrees with its contents is worse than no
// badge at all.

const LIVE_SHIPMENT = "s.status NOT IN ('CANCELLED','FAILED','LOST')";

// A bucket must agree with the stage the row then displays, and the stage is
// derived from the ORDER first. Without this, a PLACED or CANCELLED order that
// still carries an old shipment row lands in a fulfilment bucket and shows
// "Confirm order" underneath a "Ready for pickup" tab — found in the browser,
// not by reading the SQL.
const IN_FULFILMENT = "o.order_status = 'PROCESSING'";
const WITH_CARRIER = "o.order_status IN ('PROCESSING','COMPLETED')";
const shipmentExists = (extra) => `EXISTS (
  SELECT 1 FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id
   WHERE f.order_id = o.id AND ${LIVE_SHIPMENT} AND ${extra})`;
const noShipmentBeyond = (extra) => `NOT ${shipmentExists(extra)}`;

export const WORKFLOW_BUCKETS = Object.freeze({
  ALL: { label: 'All', where: null },

  // Waiting on this warehouse, right now.
  NEEDS_ACTION: {
    label: 'Needs action',
    where: `(
      o.order_status = 'PLACED'
      OR o.order_status = 'CONFIRMED'
      OR (o.order_status = 'PROCESSING' AND ${shipmentExists("s.booking_status <> 'BOOKED'")})
      OR (o.order_status = 'PROCESSING' AND ${shipmentExists("s.booking_status = 'BOOKED' AND s.label_status = 'AVAILABLE' AND s.pickup_requested_at IS NULL")})
    )`,
  },

  PREPARING: {
    label: 'Preparing',
    where: `(${IN_FULFILMENT} AND ${shipmentExists("s.booking_status <> 'BOOKED'")})`,
  },

  // Booked with a real AWB, not yet handed to the carrier queue.
  READY_TO_SHIP: {
    label: 'Ready to ship',
    where: `(${IN_FULFILMENT} AND ${shipmentExists("s.booking_status = 'BOOKED' AND s.pickup_requested_at IS NULL AND s.status IN ('BOOKED','READY_TO_BOOK')")})`,
  },

  READY_FOR_PICKUP: {
    label: 'Ready for pickup',
    where: `(${IN_FULFILMENT} AND ${shipmentExists("s.pickup_requested_at IS NOT NULL AND s.status IN ('BOOKED','PICKUP_PENDING')")})`,
  },

  IN_TRANSIT: {
    label: 'In transit',
    where: `(${WITH_CARRIER} AND ${shipmentExists("s.status IN ('PICKED_UP','IN_TRANSIT')")})`,
  },

  OUT_FOR_DELIVERY: {
    label: 'Out for delivery',
    where: `(${WITH_CARRIER} AND ${shipmentExists("s.status = 'OUT_FOR_DELIVERY'")})`,
  },

  DELIVERED: {
    label: 'Delivered',
    // Delivered means every live parcel arrived — not just one of them.
    where: `(${WITH_CARRIER} AND ${shipmentExists("s.status = 'DELIVERED'")} AND ${noShipmentBeyond("s.status <> 'DELIVERED'")})`,
  },

  CANCELLED: { label: 'Cancelled', where: "o.order_status = 'CANCELLED'" },

  RETURNS: {
    label: 'Returns',
    where: `(EXISTS (SELECT 1 FROM return_requests rr WHERE rr.order_id = o.id)
             OR ${shipmentExists("s.status IN ('RTO_IN_TRANSIT','RTO_RETURNED','DELIVERY_EXCEPTION')")})`,
  },
});

export const WORKFLOW_KEYS = Object.freeze(Object.keys(WORKFLOW_BUCKETS));

export function workflowWhere(key) {
  return WORKFLOW_BUCKETS[key]?.where ?? null;
}
