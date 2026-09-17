import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { fulfillmentRepository as shippingMetadataRepository } from '../shipping/fulfillmentRepository.js';
import { warehouseSnapshot } from '../warehouses/service.js';
import { fulfillmentRepository } from './repository.js';
import { buildPackageSnapshot, evaluateReadiness, READINESS } from './readiness.js';
import { assertTransition, nextOperatorStatus } from './transitions.js';
import { carrierTrackingUrl } from '../logistics/carrierTracking.js';

const parse = (value) => (typeof value === 'string' ? JSON.parse(value) : value);
const num = (value) => (value == null ? null : Number(value));

const orderCodMinor = (order) =>
  order.payment_mode === 'PREPAID' ? 0 : Number(order.cod_due_minor);

/**
 * Split an integer minor-unit total across N buckets by weight, remainder to
 * the earliest (priority-ordered) buckets. Guarantees the parts sum to `total`
 * exactly — the split-COD invariant SUM(shipment.cod) = orders.cod_due_minor.
 */
const splitMinorByWeight = (total, weights) => {
  const sum = weights.reduce((acc, value) => acc + value, 0);
  if (total <= 0) return weights.map(() => 0);
  if (sum <= 0) return weights.map((_, index) => (index === 0 ? total : 0));
  const parts = weights.map((weight) => Math.floor((total * weight) / sum));
  let remainder = total - parts.reduce((acc, value) => acc + value, 0);
  for (let index = 0; index < parts.length && remainder > 0; index += 1, remainder -= 1) parts[index] += 1;
  return parts;
};

const financialSnapshot = (order, codCollectionMinor = orderCodMinor(order)) => ({
  currency: order.currency,
  paymentMode: order.payment_mode,
  orderTotalMinor: Number(order.total_minor),
  onlinePaidMinor: Number(order.online_paid_minor),
  codDueMinor: Number(order.cod_due_minor),
  // This fulfillment's share of the order's COD collection (splits across
  // warehouses sum back to orders.cod_due_minor exactly).
  codCollectionMinor,
});

const log = (event, detail) => console.log(JSON.stringify({ scope: 'fulfillment', event, ...detail }));

/**
 * Wave 7A forward-fulfillment foundation.
 *
 * Boundaries this service must never cross:
 *  - it runs AFTER the Order finalization transaction has committed (§7);
 *  - it never mutates inventory, reservations, payments, or pricing (§18);
 *  - it never calls a logistics provider and never generates an AWB (§48).
 */
export class FulfillmentService {
  constructor({
    repository = fulfillmentRepository,
    metadata = shippingMetadataRepository,
    transaction = withTransaction,
  } = {}) {
    this.repository = repository;
    this.metadata = metadata;
    this.transaction = transaction;
  }

