import { createHash } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { addressService } from '../addresses/service.js';
import { cartService } from '../cart/service.js';
import { inventoryService } from '../inventory/service.js';
import { compareQuoteToFresh, matchingShippingOption, shippingService } from '../shipping/service.js';
import { ALLOCATION_STATUS, allocationItemsFingerprint, warehouseAllocationService } from '../warehouses/allocationService.js';
import { promotionService } from '../promotions/service.js';
import { query } from '../../database/connection/pool.js';
import { checkoutRepository } from './repository.js';
import { logger } from '../../utils/logger.js';

const log = logger('checkout');

const parseJson = (value, fallback = null) => value == null ? fallback : typeof value === 'string' ? JSON.parse(value) : value;
const cartFingerprint = (cart) => createHash('sha256').update(JSON.stringify(cart.items
  .map((item) => [item.skuId,item.quantity,item.unitPriceMinor]).sort((a,b) => a[0].localeCompare(b[0])))).digest('hex');
const snapshotAddress = (row) => ({ firstName: row.first_name, lastName: row.last_name, phone: row.phone, addressLine1: row.address_line1, addressLine2: row.address_line2, city: row.city, district: row.district || null, state: row.state, postalCode: row.postal_code, country: row.country || 'IN' });
const reservationExpired = (row) => row.reservation_status === 'EXPIRED' || Boolean(Number(row.reservation_is_expired));

/**
 * What a delivery re-quote may do to a checkout. Without a selection only the
 * offered options are refreshed. With one, it moves onto the fresh quote only
 * when the same method is still offered at exactly the same charge — anything
 * else would change the total under the customer, so the selection is dropped
 * and they choose again.
 */
export function planShippingRefresh(selected, fresh) {
  if (!selected) return { action: 'SNAPSHOT_ONLY' };
  const comparison = compareQuoteToFresh(selected, fresh, { toleranceMinor: 0 });
  if (!comparison.ok) return { action: 'RESET', reason: comparison.reason };
  const option = matchingShippingOption(selected, fresh);
  // The checkout charges rateMinor; compareQuoteToFresh may have compared a
  // different charge field, so the kept option must match on this one too.
  if (Number(option.rateMinor) !== Number(selected.rateMinor)) return { action: 'RESET', reason: 'RATE_CHANGED' };
  return { action: 'KEEP', option };
}

export class CheckoutService {
  async create(customerId, idempotencyKey) {
    const scopedKey = `${customerId}:${idempotencyKey}`;
    const existing = await checkoutRepository.findByIdempotency(customerId, scopedKey);
    if (existing) return this.get(customerId, existing.id);
    return withTransaction(async (connection) => {
      const cart = await cartService.getCart(customerId, { create: false, connection, lock: true });
      if (!cart.id || !cart.items.length) throw new AppError('EMPTY_CART', 'Your cart is empty.', 409);
      const fingerprint = cartFingerprint(cart);
      const retry = await checkoutRepository.findByIdempotency(customerId, scopedKey, connection);
      if (retry) return this.map(retry, cart);
      const current = await checkoutRepository.findCurrent(customerId, connection, { lock: true });
      if (current && !reservationExpired(current) && current.cart_fingerprint === fingerprint) return this.map(current, cart);
      if (current) {
        if (reservationExpired(current)) {
          await inventoryService.expireReservation(current.inventory_reservation_id, { connection });
          await checkoutRepository.markStatus(connection, customerId, current.id, 'EXPIRED');
        } else {
          await inventoryService.releaseReservation(current.inventory_reservation_id, { connection });
          await checkoutRepository.markStatus(connection, customerId, current.id, 'CANCELLED');
        }
      }
      const allocation = await this.allocateOrThrow({ items: cart.items });
      const reservation = await inventoryService.reserve(
        warehouseAllocationService.toReservationItems(allocation),
        { customerId, idempotencyKey: `checkout:${scopedKey}`, connection },
      );
      const row = await checkoutRepository.create(connection, { customerId, cartId: cart.id, reservationId: reservation.id, idempotencyKey: scopedKey, cartFingerprint: fingerprint, items: cart.items, currency: cart.currency, subtotalMinor: cart.subtotalMinor, reservationExpiresAt: reservation.expiresAt, warehouseAllocation: allocation });
      return this.map(row, cart);
    });
  }

