import { AppError } from '../../utils/errors.js';

// Single source of truth for valid Fulfillment status transitions (§41).
// No code path outside FulfillmentService writes fulfillments.status directly.
// WAREHOUSE_CONFIRMED is a human acceptance: someone at the allocated
// warehouse has looked at the order and undertaken to fulfil it.
//
// It is a state of its own rather than a reuse of either existing "ready",
// because those already mean two other things and must keep meaning them:
//   * `readiness_status` ∈ (READY, BLOCKED) is BOOKING readiness — derived
//     from whether carrier metadata exists, never set by a person.
//   * `status = 'READY'` is an operational staff state with its own ready_at.
// Neither says a warehouse has accepted the work.
//
// The pre-existing edges are left intact on purpose. Removing PENDING ->
// PROCESSING would be a breaking change for callers that predate this step
// (the auto-fulfilment path and the existing CMS transition endpoint among
// them), and the sequential operator flow is enforced by only offering the
// next valid action rather than by making the older paths throw. Tightening
// the graph is a deliberate follow-up once nothing drives PROCESSING directly.
const GRAPH = Object.freeze({
  PENDING: ['WAREHOUSE_CONFIRMED', 'READY', 'PROCESSING', 'ON_HOLD', 'CANCELLED'],
  WAREHOUSE_CONFIRMED: ['READY', 'PROCESSING', 'ON_HOLD', 'CANCELLED'],
  READY: ['PROCESSING', 'ON_HOLD', 'CANCELLED', 'PENDING'],
  PROCESSING: ['PARTIALLY_FULFILLED', 'FULFILLED', 'ON_HOLD', 'CANCELLED'],
  PARTIALLY_FULFILLED: ['PROCESSING', 'FULFILLED', 'ON_HOLD', 'CANCELLED'],
  ON_HOLD: ['PENDING', 'WAREHOUSE_CONFIRMED', 'READY', 'PROCESSING', 'CANCELLED'],
  FULFILLED: [],
  CANCELLED: [],
});

// The operator-facing sequence. The CMS offers exactly one next action, taken
// from here, rather than every transition the graph would technically permit.
export const OPERATOR_FLOW = Object.freeze(['PENDING', 'WAREHOUSE_CONFIRMED', 'PROCESSING', 'FULFILLED']);

/** The next action an operator should be offered, or null when there is none. */
export function nextOperatorStatus(from) {
  const i = OPERATOR_FLOW.indexOf(from);
  if (i < 0 || i === OPERATOR_FLOW.length - 1) return null;
  return OPERATOR_FLOW[i + 1];
}

export const TERMINAL_STATUSES = Object.freeze(['FULFILLED', 'CANCELLED']);

export function assertTransition(from, to) {
  if (from === to) return;
  if (!GRAPH[from]) throw new AppError('FULFILLMENT_STATUS_UNKNOWN', `Unknown fulfillment status "${from}".`, 500);
  if (!GRAPH[from].includes(to)) {
    throw new AppError('FULFILLMENT_TRANSITION_INVALID', `Fulfillment cannot move from ${from} to ${to}.`, 409);
  }
}

export function canTransition(from, to) {
  return from === to || Boolean(GRAPH[from]?.includes(to));
}