  /**
   * Idempotent, concurrency-safe bootstrap of the initial Fulfillment(s) for an
   * Order — one INITIAL fulfillment (+ its DRAFT Shipment) per origin warehouse.
   * The warehouse split is read from the Order's consumed reservation lines
   * (`inventory_reservation_items.warehouse_id`); a reservation with no itemised
   * lines falls back to the configured default warehouse. Works identically
   * for a 1-warehouse and an N-warehouse deployment.
   *
   * Safe to call any number of times / concurrently: the Order row lock
   * serializes callers and `uk_fulfillments_initial_order_warehouse` is the
   * hard backstop.
   *
   * Returns the primary (lowest-sequence) fulfillment DTO, augmented with
   * `warehouseId` and `fulfillments` (every INITIAL fulfillment DTO for the
   * Order — length 1 in a single-warehouse deployment).
   *
   * @param {string} orderId
   * @param {{ connection?: object }} [options]  pass a connection to compose
   *        inside an existing transaction (tests / batch tools only — the
   *        Order finalization path always calls this post-commit with none).
   */
  async ensureForOrder(orderId, { connection = null } = {}) {
    const run = async (tx) => {
      const order = await this.repository.lockOrder(tx, orderId);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);

      const existing = await this.repository.initialFulfillments(tx, orderId);
      if (existing.length) {
        // Recovery: fulfillments survived but a DRAFT shipment did not.
        for (const fulfillment of existing) await this.#ensureDraftShipment(tx, order, fulfillment);
        return this.#assemblePrimary(tx, existing);
      }

      const orderItems = await this.repository.orderItems(tx, orderId);
      const orderItemBySku = new Map(orderItems.map((item) => [item.sku_id, item]));
      const unitPriceBySku = new Map(orderItems.map((item) => [item.sku_id, Number(item.unit_price_minor)]));

      // Warehouse split = the consumed reservation's per-warehouse lines.
      let groups = await this.repository.reservationWarehouseGroups(tx, order.inventory_reservation_id);
      if (!groups.length) {
        const fallback = await this.repository.defaultWarehouse(tx);
        if (!fallback) throw new AppError('WAREHOUSE_NOT_CONFIGURED', 'No warehouse is configured.', 409);
        groups = [{
          warehouseId: fallback.id,
          warehouse: fallback,
          items: orderItems.map((item) => ({ skuId: item.sku_id, quantity: Number(item.quantity) })),
        }];
      }

      const cancelled = order.order_status === 'CANCELLED';
      const status = cancelled ? 'CANCELLED' : 'PENDING';

      // COD split across warehouses, weighted by each group's merchandise value,
      // summing back to orders.cod_due_minor exactly.
      const merchValues = groups.map((group) => group.items.reduce(
        (sum, line) => sum + (unitPriceBySku.get(line.skuId) || 0) * line.quantity, 0,
      ));
      const codShares = splitMinorByWeight(cancelled ? 0 : orderCodMinor(order), merchValues);

      const shippingAddress = parse(order.shipping_address_snapshot);
      const shippingMethod = parse(order.shipping_snapshot);
      const created = [];

      for (const [index, group] of groups.entries()) {
        const allocations = group.items.map((line) => {
          const orderItem = orderItemBySku.get(line.skuId);
          if (!orderItem) {
            const error = new Error(`Reservation SKU ${line.skuId} is not an item on order ${orderId}.`);
            error.code = 'FULFILLMENT_ALLOCATION_MISMATCH';
            throw error;
          }
          return { orderItemId: orderItem.id, skuId: line.skuId, quantity: line.quantity };
        });

        const packageItems = await this.metadata.resolveItems(
          allocations.map((allocation) => ({ skuId: allocation.skuId, quantity: allocation.quantity })),
        );
        const { readinessStatus, blockReason } = evaluateReadiness({
          orderStatus: order.order_status,
          shippingAddress,
          allocations,
          packageItems,
        });

        const sequence = await this.repository.nextSequence(tx, orderId);
        let fulfillment;
        try {
          fulfillment = await this.repository.insertFulfillment(tx, {
            orderId,
            warehouseId: group.warehouseId,
            fulfillmentNumber: `FUL-${order.order_number}-${sequence}`,
            fulfillmentType: 'INITIAL',
            sequence,
            status,
            readinessStatus,
            blockReason,
            shippingAddressSnapshot: shippingAddress,
            shippingMethodSnapshot: shippingMethod,
            financialSnapshot: { ...financialSnapshot(order, codShares[index]), warehouseId: group.warehouseId },
            warehouseSnapshot: warehouseSnapshot(group.warehouse),
          });
        } catch (error) {
          if (error.code === 'ER_DUP_ENTRY') {
            // Another caller won the race for this Order — roll back and return
            // whatever it created.
            const raced = await this.repository.initialFulfillments(tx, orderId);
            if (raced.length) {
              for (const f of raced) await this.#ensureDraftShipment(tx, order, f);
              return this.#assemblePrimary(tx, raced);
            }
          }
          throw error;
        }

        await this.repository.insertItems(tx, fulfillment.id, allocations);
        await this.repository.assertAllocationWithinOrderedQuantity(tx, orderId);
        await this.repository.recordEvent(tx, fulfillment.id, {
          type: 'FULFILLMENT_CREATED',
          toStatus: status,
          detail: { warehouseId: group.warehouseId, readinessStatus, blockReason, allocations: allocations.length, sequence, codCollectionMinor: codShares[index] },
        });

        if (!cancelled) await this.#ensureDraftShipment(tx, order, fulfillment, packageItems);
        if (blockReason) log('readiness_blocked', { orderId, fulfillmentId: fulfillment.id, warehouseId: group.warehouseId, blockReason });
        created.push(fulfillment);
      }

      return this.#assemblePrimary(tx, created);
    };

