import { isProduction } from '../../config/index.js';
import { fulfillmentService } from '../fulfillment/service.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { orderOpsRepository } from './repository.js';
import { orderConfirmationService, shipmentBookingService, shipmentLabelService } from './service.js';
import { shipmentProviderCancellationService, shipmentPackageService } from './shipmentCancellationService.js';
import { trackReconciliationService } from '../logistics/trackReconciliation.js';
import { carrierDocumentService } from '../logistics/carrierDocumentService.js';
import { ndrService } from '../logistics/ndrService.js';
import { warehousePickupService } from '../shipping/pickupService.js';
import { documentService } from '../documents/service.js';
import { refundRepository } from '../returns/refundRepository.js';
import { CANCELLATION_REFUND_ORIGIN } from './cancellationRefundService.js';
import { notificationService } from '../notifications/service.js';
import { nextOperatorAction, operatorProgress } from './operatorFlow.js';
import { customerOrderStatus, CUSTOMER_STATUS_LABEL } from './customerStatus.js';
import { pickupContactStatus } from '../warehouses/pickupContact.js';
import * as v from './validation.js';

const audit = new StaffAuditRepository();
const ok = (res, data, status = 200) => res.status(status).json({ data });
const actorOf = (req) => ({ id: req.staff?.id, email: req.staff?.email, ip: req.ip, requestId: req.id });
const staffOf = (req) => ({ id: req.staff?.id, role: req.staff?.role, brandId: req.brandId });

const maskEmail = (v) => {
  if (!v) return null;
  const [u, d] = String(v).split('@');
  return d ? `${u.slice(0, 2)}***@${d}` : v;
};
const maskPhone = (v) => (v ? `${String(v).slice(0, 3)}*****${String(v).slice(-2)}` : null);
const parseJson = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

export async function listOrders(req, res, next) {
  try {
    const q = v.listOrdersQuery.parse(req.query);
    const scope = await warehouseScopeForStaff(staffOf(req), req.brandId);
    const warehouseIds = scope.all ? null : scope.warehouseIds;
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    if (warehouseIds && warehouseIds.length === 0) {
      return ok(res, { orders: [], total: 0, limit, offset });
    }
    const filter = {
      workflow: q.workflow ?? null,
      status: q.status ?? null,
      paymentStatus: q.paymentStatus ?? null,
      fulfillmentStatus: q.fulfillmentStatus ?? null,
      placedFrom: q.placedFrom ?? null,
      placedTo: q.placedTo ?? null,
      q: q.q ?? null,
      warehouseIds, limit, offset,
      brandId: req.brandId,
    };
    const [orders, total] = await Promise.all([
      orderOpsRepository.listOrders(filter),
      orderOpsRepository.countOrders(filter),
    ]);
    ok(res, { orders: orders.map(listRowDto), total, limit, offset });
  } catch (err) { next(err); }
}

/**
 * Reconstruct just enough of the shipment shape for `nextOperatorAction`.
 *
 * The list query returns aggregates, not rows — but the row's next action MUST
 * come from the same function the detail page uses, or the two surfaces drift.
 * So the counts are expanded back into the minimum shipment shape that
 * function reads. Anything it does not read is deliberately absent.
 */
function pseudoShipments(r) {
  const live = Number(r.shipment_live_count || 0);
  if (!live) return [];
  const booked = Number(r.shipment_booked_count || 0);
  const labelled = Number(r.shipment_label_ready_count || 0);
  const picked = Number(r.shipment_pickup_count || 0);
  const transit = Number(r.shipment_transit_count || 0);
  const ofd = Number(r.shipment_ofd_count || 0);
  const delivered = Number(r.shipment_delivered_count || 0);
  const unknown = Number(r.shipment_unknown_count || 0);

  const out = [];
  for (let i = 0; i < live; i += 1) {
    const isBooked = i < booked;
    const status = i < delivered ? 'DELIVERED'
      : i < delivered + ofd ? 'OUT_FOR_DELIVERY'
        : i < delivered + ofd + transit ? 'IN_TRANSIT'
          : i < picked ? 'PICKUP_PENDING'
            : isBooked ? 'BOOKED' : 'DRAFT';
    out.push({
      id: null,
      status,
      bookingStatus: i < unknown ? 'UNKNOWN' : isBooked ? 'BOOKED' : 'READY',
      labelStatus: i < labelled ? 'AVAILABLE' : 'NONE',
      pickupRequestedAt: i < picked ? true : null,
    });
  }
  return out;
}

