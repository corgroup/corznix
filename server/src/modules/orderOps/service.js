import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { fulfillmentService } from '../fulfillment/service.js';
import { notificationService } from '../notifications/service.js';
import { orderContactFrom } from '../notifications/recipients.js';
import { staffNotificationService } from '../staffNotifications/service.js';
import { shippingService } from '../shipping/service.js';
import { warehouseResolver } from '../shipping/warehouseResolver.js';
import { documentService } from '../documents/service.js';
import { invoiceService } from '../documents/service.js';
import { assertShipmentBookable, classifyTransition, SHIPMENT_STATUS } from '../shipping/shipmentLifecycle.js';
import { compactAddressLine } from '../shipping/providers/delhiveryManifest.js';
import { orderOpsRepository } from './repository.js';

const log = logger('order-ops');
const sha256 = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const parse = (value) => (value == null ? null : typeof value === 'string' ? JSON.parse(value) : value);

/** Canonical fingerprint of an order's confirmed allocation — matches allocationItemsFingerprint. */
function fingerprintLines(lines) {
  const sorted = lines
    .map((l) => [l.warehouse_id, l.sku_id, Number(l.quantity)])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return sha256(sorted);
}

const orderDto = (o, fingerprint) => ({
  id: o.id,
  orderNumber: o.order_number,
  status: o.order_status,
  paymentStatus: o.payment_status,
  paymentMode: o.payment_mode,
  totalMinor: Number(o.total_minor),
  codDueMinor: Number(o.cod_due_minor),
  confirmedAt: o.confirmed_at,
  confirmedByStaffId: o.confirmed_by_staff_id,
  processingStartedAt: o.processing_started_at,
  allocationFingerprint: fingerprint ?? o.allocation_fingerprint,
});

export class OrderConfirmationService {
  constructor({ repository = orderOpsRepository, fulfillment = fulfillmentService } = {}) {
    this.repository = repository;
    this.fulfillment = fulfillment;
  }

  async currentFingerprint(orderId, connection = null) {
    const lines = await this.repository.reservationLines(connection, orderId);
    return fingerprintLines(lines);
  }

