// Refunding a cancelled order to the method the customer actually paid with.
//
// The cancellation cascade (WP-09) restores inventory, cancels fulfilments and
// shipments, issues a credit note and TELLS staff a refund is owed — but the
// money never moved: refund execution lived only inside the returns flow, which
// needs a return request. So a cancelled prepaid order sat with "Refund of ₹X
// required" on a staff task and nothing else: no refund row, no provider
// reference, no status, nothing the customer could see.
//
// This runs the refund itself, against the ORIGINAL payment — never store
// credit, which is a separate decision for customer-initiated cancellations.
//
// Shape follows the returns refund (§74): decide and record inside a
// transaction, call the provider OUTSIDE it, then record the outcome. One
// refund per cancelled order is guaranteed by the unique idempotency key, so a
// re-cancel, a double click or a retried job cannot pay twice; a FAILED or
// ambiguous attempt can be retried and reuses the same row.
import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import { refundRepository } from '../returns/refundRepository.js';
import { PaymentProviderRegistry } from '../payments/registry.js';
import { MockPaymentProvider } from '../payments/providers/mockPaymentProvider.js';
import { CashfreeProvider } from '../payments/providers/cashfreeProvider.js';
import { RazorpayProvider } from '../payments/providers/razorpayProvider.js';
import { storeCreditService } from '../storeCredit/service.js';
import { notificationService } from '../notifications/service.js';
import { orderContactFrom } from '../notifications/recipients.js';
import { staffNotificationService } from '../staffNotifications/service.js';

const log = logger('cancellation-refund');
export const CANCELLATION_REFUND_ORIGIN = 'ORDER_CANCELLATION';

const money = (minor, currency = 'INR') => `${currency === 'INR' ? '₹' : `${currency} `}${(Number(minor) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`;
const stamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');

/** Terminal states a retry must not touch — the money is already on its way. */
const SETTLED = new Set(['SUCCEEDED', 'PROCESSING']);

export class CancellationRefundService {
  constructor({
    repository = refundRepository,
    transaction = withTransaction,
    registry = new PaymentProviderRegistry([new MockPaymentProvider(), new CashfreeProvider(), new RazorpayProvider()]),
    storeCredit = storeCreditService,
    notifications = notificationService,
    staffNotifications = staffNotificationService,
    db = query,
  } = {}) {
    this.repository = repository;
    this.transaction = transaction;
    this.registry = registry;
    this.storeCredit = storeCredit;
    this.notifications = notifications;
    this.staffNotifications = staffNotifications;
    this.db = db;
  }

