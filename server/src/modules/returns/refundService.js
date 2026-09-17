import { createHash, randomUUID } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { refundPayoutService } from './refundPayoutService.js';
import { AppError } from '../../utils/errors.js';
import { MockPaymentProvider } from '../payments/providers/mockPaymentProvider.js';
import { CashfreeProvider } from '../payments/providers/cashfreeProvider.js';
import { RazorpayProvider } from '../payments/providers/razorpayProvider.js';
import { PaymentProviderRegistry } from '../payments/registry.js';
import { storeCreditService } from '../storeCredit/service.js';
import { refundRepository } from './refundRepository.js';
import { returnsRepository } from './repository.js';
import { returnPolicyService } from './returnPolicyService.js';
import { notificationService } from '../notifications/service.js';
import { formatMinor, refundMethodPhrase } from '../notifications/format.js';

const sha256 = (v) => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const stamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');
const DAY = 86400000; void DAY;

/**
 * Financial resolution for a completed RETURN (§85-102). Reuses the existing
 * authorities only:
 *   - PaymentService's provider registry for the original-payment refund (§89),
 *     with a persisted refund state machine (§90) and idempotency (§91).
 *   - StoreCreditService for a store-credit refund (§95) — one GRANT.
 *   - the invoice + credit-note tables for a PARTIAL-quantity credit note that
 *     never mutates the original invoice (§97/§100).
 *
 * Nothing here is invented: an unconfigured COD refund method is a
 * deterministic BLOCKED state (§93); GST reversal treatment stays
 * PENDING_CONFIGURATION (§97/§98).
 */
export class RefundService {
  constructor({
    repository = refundRepository, returns = returnsRepository, storeCredit = storeCreditService,
    policyService = returnPolicyService, transaction = withTransaction,
    registry = new PaymentProviderRegistry([new MockPaymentProvider(), new CashfreeProvider(), new RazorpayProvider()]),
  } = {}) {
    this.repository = repository;
    this.returns = returns;
    this.storeCredit = storeCredit;
    this.policyService = policyService;
    this.transaction = transaction;
    this.registry = registry;
  }