  async confirm({ orderId, expectedAllocationFingerprint = null, staffUserId = null }) {
    let notifyContext = null;
    let allocatedWarehouses = []; // [{ id, name }] — for the store-manager notification
    let invoiceOutcome = null;    // { blocked, taxStatus, missing } when tax config is incomplete
    const result = await withTransaction(async (connection) => {
      const order = await this.repository.lockOrder(connection, orderId);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
      // WP-05 — captured before any branch so an idempotent re-confirm still
      // (deduped) re-attempts a notification that a prior crash may have lost.
      // The shipping snapshot carries the phone/email the customer typed at
      // checkout. Without it resolveRecipient can only fall back to a VERIFIED
      // profile contact, so a customer who signed in with Google (email
      // verified, phone never verified) silently got no WhatsApp here while
      // PAYMENT_SUCCESSFUL — which does pass the snapshot — reached them.
      notifyContext = {
        customerId: order.customer_id,
        orderId: order.id,
        orderNumber: order.order_number,
        shippingAddressSnapshot: order.shipping_address_snapshot,
        // The order_management template has five slots; orderNumber alone left
        // four of them blank at Meta. Name comes from the same snapshot the
        // recipient is resolved from, the date from the quote's transit
        // estimate. Each has a fallback in the policy.
        customerName: orderContactFrom(order.shipping_address_snapshot)?.name || null,
        itemsSummary: await this.repository.itemsSummary(connection, order.id),
        shippingSnapshot: order.shipping_snapshot,
      };
      const fingerprint = await this.currentFingerprint(order.id, connection);

      if (order.order_status === 'CONFIRMED') {
        if (order.allocation_fingerprint === fingerprint
          && (!expectedAllocationFingerprint || expectedAllocationFingerprint === fingerprint)) {
          return orderDto(order, fingerprint);
        }
        throw new AppError('ORDER_ALREADY_CONFIRMED', 'This order has already been confirmed.', 409);
      }
      if (order.order_status !== 'PLACED') {
        throw new AppError('ORDER_NOT_CONFIRMABLE', `An order in ${order.order_status} cannot be confirmed.`, 409);
      }
      if (expectedAllocationFingerprint && expectedAllocationFingerprint !== fingerprint) {
        throw new AppError('ALLOCATION_CHANGED', 'The warehouse allocation has changed. Refresh the order before confirming.', 409);
      }

      // Guarantee the warehouse-scoped fulfillments exist for the confirmed split.
      const built = await this.fulfillment.ensureForOrder(order.id, { connection });
      const seen = new Set();
      for (const f of built.fulfillments || []) {
        if (f.warehouseId && !seen.has(f.warehouseId)) {
          seen.add(f.warehouseId);
          allocatedWarehouses.push({ id: f.warehouseId, name: f.warehouse?.name || f.warehouse?.code || 'warehouse' });
        }
      }

      await this.repository.setOrderStatus(connection, order.id, 'CONFIRMED', {
        confirmed_at: new Date(),
        confirmed_by_staff_id: staffUserId,
        allocation_fingerprint: fingerprint,
      });

      // Issue the immutable invoice + one packing slip per fulfilment. Pure DB
      // snapshots — safe inside the confirm transaction.
      //
      // issueForOrder does NOT throw when tax configuration is incomplete: it
      // returns { blocked: true } and writes no invoice row, by design — a GST
      // invoice with a guessed HSN is worse than none. But the result was
      // discarded here, so the order confirmed with no invoice and nobody was
      // told. The customer then gets "Your invoice is being prepared" forever,
      // and staff only discover why if they happen to open that order's detail
      // page. Captured now and reported after the transaction commits.
      invoiceOutcome = await invoiceService.issueForOrder(order.id, { connection });
      for (const f of built.fulfillments || []) {
        await documentService.ensurePackingSlip(connection, f.id);
      }
      return orderDto({ ...order, order_status: 'CONFIRMED', confirmed_at: new Date(), confirmed_by_staff_id: staffUserId }, fingerprint);
    });
    if (notifyContext) await notificationService.emit('ORDER_CONFIRMED', notifyContext).catch(() => {});
    // Business rule (2026-09-04): the ONLY automation is warehouse allocation +
    // this notification. Tell each allocated warehouse's staff to process the
    // order manually — no auto shipment booking / pickup / ready-to-* follows.
    for (const wh of allocatedWarehouses) {
      await staffNotificationService.record({
        category: 'ORDER', eventKey: 'ORDER_ALLOCATED', severity: 'INFO',
        title: `New order ${notifyContext?.orderNumber || ''} — allocated to ${wh.name}`.trim(),
        body: `Order ${notifyContext?.orderNumber || ''} has been allocated to your warehouse. Please process the order manually.`.trim(),
        link: `/orders/${notifyContext?.orderId}`,
        entityType: 'order', entityId: notifyContext?.orderId,
        warehouseId: wh.id,
        dedupeKey: `order_allocated:${notifyContext?.orderId}:${wh.id}`,
      }).catch(() => {});
    }

    // Render the invoice + packing-slip PDFs. This lived ONLY in the HTTP
    // controller, so any other caller of confirm() left the documents at
    // PENDING_RENDER forever — and getCustomerInvoice refuses anything that is
    // not READY, so the customer saw "Your invoice is being prepared" with no
    // trace of why. Idempotent (a READY document is returned unchanged), never
    // fatal to an already-valid CONFIRMED order, and no longer silent.
    if (!invoiceOutcome?.blocked) {
      try {
        await documentService.renderPending(result.id);
      } catch (error) {
        log.error('invoice_render_failed', {
          orderId: result.id, orderNumber: notifyContext?.orderNumber, code: error?.code || null, error: error?.message,
        });
      }
    }

    // No invoice was written. The order is confirmed and shippable, but the
    // customer's Download Invoice will answer "being prepared" until a tax
    // profile covers every product on it — and only a person can decide the
    // HSN/GST for a product, so this is raised rather than guessed.
    if (invoiceOutcome?.blocked) {
      const missing = invoiceOutcome.missing || [];
      const names = missing.map((m) => `${m.productName || m.sku} (${m.reason})`).join(', ');
      log.warn('invoice_issuance_blocked', {
        orderId: notifyContext?.orderId, orderNumber: notifyContext?.orderNumber,
        taxStatus: invoiceOutcome.taxStatus, missing: missing.length,
      });
      await staffNotificationService.record({
        category: 'ORDER', eventKey: 'INVOICE_BLOCKED', severity: 'WARNING',
        title: `No invoice for ${notifyContext?.orderNumber || 'order'} — tax configuration is ${String(invoiceOutcome.taxStatus || 'INCOMPLETE').toLowerCase()}`,
        body: missing.length
          ? `The customer cannot download an invoice for this order. Assign a tax profile (HSN + GST rate) to: ${names}.`
          : `The customer cannot download an invoice for this order. Tax configuration is ${invoiceOutcome.taxStatus}.`,
        link: `/orders/${notifyContext?.orderId}`,
        entityType: 'order', entityId: notifyContext?.orderId,
        dedupeKey: `invoice_blocked:${notifyContext?.orderId}`,
      }).catch(() => {});
    }
    return result;
  }