// Phase 5 — one readable list row. Keeps the raw enum fields (backward-compat)
// and adds a `fulfillmentProgress` text ("2 of 3 booked" / "Unfulfilled" — never
// a fake %), masked email, and item count.
function listRowDto(r) {
  const ful = Number(r.fulfillment_count || 0);
  const fulDone = Number(r.fulfillment_done_count || 0);
  const shp = Number(r.shipment_count || 0);
  const shpBooked = Number(r.shipment_booked_count || 0);
  let progress = 'Unfulfilled';
  if (r.fulfillment_status === 'FULFILLED') progress = 'Fulfilled';
  else if (r.fulfillment_status === 'CANCELLED') progress = 'Cancelled';
  else if (shp > 0) progress = `${shpBooked} of ${shp} shipment${shp === 1 ? '' : 's'} booked`;
  else if (ful > 0) progress = `${fulDone} of ${ful} fulfilment${ful === 1 ? '' : 's'} ready`;
  // One authority for "what next", shared with the detail page.
  const order = { id: r.id, status: r.order_status };
  const shipments = pseudoShipments(r);
  const nextAction = nextOperatorAction({ order, shipments });
  const customer = customerOrderStatus(order, shipments);
  return {
    id: r.id,
    order_number: r.order_number,
    orderNumber: r.order_number,
    customer_id: r.customer_id,
    customer_name: r.customer_name || null,
    customer_email: maskEmail(r.customer_email),
    order_status: r.order_status,
    payment_status: r.payment_status,
    payment_mode: r.payment_mode,
    fulfillment_status: r.fulfillment_status,
    fulfillmentProgress: progress,
    itemCount: Number(r.item_count || 0),
    total_minor: Number(r.total_minor),
    cod_due_minor: Number(r.cod_due_minor),
    currency: r.currency,
    placed_at: r.placed_at,
    // The operator reads THIS, not "0 of 1 shipment booked". The raw
    // fulfilment text stays above for anything that already consumed it.
    workflowStage: nextAction.stage,
    nextOperatorAction: nextAction.action,
    nextOperatorLabel: nextAction.label,
    customerStatus: customer,
    customerStatusLabel: CUSTOMER_STATUS_LABEL[customer] || customer,
  };
}

export async function getOrderFacets(req, res, next) {
  try {
    const scope = await warehouseScopeForStaff(staffOf(req), req.brandId);
    const warehouseIds = scope.all ? null : (scope.warehouseIds || []);
    if (warehouseIds && warehouseIds.length === 0) {
      return ok(res, { total: 0, byStatus: { PLACED: 0, CONFIRMED: 0, PROCESSING: 0, COMPLETED: 0, CANCELLED: 0 }, needsAction: 0, processing: 0, completed: 0, cancelled: 0, codDueMinor: 0, workflow: {} });
    }
    const [facets, workflow] = await Promise.all([
      orderOpsRepository.facets({ warehouseIds, brandId: req.brandId }),
      orderOpsRepository.workflowCounts({ warehouseIds, brandId: req.brandId }),
    ]);
    ok(res, { ...facets, workflow });
  } catch (err) { next(err); }
}

export async function getOrderTimeline(req, res, next) {
  try {
    ok(res, { events: await orderOpsRepository.timelineForOrder(req.params.id) });
  } catch (err) { next(err); }
}

