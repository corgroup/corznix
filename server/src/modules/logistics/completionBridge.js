import { withTransaction } from '../../database/connection/transaction.js';
import { fulfillmentService } from '../fulfillment/service.js';
import { fulfillmentRepository } from '../fulfillment/repository.js';
import { orderOpsRepository } from '../orderOps/repository.js';

// WP-01 — the shipment -> fulfilment -> order completion bridge. Nothing
// downstream of a real Delhivery scan wrote to `fulfillments.status` or
// `orders.order_status` before this (FulfillmentService.transitionStatus had
// zero callers; order_status='COMPLETED' had no writer — 08b/08c/12
// GAP-SHIP-09/GAP-ORD-05). This module is the bridge, and only the bridge:
// it never touches inventory, payments, pricing, or a provider (the same
// boundary FulfillmentService itself already enforces).
//
// Best-effort by design: an invalid transition here (e.g. a DELIVERED scan
// arriving for a fulfilment a future cancellation flow already moved to
// CANCELLED) is recorded on the shipment (shipment_events already has the
// row) but must never fail the inbound webhook. Only a genuine defect
// (a DB error, an unknown fulfilment id) propagates.

const FORWARD_MOTION_STATUSES = new Set(['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY']);
const INVALID_TRANSITION_CODES = new Set(['FULFILLMENT_TRANSITION_INVALID', 'FULFILLMENT_STATUS_UNKNOWN']);

async function safeTransition(fulfillmentId, toStatus, detail) {
  try {
    await fulfillmentService.transitionStatus(fulfillmentId, toStatus, { detail });
    return { advanced: true };
  } catch (err) {
    if (INVALID_TRANSITION_CODES.has(err.code)) return { advanced: false, reason: err.code };
    throw err;
  }
}

/**
 * Move a fulfilment in response to its (single, per the Wave 7A foundation)
 * shipment reaching a normalized status. No-ops for any status that isn't
 * forward motion or DELIVERED (RTO/exceptions/NDR are WP-04 territory).
 *
 * @param {string} fulfillmentId
 * @param {string} normalizedShipmentStatus
 */
export async function advanceFulfillmentForShipmentStatus(fulfillmentId, normalizedShipmentStatus) {
  const status = await fulfillmentRepository.statusById(null, fulfillmentId);
  if (!status) return { advanced: false, reason: 'FULFILLMENT_NOT_FOUND' };

  if (normalizedShipmentStatus === 'DELIVERED') {
    if (status === 'FULFILLED') return { advanced: false, reason: 'already fulfilled' };
    if (['PENDING', 'READY', 'ON_HOLD'].includes(status)) {
      const step = await safeTransition(fulfillmentId, 'PROCESSING', { via: 'shipment_delivered_bridge' });
      if (!step.advanced) return step;
    }
    return safeTransition(fulfillmentId, 'FULFILLED', { via: 'shipment_delivered_bridge' });
  }

  if (FORWARD_MOTION_STATUSES.has(normalizedShipmentStatus) && ['PENDING', 'READY'].includes(status)) {
    return safeTransition(fulfillmentId, 'PROCESSING', { via: 'shipment_forward_motion_bridge' });
  }

  return { advanced: false, reason: 'no-op status' };
}

/**
 * Complete an Order once every one of its INITIAL fulfilments has reached a
 * terminal outcome. Requires at least one actually FULFILLED — an order
 * whose every fulfilment was cancelled is not "completed", it is cancelled
 * (WP-09's territory, not this bridge's). Idempotent: only fires from
 * PROCESSING, so a duplicate/racing call is a safe no-op once the first
 * winner has already flipped the order.
 *
 * @param {string} orderId
 */
export async function tryCompleteOrder(orderId) {
  return withTransaction(async (connection) => {
    const order = await orderOpsRepository.lockOrder(connection, orderId);
    if (!order) return { completed: false, reason: 'ORDER_NOT_FOUND' };
    if (order.order_status !== 'PROCESSING') return { completed: false, reason: `order is ${order.order_status}` };

    const counts = await fulfillmentRepository.initialFulfillmentStatusCounts(connection, orderId);
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
    const fulfilled = counts.FULFILLED || 0;
    const cancelled = counts.CANCELLED || 0;
    if (total === 0) return { completed: false, reason: 'no initial fulfilments' };
    if (fulfilled === 0 || fulfilled + cancelled !== total) return { completed: false, reason: 'not all fulfilments terminal' };

    await orderOpsRepository.setOrderStatus(connection, orderId, 'COMPLETED', { completed_at: new Date() });
    return { completed: true };
  });
}

/**
 * The full bridge for one applied shipment event: advance its fulfilment,
 * then — only on DELIVERED, only if the fulfilment actually reached
 * FULFILLED — check whether the whole order can complete.
 *
 * @param {{fulfillmentId: string, orderId: string, normalizedStatus: string}} input
 */
export async function runCompletionBridge({ fulfillmentId, orderId, normalizedStatus }) {
  const fulfilmentResult = await advanceFulfillmentForShipmentStatus(fulfillmentId, normalizedStatus);
  if (normalizedStatus !== 'DELIVERED') return { fulfilmentResult, orderResult: { completed: false, reason: 'not a delivery event' } };
  const orderResult = await tryCompleteOrder(orderId);
  return { fulfilmentResult, orderResult };
}
