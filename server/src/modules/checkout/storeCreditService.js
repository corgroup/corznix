// Putting store credit towards a checkout.
//
// The ledger could only ever grow: refunds, exchange remainders and now
// cancellations grant credit, and nothing in checkout knew it existed. A refund
// "to store credit" was money the customer could not spend.
//
// Rules, deliberately narrow:
//   - Prepaid only. Credit that reduced a Cash-on-Delivery amount would change
//     what the courier collects, and the courier's figure is printed on a label
//     and manifested with the carrier long before it is handed over.
//   - Never more than the balance, and never more than the order costs.
//   - Choosing an amount reserves nothing. The ledger is debited when the order
//     is placed, inside the same transaction, so two checkouts cannot both
//     spend the last rupee.
import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { query } from '../../database/connection/pool.js';
import { storeCreditService } from '../storeCredit/service.js';
import { checkoutRepository } from './repository.js';

const CREDITABLE_MODES = [null, '', 'PREPAID'];

export class CheckoutStoreCreditService {
  constructor({ repository = checkoutRepository, credit = storeCreditService, db = query, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.credit = credit;
    this.db = db;
    this.transaction = transaction;
  }

  /** What the customer could put towards this checkout right now. */
  async availability(customerId, checkoutId) {
    const checkout = await this.repository.findOwned(customerId, checkoutId);
    if (!checkout) throw new AppError('CHECKOUT_NOT_FOUND', 'Checkout not found.', 404);
    const balanceMinor = await this.credit.getBalanceMinor(customerId, { currency: checkout.currency || 'INR' });
    const totalMinor = Number(checkout.total_minor || 0);
    const appliedMinor = Number(checkout.store_credit_applied_minor || 0);
    const [{ selected_payment_mode: mode } = {}] = await this.db(
      'SELECT selected_payment_mode FROM checkout_payment_eligibility WHERE checkout_id = ? LIMIT 1', [checkoutId]);
    const usable = CREDITABLE_MODES.includes(mode ?? null);
    return {
      balanceMinor,
      appliedMinor,
      // The most that could be applied on top of what already is.
      maxApplicableMinor: usable ? Math.max(0, Math.min(balanceMinor + appliedMinor, totalMinor)) : 0,
      usable,
      reason: usable ? null : 'Store credit can only be used on a prepaid order.',
      currency: checkout.currency || 'INR',
    };
  }

  /**
   * @param {number|'MAX'} amountMinor
   */
  async apply(customerId, checkoutId, amountMinor) {
    const info = await this.availability(customerId, checkoutId);
    if (!info.usable) throw new AppError('STORE_CREDIT_NOT_USABLE', info.reason, 409);
    const requested = amountMinor === 'MAX' ? info.maxApplicableMinor : Math.floor(Number(amountMinor));
    if (!Number.isFinite(requested) || requested < 0) {
      throw new AppError('VALIDATION_ERROR', 'Enter how much store credit to use.', 400);
    }
    if (requested > info.maxApplicableMinor) {
      throw new AppError('STORE_CREDIT_INSUFFICIENT', 'That is more store credit than you have available for this order.', 409);
    }
    await this.db('UPDATE checkout_sessions SET store_credit_applied_minor = ?, updated_at = NOW(3) WHERE id = ?', [requested, checkoutId]);
    return { ...(await this.availability(customerId, checkoutId)), appliedMinor: requested };
  }

  async remove(customerId, checkoutId) {
    return this.apply(customerId, checkoutId, 0);
  }

  /**
   * Spend it, when the order is created. Runs INSIDE the order transaction:
   * the debit and the order are one fact, and a balance that moved since the
   * customer chose the amount fails the placement rather than quietly
   * charging them the difference.
   *
   * @returns {Promise<number>} the amount actually spent
   */
  async spendForOrder(connection, { order, checkout }) {
    const amountMinor = Number(checkout.store_credit_applied_minor || 0);
    if (amountMinor <= 0) return 0;
    await this.credit.applyEntry({
      customerId: order.customer_id,
      amountMinor: -amountMinor,
      entryType: 'DEBIT',
      sourceType: 'ORDER_PAYMENT',
      sourceId: order.id,
      idempotencyKey: `order_credit:${order.id}`,
      reason: `Order ${order.order_number}`,
      currency: order.currency || 'INR',
      connection,
    });
    return amountMinor;
  }
}

export const checkoutStoreCreditService = new CheckoutStoreCreditService();