export async function getOrderReturns(req, res, next) {
  try {
    const rows = await orderOpsRepository.returnsForOrder(req.params.id);
    ok(res, {
      returns: rows.map((r) => ({
        id: r.id,
        requestNumber: r.request_number,
        requestType: r.request_type,
        status: r.status,
        reasonCode: r.reason_code || null,
        requestedAt: r.requested_at,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) { next(err); }
}

export async function getOrder(req, res, next) {
  try {
    const order = await orderOpsRepository.order(req.params.id, req.brandId);
    if (!order) return next(Object.assign(new Error('Order not found.'), { code: 'ORDER_NOT_FOUND', status: 404 }));
    const [fingerprint, summary, shipments, fulRows, customerRow, itemRows, discountRows, cancellationRefund] = await Promise.all([
      orderConfirmationService.currentFingerprint(order.id),
      fulfillmentService.summaryForOrder(order.id),
      orderOpsRepository.shipmentsForOrder(order.id),
      orderOpsRepository.fulfillmentIds(order.id),
      orderOpsRepository.customerForOrder(order.customer_id),
      orderOpsRepository.itemsForOrder(order.id),
      orderOpsRepository.discountsForOrder(order.id),
      refundRepository.byOrderOrigin(null, order.id, CANCELLATION_REFUND_ORIGIN),
    ]);
    const fulIdByNumber = new Map(fulRows.map((r) => [r.fulfillment_number, r.id]));
    const orderProcessing = order.order_status === 'PROCESSING';
    // Owner Delivery orders are delivered by the store — never carrier-booked.
    const isOwnerDelivery = (parseJson(order.shipping_snapshot) || {}).serviceLevel === 'OWNER_DELIVERY';
    const shipmentsWithEvents = await Promise.all(shipments.map(async (s) => {
      const booked = s.booking_status === 'BOOKED';
      const pkg = parseJson(s.package_snapshot_json) || {};
      const calc = booked ? null : await shipmentPackageService.calculatedItemWeightGrams(s.id).catch(() => null);
      const carrierDocuments = await carrierDocumentService.listForShipment(s.id).catch(() => []);
      const ndr = s.status === 'DELIVERY_EXCEPTION'
        ? await ndrService.contextForShipment(s.id).catch(() => null)
        : null;
      const packageConfirmed = Boolean(pkg.packageConfirmed);
      const labelReady = s.label_status === 'AVAILABLE';
      const printed = Boolean(s.label_printed_at);
      const pickupRequested = Boolean(s.pickup_requested_at);
      // Phase 2 §27/§30/§58 — only offer an action the backend can actually do.
      const nextActions = [];
      if (!isOwnerDelivery && !booked && !packageConfirmed && !['CANCELLED', 'DELIVERED'].includes(s.status)) nextActions.push('CONFIRM_PACKAGE');
      if (!isOwnerDelivery && orderProcessing && !booked && !['CANCELLED', 'DELIVERED'].includes(s.status)) nextActions.push('BOOK');
      // RECONCILE — resolve a BOOKING_UNKNOWN, or pull the carrier for the
      // latest tracking on a booked, non-terminal shipment (Slice 13).
      if (s.booking_status === 'UNKNOWN'
        || (booked && !['DELIVERED', 'CANCELLED', 'RTO_RETURNED', 'LOST'].includes(s.status))) {
        nextActions.push('RECONCILE');
      }
      if (s.status === 'DELIVERY_EXCEPTION') nextActions.push('NDR_ACTION');
      if (booked && !labelReady) nextActions.push('FETCH_LABEL');
      if (booked && labelReady && !printed) nextActions.push('MARK_PRINTED');
      if (booked && s.label_status === 'FAILED') nextActions.push('RETRY_LABEL');
      // READY_FOR_PICKUP is the carrier-pickup trigger, not a label change:
      // it calls the provider pickup API through the orchestrator. There is
      // deliberately no separate pickup action after it — the provider assigns
      // its own local pickup agent from the registered location.
      if (booked && printed && !pickupRequested) nextActions.push('READY_FOR_PICKUP');
      if (booked && ['BOOKED', 'READY_TO_BOOK', 'PICKUP_PENDING'].includes(s.status)) nextActions.push('CANCEL_SHIPMENT');
      // Business rule (2026-09-04): no automation past allocation. The warehouse
      // manager does BOOK -> FETCH_LABEL -> MARK_PRINTED -> READY_FOR_PICKUP as
      // discrete manual steps; RUN_AUTOMATION is no longer offered.
      return {
        id: s.id,
        shipmentNumber: s.shipment_number,
        warehouseId: s.warehouse_id,
        status: s.status,
        bookingStatus: s.booking_status,
        providerCode: s.provider_code,
        awbNumber: s.tracking_number,
        trackingUrl: s.tracking_url || null,
        lastProviderStatus: s.last_provider_status || null,
        automation: {
          status: s.auto_fulfillment_status || 'IDLE',
          step: s.auto_fulfillment_step || null,
          error: s.auto_fulfillment_error || null,
          attempts: Number(s.auto_fulfillment_attempts || 0),
          nextAt: s.auto_fulfillment_next_at,
        },
        customerShippingChargeMinor: s.customer_shipping_charge_minor == null ? null : Number(s.customer_shipping_charge_minor),
        actualLogisticsCostMinor: s.actual_logistics_cost_minor == null ? null : Number(s.actual_logistics_cost_minor),
        labelStatus: s.label_status,
        labelUrl: s.label_url || null,
        labelPrintedAt: s.label_printed_at,
        pickupRequestedAt: s.pickup_requested_at,
        codCollectionMinor: Number(s.cod_collection_minor),
        // Phase 2 · Slice 8 — package confirmation (E2E spec §4/§26)
        package: {
          confirmed: packageConfirmed,
          calculatedItemWeightGrams: calc ? calc.grams : (pkg.calculatedItemWeightGrams ?? null),
          calculatedWeightComplete: calc ? calc.complete : Boolean(pkg.calculatedWeightComplete),
          weightGrams: pkg.weightGrams ?? null,
          lengthMm: pkg.lengthMm ?? null,
          widthMm: pkg.widthMm ?? null,
          heightMm: pkg.heightMm ?? null,
          confirmedAt: pkg.confirmedAt ?? null,
          editable: !booked && !['CANCELLED', 'DELIVERED'].includes(s.status),
        },
        nextActions,
        carrierDocuments,
        ndr,
        timeline: await orderOpsRepository.events(s.id),
      };
    }));
    // Phase 5 — allocation state per SKU, from the fulfilment items.
    const allocBySku = new Map();
    for (const f of summary.fulfillments) {
      for (const it of (f.items || [])) {
        const key = it.skuId || it.sku_id;
        if (!key) continue;
        allocBySku.set(key, { fulfillmentNumber: f.fulfillmentNumber, status: f.status, readinessStatus: f.readinessStatus });
      }
    }
    const items = itemRows.map((r) => {
      const snap = parseJson(r.media_snapshot);
      return {
        id: r.id,
        productId: r.product_id,
        productName: r.product_name,
        productSlug: r.product_slug || null,
        productLive: r.product_status === 'ACTIVE',
        variantId: r.variant_id,
        skuId: r.sku_id,
        sku: r.sku,
        size: r.selected_size || null,
        color: r.selected_color || null,
        quantity: Number(r.quantity),
        unitPriceMinor: Number(r.unit_price_minor),
        lineTotalMinor: Number(r.line_total_minor),
        imageUrl: r.current_image_url || (Array.isArray(snap) ? snap[0]?.url : snap?.url) || null,
        allocation: allocBySku.get(r.sku_id) || null,
      };
    });
    const discountMinor = order.discount_minor == null ? 0 : Number(order.discount_minor);
    const shippingSnapshot = parseJson(order.shipping_snapshot) || {};

    // The backend decides the operator's next step; the CMS renders it. No
    // second copy of this graph exists on the frontend.
    const orderProjection = { id: order.id, status: order.order_status };
    const nextAction = nextOperatorAction({
      order: orderProjection, shipments: shipmentsWithEvents, isOwnerDelivery,
    });
    const progress = operatorProgress({ order: orderProjection, shipments: shipmentsWithEvents, next: nextAction });
    const customerStatus = customerOrderStatus(orderProjection, shipmentsWithEvents);

    // The pickup contact of every warehouse this order dispatches from — the
    // operator sees the number a pickup agent would call, and is warned
    // before they reach Ready for Pickup rather than at the gate.
    const warehouseIds = [...new Set(shipmentsWithEvents.map((s) => s.warehouseId).filter(Boolean))];
    const warehouseRows = warehouseIds.length
      ? await orderOpsRepository.warehousesByIds(warehouseIds).catch(() => [])
      : [];
    ok(res, {
      order: {
        id: order.id, orderNumber: order.order_number, status: order.order_status,
        paymentStatus: order.payment_status, paymentMode: order.payment_mode,
        totalMinor: Number(order.total_minor), codDueMinor: Number(order.cod_due_minor),
        onlinePaidMinor: Number(order.online_paid_minor), subtotalMinor: Number(order.subtotal_minor),
        shippingMinor: Number(order.shipping_minor), discountMinor,
        // The customer's checkout choice, persisted on the order. The manifest
        // CONSUMES this; it never re-decides it.
        shippingMethod: shippingSnapshot.serviceLevel || null,
        shippingMethodSource: shippingSnapshot.serviceLevel ? 'CUSTOMER_CHECKOUT' : null,
        // Customer charge and provider cost are separate numbers and must stay
        // separate: free shipping to the customer is not free to CORCOTTON.
        customerShippingChargeMinor: shippingSnapshot.customerShippingChargeMinor ?? Number(order.shipping_minor),
        actualLogisticsCostMinor: shippingSnapshot.actualLogisticsCostMinor ?? shippingSnapshot.providerRateMinor ?? null,
        shippingSurchargeMinor: shippingSnapshot.surchargeMinor ?? null,
        nextOperatorAction: nextAction,
        progress,
        customerStatus,
        customerStatusLabel: CUSTOMER_STATUS_LABEL[customerStatus] || customerStatus,
        ownerDelivery: isOwnerDelivery,
        ownerDeliveryZone: isOwnerDelivery ? (shippingSnapshot.ownerDeliveryZone || null) : null,
        // `shippingMethod` is set once, above, next to shippingMethodSource —
        // it was assigned twice in this same literal, so one of the two was
        // dead. Nothing could have caught that: the server had no linter.
        currency: order.currency,
        placedAt: order.placed_at, confirmedAt: order.confirmed_at, processingStartedAt: order.processing_started_at,
        completedAt: order.completed_at, cancelledAt: order.cancelled_at || null,
        cancellationReason: order.cancellation_reason || null,
        allocationFingerprint: fingerprint,
        allocationConfirmable: order.order_status === 'PLACED',
        customer: customerRow ? {
          id: customerRow.id,
          name: [customerRow.first_name, customerRow.last_name].filter(Boolean).join(' ') || null,
          email: maskEmail(customerRow.verified_email),
          phone: maskPhone(customerRow.verified_phone),
        } : null,
        shippingAddress: parseJson(order.shipping_address_snapshot),
        billingSameAsShipping: true, // no separate billing snapshot in the order model
        discounts: discountRows.map((d) => ({
          couponCode: d.coupon_code || null,
          type: d.discount_type,
          scope: d.discount_scope,
          amountMinor: Number(d.discount_total_minor),
        })),
      },
      items,
      // The refund a cancellation started, so the operator can see whether the
      // customer's money actually went back — and retry it when it did not.
      // Before this the page said CANCELLED and nothing else, while the refund
      // could be FAILED or blocked with only a staff task to say so.
      cancellationRefund: cancellationRefund ? {
        refundNumber: cancellationRefund.refund_number,
        status: cancellationRefund.status,
        method: cancellationRefund.method,
        providerCode: cancellationRefund.provider_code,
        providerRefundId: cancellationRefund.provider_refund_id,
        amountMinor: Number(cancellationRefund.amount_minor),
        currency: cancellationRefund.currency,
        failureCode: cancellationRefund.failure_code,
        completedAt: cancellationRefund.completed_at,
      } : null,
      fulfillments: summary.fulfillments.map((f) => ({ ...f, id: fulIdByNumber.get(f.fulfillmentNumber) || null })),
      shipments: shipmentsWithEvents,
      warehouses: warehouseRows.map((w) => ({
        id: w.id,
        code: w.code,
        name: w.name,
        addressLine1: w.address_line1,
        addressLine2: w.address_line2,
        city: w.city,
        state: w.state,
        postalCode: w.postal_code,
        country: w.country,
        status: w.status,
        contactEmail: w.contact_email,
        pickupContact: pickupContactStatus(w),
      })),
    });
  } catch (err) { next(err); }
}

export async function confirmOrder(req, res, next) {
  try {
    const body = v.confirmOrderBody.parse(req.body ?? {});
    const result = await orderConfirmationService.confirm({
      orderId: req.params.id,
      expectedAllocationFingerprint: body.expectedAllocationFingerprint ?? null,
      staffUserId: req.staff.id,
    });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'ORDER_CONFIRMED', resourceType: 'order', resourceId: result.id, ipAddress: req.ip });
    // Post-commit: render the invoice + packing-slip PDFs. Never fatal to a
    // valid CONFIRMED order.
    await documentService.renderPending(result.id).catch(() => {});
    ok(res, result);
  } catch (err) { next(err); }
}

export async function startProcessing(req, res, next) {
  try {
    const result = await orderConfirmationService.startProcessing({ orderId: req.params.id, staffUserId: req.staff.id });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'ORDER_PROCESSING_STARTED', resourceType: 'order', resourceId: result.id, ipAddress: req.ip });
    // Business rule (2026-09-04): automation stops at warehouse allocation.
    // Nothing here kicks the shipment workflow — the warehouse manager books
    // the shipment, fetches the label and requests pickup manually from the
    // order's Shipments panel. `runShipmentAutomation` (an explicit operator
    // "Run automation" click) is still available but never triggered by the
    // system. When SHIPMENT_AUTOMATION_MODE=MANUAL it is a no-op anyway.
    ok(res, result);
  } catch (err) { next(err); }
}

export async function runShipmentAutomation(req, res, next) {
  try {
    const { autoFulfillmentService } = await import('../shipping/autoFulfillmentService.js');
    const result = await autoFulfillmentService.runForShipment(req.params.id, { trigger: 'MANUAL', actor: actorOf(req) });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'AUTO_FULFILLMENT_RUN', resourceType: 'shipment', resourceId: req.params.id, metadata: result, ipAddress: req.ip });
    ok(res, result);
  } catch (err) { next(err); }
}