  async allocateOrThrow({ items, destinationPostalCode = null }) {
    const allocation = await warehouseAllocationService.allocate({
      items: items.map((item) => ({ skuId: item.skuId, quantity: item.quantity })),
      destinationPostalCode,
    });
    if (allocation.status !== ALLOCATION_STATUS.ALLOCATED) {
      const code = allocation.status === ALLOCATION_STATUS.PARTIALLY_UNAVAILABLE ? 'INSUFFICIENT_STOCK' : 'INVENTORY_UNALLOCATABLE';
      throw new AppError(code, 'These items cannot be fulfilled from any warehouse right now.', 409);
    }
    return allocation;
  }

  /** Re-run allocation once a destination PIN is known; swap the reservation only
   *  if the warehouse split actually changed. Non-fatal — serviceability blockers
   *  in map()/checkServiceability handle an unserviceable PIN. */
  async reallocateForAddress(customerId, id) {
    // Best-effort: the whole swap is one transaction, so any failure after the
    // lock (new split can't be allocated or reserved — stock moved again, a
    // provider blip) rolls back and leaves the EXISTING reservation fully
    // valid. The stale / unserviceable state then surfaces via
    // checkServiceability / map(). A programmer error still propagates.
    try {
      await withTransaction(async (connection) => {
        const row = await checkoutRepository.findOwned(customerId, id, connection, { lock: true });
        if (!row || !['ACTIVE', 'READY_FOR_PAYMENT'].includes(row.status) || row.reservation_status !== 'RESERVED') return;
        const address = parseJson(row.shipping_address_snapshot);
        if (!address?.postalCode) return;
        const items = parseJson(row.items_snapshot, []);
        const allocation = await warehouseAllocationService.allocate({ items, destinationPostalCode: address.postalCode });
        if (allocation.status !== ALLOCATION_STATUS.ALLOCATED) return;
        const currentFingerprint = parseJson(row.warehouse_allocation_json)?.itemsFingerprint;
        const nextFingerprint = allocationItemsFingerprint(allocation);
        if (currentFingerprint === nextFingerprint) return;
        const replacement = await inventoryService.reserve(
          warehouseAllocationService.toReservationItems(allocation),
          { customerId, idempotencyKey: `checkout:${customerId}:${id}:addr:${nextFingerprint.slice(0, 24)}`, connection },
        );
        if (replacement.id === row.inventory_reservation_id) return;
        await inventoryService.releaseReservation(row.inventory_reservation_id, { connection });
        await checkoutRepository.swapReservation(connection, customerId, id, {
          reservationId: replacement.id, reservationExpiresAt: replacement.expiresAt, allocation,
        });
      });
    } catch (error) {
      if (error instanceof AppError || (error && typeof error.code === 'string')) return;
      throw error;
    }
  }

  async get(customerId, id) {
    let row = await checkoutRepository.findOwned(customerId, id);
    if (!row) throw new AppError('CHECKOUT_NOT_FOUND', 'Checkout session not found.', 404);
    if (reservationExpired(row) && !['EXPIRED','CANCELLED'].includes(row.status)) {
      await inventoryService.expireReservation(row.inventory_reservation_id);
      await checkoutRepository.markStatus(null, customerId, id, 'EXPIRED');
      row = await checkoutRepository.findOwned(customerId, id);
    }
    const cart = await cartService.getCart(customerId, { create: false });
    // An expired checkout whose cart has since changed is cancelled too: renewing it would hold the old items.
    if (['ACTIVE','READY_FOR_PAYMENT','EXPIRED'].includes(row.status) && cartFingerprint(cart) !== row.cart_fingerprint) {
      await this.cancel(customerId, id, 'CART_CHANGED');
      row = await checkoutRepository.findOwned(customerId, id);
    }
    return this.map(row, cart);
  }

