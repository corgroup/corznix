import { withTransaction } from '../../database/connection/transaction.js';
import { pool } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { promotionRepository } from './repository.js';
import { evaluate } from './promotionEngine.js';
import { segmentService } from '../segments/service.js';

const RESERVATION_TTL_MS = 30 * 60 * 1000; // matches the checkout reservation horizon

/**
 * Redemption reservation runs at READ COMMITTED so `SELECT ... FOR UPDATE`
 * reads the latest committed rows (not the txn snapshot) and InnoDB takes no
 * gap locks — concurrent applies for the same promotion serialize cleanly on
 * the promotion row without deadlocking each other's inserts. The isolation
 * override applies only to this one transaction, then the connection reverts.
 */
async function withReadCommittedTransaction(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}
const normalizeCode = (c) => String(c || '').trim().toUpperCase();

const publicPromotion = (p) => ({
  id: p.id,
  name: p.name,
  description: p.description ?? null,
  version: Number(p.version),
  status: p.status,
  triggerType: p.trigger_type,
  discountType: p.discount_type,
  discountScope: p.discount_scope,
  discountValue: Number(p.discount_value),
  maxDiscountMinor: p.max_discount_minor == null ? null : Number(p.max_discount_minor),
  startsAt: p.starts_at, endsAt: p.ends_at,
  minSubtotalMinor: Number(p.min_subtotal_minor),
  minQuantity: Number(p.min_quantity),
  eligibleProductIds: p.eligible_product_ids || [],
  eligibleCategoryIds: p.eligible_category_ids || [],
  eligibleCollectionIds: p.eligible_collection_ids || [],
  eligibleSegmentId: p.eligible_segment_id ?? null,
  firstOrderOnly: Boolean(p.first_order_only),
  usageLimitTotal: p.usage_limit_total == null ? null : Number(p.usage_limit_total),
  usageLimitPerCustomer: Number(p.usage_limit_per_customer),
  redeemedCount: Number(p.redeemed_count),
  stackable: Boolean(p.stackable),
  priority: Number(p.priority),
  restorePolicy: p.restore_policy,
  couponCount: p.coupon_count != null ? Number(p.coupon_count) : undefined,
  createdAt: p.created_at, updatedAt: p.updated_at,
});

// The shape the engine consumes.
const toEnginePromo = (p) => ({
  id: p.id, version: Number(p.version), name: p.name,
  discountType: p.discount_type, discountScope: p.discount_scope,
  discountValue: Number(p.discount_value),
  maxDiscountMinor: p.max_discount_minor == null ? null : Number(p.max_discount_minor),
  minSubtotalMinor: Number(p.min_subtotal_minor), minQuantity: Number(p.min_quantity),
  eligibleProductIds: p.eligible_product_ids || [], eligibleCategoryIds: p.eligible_category_ids || [],
  eligibleCollectionIds: p.eligible_collection_ids || [], eligibleSegmentId: p.eligible_segment_id ?? null,
  firstOrderOnly: Boolean(p.first_order_only), stackable: Boolean(p.stackable), priority: Number(p.priority),
});

const windowOpen = (p, now) =>
  (!p.starts_at || new Date(p.starts_at) <= now) && (!p.ends_at || new Date(p.ends_at) > now);

/**
 * Backend-authoritative promotions + coupons (Wave 8G-6). The client only ever
 * sends a coupon code; every eligibility check and the discount arithmetic
 * happen here. Redemption is RESERVED at checkout and CONSUMED once at order
 * finalization — usage-limit races resolve by locking the promotion row.
 */
export class PromotionService {
  constructor({ repository = promotionRepository, transaction = withTransaction, segments = segmentService } = {}) {
    this.repository = repository;
    this.transaction = transaction;
    this.segments = segments;
  }

  // ---- admin CRUD ---------------------------------------------------
  async list(filters) {
    return (await this.repository.list(filters)).map(publicPromotion);
  }

  async detail(id) {
    const p = await this.repository.byId(null, id);
    if (!p) throw new AppError('PROMOTION_NOT_FOUND', 'Promotion not found.', 404);
    const coupons = await this.repository.couponsFor(id);
    return { ...publicPromotion(p), coupons: coupons.map((c) => ({ id: c.id, code: c.code_display, status: c.status, createdAt: c.created_at })) };
  }