export async function bookShipment(req, res, next) {
  try {
    const body = v.bookShipmentBody.parse(req.body ?? {});
    const simulate = !isProduction() ? body.simulate ?? null : null;
    const result = await shipmentBookingService.book({
      shipmentId: req.params.id, idempotencyKey: body.idempotencyKey, staffUserId: req.staff.id, simulate,
    });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'SHIPMENT_BOOKED', resourceType: 'shipment', resourceId: req.params.id, metadata: { awbNumber: result.shipment.awbNumber }, ipAddress: req.ip });
    const bookedOrder = await orderOpsRepository.orderForShipment(req.params.id);
    if (bookedOrder) await documentService.renderPending(bookedOrder.id).catch(() => {});
    ok(res, result);
  } catch (err) { next(err); }
}

export async function shipmentEvents(req, res, next) {
  try {
    void actorOf(req);
    ok(res, { events: await orderOpsRepository.events(req.params.id) });
  } catch (err) { next(err); }
}

// Phase 2 · Slice 16 — Order Detail operational actions.
export async function fetchShipmentLabel(req, res, next) {
  try {
    const body = v.labelBody.parse(req.body ?? {});
    const result = await shipmentLabelService.fetchLabel({ shipmentId: req.params.id, size: body.size, staffUserId: req.staff.id });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: result.labelStatus === 'AVAILABLE' ? 'LABEL_FETCHED' : 'LABEL_FAILED', resourceType: 'shipment', resourceId: req.params.id, metadata: { source: result.source }, ipAddress: req.ip });
    ok(res, result);
  } catch (err) { next(err); }
}

