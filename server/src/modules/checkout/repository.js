import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { serializeAllocation } from '../warehouses/allocationSnapshot.js';

const exec = async (connection, sql, params = []) => connection ? (await connection.execute(sql, params))[0] : query(sql, params);

export class CheckoutRepository {
  async findOwned(customerId, id, connection = null, { lock = false } = {}) {
    const rows = await exec(connection,
      `SELECT cs.*,ir.status AS reservation_status,(ir.expires_at<=NOW(3)) AS reservation_is_expired FROM checkout_sessions cs
       JOIN inventory_reservations ir ON ir.id=cs.inventory_reservation_id
       WHERE cs.id=? AND cs.customer_id=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id, customerId]);
    return rows[0] || null;
  }

  async findByIdempotency(customerId, key, connection = null) {
    const rows = await exec(connection,
      `SELECT cs.*,ir.status AS reservation_status,(ir.expires_at<=NOW(3)) AS reservation_is_expired
       FROM checkout_sessions cs JOIN inventory_reservations ir ON ir.id=cs.inventory_reservation_id
       WHERE cs.customer_id=? AND cs.idempotency_key=? LIMIT 1`, [customerId, key]);
    return rows[0] || null;
  }

  async findCurrent(customerId, connection = null, { lock = false } = {}) {
    const rows = await exec(connection,
      `SELECT cs.*,ir.status AS reservation_status,(ir.expires_at<=NOW(3)) AS reservation_is_expired
       FROM checkout_sessions cs JOIN inventory_reservations ir ON ir.id=cs.inventory_reservation_id
       WHERE cs.customer_id=? AND cs.status IN ('ACTIVE','READY_FOR_PAYMENT','EXPIRED')
       ORDER BY cs.updated_at DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [customerId]);
    return rows[0] || null;
  }

