import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { inventoryService } from '../inventory/service.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

/**
 * Same-style exchange target validation (§43-46). A same-style target is
 * another sellable SKU under the SAME commercial product — a different product
 * is denied here and routed to Different-Style Exchange (8F-4).
 *
 * The frontend's target is never trusted: existence, active state, product
 * identity, live stock and the price-difference policy are all re-checked on
 * the backend.
 */
export class ExchangeService {
  constructor({ inventory = inventoryService } = {}) {
    this.inventory = inventory;
  }

  #loadTargetSku(connection, targetSkuId) {
    return exec(connection,
      `SELECT s.id AS sku_id, s.status AS sku_status, s.price_minor, s.sale_price_minor,
              COALESCE(s.sale_price_minor, s.price_minor) AS effective_price_minor,
              v.id AS variant_id, v.status AS variant_status,
              p.id AS product_id, p.status AS product_status
         FROM skus s
         JOIN product_variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
        WHERE s.id = ? LIMIT 1`, [targetSkuId]).then((r) => r[0] || null);
  }

  /**
   * Validate a same-style target for one request line. Returns the frozen
   * target snapshot to persist, plus the price-difference policy outcome:
   *   NOT_REQUIRED              equal price — proceed
   *   CONFIGURED               price differs, EVEN_EXCHANGE policy set — proceed, no money moves
   *   (throws)                 price differs, no policy — SAME_STYLE_PRICE_POLICY_REQUIRED
   */
  async assessSameStyleTarget({ connection = null, orderItem, targetSkuId, quantity, policy }) {
    if (!targetSkuId) {
      throw new AppError('EXCHANGE_TARGET_REQUIRED', 'A target SKU is required for a same-style exchange.', 400);
    }
    const target = await this.#loadTargetSku(connection, targetSkuId);
    if (!target) throw new AppError('EXCHANGE_TARGET_NOT_FOUND', 'The exchange target does not exist.', 404);

    if (target.product_id !== orderItem.product_id) {
      throw new AppError('SAME_STYLE_DIFFERENT_PRODUCT',
        'That target belongs to a different product. Use a different-style exchange instead.', 409);
    }
    if (target.sku_id === orderItem.sku_id) {
      throw new AppError('SAME_STYLE_NO_CHANGE', 'The target is the size/variant you already have.', 409);
    }
    if (target.sku_status !== 'ACTIVE' || target.variant_status !== 'ACTIVE' || target.product_status !== 'ACTIVE') {
      throw new AppError('EXCHANGE_TARGET_INACTIVE', 'The exchange target is not currently available.', 409);
    }

    // Live cross-warehouse stock check (hard reservation happens at release).
    const [availability] = await this.inventory.getAvailabilityForItems([{ skuId: targetSkuId, quantity }]);
    if (availability.status !== 'AVAILABLE') {
      throw new AppError('SAME_STYLE_TARGET_OUT_OF_STOCK', 'The exchange target is not in stock.', 409);
    }

    const targetPrice = Number(target.effective_price_minor);
    const paid = Number(orderItem.unit_price_minor);
    const priceDifferenceMinor = targetPrice - paid;

    let pricePolicyOutcome;
    if (priceDifferenceMinor === 0) {
      pricePolicyOutcome = 'NOT_REQUIRED';
    } else if (policy.sameStylePriceDifferencePolicy === 'EVEN_EXCHANGE') {
      pricePolicyOutcome = 'CONFIGURED'; // business absorbs the delta — no charge, no refund
    } else {
      throw new AppError('SAME_STYLE_PRICE_POLICY_REQUIRED',
        'This same-style exchange changes the price and no same-style price policy is configured.',
        409, { priceDifferenceMinor, targetUnitPriceMinor: targetPrice, paidUnitPriceMinor: paid });
    }

    return {
      targetProductId: target.product_id,
      targetVariantId: target.variant_id,
      targetSkuId: target.sku_id,
      targetUnitPriceMinor: targetPrice,
      priceDifferenceMinor,
      pricePolicyOutcome,
    };
  }
}

export const exchangeService = new ExchangeService();