export async function markShipmentLabelPrinted(req, res, next) {
  try {
    const result = await shipmentLabelService.markPrinted({ shipmentId: req.params.id });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'LABEL_PRINTED', resourceType: 'shipment', resourceId: req.params.id, ipAddress: req.ip });
    ok(res, result);
  } catch (err) { next(err); }
}

export async function confirmShipmentPackage(req, res, next) {
  try {
    const body = v.packageBody.parse(req.body ?? {});
    const result = await shipmentPackageService.confirm({ shipmentId: req.params.id, ...body, staffUserId: req.staff.id });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'SHIPMENT_PACKAGE_CONFIRMED', resourceType: 'shipment', resourceId: req.params.id, metadata: { weightGrams: body.weightGrams }, ipAddress: req.ip });
    ok(res, result);
  } catch (err) { next(err); }
}

/**
 * MANIFEST_SHIPMENT — the single operator action that turns a packed parcel
 * into a real carrier shipment.
 *
 * It is three pre-existing backend steps, unchanged, run in the order they
 * must happen: confirm the packed package, create the shipment with the
 * carrier (which is where a REAL AWB comes from), then retrieve the label.
 * They stay separate services because they fail differently, and each is
 * already idempotent — a retry after a partial failure resumes rather than
 * duplicating.
 *
 * The shipping MODE is deliberately NOT a parameter. It comes from the
 * customer's checkout selection persisted on the order, and the manifest
 * consumes that choice rather than re-deciding it.
 */
