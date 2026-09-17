import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { fulfillmentService } from '../fulfillment/service.js';
import { inventoryService } from '../inventory/service.js';
import { warehouseAllocationService } from '../warehouses/allocationService.js';
import { differentStyleExchangeService } from './differentStyleExchangeService.js';
import { differentStyleExchangeRepository } from './differentStyleExchangeRepository.js';
import { returnsRepository } from './repository.js';

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const EXCHANGE_RESERVATION_TTL_SECONDS = 60 * 60 * 24 * 30;

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

/**
 * Places the NEW different-style exchange order (§58). This is the exchange
 * order-creation boundary: it reuses the same commerce spine as normal
 * checkout — warehouse allocator, InventoryService reservation, the orders
 * authority, and post-commit fulfillment bootstrap — and attaches the exchange
 * metadata atomically. The reserved exchange credit is consumed in the same
 * transaction (§56/§58).
 */
export class ExchangeCheckoutService {
  constructor({
    exchange = differentStyleExchangeService, exchangeRepo = differentStyleExchangeRepository,
    returns = returnsRepository, inventory = inventoryService, allocator = warehouseAllocationService,
    fulfillment = fulfillmentService, transaction = withTransaction,
  } = {}) {
    this.exchange = exchange;
    this.exchangeRepo = exchangeRepo;
    this.returns = returns;
    this.inventory = inventory;
    this.allocator = allocator;
    this.fulfillment = fulfillment;
    this.transaction = transaction;
  }

