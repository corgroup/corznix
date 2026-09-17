import { AppError } from '../../utils/errors.js';
import { returnsRepository } from './repository.js';
import { returnPolicyService } from './returnPolicyService.js';
import { exchangeService } from './exchangeService.js';

export const REQUEST_TYPES = Object.freeze([
  'RETURN', 'REPLACEMENT', 'SAME_STYLE_EXCHANGE', 'DIFFERENT_STYLE_EXCHANGE',
]);

// A request can still be cancelled by the customer up to (but not including)
// the point a reverse pickup is booked — that is the irreversible boundary (§25).
export const CANCELLABLE_STATUSES = Object.freeze(['REQUESTED', 'APPROVED', 'PICKUP_PENDING']);

const DAY_MS = 24 * 60 * 60 * 1000;
const addDays = (date, days) => new Date(new Date(date).getTime() + days * DAY_MS);

/**
 * The single backend authority on whether an order item may be returned /
 * replaced / exchanged, in what quantity, and for what value (§14). The
 * frontend never computes any of this.
 */
export class ReturnEligibilityService {
  constructor({ repository = returnsRepository, policyService = returnPolicyService } = {}) {
    this.repository = repository;
    this.policyService = policyService;
  }

  #lineEligibility(row, policy, { now = new Date() } = {}) {
    const orderedQuantity = Number(row.ordered_quantity);
    const heldQuantity = Number(row.held_quantity || 0);
    const remaining = Math.max(orderedQuantity - heldQuantity, 0);
    const deliveredAt = row.delivered_at ? new Date(row.delivered_at) : null;
    const unitPriceMinor = Number(row.unit_price_minor);

    // The window shown to the customer uses the plain return window; a specific
    // action re-checks against its own window in assessForRequest().
    const returnDeadline = deliveredAt ? addDays(deliveredAt, policy.returnWindowDays) : null;

    let reasonCode = null;
    if (!deliveredAt) reasonCode = 'NOT_DELIVERED';
    else if (now > returnDeadline) reasonCode = 'WINDOW_EXPIRED';
    else if (remaining <= 0) reasonCode = 'FULLY_CONSUMED';