export async function manifestShipment(req, res, next) {
  try {
    const body = v.manifestBody.parse(req.body ?? {});
    const shipmentId = req.params.id;
    const staffUserId = req.staff.id;

    const steps = [];
    // 1 — the physical package. Idempotent: re-confirming the same numbers is
    // a no-op, and it is refused outright once the shipment is booked.
    const existing = await orderOpsRepository.shipment(shipmentId);
    if (!existing) return next(Object.assign(new Error('Shipment not found.'), { code: 'SHIPMENT_NOT_FOUND', status: 404 }));
    if (existing.booking_status !== 'BOOKED') {
      await shipmentPackageService.confirm({
        shipmentId,
        weightGrams: body.weightGrams,
        lengthMm: body.lengthMm,
        widthMm: body.widthMm,
        heightMm: body.heightMm,
        staffUserId,
      });
      steps.push('PACKAGE_CONFIRMED');
      await audit.log({ staffUserId, actorEmail: req.staff.email, action: 'SHIPMENT_PACKAGE_CONFIRMED', resourceType: 'shipment', resourceId: shipmentId, metadata: { weightGrams: body.weightGrams }, ipAddress: req.ip });
    }

    // 2 — the carrier. The only source of an AWB; nothing here fabricates one.
    const booking = await shipmentBookingService.book({
      shipmentId, idempotencyKey: body.idempotencyKey, staffUserId, simulate: null,
    });
    steps.push('BOOKED');
    await audit.log({ staffUserId, actorEmail: req.staff.email, action: 'SHIPMENT_BOOKED', resourceType: 'shipment', resourceId: shipmentId, metadata: { awbNumber: booking.shipment?.awbNumber ?? null }, ipAddress: req.ip });

    const bookedOrder = await orderOpsRepository.orderForShipment(shipmentId);
    if (bookedOrder) await documentService.renderPending(bookedOrder.id).catch(() => {});

    // 3 — the label. A label failure must NOT undo a real booking: the AWB
    // exists at the carrier either way, and the operator retries the label.
    let label = null;
    let labelError = null;
    try {
      label = await shipmentLabelService.fetchLabel({ shipmentId, staffUserId });
      if (label?.labelStatus === 'AVAILABLE') steps.push('LABEL_READY');
      await audit.log({ staffUserId, actorEmail: req.staff.email, action: label?.labelStatus === 'AVAILABLE' ? 'LABEL_FETCHED' : 'LABEL_FAILED', resourceType: 'shipment', resourceId: shipmentId, metadata: { source: label?.source ?? null }, ipAddress: req.ip });
    } catch (err) {
      labelError = { code: err.code || 'LABEL_FETCH_FAILED', message: err.message };
    }

    ok(res, {
      steps,
      shipment: booking.shipment,
      awbNumber: booking.shipment?.awbNumber ?? null,
      label: label ? { status: label.labelStatus, url: label.labelUrl ?? null } : null,
      labelError,
    });
  } catch (err) { next(err); }
}