  async #priceCart(items) {
    const norm = new Map();
    for (const it of items || []) {
      if (!it?.skuId || !Number.isInteger(it.quantity) || it.quantity <= 0) {
        throw new AppError('VALIDATION_ERROR', 'Each exchange cart line needs a SKU and a positive quantity.', 400);
      }
      norm.set(it.skuId, (norm.get(it.skuId) || 0) + it.quantity);
    }
    if (!norm.size) throw new AppError('VALIDATION_ERROR', 'The exchange cart is empty.', 400);
    const ids = [...norm.keys()];
    const rows = await query(
      `SELECT s.id, s.status AS sku_status, COALESCE(s.sale_price_minor, s.price_minor) AS price_minor,
              v.status AS variant_status, p.status AS product_status
         FROM skus s JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
        WHERE s.id IN (${ids.map(() => '?').join(',')})`, ids);
    const bySku = new Map(rows.map((r) => [r.id, r]));
    let subtotalMinor = 0;
    const lines = [];
    for (const [skuId, quantity] of norm) {
      const row = bySku.get(skuId);
      if (!row) throw new AppError('EXCHANGE_CART_SKU_NOT_FOUND', 'An exchange cart item does not exist.', 404);
      if (row.sku_status !== 'ACTIVE' || row.variant_status !== 'ACTIVE' || row.product_status !== 'ACTIVE') {
        throw new AppError('EXCHANGE_CART_SKU_INACTIVE', 'An exchange cart item is not available.', 409);
      }
      subtotalMinor += Number(row.price_minor) * quantity;
      lines.push({ skuId, quantity, unitPriceMinor: Number(row.price_minor) });
    }
    return { subtotalMinor, lines };
  }

  async #orderDto(orderId) {
    const order = await exec(null, 'SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId]).then((r) => r[0]);
    if (!order) return null;
    return {
      id: order.id,
      orderNumber: order.order_number,
      status: order.order_status,
      isExchangeOrder: Boolean(order.is_exchange_order),
      exchangeType: order.exchange_type,
      exchangeTransactionId: order.exchange_transaction_id,
      currency: order.currency,
      subtotalMinor: Number(order.subtotal_minor),
      totalMinor: Number(order.total_minor),
      exchangeCreditAppliedMinor: Number(order.exchange_credit_applied_minor),
      extraPaidMinor: Number(order.online_paid_minor),
    };
  }

  async placeOrder({ customerId, contextToken, items, idempotencyKey }) {
    if (!idempotencyKey || String(idempotencyKey).length < 8) {
      throw new AppError('VALIDATION_ERROR', 'A valid idempotency key is required.', 400);
    }
    const context = await this.exchange.getContext({ customerId, contextToken });
    if (context.newExchangeOrderId) return this.#orderDto(context.newExchangeOrderId); // idempotent
    if (!context.usable) {
      throw new AppError('EXCHANGE_CONTEXT_UNUSABLE',
        context.expired ? 'The reserved exchange credit has expired.' : 'This exchange can no longer be used.', 409);
    }

    const originalOrder = await this.returns.orderById(context.originalOrderId);
    const shippingAddress = parse(originalOrder.shipping_address_snapshot);
    const shippingMethod = parse(originalOrder.shipping_snapshot);
    const { subtotalMinor, lines } = await this.#priceCart(items);

    // 1. Allocate + reserve — the same spine as normal checkout (§58).
    const allocation = await this.allocator.allocate({
      destinationPostalCode: shippingAddress?.postalCode || null,
      items: lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity })),
    });
    if (allocation.status !== 'ALLOCATED') {
      throw new AppError('EXCHANGE_ORDER_UNALLOCATABLE', 'The exchange items are not available for this address.', 409);
    }
    if (allocation.allocations.length > 1) {
      throw new AppError('EXCHANGE_ORDER_REQUIRES_SINGLE_WAREHOUSE', 'This exchange order would split across warehouses.', 409);
    }
    const reservation = await this.inventory.reserve(
      this.allocator.toReservationItems(allocation),
      { customerId, idempotencyKey: `exc-order:${contextToken}`, ttlSeconds: EXCHANGE_RESERVATION_TTL_SECONDS },
    );

    const newOrderId = randomUUID();
    const [excBrand] = await query('SELECT order_prefix FROM brands WHERE id = ?', [originalOrder.brand_id]);
    const orderNumber = `${excBrand?.order_prefix || 'ORD'}-EXC-${new Date().toISOString().slice(0, 10).replaceAll('-', '')}-${newOrderId.replaceAll('-', '').slice(0, 12).toUpperCase()}`;

    let result;
    try {
      result = await this.transaction(async (tx) => {
      const txn = await this.exchangeRepo.transactionByContext(tx, contextToken, { lock: true });
      if (txn.new_exchange_order_id) return { existingOrderId: txn.new_exchange_order_id };

      // Consume the reserved credit — status+version guarded (§62).
      const consume = await this.exchange.consume({
        connection: tx, contextToken, customerId, newOrderTotalMinor: subtotalMinor,
      });

      // Multi-company (DESIGN.md §4.1) — Phase 4. brand_id derived from the
      // customer's own row — an exchange order always belongs to the same
      // company as the customer and the original order it replaces.
      await tx.execute(
        `INSERT INTO orders
          (id, brand_id, order_number, checkout_id, customer_id, inventory_reservation_id, payment_status, payment_mode,
           currency, subtotal_minor, shipping_minor, total_minor, online_paid_minor, cod_due_minor,
           shipping_address_snapshot, shipping_snapshot, finalization_source,
           is_exchange_order, exchange_type, exchange_transaction_id, exchange_credit_applied_minor, placed_at)
         VALUES (?, (SELECT brand_id FROM customers WHERE id = ?), ?, NULL, ?, ?, 'PAID', 'PREPAID', ?, ?, 0, ?, ?, 0, ?, ?, 'EXCHANGE_CHECKOUT', 1, 'DIFFERENT_STYLE', ?, ?, NOW(3))`,
        [newOrderId, customerId, orderNumber, customerId, reservation.id, originalOrder.currency,
          subtotalMinor, subtotalMinor, consume.extraPaymentMinor,
          JSON.stringify(shippingAddress), JSON.stringify(shippingMethod), txn.id, consume.appliedMinor],
      );
      const skuRows = await tx.execute(
        `SELECT s.id, s.sku, s.variant_id, v.product_id, p.name
           FROM skus s JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
          WHERE s.id IN (${lines.map(() => '?').join(',')})`, lines.map((l) => l.skuId)).then((r) => r[0]);
      const skuMeta = new Map(skuRows.map((r) => [r.id, r]));
      for (const line of lines) {
        const m = skuMeta.get(line.skuId);
        await tx.execute(
          `INSERT INTO order_items (id, order_id, product_id, variant_id, sku_id, product_name, sku, quantity, unit_price_minor, line_total_minor)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), newOrderId, m.product_id, m.variant_id, line.skuId, m.name, m.sku,
            line.quantity, line.unitPriceMinor, line.unitPriceMinor * line.quantity],
        );
      }
      // Turn the hold into a sale, exactly as normal placement does
      // (orders/service.js). Without this the exchange order was created
      // against a reservation that nothing ever consumed: `on_hand` never fell,
      // and 30 days later the expiry sweeper released the hold outright — so
      // the catalogue kept counting a unit that had already shipped, and the
      // shortfall only surfaced when a customer bought stock that was not there.
      await this.inventory.consumeReservation(reservation.id, { connection: tx });
      await this.exchange.linkOrder(tx, txn.id, newOrderId);
      return { newOrderId, consume };
      });
    } catch (err) {
      // The order transaction failed — never strand the stock we reserved
      // outside it.
      await this.inventory.releaseReservation(reservation.id).catch(() => {});
      throw err;
    }

    if (result.existingOrderId) {
      await this.inventory.releaseReservation(reservation.id).catch(() => {});
      return this.#orderDto(result.existingOrderId);
    }

    await this.fulfillment.ensureForOrder(newOrderId).catch((err) => {
      console.error(JSON.stringify({ scope: 'exchange-checkout', event: 'fulfillment_bootstrap_failed', orderId: newOrderId, error: err.message }));
    });
    return { ...(await this.#orderDto(newOrderId)), consume: result.consume };
  }

  /**
   * Cancel a new different-style exchange order (§59 locked rollback):
   * cancel order -> release its inventory -> cancel exchange transaction ->
   * void reserved credit + reverse the remainder grant -> restore the original
   * order's eligibility. Reserved exchange value is NEVER refunded to the
   * original payment method; any extra captured payment follows normal refund
   * rules (deferred to 8F-6).
   */
  async cancelOrder({ customerId, orderId }) {
    const order = await exec(null,
      'SELECT * FROM orders WHERE (id = ? OR order_number = ?) AND customer_id = ? AND is_exchange_order = 1 LIMIT 1',
      [orderId, orderId, customerId]).then((r) => r[0]);
    if (!order) throw new AppError('EXCHANGE_ORDER_NOT_FOUND', 'Exchange order not found.', 404);

    if (order.order_status === 'CANCELLED') {
      return this.#cancelResult(order);
    }
    if (!['PLACED', 'CONFIRMED'].includes(order.order_status)) {
      throw new AppError('EXCHANGE_ORDER_NOT_CANCELLABLE',
        `An exchange order in ${order.order_status} can no longer be cancelled.`, 409);
    }

    await this.transaction(async (tx) => {
      await tx.execute(
        "UPDATE orders SET order_status = 'CANCELLED', updated_at = NOW(3) WHERE id = ? AND order_status IN ('PLACED','CONFIRMED')",
        [order.id],
      );
      await tx.execute(
        "UPDATE fulfillments SET status = 'CANCELLED', cancelled_at = NOW(3) WHERE order_id = ? AND status NOT IN ('FULFILLED','CANCELLED')",
        [order.id],
      );
      await tx.execute(
        "UPDATE shipments s JOIN fulfillments f ON f.id = s.fulfillment_id SET s.status = 'CANCELLED', s.booking_status = 'CANCELLED', s.cancelled_at = NOW(3) WHERE f.order_id = ? AND s.status = 'DRAFT'",
        [order.id],
      );

      // Give the stock back. An exchange order now CONSUMES its reservation at
      // placement like any other order, so this has to restore on-hand, not
      // merely drop a hold — and it belongs inside the transaction that
      // cancels the order, because stock silently failing to come back is
      // exactly as costly as the order failing to cancel. The shared helper
      // covers both shapes, so exchange orders placed before consumption
      // existed (reservation still RESERVED) still cancel correctly.
      await this.inventory.releaseForCancelledOrder({ order, connection: tx });
    });

    // Void the exchange transaction + reserved credit + restore eligibility.
    await this.exchange.cancel({
      exchangeTransactionId: order.exchange_transaction_id,
      reason: 'NEW_EXCHANGE_ORDER_CANCELLED',
      restoreEligibility: true,
    });

    return this.#cancelResult(order);
  }

  #cancelResult(order) {
    return {
      orderId: order.id,
      orderNumber: order.order_number,
      status: 'CANCELLED',
      reservedExchangeRefundToOriginalPaymentMinor: 0, // §59/§60 — never
      extraPaymentRefundPendingMinor: Number(order.online_paid_minor), // normal refund rules, 8F-6
    };
  }
}

export const exchangeCheckoutService = new ExchangeCheckoutService();