  async startProcessing({ orderId, staffUserId = null }) {
    const { dto, notify } = await withTransaction(async (connection) => {
      const order = await this.repository.lockOrder(connection, orderId);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
      // Idempotent: a second click is not a second customer message.
      if (order.order_status === 'PROCESSING') return { dto: orderDto(order), notify: null };
      if (order.order_status !== 'CONFIRMED') {
        throw new AppError('ORDER_NOT_PROCESSABLE', `An order in ${order.order_status} cannot start processing.`, 409);
      }
      await this.repository.setOrderStatus(connection, order.id, 'PROCESSING', { processing_started_at: new Date() });
      return {
        dto: orderDto({ ...order, order_status: 'PROCESSING', processing_started_at: new Date() }),
        // shippingAddressSnapshot: the order's own checkout contact — see the
        // note in confirm(). Omitting it is why this message never arrived for
        // customers with no verified profile phone.
        notify: order.customer_id
          ? {
            customerId: order.customer_id,
            orderId: order.id,
            orderNumber: order.order_number,
            shippingAddressSnapshot: order.shipping_address_snapshot,
          }
          : null,
      };
    });

    // AFTER the transition is committed, never from the button click, and
    // never inside the transaction: a notification failure must not roll back
    // a real state change.
    if (notify) await notificationService.emit('ORDER_PROCESSING', notify).catch(() => {});
    return dto;
  }
}

// Kept for an explicit operator "Run automation" click only — the system
// never calls this on its own (business rule 2026-09-04: automation stops at
// warehouse allocation). Imported lazily to avoid a circular import.
export async function triggerAutoFulfillment(orderId, trigger = 'ORDER_PROCESSING') {
  try {
    const { autoFulfillmentService } = await import('../shipping/autoFulfillmentService.js');
    return await autoFulfillmentService.queueForOrder(orderId, { trigger });
  } catch (err) {
    // Automation is a convenience layer — never fail order processing over it.
    return { error: err?.code || err?.message || 'AUTO_FULFILLMENT_TRIGGER_FAILED' };
  }
}

/**
 * The seller address as printed on the parcel: the GST-registered address from
 * the invoice's own supplier snapshot, with the GSTIN, so the label and the tax
 * invoice agree. Null when no company profile was captured — the caller then
 * falls back to the warehouse address rather than printing a half-address.
 */
function sellerAddressLine(supplier) {
  const a = supplier?.address;
  if (!a) return null;
  const parts = [
    a.addressLine1, a.addressLine2,
    [a.city, [a.state, a.postalCode].filter(Boolean).join(' ')].filter(Boolean).join(', '),
  ].filter(Boolean);
  if (!parts.length) return null;
  // Registered addresses are typed by hand and repeat themselves — the live
  // profile reads "Parasupur, Parasupur, Parsu Pur … Parsu Pur". The label has
  // room to wrap, but not to say the same village three times.
  const line = compactAddressLine(parts.join(', '), 160);
  const gstin = supplier.gstin ? `GSTIN: ${supplier.gstin}` : null;
  return [line, gstin].filter(Boolean).join(' · ');
}