    const eligible = reasonCode === null;
    return {
      orderItemId: row.order_item_id,
      skuId: row.sku_id,
      sku: row.sku,
      productId: row.product_id,
      variantId: row.variant_id,
      productName: row.product_name,
      selectedSize: row.selected_size ?? null,
      selectedColor: row.selected_color ?? null,
      fulfillmentId: row.fulfillment_id ?? null,
      orderedQuantity,
      alreadyConsumedQuantity: heldQuantity,
      eligibleQuantity: remaining,
      unitPriceMinor,
      financialEligibleValueMinor: remaining * unitPriceMinor,
      deliveredAt,
      returnDeadline,
      eligible,
      reasonCode,
      allowedActions: eligible ? [...REQUEST_TYPES] : [],
    };
  }

  /**
   * Full eligibility read model for one owned order (§27). Cross-customer
   * access surfaces as ORDER_NOT_FOUND — no existence leak (§28).
   */
  async evaluateOrder({ customerId, orderId }) {
    if (!customerId || !orderId) throw new AppError('VALIDATION_ERROR', 'A customer and order are required.', 400);
    const order = await this.repository.ownedOrder(customerId, orderId);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);

    const policy = await this.policyService.get();
    const orderCancelled = order.order_status === 'CANCELLED';
    const rows = await this.repository.itemAccounting(null, order.id);
    const now = new Date();

    const items = rows.map((row) => {
      const line = this.#lineEligibility(row, policy, { now });
      if (orderCancelled) {
        return { ...line, eligible: false, allowedActions: [], reasonCode: line.reasonCode || 'ORDER_CANCELLED' };
      }
      return line;
    });

    return {
      orderId: order.id,
      orderNumber: order.order_number,
      orderStatus: order.order_status,
      // A COD order has no instrument to refund to, so the return form must ask
      // the customer where the money should go. Exposed as a boolean rather
      // than the raw payment_mode: the storefront needs the consequence, not
      // the internal enum.
      refundDestinationRequired: ['FULL_COD', 'PARTIAL_COD'].includes(order.payment_mode),
      policy: {
        returnWindowDays: policy.returnWindowDays,
        replacementWindowDays: policy.replacementWindowDays,
        exchangeWindowDays: policy.exchangeWindowDays,
        version: policy.version,
      },
      anyEligible: items.some((item) => item.eligible),
      items,
    };
  }

  /**
   * Focused assessment for a would-be request: validates the action + each
   * requested { orderItemId, quantity } line against its own window and the
   * live remaining quantity, and returns the frozen per-line snapshot the
   * request will persist (§23). Must be called inside the order row lock.
   */
  async assessForRequest({ connection, order, requestedAction, lines }) {
    if (!REQUEST_TYPES.includes(requestedAction)) {
      throw new AppError('VALIDATION_ERROR', `Unknown request type "${requestedAction}".`, 400);
    }
    if (order.order_status === 'CANCELLED') {
      throw new AppError('RETURN_NOT_ELIGIBLE', 'This order has been cancelled.', 409);
    }
    const policy = await this.policyService.get({ connection });
    const windowDays = this.policyService.windowDaysFor(requestedAction, policy);
    const rows = await this.repository.itemAccounting(connection, order.id);
    const byItem = new Map(rows.map((row) => [row.order_item_id, row]));
    const now = new Date();

    const assessed = [];
    let sameStylePriceOutcome = null;
    for (const line of lines) {
      const row = byItem.get(line.orderItemId);
      if (!row) throw new AppError('RETURN_ITEM_NOT_ON_ORDER', 'That item is not on this order.', 400);
      const base = this.#lineEligibility(row, policy, { now });
      const deliveredAt = base.deliveredAt;
      if (!deliveredAt) throw new AppError('RETURN_NOT_ELIGIBLE', 'This item has not been delivered yet.', 409);
      const deadline = addDays(deliveredAt, windowDays);
      if (now > deadline) throw new AppError('RETURN_WINDOW_EXPIRED', 'The return window for this item has closed.', 409);
      if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new AppError('VALIDATION_ERROR', 'Return quantity must be a positive integer.', 400);
      }
      if (line.quantity > base.eligibleQuantity) {
        throw new AppError('RETURN_QUANTITY_EXCEEDED',
          `Only ${base.eligibleQuantity} unit(s) of this item can still be returned.`, 409);
      }

      const assessedLine = {
        orderItemId: base.orderItemId,
        skuId: base.skuId,
        fulfillmentId: base.fulfillmentId,
        quantity: line.quantity,
        reasonCode: line.reasonCode ?? null,
        itemNote: line.itemNote ?? null,
        unitPriceMinor: base.unitPriceMinor,
        eligibleValueMinor: base.unitPriceMinor * line.quantity,
        deliveredAt,
        returnDeadline: deadline,
      };

      if (requestedAction === 'SAME_STYLE_EXCHANGE') {
        const target = await exchangeService.assessSameStyleTarget({
          connection,
          orderItem: { product_id: row.product_id, sku_id: row.sku_id, unit_price_minor: base.unitPriceMinor },
          targetSkuId: line.target?.skuId,
          quantity: line.quantity,
          policy,
        });
        Object.assign(assessedLine, {
          targetProductId: target.targetProductId,
          targetVariantId: target.targetVariantId,
          targetSkuId: target.targetSkuId,
          targetUnitPriceMinor: target.targetUnitPriceMinor,
          priceDifferenceMinor: target.priceDifferenceMinor,
          pricePolicyOutcome: target.pricePolicyOutcome,
        });
        sameStylePriceOutcome = target.pricePolicyOutcome;
      }

      assessed.push(assessedLine);
    }

    return {
      policy: { windowDays, version: policy.version, sameStylePriceOutcome },
      lines: assessed,
    };
  }

  canCancel(status) {
    return CANCELLABLE_STATUSES.includes(status);
  }
}

export const returnEligibilityService = new ReturnEligibilityService();