export async function cancelShipmentAtProvider(req, res, next) {
  try {
    const body = v.cancelShipmentBody.parse(req.body ?? {});
    const result = await shipmentProviderCancellationService.cancel({
      shipmentId: req.params.id, reason: body.reason ?? null, actor: actorOf(req),
      // Recovery for the shipments stranded by the bug above: locally
      // CANCELLED, never cancelled at the carrier, so the waybill is live and
      // the courier will still turn up. The service only acts on that when the
      // provider has not already been told.
      allowLocallyCancelled: true,
    });
    await audit.log({
      staffUserId: req.staff.id, actorEmail: req.staff.email,
      action: result.alreadyCancelled ? 'PROVIDER_CANCEL_NOOP' : 'PROVIDER_CANCELLED',
      resourceType: 'shipment', resourceId: req.params.id, metadata: { reason: body.reason ?? null }, ipAddress: req.ip,
    });
    ok(res, result);
  } catch (err) { next(err); }
}

// Phase 2 · Slice 13 — pull the carrier's tracking + reconcile local state.
// For a BOOKING_UNKNOWN shipment this resolves whether the create landed.
export async function reconcileShipmentTracking(req, res, next) {
  try {
    const result = await trackReconciliationService.reconcileShipment(req.params.id, {
      trigger: 'MANUAL', actor: actorOf(req),
    });
    await audit.log({
      staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'SHIPMENT_RECONCILED',
      resourceType: 'shipment', resourceId: req.params.id, metadata: { outcome: result.outcome }, ipAddress: req.ip,
    });
    ok(res, result);
  } catch (err) { next(err); }
}

// Phase 2 · Slice 18 — NDR (failed delivery attempt) actions.
export async function getShipmentNdr(req, res, next) {
  try {
    ok(res, await ndrService.contextForShipment(req.params.id));
  } catch (err) { next(err); }
}

