import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';
import { AppError } from '../../utils/errors.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

const jsonCols = ['eligible_product_ids', 'eligible_category_ids', 'eligible_collection_ids'];
const dateCols = ['starts_at', 'ends_at'];

// The admin API validates schedule fields as ISO-8601 (`z.string().datetime()`,
// which REQUIRES the trailing Z). MySQL rejects that literal for a DATETIME
// column — "Incorrect datetime value: '2026-09-10T02:26:51.081Z'" — so passing
// the validated string straight through turned every scheduled promotion into
// a 500. Nothing could be given a start or end date from the CMS at all; only
// seeds, which write MySQL-shaped literals, ever got dates in.
//
// mysql2 serialises a Date correctly, so the boundary converts once and both
// the insert and the update path inherit it. An unparseable value is a 400,
// never an Invalid Date silently stored as NULL.
const toDbDateTime = (value, field) => {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new AppError('VALIDATION_ERROR', `${field} is not a valid date.`, 400);
    return value;
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new AppError('VALIDATION_ERROR', `${field} is not a valid date.`, 400);
  return parsed;
};
const hydrate = (row) => {
  if (!row) return null;
  const out = { ...row };
  for (const c of jsonCols) out[c] = row[c] == null ? [] : (typeof row[c] === 'string' ? JSON.parse(row[c]) : row[c]);
  return out;
};

export class PromotionRepository {
  // ---- promotions CRUD ------------------------------------------------
  async list({ status = null, brandId = null } = {}) {
    const resolvedBrandId = await resolveBrandId(brandId);
    const where = ['p.brand_id = ?'];
    const params = [resolvedBrandId];
    if (status) { where.push('p.status = ?'); params.push(status); }
    return query(
      `SELECT p.*, (SELECT COUNT(*) FROM promotion_coupons pc WHERE pc.promotion_id = p.id) AS coupon_count
         FROM promotions p WHERE ${where.join(' AND ')}
        ORDER BY p.created_at DESC`, params).then((rows) => rows.map(hydrate));
  }

