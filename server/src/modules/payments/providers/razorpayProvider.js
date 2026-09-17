import crypto from 'node:crypto';
import { env } from '../../../config/index.js';
import { PaymentProvider, PAYMENT_STATES } from '../providerContract.js';

// Razorpay adapter — Orders API + Razorpay Standard Checkout.
//
// The server creates a Razorpay Order for the exact server-calculated amount;
// the storefront opens Razorpay's own Checkout window for that order with the
// public Key ID only. The Key Secret never leaves this server: it
// authenticates API calls (Basic auth) and verifies the Checkout signature.
// A payment is never confirmed on the browser's word — the signature proves
// the callback came from Razorpay Checkout, and the order's payments are then
// read back from Razorpay before an attempt moves
// (PaymentService#verifyRazorpayCheckout, #status reconcile, webhooks).
//
// It used to create a Payment Link and send the customer to its hosted page,
// which put the link page's own contact-details and confirmation screens in
// front of the payment. Links created before this change are still understood
// (status, cancel, webhook, refund), so no open attempt is stranded.

const base = () => (env.RAZORPAY_API_BASE_URL || 'https://api.razorpay.com').replace(/\/+$/, '');
const authHeader = () => `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;
const jsonHeaders = () => ({ 'Content-Type': 'application/json', Authorization: authHeader() });

const isOrderReference = (ref) => String(ref || '').startsWith('order_');

// Order states. `attempted` = tried and not (yet) paid: the order stays open
// for another try, so it is still pending, not failed.
const ORDER_STATE = {
  created: PAYMENT_STATES.PENDING,
  attempted: PAYMENT_STATES.PENDING,
  paid: PAYMENT_STATES.SUCCEEDED,
};
// Payment Link states — attempts created before Razorpay Checkout.
const LINK_STATE = {
  created: PAYMENT_STATES.PENDING,
  partially_paid: PAYMENT_STATES.PENDING,
  paid: PAYMENT_STATES.SUCCEEDED,
  cancelled: PAYMENT_STATES.CANCELLED,
  expired: PAYMENT_STATES.EXPIRED,
};
// payment.* events. A failed card or UPI try does not end the attempt: the
// customer can pay again on the same order.
const PAYMENT_STATE = {
  created: PAYMENT_STATES.PENDING,
  authorized: PAYMENT_STATES.AUTHORIZED,
  captured: PAYMENT_STATES.SUCCEEDED,
  refunded: PAYMENT_STATES.SUCCEEDED,
  failed: PAYMENT_STATES.PENDING,
};

const hmacEquals = (expected, signature) => {
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

/** HMAC-SHA256(rawBody, webhook secret), hex — Razorpay's `x-razorpay-signature`. */
export function verifyRazorpaySignature(secret, { signature, rawBody }) {
  if (!secret || !signature || !rawBody) return false;
  return hmacEquals(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), signature);
}

/** Razorpay Checkout's handler signature: HMAC-SHA256(`${order_id}|${payment_id}`, Key Secret), hex. */
export function verifyCheckoutSignature(secret, { orderId, paymentId, signature }) {
  if (!secret || !orderId || !paymentId || !signature) return false;
  return hmacEquals(crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex'), signature);
}

/**
 * Why Razorpay cannot be used, or null when it can. Live keys (rzp_live_)
 * belong to RAZORPAY_ENVIRONMENT=PRODUCTION and test keys (rzp_test_) to
 * SANDBOX, so a live key never runs labelled as sandbox or the reverse. The
 * webhook secret is required too: without it every payment webhook is
 * rejected and a paid order waits for the customer to come back to the site.
 */
export function razorpayConfigurationIssue(config = env) {
  if (!config.RAZORPAY_KEY_ID || !config.RAZORPAY_KEY_SECRET) return 'RAZORPAY_KEYS_MISSING';
  if (!config.RAZORPAY_WEBHOOK_SECRET) return 'RAZORPAY_WEBHOOK_SECRET_MISSING';
  const keyMode = config.RAZORPAY_KEY_ID.startsWith('rzp_live_') ? 'PRODUCTION'
    : config.RAZORPAY_KEY_ID.startsWith('rzp_test_') ? 'SANDBOX' : null;
  if (!keyMode) return 'RAZORPAY_KEY_ID_UNRECOGNISED';
  if (keyMode !== config.RAZORPAY_ENVIRONMENT) return 'RAZORPAY_ENVIRONMENT_MISMATCH';
  return null;
}

// Razorpay refunds are `pending` -> `processed`, or `failed` when the money
// could not be returned (a closed card, a bank rejection). Mapping `failed` to
// PENDING — as this did — parks a refund that will never arrive in "with the
// gateway" forever: no failure reason, no staff task, no retry.
const refundResult = (refund) => {
  if (refund.status === 'failed') {
    const err = new Error('RAZORPAY_REFUND_FAILED');
    err.providerRefundId = String(refund.id);
    err.providerMessage = refund.error_description || refund.speed_processed || null;
    throw err;
  }
  return {
    providerRefundId: String(refund.id),
    status: refund.status === 'processed' ? PAYMENT_STATES.SUCCEEDED : PAYMENT_STATES.PENDING,
    rawStatus: refund.status || null,
  };
};

export class RazorpayProvider extends PaymentProvider {
  constructor() {
    const issue = razorpayConfigurationIssue();
    super({ code: 'RAZORPAY', configured: !issue });
    this.configurationIssue = issue;
  }

  async #get(path) {
    let response;
    try { response = await fetch(`${base()}${path}`, { headers: jsonHeaders() }); } catch { throw new Error('RAZORPAY_UNREACHABLE'); }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error('PAYMENT_PROVIDER_REJECTED');
    return data;
  }

  async #post(path, body) {
    let response;
    try {
      response = await fetch(`${base()}${path}`, { method: 'POST', headers: jsonHeaders(), body: body === undefined ? undefined : JSON.stringify(body) });
    } catch { throw new Error('RAZORPAY_UNREACHABLE'); }
    const data = await response.json().catch(() => null);
    if (!response.ok || !data) throw new Error('PAYMENT_PROVIDER_REJECTED');
    return data;
  }

  async createPaymentSession(request) {
    if (!this.configured) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
    const order = await this.#post('/v1/orders', {
      amount: Math.round(Number(request.amountMinor)), // paise, integer — the server's amount, never the browser's
      currency: request.currency,
      // The merchant reference: how webhooks (order.receipt, payment notes) find the attempt.
      receipt: String(request.merchantReference).slice(0, 40),
      partial_payment: false,
      notes: { merchant_reference: request.merchantReference },
    });
    if (!order?.id) throw new Error('PAYMENT_PROVIDER_REJECTED');
    // The Checkout window closes when the stock hold for this checkout would
    // lapse (the storefront passes the remaining time as Checkout's `timeout`).
    const lifetime = Math.max(Number(env.PAYMENT_RESERVATION_TTL_SECONDS) || 0, 60);
    return {
      providerPaymentId: String(order.id),
      // The order id the storefront opens Razorpay Checkout for.
      providerSessionReference: String(order.id),
      rawStatus: order.status || 'created',
      status: ORDER_STATE[order.status] || PAYMENT_STATES.PENDING,
      expiresAt: new Date(Date.now() + lifetime * 1000).toISOString(),
    };
  }

  async #orderByReceipt(merchantReference) {
    const data = await this.#get(`/v1/orders?receipt=${encodeURIComponent(String(merchantReference).slice(0, 40))}`);
    return Array.isArray(data.items) ? data.items[0] || null : null;
  }

  async #order({ merchantReference, providerSessionReference }) {
    if (isOrderReference(providerSessionReference)) return this.#get(`/v1/orders/${encodeURIComponent(providerSessionReference)}`);
    return this.#orderByReceipt(merchantReference);
  }

  /** An order's state as Razorpay's own record of its payments says. */
  async #orderStatus(order) {
    const data = await this.#get(`/v1/orders/${encodeURIComponent(order.id)}/payments`);
    const items = Array.isArray(data.items) ? data.items : [];
    const captured = items.find((p) => p.status === 'captured' || p.status === 'refunded');
    const authorized = items.find((p) => p.status === 'authorized');
    const lastFailed = items.filter((p) => p.status === 'failed').sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))[0];
    const status = captured || order.status === 'paid' ? PAYMENT_STATES.SUCCEEDED
      : authorized ? PAYMENT_STATES.AUTHORIZED
        : ORDER_STATE[order.status] || PAYMENT_STATES.PENDING;
    const pending = status === PAYMENT_STATES.PENDING;
    return {
      status,
      rawStatus: captured?.status || authorized?.status || order.status,
      amountMinor: Math.round(Number(captured?.amount ?? (order.amount_paid || order.amount))),
      currency: captured?.currency || order.currency,
      providerPaymentId: String(captured?.id || authorized?.id || order.id),
      paymentMethod: (captured || authorized)?.method || null,
      failureCode: pending && lastFailed ? (lastFailed.error_code || 'PAYMENT_FAILED') : null,
      failureMessage: pending && lastFailed ? (lastFailed.error_description || 'The payment did not go through.') : null,
    };
  }

  async #linkByReference(merchantReference) {
    const data = await this.#get(`/v1/payment_links?reference_id=${encodeURIComponent(merchantReference)}`);
    return Array.isArray(data.payment_links) ? data.payment_links[0] || null : null;
  }

  async getPaymentStatus({ merchantReference, providerSessionReference = null }) {
    const legacyLink = providerSessionReference && !isOrderReference(providerSessionReference);
    if (!legacyLink) {
      const order = await this.#order({ merchantReference, providerSessionReference });
      if (order) return this.#orderStatus(order);
      if (providerSessionReference) throw new Error('PAYMENT_PROVIDER_REJECTED');
    }
    // A Payment Link attempt from before Razorpay Checkout.
    const link = await this.#linkByReference(merchantReference);
    if (!link) throw new Error('PAYMENT_PROVIDER_REJECTED');
    const paidPayment = (link.payments || []).find((p) => p.status === 'captured') || (link.payments || [])[0] || null;
    return {
      status: LINK_STATE[link.status] || PAYMENT_STATES.PENDING,
      rawStatus: link.status,
      amountMinor: Math.round(Number(link.amount_paid || link.amount)),
      currency: link.currency,
      providerPaymentId: String(paidPayment?.payment_id || link.id || ''),
      failureCode: null,
      failureMessage: link.status === 'cancelled' ? 'Payment was cancelled.' : null,
    };
  }

  /**
   * Walk away from this session because the customer chose another gateway.
   * A Razorpay Order cannot be cancelled, so it is only safe to leave while
   * nothing on it is paid or being paid — otherwise refuse, and the switch
   * keeps the payment. A legacy Payment Link is closed at Razorpay.
   */
  async cancelSession({ merchantReference, providerSessionReference = null }) {
    if (!this.configured) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
    if (!providerSessionReference || isOrderReference(providerSessionReference)) {
      const order = await this.#order({ merchantReference, providerSessionReference });
      if (order) {
        const state = await this.#orderStatus(order);
        if (state.status === PAYMENT_STATES.SUCCEEDED) throw new Error('RAZORPAY_ORDER_ALREADY_PAID');
        if (state.status === PAYMENT_STATES.AUTHORIZED) throw new Error('RAZORPAY_PAYMENT_IN_PROGRESS');
        return { cancelled: true };
      }
      if (providerSessionReference) return { cancelled: true };
    }
    const link = await this.#linkByReference(merchantReference);
    if (!link || ['cancelled', 'expired'].includes(link.status)) return { cancelled: true };
    if (link.status === 'paid') throw new Error('RAZORPAY_LINK_ALREADY_PAID');
    await this.#post(`/v1/payment_links/${encodeURIComponent(link.id)}/cancel`);
    return { cancelled: true };
  }

  /** Razorpay's own headers: the HMAC signature and a per-event id for de-duplication. */
  webhookInput(headers) {
    return { signature: headers['x-razorpay-signature'], eventId: headers['x-razorpay-event-id'] || null };
  }

  verifyWebhook({ signature, rawBody }) {
    return verifyRazorpaySignature(env.RAZORPAY_WEBHOOK_SECRET, { signature, rawBody });
  }

  /** The Checkout success callback's signature, checked with the Key Secret. */
  verifyCheckoutSignature({ orderId, paymentId, signature }) {
    return verifyCheckoutSignature(env.RAZORPAY_KEY_SECRET, { orderId, paymentId, signature });
  }

  normalizeWebhook(payload) {
    const event = payload?.event || 'unknown';
    const order = payload?.payload?.order?.entity || {};
    const link = payload?.payload?.payment_link?.entity || {};
    const payment = payload?.payload?.payment?.entity || {};
    const merchantReference = order.receipt
      || link.reference_id
      || payment.notes?.merchant_reference
      || payment.notes?.merchantReference
      || null;

    let status;
    if (event === 'order.paid') status = PAYMENT_STATES.SUCCEEDED;
    else if (event.startsWith('payment_link.')) status = LINK_STATE[link.status] || PAYMENT_STATES.PENDING;
    else if (event.startsWith('payment.')) status = PAYMENT_STATE[payment.status] || PAYMENT_STATES.PENDING;
    else status = PAYMENT_STATES.PENDING;

    return {
      merchantReference,
      providerPaymentId: String(payment.id || order.id || link.id || ''),
      status,
      rawStatus: payment.status || order.status || link.status || event,
      amountMinor: Math.round(Number(payment.amount || order.amount_paid || link.amount_paid || order.amount || link.amount || 0)),
      currency: payment.currency || order.currency || link.currency || 'INR',
      eventType: event,
    };
  }

  supportsRefund() {
    return this.configured;
  }

  /** The attempt stores the order id (order_) or, for older attempts, the link id (plink_); a refund needs the captured payment (pay_). */
  async #capturedPaymentId(providerPaymentId) {
    const id = String(providerPaymentId || '');
    if (id.startsWith('pay_')) return id;
    if (id.startsWith('order_')) {
      const data = await this.#get(`/v1/orders/${encodeURIComponent(id)}/payments`);
      const captured = (data.items || []).find((p) => p.status === 'captured');
      if (!captured?.id) throw new Error('RAZORPAY_NO_CAPTURED_PAYMENT');
      return String(captured.id);
    }
    if (!id.startsWith('plink_')) throw new Error('RAZORPAY_PAYMENT_REFERENCE_UNKNOWN');
    const link = await this.#get(`/v1/payment_links/${encodeURIComponent(id)}`);
    const captured = (link.payments || []).find((p) => p.status === 'captured');
    if (!captured?.payment_id) throw new Error('RAZORPAY_NO_CAPTURED_PAYMENT');
    return String(captured.payment_id);
  }

  async refund({ paymentRefundId, providerPaymentId, amountMinor, idempotencyKey }) {
    if (!this.configured) throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
    const paymentId = await this.#capturedPaymentId(providerPaymentId);
    // A retry after a timeout must not refund twice: a refund already created
    // for this key is returned instead of creating another one.
    const listed = await this.#get(`/v1/payments/${encodeURIComponent(paymentId)}/refunds?count=100`);
    const existing = (listed.items || []).find((r) => r.notes?.idempotency_key === idempotencyKey);
    if (existing) return refundResult(existing);

    let response;
    try {
      response = await fetch(`${base()}/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          amount: Math.round(Number(amountMinor)),
          speed: 'normal',
          notes: { idempotency_key: idempotencyKey, payment_refund_id: paymentRefundId },
        }),
      });
    } catch {
      // The request may have reached Razorpay: the outcome is unknown, not failed.
      throw Object.assign(new Error('RAZORPAY_REFUND_TIMEOUT'), { ambiguous: true });
    }
    const data = await response.json().catch(() => null);
    if (response.status >= 500) throw Object.assign(new Error('RAZORPAY_REFUND_UNCONFIRMED'), { ambiguous: true });
    if (!response.ok || !data?.id) throw new Error('RAZORPAY_REFUND_REJECTED');
    return refundResult(data);
  }
}