  #dto(a) {
    if (!a) return null;
    return {
      id: a.id,
      refundNumber: a.refund_number,
      status: a.status,
      method: a.method,
      providerCode: a.provider_code ?? null,
      providerRefundId: a.provider_refund_id ?? null,
      amountMinor: Number(a.amount_minor),
      currency: a.currency,
      failureCode: a.failure_code ?? null,
      completedAt: a.completed_at ?? null,
    };
  }

  /**
   * Store credit the customer SPENT on this order goes back when it is
   * cancelled — separately from any refund of money, because it was never a
   * payment at a gateway. Idempotent on its own key, so a re-cancel or a retry
   * cannot credit it twice.
   */
  async reverseStoreCreditSpent(order) {
    const spentMinor = Number(order.store_credit_applied_minor || 0);
    if (spentMinor <= 0) return { status: 'NOT_REQUIRED', amountMinor: 0 };
    const entry = await this.storeCredit.applyEntry({
      customerId: order.customer_id,
      amountMinor: spentMinor,
      entryType: 'REVERSAL',
      sourceType: 'ORDER_CANCELLATION_CREDIT_REVERSAL',
      sourceId: order.id,
      idempotencyKey: `order_cancel_credit_reversal:${order.id}`,
      reason: `Order ${order.order_number} cancelled — store credit returned`,
      currency: order.currency || 'INR',
    });
    return { status: 'RETURNED', amountMinor: spentMinor, entryId: entry.id };
  }

  /**
   * The refundable amount as store credit, for a cancellation the CUSTOMER
   * made themselves. Instant and final — the credit either exists or it does
   * not, so there is no pending state to hold open — and idempotent twice
   * over: one refund row per order (unique key) and one ledger entry per order
   * (its own key), so a double-tapped Cancel cannot credit twice.
   */
  async creditCancelledOrderToStoreCredit(orderId) {
    const [order] = await this.db('SELECT * FROM orders WHERE id = ? OR order_number = ? LIMIT 1', [orderId, orderId]);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
    if (order.order_status !== 'CANCELLED') {
      throw new AppError('ORDER_NOT_CANCELLED', 'Only a cancelled order is refunded this way.', 409);
    }
    const onlinePaidMinor = Number(order.online_paid_minor || 0);
    const withheldMinor = Math.min(Number(order.non_refundable_advance_minor || 0), onlinePaidMinor);
    const refundableMinor = Math.max(0, onlinePaidMinor - withheldMinor);
    if (refundableMinor <= 0) return { status: 'NOT_REQUIRED', refund: null, amountMinor: 0 };

    const outcome = await this.transaction(async (tx) => {
      const existing = await this.repository.byOrderOrigin(tx, order.id, CANCELLATION_REFUND_ORIGIN, { lock: true });
      if (existing) return { replay: existing };
      const entry = await this.storeCredit.applyEntry({
        customerId: order.customer_id,
        amountMinor: refundableMinor,
        entryType: 'GRANT',
        sourceType: 'ORDER_CANCELLATION',
        sourceId: order.id,
        idempotencyKey: `order_cancel_credit:${order.id}`,
        reason: `Order ${order.order_number} cancelled`,
        currency: order.currency || 'INR',
        connection: tx,
      });
      const attempt = await this.repository.insert(tx, {
        refundNumber: `RFND-${stamp()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`,
        returnRequestId: null,
        origin: CANCELLATION_REFUND_ORIGIN,
        orderId: order.id,
        customerId: order.customer_id,
        sourcePaymentAttemptId: null,
        providerCode: null,
        method: 'STORE_CREDIT',
        amountMinor: refundableMinor,
        nonRefundableWithheldMinor: withheldMinor,
        currency: order.currency || 'INR',
        status: 'SUCCEEDED',
        idempotencyKey: `order_cancel_refund:${order.id}`,
        requestHash: `${order.id}:${refundableMinor}:store_credit`,
      });
      await this.repository.update(tx, attempt.id, { provider_refund_id: entry.id, completed_at: new Date() });
      return { attempt: { ...attempt, provider_refund_id: entry.id }, entry };
    });

    if (outcome.replay) {
      return { status: 'REPLAY', refund: this.#dto(outcome.replay), amountMinor: Number(outcome.replay.amount_minor) };
    }
    await this.#notify(order, outcome.attempt, refundableMinor, 'REFUND_COMPLETED', 'your CORCOTTON store credit');
    return {
      status: 'SUCCEEDED',
      refund: this.#dto(outcome.attempt),
      amountMinor: refundableMinor,
      storeCredit: { entryId: outcome.entry.id, balanceAfterMinor: Number(outcome.entry.balanceAfterMinor ?? outcome.entry.balance_after_minor ?? 0) },
    };
  }

  /**
   * @param {string} orderId
   * @param {{ simulate?: string|null, retry?: boolean }} [options]
   *   retry — only a FAILED / UNKNOWN attempt is sent again; a SUCCEEDED or
   *   in-flight one is returned untouched either way.
   */
  async refundCancelledOrder(orderId, { simulate = null, retry = false } = {}) {
    const [order] = await this.db('SELECT * FROM orders WHERE id = ? OR order_number = ? LIMIT 1', [orderId, orderId]);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
    if (order.order_status !== 'CANCELLED') {
      throw new AppError('ORDER_NOT_CANCELLED', 'Only a cancelled order is refunded this way.', 409);
    }

    const onlinePaidMinor = Number(order.online_paid_minor || 0);
    // A disclosed non-refundable COD advance is kept — the same arithmetic the
    // cancellation cascade reports, so the two can never disagree.
    const withheldMinor = Math.min(Number(order.non_refundable_advance_minor || 0), onlinePaidMinor);
    const refundableMinor = Math.max(0, onlinePaidMinor - withheldMinor);
    if (refundableMinor <= 0) {
      return { status: 'NOT_REQUIRED', refund: null, amountMinor: 0 };
    }

    const decided = await this.transaction(async (tx) => {
      const existing = await this.repository.byOrderOrigin(tx, order.id, CANCELLATION_REFUND_ORIGIN, { lock: true });
      if (existing && (SETTLED.has(existing.status) || !retry)) {
        return { replay: existing };
      }
      const source = await this.repository.sourceOnlinePayment(tx, order.id);
      if (!source) {
        // Paid according to the order, but no SUCCEEDED online attempt to
        // reverse: refusing loudly beats inventing a refund target.
        return { unreconciled: true };
      }
      if (existing) {
        await this.repository.update(tx, existing.id, { status: 'PROCESSING', failure_code: null });
        return { attempt: { ...existing, status: 'PROCESSING' }, source };
      }
      const attempt = await this.repository.insert(tx, {
        refundNumber: `RFND-${stamp()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`,
        returnRequestId: null,
        origin: CANCELLATION_REFUND_ORIGIN,
        orderId: order.id,
        customerId: order.customer_id,
        sourcePaymentAttemptId: source.id,
        providerCode: source.provider_code,
        method: 'ORIGINAL_PAYMENT',
        amountMinor: refundableMinor,
        nonRefundableWithheldMinor: withheldMinor,
        currency: order.currency || 'INR',
        status: 'PROCESSING',
        idempotencyKey: `order_cancel_refund:${order.id}`,
        requestHash: `${order.id}:${refundableMinor}`,
      });
      return { attempt, source };
    });

    if (decided.unreconciled) {
      await this.#flagForStaff(order, refundableMinor, 'NO_CAPTURED_PAYMENT_TO_REVERSE');
      throw new AppError('REFUND_SOURCE_NOT_FOUND', 'No captured online payment was found to refund.', 409);
    }
    if (decided.replay) {
      return { status: 'REPLAY', refund: this.#dto(decided.replay), amountMinor: Number(decided.replay.amount_minor) };
    }

    const provider = this.registry.resolve(decided.attempt.provider_code);
    if (!provider || typeof provider.refund !== 'function' || !provider.supportsRefund?.()) {
      const blocked = await this.transaction((tx) => this.repository.update(tx, decided.attempt.id, {
        status: 'BLOCKED', failure_code: 'REFUND_PROVIDER_NOT_ENABLED',
      }));
      await this.#flagForStaff(order, refundableMinor, 'REFUND_PROVIDER_NOT_ENABLED');
      return { status: 'BLOCKED', refund: this.#dto(blocked || decided.attempt), amountMinor: refundableMinor };
    }

    await this.#notify(order, decided.attempt, refundableMinor, 'REFUND_INITIATED');

    let result = null;
    let failure = null;
    try {
      result = await provider.refund({
        paymentRefundId: decided.attempt.id,
        providerPaymentId: decided.source.provider_payment_id,
        // Cashfree addresses refunds by the merchant order reference, Razorpay
        // by the captured payment — both are passed and each uses its own.
        merchantReference: decided.source.merchant_reference,
        amountMinor: refundableMinor,
        currency: order.currency || 'INR',
        idempotencyKey: `refund:${decided.attempt.id}`,
        simulate,
      });
    } catch (err) { failure = err; }

    await this.transaction(async (tx) => {
      if (result) {
        // A provider that answers "pending" has NOT paid yet — saying SUCCEEDED
        // there is how a refund gets marked done and never lands.
        const succeeded = result.status ? result.status === 'SUCCEEDED' : true;
        return this.repository.update(tx, decided.attempt.id, {
          status: succeeded ? 'SUCCEEDED' : 'PROCESSING',
          provider_refund_id: result.providerRefundId || null,
          completed_at: succeeded ? new Date() : null,
        });
      }
      if (failure?.ambiguous) {
        // Timeout / 5xx: the refund may exist at the provider. Never retried
        // automatically — reconciliation or a human decides.
        return this.repository.update(tx, decided.attempt.id, {
          status: 'UNKNOWN', provider_refund_id: failure.providerRefundId || null,
          failure_code: failure.message || 'PROVIDER_TIMEOUT',
        });
      }
      return this.repository.update(tx, decided.attempt.id, {
        status: 'FAILED', failure_code: failure?.message || 'PROVIDER_ERROR',
      });
    });

    const attempt = await this.repository.byOrderOrigin(null, order.id, CANCELLATION_REFUND_ORIGIN);
    if (attempt?.status === 'SUCCEEDED') {
      await this.#notify(order, attempt, refundableMinor, 'REFUND_COMPLETED');
    } else {
      log.error('cancellation_refund_unsettled', {
        orderNumber: order.order_number, status: attempt?.status, failureCode: attempt?.failure_code || null,
      });
      await this.#flagForStaff(order, refundableMinor, attempt?.failure_code || attempt?.status || 'UNKNOWN');
    }
    return { status: attempt?.status || 'UNKNOWN', refund: this.#dto(attempt), amountMinor: refundableMinor };
  }

  async #notify(order, attempt, amountMinor, eventKey, methodPhrase = 'your original payment method') {
    try {
      const contact = orderContactFrom(order.shipping_address_snapshot || null);
      await this.notifications.emit(eventKey, {
        customerId: order.customer_id,
        refundAttemptId: attempt.id,
        // A cancellation has no return request; the order is the reference the
        // customer has, and the copy reads "for <reference>".
        requestNumber: order.order_number,
        orderNumber: order.order_number,
        amount: money(amountMinor, order.currency),
        refundAmount: money(amountMinor, order.currency),
        customerName: contact?.name || null,
        method: methodPhrase,
        shippingAddressSnapshot: order.shipping_address_snapshot || null,
      });
    } catch { /* isolated — a refund is not undone by a message failing */ }
  }

  async #flagForStaff(order, amountMinor, reason) {
    await this.staffNotifications.record({
      category: 'PAYMENT', eventKey: 'ORDER_REFUND_NEEDS_ATTENTION', severity: 'CRITICAL',
      title: `Refund not completed for ${order.order_number}`,
      body: `${money(amountMinor, order.currency)} to the original payment method — ${reason}. Retry from the order, or refund in the provider dashboard.`,
      link: `/orders/${order.id}`, entityType: 'order', entityId: order.id,
      dedupeKey: `order_refund_attention:${order.id}:${reason}`,
    }).catch(() => {});
  }
}

export const cancellationRefundService = new CancellationRefundService();
