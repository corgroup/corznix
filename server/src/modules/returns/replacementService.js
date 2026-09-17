import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { fulfillmentRepository } from '../fulfillment/repository.js';
import { inventoryService } from '../inventory/service.js';
import { warehouseAllocationService } from '../warehouses/allocationService.js';
import { warehouseRepository } from '../warehouses/repository.js';
import { warehouseSnapshot } from '../warehouses/service.js';
import { returnsRepository } from './repository.js';

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/**
 * Releases the outgoing replacement for a REPLACEMENT return request (§33/§34).
 * Reuses the existing commerce spine end-to-end — warehouse allocator,
 * InventoryService reservations (FOR UPDATE — the oversell guard, §36), and
 * the fulfillment + shipment authority. Never a parallel inventory / carrier.
 *
 * The replacement ships against the ORIGINAL order: its SUPPLEMENTARY
 * fulfillment carries `return_request_id` and its `fulfillment_items` reference
 * the original order items — traceability is explicit (§37).
 *
 * Idempotent: `uk_fulfillments_return_request` means one replacement
 * fulfillment per request; a repeat call returns the existing one.
 */
export class ReplacementService {
  constructor({ repository = returnsRepository, inventory = inventoryService, allocator = warehouseAllocationService, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.inventory = inventory;
    this.allocator = allocator;
    this.transaction = transaction;
  }

  async existingFor(returnRequestId, connection = null) {
    const exec = connection
      ? (sql, p) => connection.execute(sql, p).then((r) => r[0])
      : (sql, p) => import('../../database/connection/pool.js').then((m) => m.query(sql, p));
    const rows = await exec('SELECT * FROM fulfillments WHERE return_request_id = ? LIMIT 1', [returnRequestId]);
    return rows[0] || null;
  }

  async releaseFor(returnRequestId) {
    const request = await this.repository.requestById(returnRequestId);
    if (!request) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);
    if (!['REPLACEMENT', 'SAME_STYLE_EXCHANGE'].includes(request.request_type)) {
      throw new AppError('NOT_RELEASABLE', 'This request type has no outgoing fulfillment.', 409);
    }
    if (!['QC_PASSED', 'RESOLUTION_PENDING', 'COMPLETED'].includes(request.status)) {
      throw new AppError('OUTBOUND_NOT_READY', `The outgoing shipment is released after QC, not in ${request.status}.`, 409);
    }

    const already = await this.existingFor(returnRequestId);
    if (already) return this.#dto(already);

    const order = await this.repository.orderById(request.order_id);
    const items = await this.repository.requestItems(returnRequestId);
    const isExchange = request.request_type === 'SAME_STYLE_EXCHANGE';

    // Outbound SKU = the returned SKU for a replacement, the target SKU for a
    // same-style exchange. Each outbound line keeps a pointer to the ORIGINAL
    // order item so the fulfillment stays traceable (§37).
    const originalByOutSku = new Map();
    const outBySku = new Map();
    for (const item of items) {
      const outSkuId = isExchange ? item.target_sku_id : item.sku_id;
      if (!outSkuId) throw new AppError('EXCHANGE_TARGET_MISSING', 'This exchange line has no target SKU.', 409);
      outBySku.set(outSkuId, (outBySku.get(outSkuId) || 0) + Number(item.quantity));
      if (!originalByOutSku.has(outSkuId)) originalByOutSku.set(outSkuId, item.order_item_id);
    }
    const allocItems = [...outBySku.entries()].map(([skuId, quantity]) => ({ skuId, quantity }));
    const destinationPostalCode = parse(order.shipping_address_snapshot)?.postalCode || null;

    // 1. Allocate against warehouse inventory (the only authority, §35).
    const allocation = await this.allocator.allocate({ destinationPostalCode, items: allocItems });
    if (allocation.status !== 'ALLOCATED') {
      throw new AppError('OUTBOUND_UNALLOCATABLE', 'Outgoing stock is not available for this destination.', 409);
    }
    if (allocation.allocations.length > 1) {
      // A split outbound needs multi-fulfillment linkage — deferred (8F-5).
      throw new AppError('OUTBOUND_REQUIRES_SINGLE_WAREHOUSE', 'This outgoing shipment would split across warehouses.', 409);
    }
    const group = allocation.allocations[0];

    // 2. Reserve transactionally — FOR UPDATE inside inventoryService prevents
    //    oversell even under a concurrent race (§36).
    const reservation = await this.inventory.reserve(
      this.allocator.toReservationItems(allocation),
      { customerId: order.customer_id, idempotencyKey: `outbound:${returnRequestId}` },
    );

    // 3. Create the SUPPLEMENTARY fulfillment + items + shipment, consume the
    //    reservation, link everything back to the return request.
    const warehouse = await warehouseRepository.findById(group.warehouseId);
    const result = await this.transaction(async (tx) => {
      const raced = await this.existingFor(returnRequestId, tx);
      if (raced) return { fulfillment: raced, raced: true };

      const sequence = await fulfillmentRepository.nextSequence(tx, order.id);
      let fulfillment;
      try {
        fulfillment = await fulfillmentRepository.insertFulfillment(tx, {
          orderId: order.id,
          warehouseId: group.warehouseId,
          fulfillmentNumber: `FUL-${order.order_number}-R${sequence}`,
          fulfillmentType: 'SUPPLEMENTARY',
          sequence,
          status: 'PENDING',
          readinessStatus: 'READY',
          blockReason: null,
          shippingAddressSnapshot: parse(order.shipping_address_snapshot),
          shippingMethodSnapshot: parse(order.shipping_snapshot),
          financialSnapshot: { outbound: request.request_type, currency: order.currency, returnRequestId, orderTotalMinor: 0, codCollectionMinor: 0 },
          warehouseSnapshot: warehouseSnapshot(warehouse),
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          const ex = await this.existingFor(returnRequestId, tx);
          if (ex) return { fulfillment: ex, raced: true };
        }
        throw err;
      }
      await tx.execute(
        'UPDATE fulfillments SET return_request_id = ?, source_reservation_id = ? WHERE id = ?',
        [returnRequestId, reservation.id, fulfillment.id],
      );

      for (const line of group.items) {
        const originalOrderItemId = originalByOutSku.get(line.skuId);
        await tx.execute(
          'INSERT INTO fulfillment_items (id,fulfillment_id,order_item_id,sku_id,quantity) VALUES (?,?,?,?,?)',
          [randomUUID(), fulfillment.id, originalOrderItemId, line.skuId, line.quantity],
        );
      }

      const shipmentId = randomUUID();
      await tx.execute(
        `INSERT INTO shipments (id,brand_id,fulfillment_id,warehouse_id,shipment_number,sequence,status,booking_status,service_code,cod_collection_minor)
         VALUES (?,(SELECT brand_id FROM fulfillments WHERE id = ?),?,?,?,1,'DRAFT','READY',?,0)`,
        [shipmentId, fulfillment.id, fulfillment.id, group.warehouseId, `SHP-${order.order_number}-R${sequence}`, parse(order.shipping_snapshot)?.serviceLevel || 'STANDARD'],
      );

      await fulfillmentRepository.recordEvent(tx, fulfillment.id, {
        type: isExchange ? 'EXCHANGE_FULFILLMENT_CREATED' : 'REPLACEMENT_FULFILLMENT_CREATED',
        toStatus: 'PENDING',
        detail: { returnRequestId, requestType: request.request_type, warehouseId: group.warehouseId, reservationId: reservation.id, items: group.items },
      });
      await this.repository.recordEvent(tx, returnRequestId, {
        eventType: isExchange ? 'EXCHANGE_FULFILLMENT_RELEASED' : 'REPLACEMENT_RELEASED',
        actorType: 'STAFF',
        detail: { fulfillmentId: fulfillment.id, shipmentId, warehouseId: group.warehouseId },
      });

      // Commit the stock — the replacement goods are now allocated out.
      await this.inventory.consumeReservation(reservation.id, { connection: tx });
      return { fulfillment: await this.existingFor(returnRequestId, tx) };
    });

    if (result.raced) {
      // Our reservation lost the race — release it so stock is not stranded.
      await this.inventory.releaseReservation(reservation.id).catch(() => {});
    }
    return this.#dto(result.fulfillment);
  }

  #dto(fulfillment) {
    return {
      fulfillmentId: fulfillment.id,
      fulfillmentNumber: fulfillment.fulfillment_number,
      returnRequestId: fulfillment.return_request_id,
      orderId: fulfillment.order_id,
      warehouseId: fulfillment.warehouse_id,
      status: fulfillment.status,
      sourceReservationId: fulfillment.source_reservation_id,
    };
  }
}

export const replacementService = new ReplacementService();