const shipmentDto = (s) => ({
  id: s.id,
  shipmentNumber: s.shipment_number,
  status: s.status,
  bookingStatus: s.booking_status,
  providerCode: s.provider_code,
  providerShipmentId: s.external_shipment_id,
  awbNumber: s.tracking_number,
  trackingUrl: s.tracking_url,
  codCollectionMinor: Number(s.cod_collection_minor),
  bookedAt: s.booked_at,
  lastProviderStatus: s.last_provider_status,
  lastEventAt: s.last_event_at,
});

export class ShipmentBookingService {
  constructor({ repository = orderOpsRepository, shipping = shippingService } = {}) {
    this.repository = repository;
    this.shipping = shipping;
  }

  async #buildRequest(shipment, order, simulate, providerCode) {
    const warehouse = parse(shipment.warehouse_snapshot_json) || {};
    const destination = parse(shipment.shipping_address_snapshot_json) || {};
    const pkg = parse(shipment.package_snapshot_json) || {};
    const shippingSnap = parse(order.shipping_snapshot) || {};
    const warehouseId = warehouse.warehouseId || warehouse.id || shipment.warehouse_id;

    // Phase 2 §35 — the provider's registered pickup-location name. For MOCK
    // this is informational; for a real carrier a missing mapping BLOCKS the
    // booking here, before any provider call — never guessed.
    let pickupLocationName = null;
    let origin = { warehouseId, name: warehouse.name || null, address: warehouse.address_line1 || warehouse.address || null };
    if (warehouseId) {
      try {
        const resolved = await warehouseResolver.resolveOrigin({ warehouseId });
        origin = {
          warehouseId,
          name: resolved.name,
          address: [resolved.addressLine1, resolved.addressLine2].filter(Boolean).join(', ') || null,
          city: resolved.city,
          state: resolved.state,
          postalCode: resolved.postalCode,
          phone: resolved.contactPhone,
        };
      } catch { /* fall through with the snapshot origin */ }
      const loc = providerCode && providerCode !== 'MOCK'
        ? await warehouseResolver.providerLocation(warehouseId, providerCode)
        : null;
      pickupLocationName = loc?.identifier || null;
    }

    if (providerCode && providerCode !== 'MOCK' && !pickupLocationName) {
      throw new AppError(
        'WAREHOUSE_NOT_REGISTERED_WITH_PROVIDER',
        `The origin warehouse has no registered ${providerCode} pickup location. Map it in Warehouses → Carriers before booking.`,
        409,
      );
    }

    // What the carrier prints on the label. These are documented manifest
    // fields that were simply never populated — `products_desc` was the
    // literal string "Apparel", and quantity / hsn_code / seller_inv went
    // empty — which is why our labels read as a generic parcel while the same
    // shipment created in Delhivery's own panel showed product, SKU and
    // invoice. All of it comes from the ORDER-ITEM SNAPSHOT and the issued
    // invoice, never the live catalogue: what was sold, not what the product
    // happens to be called today.
    const facts = await this.repository.labelFactsForOrder(order.id).catch(() => null);
    const lines = facts?.items || [];
    const productsDesc = lines.length
      ? lines
        .map((i) => [
          i.product_name,
          [i.selected_color, i.selected_size].filter(Boolean).join(' / '),
          i.sku ? `SKU:${i.sku}` : null,
        ].filter(Boolean).join(' — '))
        .join(' | ')
        .slice(0, 250) // provider field is not unbounded; keep the head, which carries the identity
      : 'Apparel';
    const totalUnits = lines.reduce((n, i) => n + Number(i.quantity || 0), 0);
    // The legal supplier identity as invoiced — not the warehouse's display
    // name, which is what used to appear as the seller.
    const supplier = facts?.invoice?.supplier_snapshot_json
      ? (typeof facts.invoice.supplier_snapshot_json === 'string'
        ? JSON.parse(facts.invoice.supplier_snapshot_json)
        : facts.invoice.supplier_snapshot_json)
      : null;