  // Multi-company (DESIGN.md §4.1) — Phase 4. brand_id derived from the
  // customer's own row (never a separate caller-supplied value) — a
  // checkout session always belongs to the same company as its customer.
  async create(connection, input) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO checkout_sessions
       (id,brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,items_snapshot,status,currency,
        subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at,warehouse_allocation_json)
       VALUES (?,(SELECT brand_id FROM customers WHERE id = ?),?,?,?,?,?,?,'ACTIVE',?,?,0,?,?,?,?)`,
      [id,input.customerId,input.customerId,input.cartId,input.reservationId,input.idempotencyKey,input.cartFingerprint,JSON.stringify(input.items),input.currency,input.subtotalMinor,input.subtotalMinor,input.reservationExpiresAt,input.reservationExpiresAt,
       input.warehouseAllocation ? JSON.stringify(serializeAllocation(input.warehouseAllocation)) : null]);
    return this.findOwned(input.customerId, id, connection);
  }

  async swapReservation(connection, customerId, id, { reservationId, reservationExpiresAt, allocation }) {
    await exec(connection,
      `UPDATE checkout_sessions SET inventory_reservation_id=?,reservation_expires_at=?,warehouse_allocation_json=?,updated_at=NOW(3)
       WHERE id=? AND customer_id=? AND status IN ('ACTIVE','READY_FOR_PAYMENT')`,
      [reservationId, reservationExpiresAt, JSON.stringify(serializeAllocation(allocation)), id, customerId]);
  }

  async updateAddress(customerId, id, { addressId, snapshot }) {
    const result = await query(
      `UPDATE checkout_sessions SET shipping_address_id=?,shipping_address_snapshot=?,serviceability_snapshot=NULL,
       shipping_methods_snapshot=NULL,selected_shipping_method_code=NULL,shipping_minor=0,
       coupon_code=NULL,discount_minor=0,promotion_context_json=NULL,total_minor=subtotal_minor,
       selected_provider_code=NULL,selected_provider_service_code=NULL,shipping_quote_reference=NULL,
       shipping_quote_snapshot=NULL,shipping_quote_selected_at=NULL,shipping_quote_expires_at=NULL,
       status='ACTIVE',updated_at=NOW(3) WHERE id=? AND customer_id=? AND status IN ('ACTIVE','READY_FOR_PAYMENT')`,
      [addressId, JSON.stringify(snapshot), id, customerId]);
    if (result.affectedRows) await query('DELETE FROM checkout_payment_eligibility WHERE checkout_id=?',[id]);
    return result.affectedRows > 0;
  }

  // Wave 8G-6: fold an applied coupon's discount into total_minor so the whole
  // payment pipeline (eligibility, obligations, attempt amounts) stays
  // backend-authoritative. Re-derives total from the immutable subtotal +
  // current shipping to stay correct regardless of call order.
  async applyDiscount(customerId, id, { couponCode, discountMinor, context }) {
    const result = await query(
      `UPDATE checkout_sessions
          SET coupon_code=?, discount_minor=?, promotion_context_json=CAST(? AS JSON),
              total_minor = GREATEST(0, subtotal_minor + shipping_minor - ?), updated_at=NOW(3)
        WHERE id=? AND customer_id=? AND status IN ('ACTIVE','READY_FOR_PAYMENT')`,
      [couponCode ?? null, discountMinor, JSON.stringify(context ?? null), discountMinor, id, customerId]);
    if (result.affectedRows) await query('DELETE FROM checkout_payment_eligibility WHERE checkout_id=?',[id]);
    return result.affectedRows > 0;
  }

  async clearDiscount(customerId, id) {
    const result = await query(
      `UPDATE checkout_sessions
          SET coupon_code=NULL, discount_minor=0, promotion_context_json=NULL,
              total_minor = subtotal_minor + shipping_minor, updated_at=NOW(3)
        WHERE id=? AND customer_id=?`,
      [id, customerId]);
    if (result.affectedRows) await query('DELETE FROM checkout_payment_eligibility WHERE checkout_id=?',[id]);
    return result.affectedRows > 0;
  }

  async updateServiceability(customerId, id, result) {
    const { methods, ...serviceability } = result;
    const update = await query(
      `UPDATE checkout_sessions SET serviceability_snapshot=?,shipping_methods_snapshot=?,selected_shipping_method_code=NULL,
       selected_provider_code=NULL,selected_provider_service_code=NULL,shipping_quote_reference=NULL,
       shipping_quote_snapshot=NULL,shipping_quote_selected_at=NULL,shipping_quote_expires_at=NULL,
       coupon_code=NULL,discount_minor=0,promotion_context_json=NULL,
       shipping_minor=0,total_minor=subtotal_minor,status='ACTIVE',updated_at=NOW(3)
       WHERE id=? AND customer_id=? AND status IN ('ACTIVE','READY_FOR_PAYMENT')`,
      [JSON.stringify(serviceability), JSON.stringify(methods), id, customerId]);
    if (update.affectedRows) await query('DELETE FROM checkout_payment_eligibility WHERE checkout_id=?',[id]);
    return update.affectedRows > 0;
  }

  // Moves the checkout onto a fresh delivery quote. With an option, the
  // selection moves to that option's new quote id and expiry — same method and
  // the same charge (guarded by shipping_minor), so coupon, totals and status
  // stay as they are. Without one, only the quote snapshots change, and only
  // while nothing is selected.
  async refreshQuote(customerId, id, result, option) {
    const { methods, ...serviceability } = result;
    const update = option
      ? await query(
        `UPDATE checkout_sessions SET serviceability_snapshot=?,shipping_methods_snapshot=?,selected_provider_code=?,selected_provider_service_code=?,
         shipping_quote_reference=?,shipping_quote_snapshot=?,shipping_quote_expires_at=?,updated_at=NOW(3)
         WHERE id=? AND customer_id=? AND status IN ('ACTIVE','READY_FOR_PAYMENT') AND shipping_quote_reference IS NOT NULL AND shipping_minor=?`,
        [JSON.stringify(serviceability), JSON.stringify(methods), option.providerCode, option.providerServiceCode,
          option.quoteId, JSON.stringify(option), new Date(option.quoteExpiresAt), id, customerId, option.rateMinor])
      : await query(
        `UPDATE checkout_sessions SET serviceability_snapshot=?,shipping_methods_snapshot=?,updated_at=NOW(3)
         WHERE id=? AND customer_id=? AND status IN ('ACTIVE','READY_FOR_PAYMENT') AND shipping_quote_reference IS NULL`,
        [JSON.stringify(serviceability), JSON.stringify(methods), id, customerId]);
    return update.affectedRows > 0;
  }

  async selectShipping(customerId, id, option) {
    const result = await query(
      `UPDATE checkout_sessions SET selected_shipping_method_code=?,selected_provider_code=?,selected_provider_service_code=?,
       shipping_quote_reference=?,shipping_quote_snapshot=?,shipping_quote_selected_at=NOW(3),shipping_quote_expires_at=?,
       coupon_code=NULL,discount_minor=0,promotion_context_json=NULL,
       shipping_minor=?,total_minor=subtotal_minor+?,
       status='READY_FOR_PAYMENT',updated_at=NOW(3) WHERE id=? AND customer_id=? AND status IN ('ACTIVE','READY_FOR_PAYMENT')`,
      [option.serviceLevel,option.providerCode,option.providerServiceCode,option.quoteId,JSON.stringify(option),new Date(option.quoteExpiresAt),
       option.rateMinor,option.rateMinor,id,customerId]);
    if (result.affectedRows) await query('DELETE FROM checkout_payment_eligibility WHERE checkout_id=?',[id]);
    return result.affectedRows > 0;
  }

  // Re-arm an expired checkout with a fresh hold, keeping its address,
  // delivery choice and coupon. Only EXPIRED qualifies: a cancelled checkout
  // was left on purpose (the cart changed) and starts again.
  async renewReservation(connection, customerId, id, { reservationId, reservationExpiresAt, allocation, status }) {
    await exec(connection,
      `UPDATE checkout_sessions SET inventory_reservation_id=?,reservation_expires_at=?,expires_at=?,warehouse_allocation_json=?,status=?,updated_at=NOW(3)
       WHERE id=? AND customer_id=? AND status='EXPIRED'`,
      [reservationId, reservationExpiresAt, reservationExpiresAt, JSON.stringify(serializeAllocation(allocation)), status, id, customerId]);
  }

  async syncReservationExpiry(connection, id, expiresAt) {
    await exec(connection,
      `UPDATE checkout_sessions SET reservation_expires_at=?,expires_at=GREATEST(expires_at,?),updated_at=NOW(3)
       WHERE id=? AND status IN ('ACTIVE','READY_FOR_PAYMENT')`, [expiresAt, expiresAt, id]);
  }

  async markStatus(connection, customerId, id, status) {
    await exec(connection,
      `UPDATE checkout_sessions SET status=?,cancelled_at=IF(?='CANCELLED',NOW(3),cancelled_at),updated_at=NOW(3)
       WHERE id=? AND customer_id=?`, [status,status,id,customerId]);
  }
}

export const checkoutRepository = new CheckoutRepository();
