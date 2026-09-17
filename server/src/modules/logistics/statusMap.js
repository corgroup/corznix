// WP-01 — Delhivery Scan Push raw -> CORCOTTON normalized shipment status.
//
// Grounded strictly in what the supplied Delhivery material documents
// (`docs/cms-functional-flow/08d-delhivery-provider-contract-reconciliation.md`
// §N.1, sourced from "CORCOTTON Delhivery Webhook Integration Analysis" §6):
//
//   StatusType values: UD (undelivered/in-progress), DL (delivered),
//   RT (RTO), PP (pickup pending), PU (picked up), CN (cancelled).
//   Forward:  Manifested -> Not Picked/In Transit -> Pending -> Dispatched -> Delivered
//   RTO:      RT In Transit -> RT Pending -> RT Dispatched -> DL RTO
//   Reverse:  PP Open -> PP Scheduled -> PP Dispatched -> PU In Transit ->
//             PU Pending -> PU Dispatched -> DL DTO  (+ CN Canceled/Closed)
//   "DL + Delivered" (forward) != "DL + RTO" != "DL + DTO" — never collapse.
//
// The source itself calls this "conceptual, not a guarantee every stage will
// be emitted", and flags the NSL list as currentness-unverified (WP-00). This
// map therefore only classifies scans it can classify with real confidence
// from StatusType + Status text; everything else returns null and the caller
// records-but-does-not-apply the event rather than guess (no assumptions —
// carried over from the audit into this implementation). In particular:
// undelivered-attempt / NDR-reason detail (which UD scan is "in transit" vs a
// genuine failed attempt) needs the current NSL list and is WP-04's job, not
// this one's.
//
// PP / PU are the documented REVERSE-shipment family — a forward shipment
// receiving one is treated as unmapped, not forced into a state.

const norm = (value) => String(value ?? '').trim().toLowerCase();

// NDR reasons Delhivery puts in `instructions` when a delivery attempt fails.
// Every entry describes an attempt that DID NOT succeed — none of them can
// occur on a healthy in-transit scan. Kept deliberately conservative: a reason
// that merely sounds unhappy ("delayed", "held at hub") is NOT here, because
// misclassifying ordinary transit as a failed attempt would alarm the customer
// and raise a false NDR for the operator.
const NDR_REASONS = Object.freeze([
  'consignee not available',
  'customer not available',
  'consignee unavailable',
  'customer refused',
  'consignee refused',
  'refused to accept',
  'address incorrect',
  'incorrect address',
  'incomplete address',
  'address not found',
  'premises closed',
  'office closed',
  'consignee shifted',
  'out of station',
  'phone not reachable',
  'contact not reachable',
  'number not reachable',
  'cod amount not ready',
  'payment not ready',
  'delivery attempted',
  'attempted delivery',
  'reattempt',
  're-attempt',
]);

/**
 * @param {{statusType: string, statusText: string, instructions?: string}} scan
 * @returns {import('../shipping/shipmentLifecycle.js').SHIPMENT_STATUS[number] | null}
 */
export function mapDelhiveryStatus({ statusType, statusText, instructions }) {
  const type = String(statusType ?? '').trim().toUpperCase();
  const text = norm(statusText);
  const reason = norm(instructions);

  if (type === 'RT') {
    // RTO family. A terminal "DL RTO" scan is documented as still carrying
    // meaning distinct from a forward DELIVERED (§N.1) — some accounts surface
    // the RTO-complete scan under StatusType RT too, so check text here as
    // well as under DL below.
    if (text.includes('return') || text.includes('delivered to origin') || text.includes('rto delivered')) {
      return 'RTO_RETURNED';
    }
    return 'RTO_IN_TRANSIT';
  }

  if (type === 'DL') {
    // "DL + RTO" / "DL + DTO" must never collapse into forward DELIVERED.
    if (text.includes('rto') || text.includes('dto') || text.includes('return')) return 'RTO_RETURNED';
    return 'DELIVERED';
  }

  if (type === 'CN') return 'CANCELLED';

  if (type === 'UD') {
    // Forward family, now grounded in Dev_API.docx "Package Lifecycle":
    //   Manifested -> Not Picked -> In Transit -> Pending -> Dispatched -> Delivered
    //   "Dispatched" = "dispatched for delivery to end customer" => OUT_FOR_DELIVERY
    //   "Pending"    = "reached DC but not yet dispatched for delivery" => IN_TRANSIT
    //   "In Transit" = "in transit to its DC after physical pick up" => IN_TRANSIT
    //   "Not Picked" = "not physically picked up from client's warehouse" => still pending pickup
    if (text.includes('out for delivery') || text.includes('ofd')) return 'OUT_FOR_DELIVERY';
    if (text.includes('dispatched')) return 'OUT_FOR_DELIVERY';
    // A cancellation does NOT always arrive as StatusType CN. Cancelling a
    // shipment in Delhivery's own panel leaves the scan as UD / "Not Picked"
    // and puts the reason in `instructions` ("Seller cancelled the order",
    // NSL DTUP-210) — observed live. Without this the scan matched the
    // "not picked" rule below and mapped to PICKUP_PENDING, so a shipment
    // that will NEVER be collected was indistinguishable from one still
    // waiting for the courier: it sits in Ready for Pickup forever, staff
    // keep expecting a van, and the customer keeps seeing "Ready for
    // shipment". Only fires when the provider itself says cancelled.
    if (reason.includes('cancel')) return 'CANCELLED';
    if (text.includes('not picked')) return 'PICKUP_PENDING';
    if (text.includes('picked')) return 'PICKED_UP';

    // A failed delivery attempt frequently arrives as an ordinary-looking
    // "UD / Pending" scan with the NDR reason ONLY in `instructions` — the
    // status text says nothing about a failure. Checked BEFORE the transit
    // rules below, which would otherwise swallow it: the customer would be
    // told "your order has shipped" after the courier had already failed to
    // deliver, ORDER_DELIVERY_ATTEMPT_FAILED would never fire, and the
    // operator would get no NDR alert.
    //
    // Only reasons that unambiguously describe a delivery attempt that did
    // not succeed. Anything vaguer is left to the transit rules rather than
    // guessed into an exception.
    if (NDR_REASONS.some((r) => reason.includes(r))) return 'DELIVERY_EXCEPTION';

    if (text.includes('in transit') || text.includes('pending')) return 'IN_TRANSIT';
    if (text.includes('undelivered') || text.includes('delivery attempt') || text.includes('failed')) return 'DELIVERY_EXCEPTION';
    // "Manifested" only confirms what CORCOTTON already knows (booking already
    // set status=BOOKED) — classifyTransition(BOOKED,BOOKED) is a harmless
    // no-op "stale", so mapping it keeps the audit trail complete.
    if (text.includes('manifest')) return 'BOOKED';
    // A genuinely ambiguous UD scan — do not guess without the current NSL list.
    return null;
  }

  // PP / PU on a forward shipment, or any other/unknown StatusType.
  return null;
}