  #validateDraft(input) {
    if (!input.name || String(input.name).trim().length < 2) throw new AppError('VALIDATION_ERROR', 'A promotion name is required.', 400);
    if (!['PERCENTAGE', 'FIXED_AMOUNT'].includes(input.discountType)) throw new AppError('VALIDATION_ERROR', 'discountType must be PERCENTAGE or FIXED_AMOUNT.', 400);
    if (!['ORDER', 'ITEM'].includes(input.discountScope || 'ORDER')) throw new AppError('VALIDATION_ERROR', 'discountScope must be ORDER or ITEM.', 400);
    if (!Number.isInteger(input.discountValue) || input.discountValue <= 0) throw new AppError('VALIDATION_ERROR', 'discountValue must be a positive integer (bps or minor units).', 400);
    if (input.discountType === 'PERCENTAGE' && input.discountValue > 10000) throw new AppError('VALIDATION_ERROR', 'A percentage cannot exceed 10000 bps.', 400);
    if (input.maxDiscountMinor != null && (!Number.isInteger(input.maxDiscountMinor) || input.maxDiscountMinor < 0)) throw new AppError('VALIDATION_ERROR', 'maxDiscountMinor must be a non-negative integer.', 400);
    for (const k of ['minSubtotalMinor', 'minQuantity', 'usageLimitPerCustomer']) {
      if (input[k] != null && (!Number.isInteger(input[k]) || input[k] < 0)) throw new AppError('VALIDATION_ERROR', `${k} must be a non-negative integer.`, 400);
    }
    if (input.usageLimitTotal != null && (!Number.isInteger(input.usageLimitTotal) || input.usageLimitTotal < 1)) throw new AppError('VALIDATION_ERROR', 'usageLimitTotal must be a positive integer.', 400);
  }

  async create(input) {
    this.#validateDraft(input);
    const p = await this.repository.insertPromotion(null, {
      ...input,
      triggerType: input.triggerType || 'CODE_REQUIRED',
      discountScope: input.discountScope || 'ORDER',
    });
    return this.detail(p.id);
  }

  async update({ id, ...fields }) {
    const p = await this.repository.byId(null, id);
    if (!p) throw new AppError('PROMOTION_NOT_FOUND', 'Promotion not found.', 404);
    const col = {};
    const map = {
      name: 'name', description: 'description', status: 'status', triggerType: 'trigger_type',
      discountType: 'discount_type', discountScope: 'discount_scope', discountValue: 'discount_value',
      maxDiscountMinor: 'max_discount_minor', startsAt: 'starts_at', endsAt: 'ends_at',
      minSubtotalMinor: 'min_subtotal_minor', minQuantity: 'min_quantity',
      eligibleProductIds: 'eligible_product_ids', eligibleCategoryIds: 'eligible_category_ids',
      eligibleCollectionIds: 'eligible_collection_ids', eligibleSegmentId: 'eligible_segment_id',
      firstOrderOnly: 'first_order_only', usageLimitTotal: 'usage_limit_total',
      usageLimitPerCustomer: 'usage_limit_per_customer', stackable: 'stackable', priority: 'priority',
      restorePolicy: 'restore_policy',
    };
    // A rule-affecting change bumps `version` so order snapshots stay precise.
    const RULE_KEYS = new Set(['discountType', 'discountScope', 'discountValue', 'maxDiscountMinor', 'minSubtotalMinor',
      'minQuantity', 'eligibleProductIds', 'eligibleCategoryIds', 'eligibleCollectionIds', 'eligibleSegmentId', 'firstOrderOnly']);
    let bump = false;
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || !map[k]) continue;
      col[map[k]] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
      if (RULE_KEYS.has(k)) bump = true;
    }
    if (col.status && !['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].includes(col.status)) throw new AppError('VALIDATION_ERROR', 'Invalid status.', 400);
    if (!Object.keys(col).length) throw new AppError('VALIDATION_ERROR', 'Nothing to update.', 400);
    await this.repository.updatePromotion(null, id, col, { bumpVersion: bump });
    return this.detail(id);
  }

  async addCoupon({ promotionId, code }) {
    const p = await this.repository.byId(null, promotionId);
    if (!p) throw new AppError('PROMOTION_NOT_FOUND', 'Promotion not found.', 404);
    const codeNormalized = normalizeCode(code);
    if (!/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(codeNormalized)) {
      throw new AppError('VALIDATION_ERROR', 'A coupon code is 3-64 chars: letters, digits, hyphen, underscore.', 400);
    }
    if (await this.repository.couponByCode(null, codeNormalized)) throw new AppError('COUPON_CODE_TAKEN', 'That coupon code is already in use.', 409);
    await this.repository.insertCoupon(null, { promotionId, codeNormalized, codeDisplay: code.trim() });
    return this.detail(promotionId);
  }

  // ---- checkout: quote (no reservation) ---------------------------
  async #candidates(connection, { couponCode, now }) {
    const active = (await this.repository.list({ status: 'ACTIVE' }));
    const automatic = active.filter((p) => p.trigger_type === 'AUTOMATIC' && windowOpen(p, now));
    let couponPromo = null;
    let coupon = null;
    if (couponCode) {
      coupon = await this.repository.couponByCode(connection, normalizeCode(couponCode));
      if (!coupon || coupon.status !== 'ACTIVE') throw new AppError('COUPON_INVALID', 'That code is not valid.', 404);
      couponPromo = await this.repository.byId(connection, coupon.promotion_id);
      if (!couponPromo || couponPromo.status !== 'ACTIVE' || !windowOpen(couponPromo, now)) {
        throw new AppError('COUPON_INACTIVE', 'That code is not currently active.', 409);
      }
    }
    const seen = new Set();
    const promos = [];
    for (const p of [...(couponPromo ? [couponPromo] : []), ...automatic]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      promos.push(p);
    }
    return { promos, coupon, couponPromoId: couponPromo?.id ?? null };
  }

  async #buildContext({ customerId, subtotalMinor, lines, promos }) {
    const isFirstOrder = !(await this.repository.hasPriorPaidOrder(customerId));
    const segmentIds = new Set();
    for (const p of promos) {
      if (p.eligible_segment_id && await this.segments.isMember(p.eligible_segment_id, customerId)) {
        segmentIds.add(p.eligible_segment_id);
      }
    }
    return { subtotalMinor, lines, segmentIds, isFirstOrder };
  }

  /** Compute the discount for a cart. Never reserves, never trusts a client amount. */
  async quote({ customerId, subtotalMinor, lines, couponCode = null, now = new Date() }) {
    const { promos, couponPromoId } = await this.#candidates(null, { couponCode, now });
    const ctx = await this.#buildContext({ customerId, subtotalMinor, lines, promos });
    const result = evaluate(promos.map(toEnginePromo), ctx);
    const couponApplied = couponPromoId ? result.appliedPromotions.some((a) => a.promotionId === couponPromoId) : null;
    if (couponCode && couponPromoId && !couponApplied) {
      const why = result.rejected.find((r) => r.promotionId === couponPromoId)?.reason || 'COUPON_NOT_ELIGIBLE';
      throw new AppError('COUPON_NOT_ELIGIBLE', `This code can't be applied: ${why}.`, 409, { reason: why });
    }
    return {
      couponCode: couponApplied ? normalizeCode(couponCode) : null,
      totalDiscountMinor: result.totalDiscountMinor,
      appliedPromotions: result.appliedPromotions,
      lineAllocations: result.lineAllocations,
      rejected: result.rejected,
    };
  }

  /**
   * Apply to a checkout: quote, then RESERVE each applied promotion under its
   * row lock, enforcing the global + per-customer limits (§104/§105). Any
   * previously reserved (uncommitted) redemption for this checkout is cleared
   * first so re-quoting is safe.
   */
  async applyToCheckout({ customerId, checkoutId, subtotalMinor, lines, couponCode = null, now = new Date() }) {
    return withReadCommittedTransaction(async (tx) => {
      await this.repository.releaseUnconsumedForCheckout(tx, checkoutId);
      const { promos, coupon, couponPromoId } = await this.#candidates(tx, { couponCode, now });
      const ctx = await this.#buildContext({ customerId, subtotalMinor, lines, promos });
      const result = evaluate(promos.map(toEnginePromo), ctx);

      const expiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
      const reserved = [];
      for (const applied of result.appliedPromotions) {
        // Lock the promotion row — this is the serialization point for the
        // usage-limit races.
        const promo = await this.repository.byId(tx, applied.promotionId, { lock: true });
        const total = await this.repository.liveTotal(tx, promo.id);
        if (promo.usage_limit_total != null && total >= Number(promo.usage_limit_total)) {
          if (promo.id === couponPromoId) throw new AppError('COUPON_LIMIT_REACHED', 'This code has been fully redeemed.', 409);
          continue;
        }
        const mine = await this.repository.liveForCustomer(tx, promo.id, customerId);
        if (mine >= Number(promo.usage_limit_per_customer)) {
          if (promo.id === couponPromoId) throw new AppError('COUPON_ALREADY_USED', 'You have already used this code.', 409);
          continue;
        }
        await this.repository.insertReservation(tx, {
          promotionId: promo.id,
          couponId: promo.id === couponPromoId ? coupon?.id ?? null : null,
          customerId, checkoutId, discountMinor: applied.discountMinor, expiresAt,
        });
        reserved.push(applied);
      }

      if (couponCode && couponPromoId && !reserved.some((r) => r.promotionId === couponPromoId)) {
        const why = result.rejected.find((r) => r.promotionId === couponPromoId)?.reason || 'COUPON_NOT_ELIGIBLE';
        throw new AppError('COUPON_NOT_ELIGIBLE', `This code can't be applied: ${why}.`, 409, { reason: why });
      }

      // Re-run the engine over just the reservable promotions so the persisted
      // allocation matches exactly what was reserved.
      const reservedIds = new Set(reserved.map((r) => r.promotionId));
      const finalResult = evaluate(promos.filter((p) => reservedIds.has(p.id)).map(toEnginePromo), ctx);
      for (const applied of finalResult.appliedPromotions) {
        const row = await this.repository.redemptionForCheckout(tx, applied.promotionId, checkoutId);
        if (row && row.discount_minor !== applied.discountMinor) {
          await this.repository.updateReservationDiscount(tx, row.id, applied.discountMinor);
        }
      }

      return {
        couponCode: couponPromoId && reservedIds.has(couponPromoId) ? normalizeCode(couponCode) : null,
        totalDiscountMinor: finalResult.totalDiscountMinor,
        appliedPromotions: finalResult.appliedPromotions,
        lineAllocations: finalResult.lineAllocations,
        context: {
          appliedPromotions: finalResult.appliedPromotions,
          lineAllocations: finalResult.lineAllocations,
          couponCode: couponPromoId && reservedIds.has(couponPromoId) ? normalizeCode(couponCode) : null,
          isFirstOrder: ctx.isFirstOrder,
          evaluatedAt: now.toISOString(),
        },
      };
    });
  }

  releaseCheckout({ checkoutId, reason = 'CHECKOUT_CANCELLED' }, connection = null) {
    return connection
      ? this.repository.releaseForCheckout(connection, { checkoutId, reason })
      : this.transaction((tx) => this.repository.releaseForCheckout(tx, { checkoutId, reason }));
  }

  /**
   * Order finalization: CONSUME each reserved redemption for this checkout
   * exactly once and freeze the discount snapshot (§109/§114/§115). Idempotent
   * against duplicate finalization / duplicate payment webhook.
   */
  async consumeForOrder({ checkoutId, orderId, context, orderItems }, connection) {
    const run = async (tx) => {
      const rows = await this.repository.reservationsForCheckout(tx, checkoutId);
      let consumedTotal = 0;
      for (const row of rows) {
        const applied = (context?.appliedPromotions || []).find((a) => a.promotionId === row.promotion_id);
        const discountMinor = applied ? applied.discountMinor : Number(row.discount_minor);
        const didConsume = await this.repository.consumeForCheckout(tx, {
          promotionId: row.promotion_id, checkoutId, orderId, discountMinor,
        });
        // Only a fresh RESERVED -> CONSUMED transition counts / writes a
        // snapshot. An already-CONSUMED row (duplicate finalize / webhook) is a
        // no-op — DUPLICATE_REDEMPTION stays 0.
        if (!didConsume) continue;
        consumedTotal += discountMinor;

        {
          const promo = await this.repository.byId(tx, row.promotion_id);
          await this.repository.insertOrderDiscount(tx, {
            orderId, promotionId: promo.id, promotionVersion: Number(promo.version),
            couponCode: row.coupon_id ? context?.couponCode ?? null : null,
            discountType: promo.discount_type, discountScope: promo.discount_scope,
            discountValue: Number(promo.discount_value), discountTotalMinor: discountMinor,
            eligibilityContext: { isFirstOrder: context?.isFirstOrder ?? null, evaluatedAt: context?.evaluatedAt ?? null },
          });
          for (const alloc of context?.lineAllocations || []) {
            const item = (orderItems || []).find((it) => it.lineKey === alloc.lineKey || it.skuId === alloc.lineKey);
            if (item && alloc.discountMinor > 0) {
              await this.repository.insertOrderItemDiscount(tx, {
                orderId, orderItemId: item.id, promotionId: promo.id, discountMinor: alloc.discountMinor,
              });
            }
          }
        }
      }
      return { consumedTotalMinor: consumedTotal };
    };
    return connection ? run(connection) : this.transaction(run);
  }

  expireStale() {
    return this.repository.expireStale();
  }
}

export const promotionService = new PromotionService();