    return {
      clientReference: shipment.shipment_number,
      orderReference: order.order_number,
      providerCode: providerCode || null,
      simulate: simulate || null,
      pickupLocationName,
      serviceLevel: shippingSnap.serviceLevel === 'EXPRESS' ? 'EXPRESS' : 'STANDARD',
      productsDesc,
      quantity: totalUnits > 0 ? totalUnits : null,
      hsnCode: facts?.hsnSac || null,
      sellerInvoice: facts?.invoice?.invoice_number || null,
      sellerLegalName: supplier?.legalName || supplier?.name || null,
      // The same registered address and GSTIN the tax invoice carries, so the
      // parcel and the invoice name one seller, not two.
      sellerAddress: sellerAddressLine(supplier),
      origin,
      destination: {
        name: [destination.firstName, destination.lastName].filter(Boolean).join(' ') || null,
        phone: destination.phone || null,
        address: [destination.addressLine1, destination.addressLine2].filter(Boolean).join(', ') || null,
        city: destination.city || null,
        state: destination.state || null,
        postalCode: destination.postalCode || null,
        country: destination.country || 'India',
      },
      package: {
        weightGrams: pkg.weightGrams ?? null,
        lengthMm: pkg.lengthMm ?? null,
        widthMm: pkg.widthMm ?? pkg.breadthMm ?? null,
        heightMm: pkg.heightMm ?? null,
      },
      payment: {
        mode: order.payment_mode === 'PREPAID' ? 'PREPAID' : 'COD',
        codCollectionMinor: Number(shipment.cod_collection_minor),
        orderValueMinor: Number(order.total_minor ?? 0),
      },
    };
  }

  async book({ shipmentId, idempotencyKey, staffUserId = null, simulate = null }) {
    if (!idempotencyKey || String(idempotencyKey).length > 120) {
      throw new AppError('VALIDATION_ERROR', 'A valid idempotency key is required.', 400);
    }
    void staffUserId;

    // Phase 1 — persist booking intent. Any provider identity that already
    // exists is a completed booking; an UNKNOWN attempt blocks retries.
    const intent = await withTransaction(async (connection) => {
      const shipment = await this.repository.lockShipment(connection, shipmentId);
      if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
      const order = await this.repository.orderForShipment(shipmentId);
      if (!order || order.order_status !== 'PROCESSING') {
        throw new AppError('ORDER_NOT_PROCESSING', 'The order must be in PROCESSING before a shipment can be booked.', 409);
      }
      if (shipment.booking_status === 'BOOKED') return { done: shipmentDto(shipment) };

      // Phase 2 §32 — pick the provider for this NEW shipment (MOCK mode ⇒ MOCK,
      // REAL ⇒ the configured default; a 503 here is surfaced, never a fallback).
      const providerCode = shipment.provider_code
        || await this.shipping.resolver.resolveForNewShipment({
          destinationPostalCode: (parse(shipment.shipping_address_snapshot_json) || {}).postalCode || null,
        });
      const request = await this.#buildRequest(shipment, order, simulate, providerCode);
      const requestHash = sha256(request);
      const existing = await this.repository.attemptByKey(connection, idempotencyKey);
      if (existing) {
        if (existing.request_hash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was used for a different booking.', 409);
        if (existing.status === 'SUCCEEDED') return { done: shipmentDto(shipment) };
        if (existing.status === 'UNKNOWN') return { reconcile: true };
        if (existing.status === 'PENDING') throw new AppError('BOOKING_IN_PROGRESS', 'A booking for this shipment is already in progress.', 409);
        await this.repository.completeAttempt(connection, existing.id, { status: 'PENDING' }); // FAILED -> retry
      }
      assertShipmentBookable(shipment);
      const attempt = existing || await this.repository.createAttempt(connection, { shipmentId, providerCode, idempotencyKey, requestHash });
      return { attemptId: attempt.id, request };
    });

    if (intent.done) return { shipment: intent.done, realProviderCallPerformed: false };
    if (intent.reconcile) throw new AppError('BOOKING_RECONCILIATION_REQUIRED', 'A previous booking attempt had an unknown outcome and must be reconciled with the provider.', 409);

    // Phase 2 — provider call, outside any transaction (no DB locks held).
    let result = null;
    let failure = null;
    try { result = await this.shipping.bookShipment(intent.request); } catch (error) { failure = error; }

    // Phase 3 — persist the outcome and COMMIT it, then signal a failure.
    const outcome = await withTransaction(async (connection) => {
      if (result) {
        await this.repository.completeAttempt(connection, intent.attemptId, {
          status: 'SUCCEEDED', providerShipmentId: result.providerShipmentId, trackingNumber: result.awbNumber, response: result,
        });
        await this.repository.updateShipment(connection, shipmentId, {
          provider_code: result.providerCode, external_shipment_id: result.providerShipmentId,
          tracking_number: result.awbNumber, tracking_url: result.trackingUrl || null,
          booking_status: 'BOOKED', status: 'BOOKED', booking_idempotency_key: idempotencyKey,
          booked_at: new Date(), last_provider_status: result.status, last_event_at: new Date(),
        });
        await this.repository.insertEvent(connection, {
          shipmentId, providerCode: result.providerCode, providerEventKey: `${result.providerShipmentId}:BOOKED`,
          providerStatus: result.status, normalizedStatus: 'BOOKED', occurredAt: new Date(), applied: true,
        });
        await documentService.ensureShippingLabel(connection, shipmentId);
        return { shipment: shipmentDto(await this.repository.lockShipment(connection, shipmentId)) };
      }
      if (failure?.ambiguous) {
        await this.repository.completeAttempt(connection, intent.attemptId, {
          status: 'UNKNOWN', providerShipmentId: failure.providerShipmentId || null,
          trackingNumber: failure.awbNumber || null, failureCode: failure.message,
        });
        await this.repository.updateShipment(connection, shipmentId, { booking_status: 'UNKNOWN' });
        return { reconcile: true };
      }
      await this.repository.completeAttempt(connection, intent.attemptId, { status: 'FAILED', failureCode: failure?.code || failure?.message || 'PROVIDER_ERROR' });
      await this.repository.updateShipment(connection, shipmentId, { booking_status: 'FAILED' });
      return { failed: true };
    });

    if (outcome.reconcile) throw new AppError('BOOKING_RECONCILIATION_REQUIRED', 'The booking outcome is unknown — the provider may have created the shipment. Reconcile before retrying.', 409);
    if (outcome.failed) throw new AppError('SHIPPING_PROVIDER_ERROR', 'The shipping provider could not book this shipment.', 502);
    return { shipment: outcome.shipment, realProviderCallPerformed: false };
  }
}

