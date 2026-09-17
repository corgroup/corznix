import { randomBytes, randomUUID } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { storeCreditService } from '../storeCredit/service.js';
import { differentStyleExchangeRepository } from './differentStyleExchangeRepository.js';
import { returnsRepository } from './repository.js';
import { returnPolicyService } from './returnPolicyService.js';

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const stamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

/**
 * Different-style exchange (§50-66). The customer's returned value is frozen
 * from the original immutable transaction (§64) into a Reserved Exchange
 * Credit — a restricted, customer-bound, exchange-bound, single-consume
 * liability that is NOT spendable store credit (§51/§96). Only a cheaper-item
 * remainder converts to normal CORCOTTON Credit, as one GRANT (§65).
 *
 * Reserved exchange value is NEVER refunded to the original payment method
 * (§53/§59/§60).
 */
export class DifferentStyleExchangeService {
  constructor({
    repository = differentStyleExchangeRepository, returns = returnsRepository,
    storeCredit = storeCreditService, policyService = returnPolicyService, transaction = withTransaction,
  } = {}) {
    this.repository = repository;
    this.returns = returns;
    this.storeCredit = storeCredit;
    this.policyService = policyService;
    this.transaction = transaction;
  }

  txnDto(t, credit = null) {
    return {
      id: t.id,
      transactionNumber: t.transaction_number,
      status: t.status,
      originalOrderId: t.original_order_id,
      returnRequestId: t.return_request_id,
      newExchangeOrderId: t.new_exchange_order_id ?? null,
      eligibleValueMinor: Number(t.eligible_value_minor),
      currency: t.currency,
      contextToken: t.context_token,
      expiresAt: t.expires_at,
      reservedCredit: credit ? {
        id: credit.id,
        status: credit.status,
        amountMinor: Number(credit.amount_minor),
        consumedAmountMinor: Number(credit.consumed_amount_minor),
        remainingMinor: Number(credit.amount_minor) - Number(credit.consumed_amount_minor),
        expiresAt: credit.expires_at,
      } : null,
    };
  }