  #attemptDto(a) {
    return {
      id: a.id,
      refundNumber: a.refund_number,
      method: a.method,
      providerCode: a.provider_code ?? null,
      amountMinor: Number(a.amount_minor),
      status: a.status,
      providerRefundId: a.provider_refund_id ?? null,
      failureCode: a.failure_code ?? null,
    };
  }

  async #partialCreditNote(tx, { request, order, refundableMinor, items }) {
    const existing = await this.repository.creditNoteByReturnRequest(tx, request.id);
    if (existing) {
      return { status: 'EXISTING', creditNoteId: existing.id, number: existing.credit_note_number, treatment: existing.treatment_status };
    }
    const invoice = await this.repository.invoiceByOrder(tx, order.id);
    if (!invoice) return { status: 'NO_INVOICE' };

    const invItems = await this.repository.invoiceItems(tx, invoice.id);
    // Match invoice lines to returned lines by the IMMUTABLE sku_id (Phase 1B).
    // `invoice_items.sku_id` is populated at invoice time and by the 057
    // backfill; the SKU-string key is only a fallback for any pre-057 invoice
    // that predates the column (both snapshots were written together, so the
    // string still resolves the same line).
    const invByKey = new Map();
    for (const li of invItems) {
      if (li.sku_id) invByKey.set(`id:${li.sku_id}`, li);
      if (li.sku) invByKey.set(`str:${li.sku}`, li);
    }
    const orderItems = await this.repository.orderItemsByIds(tx, items.map((it) => it.order_item_id));
    const oiById = new Map(orderItems.map((oi) => [oi.id, oi]));
    let taxableMinor = 0;
    let indicativeTaxMinor = 0;
    const cnItems = items.map((it) => {
      const oi = oiById.get(it.order_item_id) || {};
      const skuId = it.sku_id || oi.sku_id || null;
      const inv = (skuId && invByKey.get(`id:${skuId}`)) || (oi.sku && invByKey.get(`str:${oi.sku}`)) || null;
      const skuCode = oi.sku || inv?.sku || skuId;
      const qty = Number(it.quantity);
      const unit = Number(it.unit_price_minor);
      const returnedValueMinor = unit * qty;
      // Indicative only — pro-rata of the invoice line tax. NOT a final GST
      // reversal (§97/§98).
      const perUnitTax = inv && Number(inv.quantity) > 0 ? Math.round(Number(inv.tax_minor) / Number(inv.quantity)) : 0;
      const idxTax = perUnitTax * qty;
      taxableMinor += returnedValueMinor;
      indicativeTaxMinor += idxTax;
      return {
        orderItemId: it.order_item_id, sku: skuCode, productName: inv?.product_name || oi.product_name || skuCode,
        hsn: inv?.hsn_sac || null, quantity: qty, unitPriceMinor: unit, returnedValueMinor,
        indicativeTaxMinor: idxTax, invoiceItemRef: inv?.id || null,
      };
    });

    const number = await this.repository.nextCreditNoteNumber(tx, order.brand_id);
    const cn = await this.repository.insertPartialCreditNote(tx, {
      invoiceId: invoice.id, orderId: order.id, returnRequestId: request.id, creditNoteNumber: number,
      amountMinor: refundableMinor, taxableMinor, indicativeTaxMinor,
      reason: `Partial return ${request.request_number}`, items: cnItems,
    });
    // The original invoice is deliberately NOT cancelled or mutated (§97/§100).
    return {
      status: 'CREATED', creditNoteId: cn.id, number, treatment: 'PENDING_CONFIGURATION',
      taxableMinor, indicativeTaxMinor,
      accountingReviewRequired: true, // §98 — LEGAL_ACCOUNTING_REVIEW_REQUIRED
    };
  }

  /**
   * Resolve the refund for a return request. Idempotent per request (§91).
   * `simulate` ('FAIL' | 'AMBIGUOUS') is a dev-only provider hook.
   */
  async resolveForReturn({ returnRequestId, simulate = null }) {
    // Phase 1 — decide + persist the refund intent + the credit note, in one txn.
    const decided = await this.transaction(async (tx) => {
      const request = await this.returns.lockRequest(tx, returnRequestId);
      if (!request) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'Return request not found.', 404);

      const prior = await this.repository.byReturnRequest(tx, request.id, { lock: true });
      if (prior && prior.status !== 'PENDING') {
        return { replay: this.#attemptDto(prior) };
      }

      const order = await this.returns.orderById(request.order_id, tx);
      const items = await this.returns.requestItems(request.id, tx);
      let refundableMinor = items.reduce((s, i) => s + Number(i.eligible_value_minor), 0);
      // Set only on a partial-COD order that carries a non-refundable advance;
      // recorded on the attempt so the next refund knows what is left to keep.
      let nonRefundableWithheldMinor = 0;
      if (refundableMinor <= 0) throw new AppError('REFUND_VALUE_ZERO', 'Nothing to refund.', 409);
      // The value of the goods coming back, before any advance is withheld.
      // The credit note documents merchandise, not cash movement.
      const returnedValueMinor = refundableMinor;

      // §88 cap: nothing already resolved + this refund may exceed the order's
      // merchandise value.
      const alreadyResolved = await this.repository.resolvedFinancialForOrder(tx, order.id);
      if (alreadyResolved + refundableMinor > Number(order.subtotal_minor)) {
        throw new AppError('FINANCIAL_RESOLUTION_OVERFLOW',
          'This refund would exceed the order\'s refundable value.', 409,
          { alreadyResolved, refundableMinor, cap: Number(order.subtotal_minor) });
      }

      const policy = await this.policyService.get({ connection: tx });
      let method; let status; let providerCode = null; let sourcePaymentAttemptId = null;
      let sourceProviderPaymentId = null; let failureCode = null;
      let codBlockedComponentMinor = 0;

      // If the original payment can't be resolved, block deterministically —
      // never crash the return completion.
      const originalPaymentOrBlock = (src) => {
        if (src) {
          method = 'ORIGINAL_PAYMENT'; status = 'PENDING';
          providerCode = src.provider_code; sourcePaymentAttemptId = src.id; sourceProviderPaymentId = src.provider_payment_id;
        } else {
          method = 'BLOCKED'; status = 'BLOCKED'; failureCode = 'REFUND_SOURCE_PAYMENT_NOT_FOUND';
        }
      };

      // A COD order has no instrument to refund to, but that must never block
      // the refund: the customer nominated a payout destination (UPI or bank)
      // when raising the return, and operations pays it out. Only a return with
      // NO destination on file is blocked, and the failure code says exactly
      // what is missing so it can be chased rather than silently stalling.
      const codPayout = async () => {
        const dest = await refundPayoutService.find(request.id, tx);
        if (dest) { method = 'COD_PAYOUT'; status = 'PENDING'; return true; }
        if (policy.codRefundMethod) { method = 'STORE_CREDIT'; status = 'PENDING'; return true; }
        method = 'COD_BLOCKED'; status = 'BLOCKED'; failureCode = 'COD_PAYOUT_DETAILS_MISSING';
        return false;
      };

      if (order.payment_mode === 'FULL_COD') {
        if (!await codPayout()) codBlockedComponentMinor = refundableMinor;
      } else if (order.payment_mode === 'PARTIAL_COD') {
        const total = Number(order.total_minor);
        // The advance taken online at checkout is the part the customer was
        // told is non-refundable; what they hand over at the door is not. So
        // the advance is withheld from the money going back, and only the
        // refundable remainder of it is ever returned to the card.
        //
        // Withheld ONCE per order: an order returned a line at a time must not
        // lose the advance again on every request, so what earlier refunds
        // already kept is subtracted first.
        const advanceMinor = Number(order.online_paid_minor || 0);
        const nonRefundableAdvance = Math.min(Number(order.non_refundable_advance_minor || 0), advanceMinor);
        const alreadyWithheld = await this.repository.withheldAdvanceForOrder(tx, order.id);
        nonRefundableWithheldMinor = Math.max(0, Math.min(nonRefundableAdvance - alreadyWithheld, refundableMinor));
        refundableMinor -= nonRefundableWithheldMinor;
        // Only the part of the advance that IS refundable can go back to the card.
        const refundableAdvance = Math.max(0, advanceMinor - nonRefundableAdvance);
        const onlineShare = refundableMinor > 0 && total > 0 ? Math.round((refundableMinor * refundableAdvance) / total) : 0;
        // Same rule for the cash half of a partial-COD order: a nominated
        // payout destination clears it, so nothing is stranded.
        const hasPayoutDest = Boolean(await refundPayoutService.find(request.id, tx));
        codBlockedComponentMinor = (hasPayoutDest || policy.codRefundMethod) ? 0 : Math.max(0, refundableMinor - onlineShare);
        if (refundableMinor <= 0) {
          // The advance covered the whole refundable value, so no money moves.
          // Still resolved, not refused: the return must be able to COMPLETE,
          // and the row records that nothing was owed and why.
          method = 'FULLY_WITHHELD'; status = 'SUCCEEDED'; codBlockedComponentMinor = 0;
        } else if (onlineShare <= 0) {
          if (hasPayoutDest) { method = 'COD_PAYOUT'; status = 'PENDING'; }
          else if (policy.codRefundMethod) { method = 'STORE_CREDIT'; status = 'PENDING'; }
          else { method = 'COD_BLOCKED'; status = 'BLOCKED'; failureCode = 'COD_PAYOUT_DETAILS_MISSING'; }
        } else {
          originalPaymentOrBlock(await this.repository.sourceOnlinePayment(tx, order.id));
        }
      } else {
        // PREPAID
        if (policy.refundDestination === 'STORE_CREDIT') {
          method = 'STORE_CREDIT'; status = 'PENDING';
        } else {
          originalPaymentOrBlock(await this.repository.sourceOnlinePayment(tx, order.id));
        }
      }

      // Multi-company (DESIGN.md §9 risk area) — brand's own order_prefix
      // (migration 081), never a hardcoded "COR-".
      const [refundBrand] = await tx.execute('SELECT order_prefix FROM brands WHERE id = ?', [order.brand_id]).then((r) => r[0]);
      const refundNumber = `${refundBrand?.order_prefix || 'ORD'}-RFND-${stamp()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
      const requestHash = sha256({ orderId: order.id, refundableMinor, method });
      let attempt;
      try {
        attempt = await this.repository.insert(tx, {
          refundNumber, returnRequestId: request.id, orderId: order.id, customerId: request.customer_id,
          sourcePaymentAttemptId, providerCode, method, amountMinor: refundableMinor,
          nonRefundableWithheldMinor, currency: order.currency,
          status, idempotencyKey: `return-refund:${request.id}`, requestHash, failureCode,
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          const raced = await this.repository.byReturnRequest(tx, request.id, { lock: true });
          if (raced) return { replay: this.#attemptDto(raced) };
        }
        throw err;
      }

      const creditNote = await this.#partialCreditNote(tx, { request, order, refundableMinor: returnedValueMinor, items });

      // STORE_CREDIT resolves synchronously in the same txn — one GRANT (§95).
      if (method === 'STORE_CREDIT') {
        await this.storeCredit.applyEntry({
          customerId: request.customer_id, amountMinor: refundableMinor, entryType: 'GRANT',
          sourceType: 'RETURN_RESOLUTION', sourceId: request.id,
          idempotencyKey: `return-refund:${request.id}`, reason: `Return ${request.request_number}`, connection: tx,
        });
        await this.repository.update(tx, attempt.id, { status: 'SUCCEEDED', completed_at: new Date() });
        attempt.status = 'SUCCEEDED';
      }

      const resolution = {
        financial: status === 'BLOCKED' ? 'BLOCKED'
          : method === 'FULLY_WITHHELD' ? 'FULLY_WITHHELD'
            : method === 'STORE_CREDIT' ? 'STORE_CREDIT' : 'REFUND_PENDING',
        refund: {
          refundAttemptId: attempt.id, method, amountMinor: refundableMinor,
          // What the customer keeps having paid: disclosed at checkout, kept here.
          nonRefundableWithheldMinor, returnedValueMinor,
          status: attempt.status, providerCode,
        },
        codBlockedComponentMinor,
        creditNote,
        legalAccountingReviewRequired: creditNote.status === 'CREATED',
        finalAccountingGstValidation: 'NOT_YET',
      };
      await this.returns.updateRequest(tx, request.id, { resolution_json: JSON.stringify(resolution) });

      return {
        attempt, refundableMinor, method, sourceProviderPaymentId, resolution,
        currency: order.currency, requestNumber: request.request_number,
        customerId: request.customer_id, orderNumber: order.order_number,
      };
    });

    if (decided.replay) {
      return { refund: decided.replay, replay: true };
    }

    // Phase 2 — provider refund OUTSIDE the txn (§74-style), then record.
    if (decided.method === 'ORIGINAL_PAYMENT' && decided.attempt.status === 'PENDING') {
      const provider = this.registry.resolve(decided.attempt.provider_code);
      if (!provider || typeof provider.refund !== 'function' || !provider.supportsRefund?.()) {
        // e.g. a real Cashfree payment with no sandbox-approved refund path —
        // block deterministically, never call (§6/§89).
        await this.transaction((tx) => this.repository.update(tx, decided.attempt.id, {
          status: 'BLOCKED', failure_code: 'REFUND_PROVIDER_NOT_ENABLED',
        }));
        return { refund: { ...this.#attemptDto(decided.attempt), status: 'BLOCKED', failureCode: 'REFUND_PROVIDER_NOT_ENABLED' }, resolution: decided.resolution };
      }

      await this.transaction((tx) => this.repository.update(tx, decided.attempt.id, { status: 'PROCESSING' }));

      let result = null;
      let failure = null;
      try {
        result = await provider.refund({
          paymentRefundId: decided.attempt.id,
          providerPaymentId: decided.sourceProviderPaymentId,
          amountMinor: decided.refundableMinor,
          currency: decided.currency,
          idempotencyKey: `refund:${decided.attempt.id}`,
          simulate,
        });
      } catch (err) { failure = err; }

      await this.transaction(async (tx) => {
        if (result) {
          await this.repository.update(tx, decided.attempt.id, {
            status: 'SUCCEEDED', provider_refund_id: result.providerRefundId, completed_at: new Date(),
          });
        } else if (failure?.ambiguous) {
          await this.repository.update(tx, decided.attempt.id, {
            status: 'UNKNOWN', provider_refund_id: failure.providerRefundId || null,
            failure_code: failure.message || 'PROVIDER_TIMEOUT',
          });
        } else {
          await this.repository.update(tx, decided.attempt.id, {
            status: 'FAILED', failure_code: failure?.message || 'PROVIDER_ERROR',
          });
        }
      });
    }

    const finalAttempt = await this.repository.byReturnRequest(null, returnRequestId);
    await this.#notifyRefund(decided, finalAttempt);
    return { refund: this.#attemptDto(finalAttempt), resolution: decided.resolution };
  }

  // WP-05b — customer refund notification. Post-commit, isolated, deduped per
  // refund attempt id. INITIATED while the refund is still in flight,
  // COMPLETED once it has actually succeeded. Nothing for BLOCKED / FAILED /
  // UNKNOWN.
  async #notifyRefund(decided, attempt) {
    if (!attempt || !decided?.customerId) return;
    const eventKey = attempt.status === 'SUCCEEDED' ? 'REFUND_COMPLETED'
      : ['PENDING', 'PROCESSING'].includes(attempt.status) ? 'REFUND_INITIATED'
        : null;
    if (!eventKey) return;
    try {
      await notificationService.emit(eventKey, {
        customerId: decided.customerId,
        refundAttemptId: attempt.id,
        requestNumber: decided.requestNumber,
        orderNumber: decided.orderNumber,
        amount: formatMinor(decided.refundableMinor, decided.currency),
        method: refundMethodPhrase(decided.method),
      });
    } catch { /* isolated */ }
  }

  /** Resolve an UNKNOWN provider refund (§92) — no blind duplicate. */
  async reconcile({ refundAttemptId, providerOutcome }) {
    if (!['SUCCEEDED', 'FAILED'].includes(providerOutcome)) {
      throw new AppError('VALIDATION_ERROR', 'providerOutcome must be SUCCEEDED or FAILED.', 400);
    }
    const result = await this.transaction(async (tx) => {
      const attempt = await this.repository.lockById(tx, refundAttemptId);
      if (!attempt) throw new AppError('REFUND_ATTEMPT_NOT_FOUND', 'Refund attempt not found.', 404);
      if (attempt.status !== 'UNKNOWN') return { dto: this.#attemptDto(attempt), attempt, changed: false };
      await this.repository.update(tx, attempt.id, {
        status: providerOutcome, reconciled_at: new Date(),
        completed_at: providerOutcome === 'SUCCEEDED' ? new Date() : null,
        failure_code: providerOutcome === 'FAILED' ? 'RECONCILED_FAILED' : null,
      });
      return { dto: this.#attemptDto({ ...attempt, status: providerOutcome }), attempt, changed: true };
    });
    if (result.changed && providerOutcome === 'SUCCEEDED') {
      try {
        const [request, order] = await Promise.all([
          this.returns.requestById(result.attempt.return_request_id),
          this.returns.orderById(result.attempt.order_id),
        ]);
        await notificationService.emit('REFUND_COMPLETED', {
          customerId: result.attempt.customer_id,
          refundAttemptId: result.attempt.id,
          requestNumber: request?.request_number || '',
          orderNumber: order?.order_number || '',
          amount: formatMinor(result.attempt.amount_minor, result.attempt.currency),
          method: refundMethodPhrase(result.attempt.method),
        });
      } catch { /* isolated */ }
    }
    return result.dto;
  }
}

export const refundService = new RefundService();

/**
 * Operations moving a COD payout by hand.
 *
 * There is no provider to ask, so the transition is explicit: a person paid
 * the customer (or failed to) and records which. Guarded so the ledger cannot
 * be walked backwards — a SUCCEEDED payout is terminal, and only a COD_PAYOUT
 * attempt is workable this way (an ORIGINAL_PAYMENT refund belongs to the
 * gateway reconciliation path, never to a manual mark).
 */
export async function transitionCodPayout({ returnRequestId, action, payoutReference = null, note = null, failureCode = null, staffId = null }) {
  const { withTransaction } = await import('../../database/connection/transaction.js');
  const { AppError: Err } = await import('../../utils/errors.js');

  return withTransaction(async (tx) => {
    const [rows] = await tx.execute(
      'SELECT * FROM refund_attempts WHERE return_request_id = ? FOR UPDATE', [returnRequestId],
    );
    const attempt = rows[0];
    if (!attempt) throw new Err('REFUND_NOT_FOUND', 'No refund exists for this return.', 404);
    if (attempt.method !== 'COD_PAYOUT') {
      throw new Err('REFUND_NOT_MANUAL', 'Only a COD payout can be settled by hand.', 409);
    }
    if (attempt.status === 'SUCCEEDED') {
      throw new Err('REFUND_ALREADY_COMPLETED', 'This refund is already marked refunded.', 409);
    }

    const now = new Date();
    let patch;
    if (action === 'START_PROCESSING') {
      if (attempt.status !== 'PENDING' && attempt.status !== 'FAILED') {
        throw new Err('REFUND_NOT_PENDING', 'Only a pending or failed payout can be moved to processing.', 409);
      }
      patch = { status: 'PROCESSING', processing_started_at: now, processed_by_staff_id: staffId, payout_note: note, failure_code: null };
    } else if (action === 'MARK_REFUNDED') {
      patch = { status: 'SUCCEEDED', completed_at: now, processed_by_staff_id: staffId, payout_reference: payoutReference, payout_note: note, failure_code: null };
    } else {
      // A failed payout stays workable — operations retry it rather than the
      // customer losing the refund because one transfer bounced.
      patch = { status: 'FAILED', processed_by_staff_id: staffId, payout_note: note, failure_code: failureCode || 'PAYOUT_FAILED' };
    }

    const cols = Object.keys(patch);
    await tx.execute(
      `UPDATE refund_attempts SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = NOW(3) WHERE id = ?`,
      [...cols.map((c) => patch[c] ?? null), attempt.id],
    );
    const [after] = await tx.execute('SELECT * FROM refund_attempts WHERE id = ?', [attempt.id]);
    const settled = after[0];

    // Tell the customer what happened. Isolated and post-update: a notification
    // problem must never roll back a payout that really was made, and silence
    // after a failed transfer is worse than the failure itself.
    if (action === 'MARK_REFUNDED' || action === 'MARK_FAILED') {
      const [ctxRows] = await tx.execute(
        `SELECT rr.request_number, o.order_number
           FROM return_requests rr JOIN orders o ON o.id = rr.order_id
          WHERE rr.id = ?`, [returnRequestId],
      );
      const ctx = ctxRows[0] || {};
      notifyPayoutOutcome({
        action,
        customerId: settled.customer_id,
        refundAttemptId: settled.id,
        requestNumber: ctx.request_number,
        orderNumber: ctx.order_number,
        amountMinor: Number(settled.amount_minor),
        currency: settled.currency,
      });
    }

    return {
      refundNumber: after[0].refund_number,
      method: after[0].method,
      status: after[0].status,
      amountMinor: Number(after[0].amount_minor),
      currency: after[0].currency,
      payoutReference: after[0].payout_reference,
      failureCode: after[0].failure_code,
      completedAt: after[0].completed_at ? new Date(after[0].completed_at).toISOString() : null,
    };
  });
}

/**
 * Fire-and-forget customer notification for a manual COD payout outcome.
 *
 * Deliberately NOT awaited by the caller and never inside the transaction: a
 * notification failure must not roll back money that has actually moved, and a
 * failed payout the customer never hears about is worse than the failure.
 */
function notifyPayoutOutcome({ action, customerId, refundAttemptId, requestNumber, orderNumber, amountMinor, currency }) {
  if (!customerId) return;
  const eventKey = action === 'MARK_REFUNDED' ? 'REFUND_COMPLETED' : 'REFUND_FAILED';
  Promise.resolve()
    .then(() => notificationService.emit(eventKey, {
      customerId,
      refundAttemptId,
      requestNumber,
      orderNumber,
      amount: formatMinor(amountMinor, currency),
      method: refundMethodPhrase('COD_PAYOUT'),
      // Distinguishes a second failure from the first so a retry that also
      // fails is not deduped into silence.
      ...(eventKey === 'REFUND_FAILED' ? { failedAt: Date.now() } : {}),
    }))
    .catch(() => { /* isolated — never surfaces to the operator settling a payout */ });
}