export async function submitShipmentNdrAction(req, res, next) {
  try {
    const body = v.ndrActionBody.parse(req.body ?? {});
    const result = await ndrService.submitAction({
      shipmentId: req.params.id, action: body.action, instructions: body.instructions ?? null, staffUserId: req.staff.id,
    });
    await audit.log({
      staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'NDR_ACTION_SUBMITTED',
      resourceType: 'shipment', resourceId: req.params.id, metadata: { ndrAction: body.action, status: result.status }, ipAddress: req.ip,
    });
    ok(res, result);
  } catch (err) { next(err); }
}

export async function refreshNdrAction(req, res, next) {
  try {
    ok(res, await ndrService.refreshAction(req.params.actionId));
  } catch (err) { next(err); }
}

// Phase 2 · Slice 17 — carrier documents (EPOD / QC / Sorter).
export async function listShipmentCarrierDocuments(req, res, next) {
  try {
    ok(res, { documents: await carrierDocumentService.listForShipment(req.params.id) });
  } catch (err) { next(err); }
}

export async function fetchShipmentCarrierDocument(req, res, next) {
  try {
    const body = v.carrierDocumentFetchBody.parse(req.body ?? {});
    const result = await carrierDocumentService.fetchFromProvider({ shipmentId: req.params.id, docType: body.docType });
    await audit.log({
      staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'CARRIER_DOCUMENT_FETCHED',
      resourceType: 'shipment', resourceId: req.params.id, metadata: { docType: body.docType, available: result.available }, ipAddress: req.ip,
    });
    ok(res, result);
  } catch (err) { next(err); }
}

export async function streamCarrierDocument(req, res, next) {
  try {
    const result = await carrierDocumentService.content(req.params.id);
    if (result.redirect) return res.redirect(302, result.redirect);
    res.set('Content-Type', result.contentType);
    res.set('Content-Disposition', `inline; filename="${result.filename}"`);
    res.send(result.bytes);
  } catch (err) { next(err); }
}

export async function requestShipmentPickup(req, res, next) {
  try {
    const body = v.readyForPickupBody.parse(req.body ?? {});
    const shipment = await orderOpsRepository.shipment(req.params.id);
    if (!shipment) return next(Object.assign(new Error('Shipment not found.'), { code: 'SHIPMENT_NOT_FOUND', status: 404 }));
    // The operator asserting "label printed and attached" is the real print
    // event. Recording it here keeps the audit fact that "Mark printed" used
    // to carry, without a button whose only job was to unlock the next one.
    if (body.labelPrinted && !shipment.label_printed_at) {
      await shipmentLabelService.markPrinted({ shipmentId: shipment.id }).catch(() => {});
      await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'LABEL_PRINTED', resourceType: 'shipment', resourceId: shipment.id, ipAddress: req.ip });
    }
    // Per-parcel "this one is ready", which joins the warehouse's open pickup
    // request for the day rather than failing once one exists. Raising the
    // day's request outright remains available via requestForWarehouse.
    const result = await warehousePickupService.readyForPickup({
      shipmentId: shipment.id,
      pickupDate: body.pickupDate,
      pickupTime: body.pickupTime,
      staffUserId: req.staff.id,
    });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'PICKUP_REQUESTED', resourceType: 'warehouse', resourceId: shipment.warehouse_id, metadata: { mode: result.mode, shipmentsCovered: result.shipmentsCovered ?? 0 }, ipAddress: req.ip });

    // The customer is told AFTER the authoritative transition is persisted —
    // never from the button click. "Ready for shipment", not "shipped": the
    // carrier has not touched the parcel yet.
    if (!result.alreadyReady) {
      const orderRow = await orderOpsRepository.orderForShipment(shipment.id);
      if (orderRow?.customer_id) {
        await notificationService.emit('ORDER_READY_FOR_SHIPMENT', {
          customerId: orderRow.customer_id,
          orderId: orderRow.id,
          orderNumber: orderRow.order_number,
          shipmentId: shipment.id,
          // The order's own checkout contact — without it this message only
          // reaches customers who happen to have a verified profile phone.
          shippingAddressSnapshot: orderRow.shipping_address_snapshot,
        }).catch(() => {});
      }
    }
    ok(res, result);
  } catch (err) { next(err); }
}