const TIMESTAMP_FOR = { PICKED_UP: 'shipped_at', IN_TRANSIT: 'shipped_at', DELIVERED: 'delivered_at', CANCELLED: 'cancelled_at', RTO_RETURNED: 'cancelled_at' };

export class ShipmentEventService {
  constructor({ repository = orderOpsRepository } = {}) {
    this.repository = repository;
  }

  async ingest(event) {
    const {
      shipmentId, providerCode, providerEventKey, providerStatus = null,
      statusType = null, nslCode = null,
      normalizedStatus, occurredAt, locationText = null, remarks = null, source = 'MOCK',
    } = event;
    if (!SHIPMENT_STATUS.includes(normalizedStatus)) {
      throw new AppError('INVALID_TRACKING_EVENT', `Unknown normalized status "${normalizedStatus}".`, 422);
    }
    if (!providerEventKey || !occurredAt) throw new AppError('INVALID_TRACKING_EVENT', 'providerEventKey and occurredAt are required.', 422);

    return withTransaction(async (connection) => {
      const shipment = await this.repository.lockShipment(connection, shipmentId);
      if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);

      if (await this.repository.eventByKey(connection, providerCode, providerEventKey)) {
        return { deduped: true, applied: false, status: shipment.status };
      }

      const decision = classifyTransition(shipment.status, normalizedStatus);
      if (decision === 'invalid') {
        throw new AppError('INVALID_SHIPMENT_TRANSITION', `Shipment cannot move from ${shipment.status} to ${normalizedStatus}.`, 409);
      }

      const occurred = new Date(occurredAt);
      try {
        await this.repository.insertEvent(connection, {
          shipmentId, source, providerCode, providerEventKey, providerStatus, statusType, nslCode,
          normalizedStatus, occurredAt: occurred, locationText, remarks, applied: decision === 'apply',
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return { deduped: true, applied: false, status: shipment.status };
        throw err;
      }

      if (decision === 'stale') return { deduped: false, applied: false, reason: 'STALE', status: shipment.status };

      const fields = { status: normalizedStatus, last_provider_status: providerStatus || normalizedStatus, last_event_at: occurred };
      const tsColumn = TIMESTAMP_FOR[normalizedStatus];
      if (tsColumn) fields[tsColumn] = occurred;
      await this.repository.updateShipment(connection, shipmentId, fields);
      return { deduped: false, applied: true, status: normalizedStatus };
    });
  }
}

// Phase 2 · Slice 11 — real shipping label. The label is provider-hosted (a
// Delhivery S3 URL); for MOCK the adapter returns a RENDERED sentinel and we
// fall back to the locally-rendered PDF. A label can never be produced before
// the AWB exists (booking_status = BOOKED).
export class ShipmentLabelService {
  constructor({ repository = orderOpsRepository, shipping = shippingService, documents = documentService } = {}) {
    this.repository = repository;
    this.shipping = shipping;
    this.documents = documents;
  }