  /**
   * Reserve the exchange value for an approved DIFFERENT_STYLE_EXCHANGE request.
   * Idempotent (one transaction per request). Called from the return lifecycle
   * at approval — the reverse pickup of the original runs in parallel.
   */
  async createForRequest({ connection, request }) {
    const existing = await this.repository.transactionByRequest(connection, request.id);
    if (existing) {
      const credit = await this.repository.creditByTransaction(connection, existing.id);
      return this.txnDto(existing, credit);
    }
    const items = await this.returns.requestItems(request.id, connection);
    const eligibleValueMinor = items.reduce((sum, i) => sum + Number(i.eligible_value_minor), 0);
    if (eligibleValueMinor <= 0) throw new AppError('EXCHANGE_VALUE_ZERO', 'This exchange has no eligible value.', 409);

    const policy = await this.policyService.get({ connection });
    const expiresAt = new Date(Date.now() + policy.reservedExchangeCreditExpiryDays * 86400000);
    const order = await this.returns.orderById(request.order_id, connection);

    const eligibilitySnapshot = {
      frozenAt: new Date().toISOString(),
      source: 'ORIGINAL_TRANSACTION_SNAPSHOT',
      originalOrderNumber: order.order_number,
      currency: order.currency,
      lines: items.map((i) => ({
        orderItemId: i.order_item_id, skuId: i.sku_id, quantity: Number(i.quantity),
        unitPriceMinor: Number(i.unit_price_minor), eligibleValueMinor: Number(i.eligible_value_minor),
      })),
      eligibleValueMinor,
    };

    let transaction;
    try {
      const [dseBrand] = await connection.execute('SELECT order_prefix FROM brands WHERE id = ?', [order.brand_id]).then((r) => r[0]);
      transaction = await this.repository.insertTransaction(connection, {
        transactionNumber: `${dseBrand?.order_prefix || 'ORD'}-EXC-${stamp()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`,
        customerId: request.customer_id,
        originalOrderId: request.order_id,
        returnRequestId: request.id,
        currency: order.currency,
        eligibleValueMinor,
        eligibilitySnapshot,
        contextToken: randomBytes(32).toString('hex'),
        expiresAt,
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        const raced = await this.repository.transactionByRequest(connection, request.id);
        if (raced) return this.txnDto(raced, await this.repository.creditByTransaction(connection, raced.id));
      }
      throw err;
    }
    const credit = await this.repository.insertCredit(connection, {
      exchangeTransactionId: transaction.id,
      customerId: request.customer_id,
      currency: order.currency,
      amountMinor: eligibleValueMinor,
      expiresAt,
    });
    await this.returns.recordEvent(connection, request.id, {
      eventType: 'EXCHANGE_CREDIT_RESERVED',
      actorType: 'SYSTEM',
      detail: { exchangeTransactionId: transaction.id, reservedCreditId: credit.id, eligibleValueMinor, expiresAt },
    });
    return this.txnDto(transaction, credit);
  }

  /** Checkout-facing context resolution — never trusts a raw transaction id (§57). */
  async getContext({ customerId, contextToken }) {
    if (!contextToken || !/^[a-f0-9]{64}$/.test(contextToken)) {
      throw new AppError('EXCHANGE_CONTEXT_INVALID', 'Invalid exchange context.', 400);
    }
    const transaction = await this.repository.transactionByContext(null, contextToken);
    if (!transaction || transaction.customer_id !== customerId) {
      throw new AppError('EXCHANGE_CONTEXT_NOT_FOUND', 'Exchange context not found.', 404);
    }
    const credit = await this.repository.creditByTransaction(null, transaction.id);
    const expired = new Date(transaction.expires_at) <= new Date();
    return {
      ...this.txnDto(transaction, credit),
      usable: transaction.status === 'RESERVED' && credit?.status === 'RESERVED' && !expired,
      expired,
    };
  }

  /**
   * Consume the reserved credit against a new exchange order total. MUST run
   * inside the order-creation transaction with the credit row already locked
   * FOR UPDATE (the caller passes `connection`). The status + version guard is
   * the consume-vs-expiry race resolver (§62) — CONSUMED and EXPIRED can never
   * both happen.
   *
   * Returns { appliedMinor, extraPaymentMinor, remainderMinor }.
   */
  async consume({ connection, contextToken, customerId, newOrderTotalMinor }) {
    const transaction = await this.repository.transactionByContext(connection, contextToken, { lock: true });
    if (!transaction || transaction.customer_id !== customerId) {
      throw new AppError('EXCHANGE_CONTEXT_NOT_FOUND', 'Exchange context not found.', 404);
    }
    if (transaction.status !== 'RESERVED') {
      throw new AppError('EXCHANGE_ALREADY_CONSUMED', `This exchange is ${transaction.status}.`, 409);
    }
    const credit = await this.repository.creditByTransaction(connection, transaction.id, { lock: true });
    if (!credit || credit.status !== 'RESERVED') {
      throw new AppError('EXCHANGE_CREDIT_NOT_RESERVED', `The reserved exchange credit is ${credit?.status || 'missing'}.`, 409);
    }
    if (new Date(credit.expires_at) <= new Date()) {
      throw new AppError('EXCHANGE_CREDIT_EXPIRED', 'The reserved exchange credit has expired.', 409);
    }

    const reservedMinor = Number(credit.amount_minor);
    const appliedMinor = Math.min(reservedMinor, newOrderTotalMinor);
    const extraPaymentMinor = newOrderTotalMinor - appliedMinor; // customer pays only this (§55)
    const remainderMinor = reservedMinor - appliedMinor;         // cheaper item -> store credit (§53)

    const won = await this.repository.transitionCredit(connection, credit.id, {
      fromStatus: 'RESERVED', expectedVersion: Number(credit.version), toStatus: 'CONSUMED',
      fields: { consumed_amount_minor: appliedMinor, consumed_at: new Date() },
    });
    if (!won) throw new AppError('EXCHANGE_CREDIT_RACE_LOST', 'The reserved exchange credit changed state — retry.', 409);

    await this.repository.updateTransaction(connection, transaction.id, {
      status: 'CONSUMED', consumed_at: new Date(),
    });

    if (remainderMinor > 0) {
      // One ledger entry, into the real closed-loop credit (§65).
      await this.storeCredit.applyEntry({
        customerId, amountMinor: remainderMinor, entryType: 'GRANT',
        sourceType: 'EXCHANGE_REMAINDER', sourceId: transaction.id,
        idempotencyKey: `exc-remainder:${transaction.id}`,
        reason: `Different-style exchange ${transaction.transaction_number} remainder`,
        connection,
      });
    }

    await this.returns.recordEvent(connection, transaction.return_request_id, {
      eventType: 'EXCHANGE_CREDIT_CONSUMED',
      actorType: 'SYSTEM',
      detail: { appliedMinor, extraPaymentMinor, remainderMinor },
    });

    return { appliedMinor, extraPaymentMinor, remainderMinor, reservedMinor, transactionId: transaction.id };
  }

  /** Link the new exchange order to its transaction — after the order row exists. */
  linkOrder(connection, transactionId, newExchangeOrderId) {
    return this.repository.updateTransaction(connection, transactionId, { new_exchange_order_id: newExchangeOrderId });
  }

  /**
   * Void the exchange (order cancellation §59, or standalone). Reverses the
   * cheaper-item remainder grant, voids the credit + transaction, and restores
   * the original order's return/exchange eligibility. NEVER refunds reserved
   * value to the original payment method.
   */
  async cancel({ exchangeTransactionId, reason = 'CANCELLED', restoreEligibility = true }) {
    return this.transaction(async (tx) => {
      const transaction = await this.repository.transactionById(tx, exchangeTransactionId, { lock: true });
      if (!transaction) throw new AppError('EXCHANGE_TRANSACTION_NOT_FOUND', 'Exchange transaction not found.', 404);
      if (['CANCELLED', 'EXPIRED'].includes(transaction.status)) {
        return this.txnDto(transaction, await this.repository.creditByTransaction(tx, transaction.id));
      }
      const credit = await this.repository.creditByTransaction(tx, transaction.id, { lock: true });

      let remainderClawback = null;
      if (credit.status === 'CONSUMED' && Number(credit.consumed_amount_minor) < Number(credit.amount_minor)) {
        const remainder = Number(credit.amount_minor) - Number(credit.consumed_amount_minor);
        try {
          await this.storeCredit.applyEntry({
            customerId: transaction.customer_id, amountMinor: -remainder, entryType: 'REVERSAL',
            sourceType: 'EXCHANGE_REMAINDER_REVERSAL', sourceId: transaction.id,
            idempotencyKey: `exc-remainder-rev:${transaction.id}`,
            reason: `Cancelled exchange ${transaction.transaction_number}`, connection: tx,
          });
          remainderClawback = { reversedMinor: remainder };
        } catch (err) {
          if (err.code === 'INSUFFICIENT_STORE_CREDIT') remainderClawback = { blocked: 'REMAINDER_ALREADY_SPENT', remainder };
          else throw err;
        }
      }

      await this.repository.transitionCredit(tx, credit.id, {
        fromStatus: credit.status, expectedVersion: Number(credit.version), toStatus: 'CANCELLED',
        fields: { cancelled_at: new Date() },
      });
      await this.repository.updateTransaction(tx, transaction.id, { status: 'CANCELLED', cancelled_at: new Date() });
      await this.returns.recordEvent(tx, transaction.return_request_id, {
        eventType: 'EXCHANGE_CANCELLED', actorType: 'SYSTEM', detail: { reason, remainderClawback },
      });

      if (restoreEligibility) {
        // Restoring eligibility = releasing the units the return request holds.
        const request = await this.returns.lockRequest(tx, transaction.return_request_id);
        if (request && !['CANCELLED', 'REJECTED', 'EXPIRED', 'COMPLETED'].includes(request.status)) {
          await this.returns.setRequestStatus(tx, request.id, 'CANCELLED', { cancelled_at: new Date() });
          await this.returns.recordEvent(tx, request.id, {
            fromStatus: request.status, toStatus: 'CANCELLED',
            eventType: 'RETURN_REQUEST_CANCELLED', actorType: 'SYSTEM', detail: { reason: 'EXCHANGE_CANCELLED' },
          });
        }
      }

      return { ...this.txnDto(transaction, await this.repository.creditByTransaction(tx, transaction.id)), remainderClawback };
    });
  }

  /**
   * Expire reserved credits past their window (§61). The status+version guard
   * means a credit being consumed at the same instant is never also expired
   * (§62).
   */
  async expireDue({ limit = 50 } = {}) {
    const due = await this.repository.dueForExpiry(limit);
    const expired = [];
    for (const row of due) {
      const done = await this.transaction(async (tx) => {
        const credit = await this.repository.creditByTransaction(tx, row.exchange_transaction_id, { lock: true });
        if (!credit || credit.status !== 'RESERVED' || new Date(credit.expires_at) > new Date()) return null;
        const won = await this.repository.transitionCredit(tx, credit.id, {
          fromStatus: 'RESERVED', expectedVersion: Number(credit.version), toStatus: 'EXPIRED',
          fields: { expired_at: new Date() },
        });
        if (!won) return null;
        await this.repository.updateTransaction(tx, row.exchange_transaction_id, { status: 'EXPIRED', expired_at: new Date() });
        const request = await this.returns.lockRequest(tx, row.return_request_id);
        if (request && !['CANCELLED', 'REJECTED', 'EXPIRED', 'COMPLETED'].includes(request.status)) {
          await this.returns.setRequestStatus(tx, request.id, 'EXPIRED', {});
          await this.returns.recordEvent(tx, request.id, {
            fromStatus: request.status, toStatus: 'EXPIRED',
            eventType: 'EXCHANGE_EXPIRED', actorType: 'SYSTEM',
          });
        }
        return row.exchange_transaction_id;
      });
      if (done) expired.push(done);
    }
    return { expired };
  }

  async getOwnedTransaction(customerId, idOrNumber) {
    const t = await this.repository.ownedTransaction(customerId, idOrNumber);
    if (!t) throw new AppError('EXCHANGE_TRANSACTION_NOT_FOUND', 'Exchange transaction not found.', 404);
    return this.txnDto(t, await this.repository.creditByTransaction(null, t.id));
  }
}

export const differentStyleExchangeService = new DifferentStyleExchangeService();
export { parse as _parse };