  byId(connection, id, { lock = false } = {}) {
    return exec(connection, `SELECT * FROM promotions WHERE id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id])
      .then((r) => hydrate(r[0] || null));
  }

  couponsFor(promotionId) {
    return query('SELECT id, code_display, code_normalized, status, created_at FROM promotion_coupons WHERE promotion_id = ? ORDER BY created_at', [promotionId]);
  }

  couponByCode(connection, codeNormalized) {
    return exec(connection,
      `SELECT c.*, p.id AS promo_id FROM promotion_coupons c JOIN promotions p ON p.id = c.promotion_id
        WHERE c.code_normalized = ? LIMIT 1`, [codeNormalized]).then((r) => r[0] || null);
  }

  async insertPromotion(connection, p) {
    const id = randomUUID();
    const brandId = await resolveBrandId(p.brandId);
    await exec(connection,
      `INSERT INTO promotions
        (id, brand_id, name, description, status, trigger_type, discount_type, discount_scope, discount_value, max_discount_minor,
         currency, starts_at, ends_at, min_subtotal_minor, min_quantity, eligible_product_ids, eligible_category_ids,
         eligible_collection_ids, eligible_segment_id, first_order_only, usage_limit_total, usage_limit_per_customer,
         stackable, priority, restore_policy, created_by_staff_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),CAST(? AS JSON),?,?,?,?,?,?,?,?)`,
      [id, brandId, p.name, p.description || null, p.status || 'DRAFT', p.triggerType, p.discountType, p.discountScope,
        p.discountValue, p.maxDiscountMinor ?? null, p.currency || 'INR',
        toDbDateTime(p.startsAt, 'startsAt'), toDbDateTime(p.endsAt, 'endsAt'),
        p.minSubtotalMinor || 0, p.minQuantity || 0,
        JSON.stringify(p.eligibleProductIds || []), JSON.stringify(p.eligibleCategoryIds || []),
        JSON.stringify(p.eligibleCollectionIds || []), p.eligibleSegmentId ?? null, p.firstOrderOnly ? 1 : 0,
        p.usageLimitTotal ?? null, p.usageLimitPerCustomer ?? 1, p.stackable ? 1 : 0, p.priority ?? 100,
        p.restorePolicy || 'CONFIG_REQUIRED', p.staffId ?? null]);
    return this.byId(connection, id);
  }

  async updatePromotion(connection, id, fields, { bumpVersion = false } = {}) {
    const cols = Object.keys(fields);
    const sets = cols.map((c) => `${jsonCols.includes(c) ? `${c} = CAST(? AS JSON)` : `${c} = ?`}`);
    if (bumpVersion) sets.push('version = version + 1');
    if (!sets.length) return;
    const vals = cols.map((c) => {
      if (jsonCols.includes(c)) return JSON.stringify(fields[c]);
      if (dateCols.includes(c)) return toDbDateTime(fields[c], c);
      return fields[c];
    });
    await exec(connection, `UPDATE promotions SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ?`, [...vals, id]);
  }

  async insertCoupon(connection, { promotionId, codeNormalized, codeDisplay }) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO promotion_coupons (id, promotion_id, code_normalized, code_display) VALUES (?,?,?,?)`,
      [id, promotionId, codeNormalized, codeDisplay]);
    return id;
  }

  // ---- redemption lifecycle (concurrency-safe, §104/§105) -----------
  /**
   * Count of live redemptions (CONSUMED + unexpired RESERVED). The trailing
   * `FOR UPDATE` forces a CURRENT read (not the txn's REPEATABLE-READ snapshot)
   * and locks the matching rows — combined with the promotion-row lock the
   * caller already holds, this is the serialization point for the usage-limit
   * races (§104/§105). MySQL is fine with `SELECT COUNT(*) ... FOR UPDATE`.
   */
  liveTotal(connection, promotionId) {
    return exec(connection,
      `SELECT COUNT(*) AS n FROM promotion_redemptions
        WHERE promotion_id = ? AND (status = 'CONSUMED' OR (status = 'RESERVED' AND (expires_at IS NULL OR expires_at > NOW(3))))
        FOR UPDATE`,
      [promotionId]).then((r) => Number(r[0].n));
  }

  liveForCustomer(connection, promotionId, customerId) {
    return exec(connection,
      `SELECT COUNT(*) AS n FROM promotion_redemptions
        WHERE promotion_id = ? AND customer_id = ?
          AND (status = 'CONSUMED' OR (status = 'RESERVED' AND (expires_at IS NULL OR expires_at > NOW(3))))
        FOR UPDATE`,
      [promotionId, customerId]).then((r) => Number(r[0].n));
  }

  /**
   * Release (not delete) every un-consumed reservation for a checkout. Used
   * when a coupon is re-quoted or the cart/address/shipping changed. A DELETE
   * here would gap-lock an unindexed scan and deadlock concurrent applies —
   * a targeted UPDATE on the checkout index does not.
   */
  releaseUnconsumedForCheckout(connection, checkoutId) {
    return exec(connection,
      "UPDATE promotion_redemptions SET status = 'RELEASED', released_at = NOW(3), release_reason = 'REQUOTED' WHERE checkout_id = ? AND status = 'RESERVED'",
      [checkoutId]);
  }

  redemptionForCheckout(connection, promotionId, checkoutId) {
    return exec(connection,
      'SELECT * FROM promotion_redemptions WHERE promotion_id = ? AND checkout_id = ? LIMIT 1',
      [promotionId, checkoutId]).then((r) => r[0] || null);
  }

  reservationsForCheckout(connection, checkoutId) {
    return exec(connection,
      "SELECT * FROM promotion_redemptions WHERE checkout_id = ? AND status IN ('RESERVED','CONSUMED')", [checkoutId]);
  }

  /**
   * Reserve one redemption for (promotion, checkout). Idempotent on the unique
   * key — re-quoting the same checkout moves a RELEASED/EXPIRED row back to
   * RESERVED without a scanning delete. A CONSUMED row is never disturbed.
   */
  async insertReservation(connection, { promotionId, couponId, customerId, checkoutId, discountMinor, expiresAt }) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO promotion_redemptions
        (id, promotion_id, coupon_id, customer_id, checkout_id, status, discount_minor, expires_at)
       VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?) AS new
       ON DUPLICATE KEY UPDATE
         status = IF(promotion_redemptions.status = 'CONSUMED', promotion_redemptions.status, 'RESERVED'),
         coupon_id = new.coupon_id,
         discount_minor = new.discount_minor,
         expires_at = new.expires_at,
         released_at = NULL,
         release_reason = NULL,
         reserved_at = NOW(3)`,
      [id, promotionId, couponId ?? null, customerId, checkoutId, discountMinor, expiresAt ?? null]);
    return id;
  }

  updateReservationDiscount(connection, id, discountMinor) {
    return exec(connection, 'UPDATE promotion_redemptions SET discount_minor = ? WHERE id = ? AND status = \'RESERVED\'', [discountMinor, id]);
  }

  /** RESERVED -> CONSUMED for one checkout's redemption, attaching the order. Idempotent. */
  async consumeForCheckout(connection, { promotionId, checkoutId, orderId, discountMinor }) {
    const res = await exec(connection,
      `UPDATE promotion_redemptions
          SET status = 'CONSUMED', order_id = ?, discount_minor = ?, consumed_at = NOW(3)
        WHERE promotion_id = ? AND checkout_id = ? AND status = 'RESERVED'`,
      [orderId, discountMinor, promotionId, checkoutId]);
    if (res.affectedRows === 1) {
      await exec(connection, 'UPDATE promotions SET redeemed_count = redeemed_count + 1 WHERE id = ?', [promotionId]);
    }
    return res.affectedRows === 1;
  }

  releaseForCheckout(connection, { checkoutId, reason }) {
    return exec(connection,
      `UPDATE promotion_redemptions SET status = 'RELEASED', released_at = NOW(3), release_reason = ?
        WHERE checkout_id = ? AND status = 'RESERVED'`, [reason || 'RELEASED', checkoutId]).then((r) => r.affectedRows);
  }

  expireStale(limit = 500) {
    return query(
      `UPDATE promotion_redemptions SET status = 'EXPIRED', released_at = NOW(3), release_reason = 'EXPIRED'
        WHERE status = 'RESERVED' AND expires_at IS NOT NULL AND expires_at <= NOW(3)
        LIMIT ${Number(limit)}`).then((r) => r.affectedRows);
  }

  redemptionsForOrder(orderId) {
    return query('SELECT * FROM promotion_redemptions WHERE order_id = ?', [orderId]);
  }

  // ---- order discount snapshot (immutable, §115) -------------------
  async insertOrderDiscount(connection, d) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO order_discounts
        (id, order_id, promotion_id, promotion_version, coupon_code, discount_type, discount_scope, discount_value, discount_total_minor, eligibility_context_json)
       VALUES (?,?,?,?,?,?,?,?,?, CAST(? AS JSON))`,
      [id, d.orderId, d.promotionId, d.promotionVersion, d.couponCode ?? null, d.discountType, d.discountScope,
        d.discountValue, d.discountTotalMinor, JSON.stringify(d.eligibilityContext ?? null)]);
    return id;
  }

  insertOrderItemDiscount(connection, { orderId, orderItemId, promotionId, discountMinor }) {
    return exec(connection,
      `INSERT INTO order_item_discounts (id, order_id, order_item_id, promotion_id, discount_minor) VALUES (?,?,?,?,?)`,
      [randomUUID(), orderId, orderItemId, promotionId, discountMinor]);
  }

  orderDiscounts(orderId) {
    return query('SELECT * FROM order_discounts WHERE order_id = ?', [orderId]);
  }

  orderItemDiscounts(orderId) {
    return query('SELECT * FROM order_item_discounts WHERE order_id = ?', [orderId]);
  }

  // ---- first-order truth (§118) -----------------------------------
  hasPriorPaidOrder(customerId) {
    return query(
      "SELECT 1 FROM orders WHERE customer_id = ? AND payment_status IN ('PAID','COD_DUE','PARTIALLY_PAID') LIMIT 1",
      [customerId]).then((r) => r.length > 0);
  }
}

export const promotionRepository = new PromotionRepository();