  async fetchLabel({ shipmentId, size = '4R', staffUserId = null }) {
    void staffUserId;
    const shipment = await this.repository.shipment(shipmentId);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
    if (shipment.booking_status !== 'BOOKED' || !shipment.tracking_number) {
      throw new AppError('SHIPMENT_NOT_BOOKED', 'A label needs a booked shipment with an AWB.', 409);
    }

    await withTransaction((c) => this.repository.updateShipment(c, shipmentId, { label_status: 'PENDING' }));
    try {
      // ShippingService itself has no getLabel wrapper (unlike bookShipment) —
      // this is the direct orchestrator passthrough, the same pattern
      // shipmentCancellationService already uses for cancelShipment. Calling
      // this.shipping.getLabel() instead of this.shipping.orchestrator.getLabel()
      // silently threw "not a function" on every real fetch, caught by the
      // catch block below and reported as a generic LABEL_FETCH_FAILED — so
      // no label has ever actually been fetched through this path.
      const result = await this.shipping.orchestrator.getLabel({
        awb: shipment.tracking_number,
        providerCode: shipment.provider_code,
        size,
      });
      if (result.format === 'RENDERED' || !result.url) {
        // MOCK / CORCOTTON-rendered path — reuse the existing document artefact.
        const doc = await this.documents.ensureShippingLabel(null, shipmentId);
        await this.documents.render(doc.id).catch(() => {});
        await withTransaction((c) => this.repository.updateShipment(c, shipmentId, {
          label_status: 'AVAILABLE', label_fetched_at: new Date(),
        }));
        return { shipmentId, labelStatus: 'AVAILABLE', source: 'CORCOTTON_RENDERED', url: null, documentId: doc.id };
      }
      await withTransaction((c) => this.repository.updateShipment(c, shipmentId, {
        label_url: result.url, label_status: 'AVAILABLE', label_fetched_at: new Date(),
      }));
      return { shipmentId, labelStatus: 'AVAILABLE', source: 'PROVIDER', url: result.url, size: result.size };
    } catch (error) {
      await withTransaction((c) => this.repository.updateShipment(c, shipmentId, { label_status: 'FAILED' }));
      // Logged with the real message, not just providerReason — a wiring bug
      // (calling a method that doesn't exist) throws a plain Error with no
      // providerReason, and previously vanished into a generic 502 forever.
      log.error('label_fetch_failed', { shipmentId, error: error?.message, providerReason: error?.providerReason || null });
      // The shipment stays BOOKED — a label failure never creates another AWB (§16).
      throw new AppError('LABEL_FETCH_FAILED', 'The shipping label could not be retrieved. The shipment is still booked — retry the label.', 502, { providerReason: error?.providerReason || null });
    }
  }

  async markPrinted({ shipmentId }) {
    const shipment = await this.repository.shipment(shipmentId);
    if (!shipment) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
    if (shipment.label_status !== 'AVAILABLE') {
      throw new AppError('LABEL_NOT_AVAILABLE', 'Generate the shipping label before marking it printed.', 409);
    }
    if (!shipment.label_printed_at) {
      await withTransaction((c) => this.repository.updateShipment(c, shipmentId, { label_printed_at: new Date() }));
    }
    return { shipmentId, labelPrintedAt: (shipment.label_printed_at || new Date()) };
  }
}

export const orderConfirmationService = new OrderConfirmationService();
export const shipmentBookingService = new ShipmentBookingService();
export const shipmentEventService = new ShipmentEventService();
export const shipmentLabelService = new ShipmentLabelService();