    return connection ? run(connection) : this.#withDupRetry(() => this.transaction(run), orderId);
  }

  async #withDupRetry(operation, orderId) {
    try {
      return await operation();
    } catch (error) {
      if (error.code !== 'ER_DUP_ENTRY') throw error;
      return this.transaction(async (tx) => {
        const existing = await this.repository.initialFulfillments(tx, orderId);
        if (!existing.length) throw error;
        const order = await this.repository.lockOrder(tx, orderId);
        for (const fulfillment of existing) await this.#ensureDraftShipment(tx, order, fulfillment);
        return this.#assemblePrimary(tx, existing);
      });
    }
  }

  async #ensureDraftShipment(tx, order, fulfillment, packageItems = null) {
    if (fulfillment.status === 'CANCELLED') return;
    const shipments = await this.repository.shipments(tx, fulfillment.id);
    if (shipments.length) return;

    const items = packageItems
      || (await this.metadata.resolveItems(
        (await this.repository.items(tx, fulfillment.id)).map((row) => ({ skuId: row.sku_id, quantity: Number(row.quantity) })),
      ));
    const packageSnapshot = buildPackageSnapshot(items);
    const method = parse(order.shipping_snapshot) || {};
    const codCollectionMinor = Number(parse(fulfillment.financial_snapshot_json)?.codCollectionMinor ?? orderCodMinor(order));

    const shipment = await this.repository.insertShipment(tx, {
      fulfillmentId: fulfillment.id,
      warehouseId: fulfillment.warehouse_id,
      // One shipment per fulfillment in this foundation; the fulfillment
      // sequence keeps shipment numbers unique across a split Order.
      shipmentNumber: `SHP-${order.order_number}-${fulfillment.sequence}`,
      sequence: 1,
      status: 'DRAFT',
      // NOT_READY / READY only — never READY_TO_BOOK in the Wave 7A foundation (§32).
      bookingStatus: fulfillment.readiness_status === READINESS.READY && packageSnapshot ? 'READY' : 'NOT_READY',
      // Provider-neutral: the normalized service level only, never a carrier service code.
      serviceCode: method.serviceLevel || null,
      packageSnapshot,
      codCollectionMinor,
      // Phase 2 §6 — customer-facing shipping charge sits on the PRIMARY
      // shipment only (the customer paid once); the actual logistics cost is
      // the pricing-policy basis from the quote (refreshed per-shipment when a
      // real per-lane rate is available).
      customerShippingChargeMinor: Number(fulfillment.sequence) === 1 ? Number(method.customerShippingChargeMinor ?? method.shippingChargeMinor ?? 0) : 0,
      actualLogisticsCostMinor: Number(fulfillment.sequence) === 1 ? (method.actualLogisticsCostMinor ?? null) : null,
      shippingCostSource: method.actualLogisticsCostMinor != null ? 'PROVIDER_QUOTE' : null,
    });
    await this.repository.recordEvent(tx, fulfillment.id, {
      type: 'SHIPMENT_DRAFTED',
      detail: { shipmentId: shipment.id, warehouseId: fulfillment.warehouse_id, bookingStatus: shipment.booking_status, hasPackageSnapshot: Boolean(packageSnapshot) },
    });
  }

  async #assemble(tx, fulfillment) {
    // A pooled connection runs one statement at a time — never Promise.all here.
    const items = await this.repository.items(tx, fulfillment.id);
    const shipments = await this.repository.shipments(tx, fulfillment.id);
    return this.#dto(fulfillment, items, shipments);
  }

  /**
   * Assemble the primary (lowest-sequence) fulfillment DTO for an Order and
   * attach the full INITIAL set. Single-warehouse Orders get a 1-element
   * `fulfillments` array and behave exactly as before.
   */
  async #assemblePrimary(tx, fulfillments) {
    const ordered = [...fulfillments].sort((a, b) => Number(a.sequence) - Number(b.sequence));
    const dtos = [];
    for (const fulfillment of ordered) dtos.push(await this.#assemble(tx, fulfillment));
    return { ...dtos[0], warehouseId: ordered[0].warehouse_id, fulfillments: dtos };
  }

  #dto(fulfillment, items, shipments) {
    return {
      id: fulfillment.id,
      orderId: fulfillment.order_id,
      warehouseId: fulfillment.warehouse_id,
      fulfillmentNumber: fulfillment.fulfillment_number,
      type: fulfillment.fulfillment_type,
      sequence: Number(fulfillment.sequence),
      status: fulfillment.status,
      readinessStatus: fulfillment.readiness_status,
      blockReason: fulfillment.block_reason,
      // Who at the warehouse accepted this order, and when (§7). Read from
      // its own columns rather than dug out of an event's JSON.
      warehouseConfirmation: fulfillment.warehouse_confirmed_at
        ? {
          at: fulfillment.warehouse_confirmed_at,
          byStaffId: fulfillment.warehouse_confirmed_by_staff_id,
          note: fulfillment.warehouse_confirmation_note,
        }
        : null,
      // The ONE action an operator should be offered next. The CMS renders
      // this rather than deciding for itself which buttons to show, so the
      // sequence lives in the domain and both surfaces agree on it.
      nextOperatorStatus: nextOperatorStatus(fulfillment.status),
      shippingAddress: parse(fulfillment.shipping_address_snapshot_json),
      shippingMethod: parse(fulfillment.shipping_method_snapshot_json),
      warehouse: parse(fulfillment.warehouse_snapshot_json),
      financial: parse(fulfillment.financial_snapshot_json),
      items: items.map((item) => ({
        id: item.id,
        orderItemId: item.order_item_id,
        skuId: item.sku_id,
        quantity: Number(item.quantity),
      })),
      shipments: shipments.map((shipment) => this.#shipmentDto(shipment)),
      createdAt: fulfillment.created_at,
      readyAt: fulfillment.ready_at,
    };
  }

  #shipmentDto(shipment) {
    return {
      id: shipment.id,
      warehouseId: shipment.warehouse_id,
      shipmentNumber: shipment.shipment_number,
      status: shipment.status,
      bookingStatus: shipment.booking_status,
      providerCode: shipment.provider_code,
      serviceCode: shipment.service_code,
      externalShipmentId: shipment.external_shipment_id,
      trackingNumber: shipment.tracking_number,
      trackingUrl: shipment.tracking_url,
      package: parse(shipment.package_snapshot_json),
      codCollectionMinor: Number(shipment.cod_collection_minor),
    };
  }

  /** Read model for a customer-owned Order (§45). Provider-neutral only. */
  async summaryForOrder(orderId) {
    const fulfillments = await this.repository.fulfillmentsForOrder(null, orderId);
    if (!fulfillments.length) return { fulfillments: [], shipments: [] };
    const assembled = await Promise.all(fulfillments.map((fulfillment) => this.#assemble(null, fulfillment)));
    const { orderOpsRepository } = await import('../orderOps/repository.js');
    const shipments = [];
    for (const fulfillment of assembled) {
      for (const shipment of fulfillment.shipments) {
        const events = await orderOpsRepository.events(shipment.id);
        shipments.push({
          shipmentNumber: shipment.shipmentNumber,
          status: shipment.status,
          bookingStatus: shipment.bookingStatus,
          awbNumber: shipment.trackingNumber,
          providerCode: shipment.providerCode,
          // WP-10 — customer-facing carrier deep link. Prefer the provider's
          // own booked tracking URL; synthesise from carrier + AWB otherwise.
          trackingUrl: shipment.trackingUrl || carrierTrackingUrl(shipment.providerCode, shipment.trackingNumber),
          codCollectionMinor: shipment.codCollectionMinor,
          timeline: events.filter((e) => e.applied).map((e) => ({
            status: e.normalized_status, at: e.occurred_at, location: e.location_text, note: e.remarks,
          })),
        });
      }
    }
    return {
      fulfillments: assembled.map((fulfillment) => ({
        fulfillmentNumber: fulfillment.fulfillmentNumber,
        status: fulfillment.status,
        readinessStatus: fulfillment.readinessStatus,
        blockReason: fulfillment.blockReason,
        items: fulfillment.items.map((item) => ({ skuId: item.skuId, quantity: item.quantity })),
      })),
      shipments,
    };
  }

  // ---- WP-11: standalone Fulfillment CMS surface --------------------
  async adminList(filter = {}) {
    const [rows, total] = await Promise.all([
      this.repository.adminList(filter),
      this.repository.countAdminList(filter),
    ]);
    return {
      fulfillments: rows.map((r) => ({
        id: r.id,
        fulfillmentNumber: r.fulfillment_number,
        type: r.fulfillment_type,
        status: r.status,
        readinessStatus: r.readiness_status,
        blockReason: r.block_reason,
        warehouseId: r.warehouse_id,
        warehouseName: r.warehouse_name,
        orderId: r.order_id,
        orderNumber: r.order_number,
        orderStatus: r.order_status,
        itemCount: Number(r.item_count),
        shipmentCount: Number(r.shipment_count),
        createdAt: r.created_at,
        readyAt: r.ready_at,
        fulfilledAt: r.fulfilled_at,
      })),
      total,
      limit: filter.limit ?? 50,
      offset: filter.offset ?? 0,
    };
  }

  async adminDetail(id) {
    const f = await this.repository.adminById(id);
    if (!f) throw new AppError('FULFILLMENT_NOT_FOUND', 'Fulfillment not found.', 404);
    const [items, shipments, events] = await Promise.all([
      this.repository.items(null, id),
      this.repository.shipments(null, id),
      this.repository.events(id),
    ]);
    return {
      id: f.id,
      fulfillmentNumber: f.fulfillment_number,
      type: f.fulfillment_type,
      status: f.status,
      readinessStatus: f.readiness_status,
      blockReason: f.block_reason,
      // The CMS renders the one next action from here rather than keeping its
      // own copy of the transition graph, which had already drifted.
      nextOperatorStatus: nextOperatorStatus(f.status),
      warehouseConfirmation: f.warehouse_confirmed_at
        ? {
          at: f.warehouse_confirmed_at,
          byStaffId: f.warehouse_confirmed_by_staff_id,
          note: f.warehouse_confirmation_note,
        }
        : null,
      warehouseId: f.warehouse_id,
      warehouseName: f.warehouse_name,
      orderId: f.order_id,
      orderNumber: f.order_number,
      orderStatus: f.order_status,
      shippingAddress: parse(f.shipping_address_snapshot_json),
      createdAt: f.created_at,
      readyAt: f.ready_at,
      fulfilledAt: f.fulfilled_at,
      cancelledAt: f.cancelled_at,
      items: items.map((i) => ({ id: i.id, orderItemId: i.order_item_id, skuId: i.sku_id, quantity: Number(i.quantity) })),
      shipments: shipments.map((s) => ({
        id: s.id, shipmentNumber: s.shipment_number, status: s.status, bookingStatus: s.booking_status,
        awbNumber: s.tracking_number, providerCode: s.provider_code,
      })),
      events: events.map((e) => ({
        type: e.event_type, fromStatus: e.from_status, toStatus: e.to_status,
        detail: parse(e.detail_json), at: e.created_at,
      })),
    };
  }

  /**
   * Centralized status transition (§41). WP-11 adds the staff-driven CMS
   * caller (POST /admin/fulfillments/:id/transition) alongside the WP-01
   * shipment→fulfilment bridge.
   */
  /**
   * A warehouse manager accepting an order (§7). Distinct from both existing
   * "ready" concepts — see transitions.js — and from PROCESSING, which is the
   * physical picking and packing that follows.
   *
   * The actor is required, not optional: the entire point of this step is that
   * a named person at the warehouse undertook to fulfil the order, so a
   * confirmation with nobody attached to it would record nothing worth having.
   */
  async confirmByWarehouse(fulfillmentId, { actorStaffId, note = null, connection = null } = {}) {
    if (!actorStaffId) {
      throw new AppError('WAREHOUSE_CONFIRMATION_ACTOR_REQUIRED',
        'Warehouse confirmation must record the staff member who confirmed it.', 400);
    }

    // Idempotent on a double-click (§20): an already-confirmed fulfilment is
    // returned untouched rather than re-stamped. Overwriting would replace the
    // person who actually accepted the order with whoever clicked last, which
    // destroys the only fact this step exists to record.
    const run = async (tx) => {
      // Locked read inside the same transaction, so two concurrent clicks
      // cannot both see "not yet confirmed" and both write.
      const rows = await tx.execute('SELECT * FROM fulfillments WHERE id=? FOR UPDATE', [fulfillmentId]);
      const existing = rows[0][0];
      if (!existing) throw new AppError('FULFILLMENT_NOT_FOUND', 'Fulfillment not found.', 404);
      if (existing.warehouse_confirmed_at) return this.#assemble(tx, existing);
      return this.transitionStatus(fulfillmentId, 'WAREHOUSE_CONFIRMED', {
        connection: tx,
        detail: { via: 'CMS', actorStaffId, note },
        warehouseConfirmation: { actorStaffId, note },
      });
    };
    return connection ? run(connection) : this.transaction(run);
  }

  async transitionStatus(fulfillmentId, toStatus, { detail = null, connection = null, warehouseConfirmation = null } = {}) {
    const run = async (tx) => {
      const rows = await tx.execute('SELECT * FROM fulfillments WHERE id=? FOR UPDATE', [fulfillmentId]);
      const fulfillment = rows[0][0];
      if (!fulfillment) throw new AppError('FULFILLMENT_NOT_FOUND', 'Fulfillment not found.', 404);
      assertTransition(fulfillment.status, toStatus);
      const timestamps = {};
      if (toStatus === 'READY') timestamps.ready_at = new Date();
      if (toStatus === 'WAREHOUSE_CONFIRMED') {
        // Routed through confirmByWarehouse so the actor cannot be omitted;
        // reaching here without one means a caller went around that door.
        if (!warehouseConfirmation?.actorStaffId) {
          throw new AppError('WAREHOUSE_CONFIRMATION_ACTOR_REQUIRED',
            'Warehouse confirmation must record the staff member who confirmed it.', 400);
        }
        timestamps.warehouse_confirmed_at = new Date();
        timestamps.warehouse_confirmed_by_staff_id = warehouseConfirmation.actorStaffId;
        timestamps.warehouse_confirmation_note = warehouseConfirmation.note ?? null;
      }
      if (toStatus === 'FULFILLED') timestamps.fulfilled_at = new Date();
      if (toStatus === 'CANCELLED') timestamps.cancelled_at = new Date();
      await this.repository.updateFulfillmentStatus(tx, fulfillmentId, toStatus, timestamps);
      // Business cancellation NEVER hard-deletes history (§7A.1 §20/§23): the
      // fulfillment, its items, its shipments and its events all remain. The
      // DRAFT shipment is moved to CANCELLED, not removed.
      if (toStatus === 'CANCELLED') await this.repository.cancelDraftShipments(tx, fulfillmentId);
      await this.repository.recordEvent(tx, fulfillmentId, {
        type: 'STATUS_TRANSITION',
        fromStatus: fulfillment.status,
        toStatus,
        detail,
      });
      // Spread the columns just written, not only the status: `fulfillment` is
      // the row as it was BEFORE the update, so without this the caller gets a
      // DTO that is missing the very fields this transition set.
      return this.#assemble(tx, { ...fulfillment, ...timestamps, status: toStatus });
    };
    // WP-09 — the order-cancellation cascade drives this inside its own
    // transaction; everyone else lets it own the transaction.
    return connection ? run(connection) : this.transaction(run);
  }

  /**
   * Re-evaluate booking readiness for an Order's initial fulfillment (§7A.1
   * §43-44). Use when shipping metadata that was previously missing has since
   * been configured on the product/SKU shipping profile.
   *
   * Idempotent: a no-op when readiness is unchanged (no write, no event, §53).
   * Never mutates inventory, Order snapshots, or allocations, and never calls a
   * provider. It only re-reads the existing product shipping-profile authority.
   */
  async reevaluateReadiness(orderId, { connection = null } = {}) {
    const run = async (tx) => {
      const fulfillments = await this.repository.initialFulfillments(tx, orderId);
      if (!fulfillments.length) throw new AppError('FULFILLMENT_NOT_FOUND', 'No initial fulfillment for this order.', 404);
      const order = await this.repository.lockOrder(tx, orderId);
      let anyChanged = false;

      for (const fulfillment of fulfillments) {
        if (['CANCELLED', 'FULFILLED'].includes(fulfillment.status)) continue;
        const allocations = (await this.repository.items(tx, fulfillment.id)).map((row) => ({
          skuId: row.sku_id, quantity: Number(row.quantity),
        }));
        const packageItems = await this.metadata.resolveItems(allocations);
        const next = evaluateReadiness({
          orderStatus: order.order_status,
          shippingAddress: parse(fulfillment.shipping_address_snapshot_json),
          allocations,
          packageItems,
        });
        if (next.readinessStatus === fulfillment.readiness_status && next.blockReason === fulfillment.block_reason) continue;

        await this.repository.updateReadiness(tx, fulfillment.id, {
          readinessStatus: next.readinessStatus,
          blockReason: next.blockReason,
          readyAt: next.readinessStatus === READINESS.READY ? new Date() : null,
        });
        const packageSnapshot = buildPackageSnapshot(packageItems);
        for (const shipment of await this.repository.shipments(tx, fulfillment.id)) {
          if (shipment.status !== 'DRAFT') continue;
          await this.repository.updateShipmentDraft(tx, shipment.id, {
            bookingStatus: next.readinessStatus === READINESS.READY && packageSnapshot ? 'READY' : 'NOT_READY',
            packageSnapshot,
          });
        }
        await this.repository.recordEvent(tx, fulfillment.id, {
          type: 'READINESS_REEVALUATED',
          detail: {
            from: { readinessStatus: fulfillment.readiness_status, blockReason: fulfillment.block_reason },
            to: next,
          },
        });
        log('readiness_reevaluated', { orderId, fulfillmentId: fulfillment.id, warehouseId: fulfillment.warehouse_id, ...next });
        anyChanged = true;
      }

      const refreshed = await this.repository.initialFulfillments(tx, orderId);
      return { changed: anyChanged, ...(await this.#assemblePrimary(tx, refreshed)) };
    };
    return connection ? run(connection) : this.transaction(run);
  }
}

export const fulfillmentService = new FulfillmentService();
