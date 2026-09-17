import { env } from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { orderOpsRepository } from '../orderOps/repository.js';
import { shipmentEventService } from '../orderOps/service.js';
import { notificationService } from '../notifications/service.js';
import { staffNotificationService } from '../staffNotifications/service.js';
import { runCompletionBridge } from './completionBridge.js';
import { runRtoBridge } from './rtoBridge.js';

const log = logger('logistics-webhook-applier');


/**
 * A customer-facing delivery estimate from the frozen shipping quote.
 *  is transit days from dispatch — the only estimate we hold —
 * so it is rendered relative to today. Returns null when the quote carried no
 * estimate rather than guessing a date the courier never promised.
 */
function estimatedDeliveryText(shippingSnapshot) {
  const snap = typeof shippingSnapshot === 'string'
    ? (() => { try { return JSON.parse(shippingSnapshot); } catch { return null; } })()
    : shippingSnapshot;
  const days = Number(snap?.estimatedDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  const when = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return when.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

// WP-05 — which customer notification a newly-applied shipment status fires.
// PICKED_UP and IN_TRANSIT both map to ORDER_SHIPPED; the engine's dedupe on
// `order_shipped:<shipmentId>` means only the first one that lands sends.
const SHIPMENT_STATUS_EVENT = {
  PICKED_UP: 'ORDER_SHIPPED',
  IN_TRANSIT: 'ORDER_SHIPPED',
  OUT_FOR_DELIVERY: 'ORDER_OUT_FOR_DELIVERY',
  DELIVERED: 'ORDER_DELIVERED',
};

// WP-01 — the `logistics` capability's ONE domain applier
// (webhookInboxService §38: "the owning domain registers exactly one
// applier per capability"). Registered for both DELHIVERY and MOCK
// providerKeys via bootstrap.js (the parser output shape is identical).
//
// Receives only the NORMALIZED event the parser produced — never the raw
// payload (§40/§47 of webhookInboxService). Everything needed to act is in
// `event.summary` (delhiveryScanPush.js's safeSummary).
//
// Returns 'APPLIED' only when the scan produced a real business effect
// (a shipment_events row that actually moved the shipment). Everything
// else — no matching shipment, an unmapped status, a stale/duplicate/
// invalid transition — is 'IGNORED': recorded on the inbox row for a human
// to review, never a thrown error, because none of those are a system
// defect. A thrown error (propagated, uncaught) marks the inbox row FAILED
// and IS meant to surface as an operational alert.
export async function logisticsWebhookApplier(event) {
  const summary = event?.summary ?? {};
  const { awb, mappedStatus, statusType, statusText, statusDateTime, locationText, instructions, nslCode } = summary;
  const providerCode = event.providerKey === 'MOCK' ? 'MOCK' : 'DELHIVERY';

  // Phase 2 §24 — OBSERVE mode: the webhook was verified, stored and parsed by
  // the inbox; here we only record what we WOULD have done and mutate nothing.
  if (env.LOGISTICS_WEBHOOK_APPLY === 'OBSERVE') {
    log.info('scan_observed_not_applied', {
      awb, providerCode, statusType, statusText, mappedStatus: mappedStatus ?? null,
      nslCode: nslCode ?? null, correlationId: event.correlationId,
    });
    return 'IGNORED';
  }

  if (!awb) {
    log.warn('scan_missing_awb', { correlationId: event.correlationId });
    return 'IGNORED';
  }
  if (!mappedStatus) {
    log.info('scan_unmapped_status', { awb, statusType, statusText, correlationId: event.correlationId });
    return 'IGNORED';
  }
  if (!statusDateTime) {
    log.warn('scan_missing_timestamp', { awb, correlationId: event.correlationId });
    return 'IGNORED';
  }

  const shipment = await orderOpsRepository.shipmentByTrackingNumber(awb, providerCode);
  if (!shipment) {
    // Not necessarily a defect: a stale test scan, an AWB from before this
    // shipment existed in CORCOTTON, or (once WP-02 books real shipments)
    // simple event-vs-booking-commit ordering. Recorded, not applied.
    log.warn('scan_no_matching_shipment', { awb, providerCode, correlationId: event.correlationId });
    return 'IGNORED';
  }

  let outcome;
  try {
    outcome = await shipmentEventService.ingest({
      shipmentId: shipment.id,
      providerCode,
      providerEventKey: event.providerEventId,
      providerStatus: statusText,
      statusType: statusType || null,
      nslCode: nslCode || null,
      normalizedStatus: mappedStatus,
      occurredAt: statusDateTime,
      locationText,
      remarks: instructions,
      source: providerCode,
    });
  } catch (err) {
    if (err.code === 'INVALID_SHIPMENT_TRANSITION') {
      // Out-of-order or non-guaranteed scan (the source material is explicit
      // that not every stage is guaranteed to be emitted) — expected, not a
      // fault. Still visible via the inbox row's IGNORED status + summary.
      log.info('scan_invalid_transition', { awb, shipmentId: shipment.id, mappedStatus, correlationId: event.correlationId });
      return 'IGNORED';
    }
    throw err;
  }

  if (!outcome.applied) return 'IGNORED';

  // The order's own checkout contact + name drive the message: every approved
  // WhatsApp template opens with the customer's name, and the number must be
  // the one given for THIS order (notifications/recipients.js).
  const addressSnapshot = shipment.shipping_address_snapshot || null;
  const snap = typeof addressSnapshot === 'string'
    ? (() => { try { return JSON.parse(addressSnapshot); } catch { return null; } })()
    : addressSnapshot;
  const notifyContext = {
    customerId: shipment.customer_id,
    orderId: shipment.order_id,
    orderNumber: shipment.order_number,
    shipmentId: shipment.id,
    awb,
    shippingAddressSnapshot: addressSnapshot,
    customerName: [snap?.firstName, snap?.lastName].filter(Boolean).join(' ') || null,
    // The carrier gives a transit-day estimate, not a date, and only on the
    // quote. Rendered as a date the customer can act on; null when we genuinely
    // do not know, so the template falls back rather than inventing a day.
    estimatedDelivery: estimatedDeliveryText(shipment.shipping_snapshot),
  };

  // WP-05 — the customer notification for the milestone this scan reached.
  const shipmentEvent = SHIPMENT_STATUS_EVENT[outcome.status];
  if (shipmentEvent) {
    await notificationService.emit(shipmentEvent, notifyContext).catch(() => {});
  }

  // Phase 2 · Slice 18 — a failed delivery attempt (NDR). Notify the customer
  // once per distinct attempt; the operator decides RE_ATTEMPT / RESCHEDULE
  // from the CMS (auto-NDR is a deliberate non-default, see ndrService).
  if (outcome.status === 'DELIVERY_EXCEPTION') {
    await notificationService.emit('ORDER_DELIVERY_ATTEMPT_FAILED', {
      ...notifyContext, occurredAt: statusDateTime, reason: instructions || statusText || null,
    }).catch(() => {});
    await staffNotificationService.record({
      category: 'SHIPMENT', eventKey: 'ORDER_DELIVERY_ATTEMPT_FAILED', severity: 'CRITICAL',
      title: `Failed delivery · ${shipment.order_number}`,
      body: `${instructions || statusText || 'Courier could not deliver'} — NDR action needed (AWB ${awb})`,
      link: `/orders/${shipment.order_id}`, entityType: 'shipment', entityId: shipment.id,
      dedupeKey: `ndr:${shipment.id}:${statusDateTime || ''}`,
    }).catch(() => {});
  }

  let bridge = null;
  try {
    bridge = await runCompletionBridge({
      fulfillmentId: shipment.fulfillment_id,
      orderId: shipment.order_id,
      normalizedStatus: mappedStatus,
    });
  } catch (err) {
    // The shipment_events write already committed and IS the source of
    // truth for tracking (§D of 11-customer-tracking-current-state.md /
    // GAP-DELIV-01). A bridge failure must not roll that back or fail the
    // webhook — it is a defect to fix, surfaced via logs, not data loss.
    log.error('completion_bridge_failed', {
      awb, shipmentId: shipment.id, fulfillmentId: shipment.fulfillment_id, orderId: shipment.order_id,
      mappedStatus, error: err.message, correlationId: event.correlationId,
    });
  }

  if (bridge?.orderResult?.completed) {
    await notificationService.emit('ORDER_COMPLETED', notifyContext).catch(() => {});
  }

  // WP-04 / GAP-INV-02 — a return-to-origin puts real units back at the
  // dispatch warehouse. Route them into quarantine (pending inspection) so
  // they are never a phantom loss. Best-effort; never fails the webhook.
  if (mappedStatus === 'RTO_RETURNED') {
    try {
      await runRtoBridge({ shipmentId: shipment.id });
    } catch (err) {
      log.error('rto_bridge_failed', { awb, shipmentId: shipment.id, error: err.message, correlationId: event.correlationId });
    }
  }

  return 'APPLIED';
}