  async current(customerId) {
    const row = await checkoutRepository.findCurrent(customerId);
    if (!row) return null;
    const checkout = await this.get(customerId, row.id);
    return checkout.status === 'CANCELLED' ? null : checkout;
  }

  async setAddress(customerId, id, input) {
    await this.requireActive(customerId, id);
    let addressId = input.addressId || null; let row;
    if (addressId) row = await addressService.getOwned(customerId, addressId);
    else {
      addressService.validate(input.address);
      // Checkout saves as the customer types. The first save adds the address
      // to their book; later saves of the same draft revise that entry, or
      // every pause in typing would leave another near-duplicate behind. An
      // entry deleted meanwhile (another tab) is simply created again.
      const revised = input.saveInfo && input.replaceAddressId
        ? await addressService.update(customerId, input.replaceAddressId, { ...input.address, type: 'SHIPPING' })
          .catch((error) => { if (error?.code === 'ADDRESS_NOT_FOUND') return null; throw error; })
        : null;
      row = revised || (input.saveInfo ? await addressService.create(customerId, { ...input.address, type: 'SHIPPING' }) : null)
        || { ...Object.fromEntries(Object.entries(input.address).map(([key,value]) => [key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`), value])), country: 'IN' };
      if (input.saveInfo) addressId = row.id;
    }
    const snapshot = snapshotAddress(row);
    if (!await checkoutRepository.updateAddress(customerId, id, { addressId, snapshot })) throw new AppError('CHECKOUT_NOT_ACTIVE', 'Checkout session is not active.', 409);
    await this.#releaseCouponHold(id);
    await this.reallocateForAddress(customerId, id);
    return this.get(customerId, id);
  }

  async checkServiceability(customerId, id) {
    const row = await this.requireActive(customerId, id);
    const address = parseJson(row.shipping_address_snapshot);
    if (!address) throw new AppError('ADDRESS_REQUIRED', 'Select a shipping address first.', 409);
    const items = parseJson(row.items_snapshot, []);
    const result = await shippingService.quote({ postalCode: address.postalCode, contextType: 'CHECKOUT', items, shipmentValueMinor: Number(row.subtotal_minor) });
    if (!await checkoutRepository.updateServiceability(customerId, id, result)) throw new AppError('CHECKOUT_NOT_ACTIVE', 'Checkout session is not active.', 409);
    await this.#releaseCouponHold(id);
    return this.get(customerId, id);
  }

  async selectShipping(customerId, id, quoteId) {
    const row = await this.requireActive(customerId, id);
    const serviceability = parseJson(row.serviceability_snapshot);
    const methods = parseJson(row.shipping_methods_snapshot, []);
    if (!serviceability?.serviceable) throw new AppError('PIN_UNSERVICEABLE', 'This PIN code is not serviceable.', 409);
    const option = shippingService.resolveQuote({ ...serviceability, methods }, quoteId);
    if (!await checkoutRepository.selectShipping(customerId, id, option)) throw new AppError('CHECKOUT_NOT_ACTIVE', 'Checkout session is not active.', 409);
    await this.#releaseCouponHold(id);
    return this.get(customerId, id);
  }

  // Delivery quotes last 15 minutes (shipping settings quote_ttl_seconds). A
  // customer who took longer was stuck: every shipping choice and the payment
  // were refused as expired, and nothing asked the couriers again.
  async refreshShippingQuote(customerId, id) {
    const row = await this.requireActive(customerId, id);
    const address = parseJson(row.shipping_address_snapshot);
    if (!address) throw new AppError('ADDRESS_REQUIRED', 'Select a shipping address first.', 409);
    const items = parseJson(row.items_snapshot, []);
    const fresh = await shippingService.quote({ postalCode: address.postalCode, contextType: 'CHECKOUT', items, shipmentValueMinor: Number(row.subtotal_minor) });
    const plan = planShippingRefresh(parseJson(row.shipping_quote_snapshot), fresh);
    const updated = plan.action === 'RESET'
      ? await checkoutRepository.updateServiceability(customerId, id, fresh)
      : await checkoutRepository.refreshQuote(customerId, id, fresh, plan.action === 'KEEP' ? plan.option : null);
    if (!updated) throw new AppError('CHECKOUT_CHANGED', 'Your checkout changed while delivery was being re-checked. Please try again.', 409);
    if (plan.action === 'RESET') await this.#releaseCouponHold(id);
    return { ...await this.get(customerId, id), shippingRefresh: { kept: plan.action !== 'RESET', reason: plan.reason || null } };
  }

  async cancel(customerId, id) {
    return withTransaction(async (connection) => {
      const row = await checkoutRepository.findOwned(customerId, id, connection, { lock: true });
      if (!row) throw new AppError('CHECKOUT_NOT_FOUND', 'Checkout session not found.', 404);
      if (row.status === 'CANCELLED') return this.map(row, await cartService.getCart(customerId, { create: false, connection }));
      if (!['EXPIRED'].includes(row.status)) await inventoryService.releaseReservation(row.inventory_reservation_id, { connection });
      // Wave 8G-6: an un-consumed promotion reservation is released here (§108).
      await promotionService.releaseCheckout({ checkoutId: id, reason: 'CHECKOUT_CANCELLED' }, connection);
      await checkoutRepository.markStatus(connection, customerId, id, 'CANCELLED');
      return this.map(await checkoutRepository.findOwned(customerId, id, connection), await cartService.getCart(customerId, { create: false, connection }));
    });
  }

  // ---- coupons (Wave 8G-6) ------------------------------------------
  async #promotionLines(row) {
    const items = parseJson(row.items_snapshot, []);
    const productIds = [...new Set(items.map((i) => i.productId).filter(Boolean))];
    let catByProduct = {};
    let colByProduct = {};
    if (productIds.length) {
      const ph = productIds.map(() => '?').join(',');
      const cats = await query(`SELECT product_id, category_id FROM product_categories WHERE product_id IN (${ph})`, productIds);
      const cols = await query(`SELECT product_id, collection_id FROM product_collections WHERE product_id IN (${ph})`, productIds);
      for (const r of cats) (catByProduct[r.product_id] ||= []).push(r.category_id);
      for (const r of cols) (colByProduct[r.product_id] ||= []).push(r.collection_id);
    }
    return items.map((i) => ({
      lineKey: i.skuId,
      productId: i.productId,
      categoryIds: catByProduct[i.productId] || [],
      collectionIds: colByProduct[i.productId] || [],
      unitPriceMinor: Number(i.unitPriceMinor),
      quantity: Number(i.quantity),
    }));
  }

  // The change above already cleared the checkout's discount, so a failed
  // release must not fail the customer's step. It must not vanish either: the
  // redemption stays RESERVED and holds a usage slot until its 30-minute
  // expiry, which on a one-use code locks every other customer out.
  async #releaseCouponHold(checkoutId) {
    try {
      await promotionService.releaseCheckout({ checkoutId, reason: 'CHECKOUT_CHANGED' });
    } catch (error) {
      log.error('coupon_release_failed', { checkoutId, code: error?.code || 'FAILED', message: error?.message });
    }
  }

  async applyCoupon(customerId, id, code) {
    const row = await this.requireActive(customerId, id);
    const lines = await this.#promotionLines(row);
    const result = await promotionService.applyToCheckout({
      customerId, checkoutId: id, subtotalMinor: Number(row.subtotal_minor), lines, couponCode: code,
    });
    if (!await checkoutRepository.applyDiscount(customerId, id, {
      couponCode: result.couponCode, discountMinor: result.totalDiscountMinor, context: result.context,
    })) {
      await promotionService.releaseCheckout({ checkoutId: id, reason: 'APPLY_FAILED' });
      throw new AppError('CHECKOUT_NOT_ACTIVE', 'Checkout session is not active.', 409);
    }
    return this.get(customerId, id);
  }

  async removeCoupon(customerId, id) {
    await this.requireActive(customerId, id);
    await promotionService.releaseCheckout({ checkoutId: id, reason: 'COUPON_REMOVED' });
    await checkoutRepository.clearDiscount(customerId, id);
    return this.get(customerId, id);
  }

  async revalidate(customerId, id, idempotencyKey) {
    await this.cancel(customerId, id);
    return this.create(customerId, idempotencyKey);
  }

  /**
   * Keep a checkout's stock held while its customer is still on it. The
   * storefront calls this every few minutes while the page is visible and in
   * use; an abandoned checkout stops calling and its hold runs out as before.
   */
  async keepAlive(customerId, id) {
    const row = await checkoutRepository.findOwned(customerId, id);
    if (!row) throw new AppError('CHECKOUT_NOT_FOUND', 'Checkout session not found.', 404);
    if (['ACTIVE', 'READY_FOR_PAYMENT'].includes(row.status) && row.reservation_status === 'RESERVED' && !reservationExpired(row)) {
      const expiresAt = await inventoryService.extendHold(row.inventory_reservation_id);
      if (expiresAt) await checkoutRepository.syncReservationExpiry(null, id, expiresAt);
    }
    return this.get(customerId, id);
  }

  /**
   * Take a fresh hold for a checkout whose hold ran out, on the same checkout,
   * so the address, delivery choice and coupon stay. When stock is gone the
   * refusal names each item and how many can still be had.
   */
  async renew(customerId, id) {
    // get() expires a lapsed hold and cancels a checkout whose cart changed.
    const current = await this.get(customerId, id);
    if (current.status !== 'EXPIRED') return current;
    await withTransaction(async (connection) => {
      const row = await checkoutRepository.findOwned(customerId, id, connection, { lock: true });
      if (!row || row.status !== 'EXPIRED') return;
      const items = parseJson(row.items_snapshot, []);
      const lines = items.map((item) => ({ skuId: item.skuId, quantity: Number(item.quantity) }));
      const address = parseJson(row.shipping_address_snapshot);
      const allocation = await warehouseAllocationService.allocate({ items: lines, destinationPostalCode: address?.postalCode || null });
      if (allocation.status !== ALLOCATION_STATUS.ALLOCATED) throw await this.#unavailableError(customerId, items);
      let reservation;
      try {
        reservation = await inventoryService.reserve(
          warehouseAllocationService.toReservationItems(allocation),
          { customerId, idempotencyKey: `checkout:${customerId}:${id}:renew:${Date.now()}`, connection },
        );
      } catch (error) {
        if (['INSUFFICIENT_STOCK', 'OUT_OF_STOCK'].includes(error?.code)) throw await this.#unavailableError(customerId, items);
        throw error;
      }
      await checkoutRepository.renewReservation(connection, customerId, id, {
        reservationId: reservation.id,
        reservationExpiresAt: reservation.expiresAt,
        allocation,
        status: row.shipping_quote_reference ? 'READY_FOR_PAYMENT' : 'ACTIVE',
      });
    });
    return this.get(customerId, id);
  }

  async #unavailableError(customerId, items) {
    const availability = await inventoryService.getAvailabilityForItems(
      items.map((item) => ({ skuId: item.skuId, quantity: Number(item.quantity) })), { customerId });
    const bySku = new Map(availability.map((row) => [row.skuId, row]));
    const unavailable = items
      .filter((item) => bySku.get(item.skuId) && bySku.get(item.skuId).status !== 'AVAILABLE')
      .map((item) => ({
        skuId: item.skuId, name: item.name, size: item.selectedSize || null,
        requested: Number(item.quantity), available: Number(bySku.get(item.skuId).available || 0),
      }));
    return new AppError('INSUFFICIENT_STOCK', 'Some items in your checkout are no longer available.', 409, { unavailable });
  }

  async requireActive(customerId, id) {
    await this.get(customerId, id);
    const row = await checkoutRepository.findOwned(customerId, id);
    if (!row) throw new AppError('CHECKOUT_NOT_FOUND', 'Checkout session not found.', 404);
    if (!['ACTIVE','READY_FOR_PAYMENT'].includes(row.status) || row.reservation_status !== 'RESERVED') throw new AppError('CHECKOUT_NOT_ACTIVE', 'Checkout session is not active.', 409);
    return row;
  }

  map(row, cart) {
    const address = parseJson(row.shipping_address_snapshot);
    const serviceability = parseJson(row.serviceability_snapshot);
    const methods = parseJson(row.shipping_methods_snapshot, []);
    const blockers = [];
    if (row.status === 'EXPIRED' || row.reservation_status === 'EXPIRED') blockers.push('RESERVATION_EXPIRED');
    if (row.status === 'CANCELLED') blockers.push('CHECKOUT_CANCELLED');
    if (!address) blockers.push('ADDRESS_REQUIRED');
    if (address && !serviceability) blockers.push('SERVICEABILITY_REQUIRED');
    if (serviceability && !serviceability.serviceable) blockers.push('PIN_UNSERVICEABLE');
    if (serviceability?.serviceable && !row.shipping_quote_reference) blockers.push('SHIPPING_METHOD_REQUIRED');
    // Phase 2 · Slice 7 — a frozen shipping quote goes stale after its TTL;
    // the customer must re-check delivery before paying (no network here — a
    // pure timestamp check; the fresh-rate check runs at place-order).
    if (row.shipping_quote_reference && row.shipping_quote_expires_at
      && new Date(row.shipping_quote_expires_at) <= new Date()) blockers.push('SHIPPING_QUOTE_EXPIRED');
    const items = parseJson(row.items_snapshot, cart.items);
    const publicShipping = serviceability ? shippingService.toPublic({ ...serviceability, methods }) : null;
    const selected = parseJson(row.shipping_quote_snapshot);
    const selectedPublic = selected ? shippingService.toPublic({ providerChoiceMode: serviceability?.providerChoiceMode, methods: [{ code: selected.serviceLevel, name: selected.name, options: [selected] }], shippingRequestId: serviceability?.shippingRequestId, postalCode: serviceability?.postalCode, serviceable: true, status: 'SERVICEABLE', quoteIssuedAt: selected.quoteIssuedAt, quoteExpiresAt: selected.quoteExpiresAt, informational: false, shippingDataGap: serviceability?.shippingDataGap }).methods[0].options[0] : null;
    return { id: row.id, status: row.status, currency: row.currency, items, pricing: { subtotalMinor: Number(row.subtotal_minor), shippingMinor: Number(row.shipping_minor), discountMinor: Number(row.discount_minor || 0), appliedCoupon: row.coupon_code || null, totalMinor: Number(row.total_minor) }, shippingAddress: address, shippingAddressId: row.shipping_address_id || null, serviceability: publicShipping ? { ...publicShipping, methods: undefined } : null, shippingMethods: publicShipping?.methods || [], selectedShippingMethodCode: row.selected_shipping_method_code, selectedShippingQuoteId: row.shipping_quote_reference, selectedShippingOption: selectedPublic, inventory: { reservationStatus: row.reservation_status || 'RESERVED', reservationExpiresAt: row.reservation_expires_at }, readiness: { canProceedToPayment: row.status === 'READY_FOR_PAYMENT' && blockers.length === 0, blockers }, updatedAt: row.updated_at };
  }
}

export const checkoutService = new CheckoutService();
