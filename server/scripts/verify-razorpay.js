// Razorpay payment path — configuration safety, Razorpay Checkout (Orders API),
// browser-callback verification, webhooks, status lookup, cancel rules and
// refunds.
//
// The payment-webhook gate only exercised Cashfree, and it called the provider
// directly, so it never saw that PaymentService read every webhook signature
// from Cashfree's header: a genuine Razorpay webhook (x-razorpay-signature)
// was always rejected. This gate drives PaymentService with the headers and
// callbacks Razorpay actually sends.
//
// Razorpay Checkout replaced Payment Links (2026-09-15): the server creates an
// Order, the storefront opens Razorpay's window, and the browser's success
// callback is only accepted after its signature checks out AND Razorpay's own
// record of the order says it is paid. Links created before the switch must
// keep working, so those cases stay covered too.
//
// Pure: collaborators are fakes and every Razorpay API call is answered by a
// local stub. No DB writes, no network.
//
//   npm run verify:razorpay
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.RAZORPAY_ENVIRONMENT = 'SANDBOX';
process.env.RAZORPAY_KEY_ID = 'rzp_test_verifyKeyId';
process.env.RAZORPAY_KEY_SECRET = 'verify-razorpay-key-secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'verify-razorpay-webhook-secret';
process.env.RAZORPAY_API_BASE_URL = 'https://api.razorpay.test';
process.env.PAYMENT_RESERVATION_TTL_SECONDS = '1800';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

// Razorpay API stub: routes are registered per test; anything unrouted fails.
const calls = [];
let routes = [];
let unexpected = 0;
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  const method = init.method || 'GET';
  calls.push({ method, url, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
  const route = routes.find((r) => r.method === method && r.match.test(url));
  if (!route) { unexpected += 1; throw new Error(`unrouted ${method} ${url}`); }
  return route.reply({ url, body: init.body ? JSON.parse(init.body) : null });
};
const stub = (list) => { routes = list; calls.length = 0; };

const { pool } = await import('../src/database/connection/pool.js');
const { RazorpayProvider, verifyRazorpaySignature, verifyCheckoutSignature, razorpayConfigurationIssue } = await import('../src/modules/payments/providers/razorpayProvider.js');
const { PaymentProviderRegistry } = await import('../src/modules/payments/registry.js');
const { PaymentService } = await import('../src/modules/payments/service.js');
const { PAYMENT_STATES } = await import('../src/modules/payments/providerContract.js');

const SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;
const results = {};
const pass = (name, note) => { results[name] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${name}${note ? ` — ${note}` : ''}`); };
const sign = (rawBody, secret = SECRET) => crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const checkoutSig = (orderId, paymentId, secret = KEY_SECRET) => crypto.createHmac('sha256', secret).update(`${orderId}|${paymentId}`).digest('hex');
const REF = 'pay_0123456789abcdef0123456789abcdef';
const ORDER = 'order_TEST0001';

const linkEvent = (event, status, { amount = 249900, amountPaid = status === 'paid' ? 249900 : 0, withPayment = status === 'paid' } = {}) => ({
  entity: 'event', event,
  payload: {
    payment_link: { entity: { id: 'plink_TEST123', status, amount, amount_paid: amountPaid, currency: 'INR', reference_id: REF } },
    ...(withPayment ? { payment: { entity: { id: 'pay_TEST456', status: 'captured', amount: amountPaid, currency: 'INR', notes: { merchant_reference: REF } } } } : {}),
  },
});
const paymentEvent = (event, status, amount = 249900) => ({
  entity: 'event', event,
  payload: { payment: { entity: { id: 'pay_TEST789', status, amount, currency: 'INR', order_id: ORDER, notes: { merchant_reference: REF } } } },
});
const orderPaidEvent = (amount = 249900) => ({
  entity: 'event', event: 'order.paid',
  payload: {
    payment: { entity: { id: 'pay_OK1', status: 'captured', amount, currency: 'INR', order_id: ORDER, notes: { merchant_reference: REF } } },
    order: { entity: { id: ORDER, status: 'paid', amount, amount_paid: amount, currency: 'INR', receipt: REF } },
  },
});

// Razorpay's order + payments responses.
const orderBody = (status = 'attempted', amount = 249900) => ({ id: ORDER, entity: 'order', status, amount, amount_paid: status === 'paid' ? amount : 0, currency: 'INR', receipt: REF });
const orderRoutes = ({ status = 'paid', payments = [{ id: 'pay_OK1', status: 'captured', amount: 249900, currency: 'INR', method: 'upi' }] } = {}) => [
  { method: 'GET', match: new RegExp(`/v1/orders/${ORDER}$`), reply: () => json(200, orderBody(status)) },
  { method: 'GET', match: new RegExp(`/v1/orders/${ORDER}/payments$`), reply: () => json(200, { items: payments }) },
];

function makeWebhookService({ attempt = null, recordEvent = { id: 'evt-1', duplicate: false } } = {}) {
  const seen = { finishEvent: [], transition: [], schedule: [], finalize: [], recordEvent: [], staff: [] };
  const staffNotifications = { record: async (input) => { seen.staff.push(input); return 'notif-1'; } };
  const payments = {
    findAttemptByMerchant: async (ref) => (attempt && attempt.merchant_reference === ref ? attempt : null),
    recordEvent: async (arg) => { seen.recordEvent.push(arg); return recordEvent; },
    finishEvent: async (id, outcome) => { seen.finishEvent.push([id, outcome]); },
    transition: async (a, status, rawStatus) => { seen.transition.push([status, rawStatus]); return { ...a, status }; },
  };
  const orders = {
    schedule: async (checkoutId) => { seen.schedule.push(checkoutId); },
    finalize: async (checkoutId, opts) => { seen.finalize.push([checkoutId, opts?.source]); return { id: 'order-1' }; },
  };
  const service = new PaymentService({ payments, orders, staffNotifications, providerRegistry: new PaymentProviderRegistry([new RazorpayProvider()]) });
  return { service, seen };
}

// A checkout owned by cust-1 with one Razorpay attempt, for status / verify.
function makeCheckoutService(attempt) {
  const seen = { transition: [], finalize: [] };
  let current = attempt;
  const owns = (customerId, checkoutId) => customerId === 'cust-1' && checkoutId === 'chk-1';
  const payments = {
    ownedAttempt: async (customerId, checkoutId) => (owns(customerId, checkoutId) ? current : null),
    obligations: async () => [],
    transition: async (a, status, rawStatus, extra) => { seen.transition.push([status, rawStatus, extra?.failureMessage || null]); current = { ...a, status, failure_message_safe: extra?.failureMessage || null }; return current; },
  };
  const orders = { schedule: async () => {}, finalize: async (checkoutId, opts) => { seen.finalize.push([checkoutId, opts?.source]); return { id: 'order-1' }; } };
  const checkouts = { findOwned: async (customerId, checkoutId) => (owns(customerId, checkoutId) ? { id: checkoutId } : null) };
  const service = new PaymentService({ payments, orders, checkouts, providerRegistry: new PaymentProviderRegistry([new RazorpayProvider()]) });
  return { service, seen };
}

const razorpayRequest = (payload, { eventId = 'evt_Rzp001', secret = SECRET } = {}) => {
  const rawBody = JSON.stringify(payload);
  const headers = { 'x-razorpay-signature': sign(rawBody, secret) };
  if (eventId) headers['x-razorpay-event-id'] = eventId;
  return { headers, rawBody };
};
const pendingAttempt = (over = {}) => ({ id: 'att-1', checkout_id: 'chk-1', provider_code: 'RAZORPAY', merchant_reference: REF, provider_session_reference: ORDER, amount_minor: 249900, currency: 'INR', status: 'PENDING', ...over });

try {
  // ---- 1. configuration: live/test key must match the environment ----
  {
    const cfg = (over) => ({ RAZORPAY_ENVIRONMENT: 'PRODUCTION', RAZORPAY_KEY_ID: 'rzp_live_abc', RAZORPAY_KEY_SECRET: 's', RAZORPAY_WEBHOOK_SECRET: 'w', ...over });
    assert.equal(razorpayConfigurationIssue(cfg({})), null, 'live key + PRODUCTION is usable');
    assert.equal(razorpayConfigurationIssue(cfg({ RAZORPAY_ENVIRONMENT: 'SANDBOX', RAZORPAY_KEY_ID: 'rzp_test_abc' })), null, 'test key + SANDBOX is usable');
    assert.equal(razorpayConfigurationIssue(cfg({ RAZORPAY_ENVIRONMENT: 'SANDBOX' })), 'RAZORPAY_ENVIRONMENT_MISMATCH', 'live key labelled sandbox');
    assert.equal(razorpayConfigurationIssue(cfg({ RAZORPAY_KEY_ID: 'rzp_test_abc' })), 'RAZORPAY_ENVIRONMENT_MISMATCH', 'test key on production');
    assert.equal(razorpayConfigurationIssue(cfg({ RAZORPAY_KEY_ID: 'abc' })), 'RAZORPAY_KEY_ID_UNRECOGNISED');
    assert.equal(razorpayConfigurationIssue(cfg({ RAZORPAY_WEBHOOK_SECRET: undefined })), 'RAZORPAY_WEBHOOK_SECRET_MISSING');
    assert.equal(razorpayConfigurationIssue(cfg({ RAZORPAY_KEY_SECRET: undefined })), 'RAZORPAY_KEYS_MISSING');
    const provider = new RazorpayProvider();
    assert.equal(provider.configured, true, 'gate env (test key + SANDBOX + webhook secret) is configured');
    assert.equal(provider.supportsRefund(), true);
    pass('CONFIG_KEY_MODE_AND_WEBHOOK_SECRET_REQUIRED');
  }

  // ---- 2. signatures: webhook body + Checkout callback ----
  {
    const raw = JSON.stringify(orderPaidEvent());
    assert.equal(verifyRazorpaySignature(SECRET, { signature: sign(raw), rawBody: raw }), true);
    assert.equal(verifyRazorpaySignature(SECRET, { signature: sign(raw), rawBody: `${raw} ` }), false, 'tampered body');
    assert.equal(verifyRazorpaySignature(SECRET, { signature: sign(raw, 'other-secret'), rawBody: raw }), false, 'wrong secret');
    assert.equal(verifyRazorpaySignature(undefined, { signature: sign(raw), rawBody: raw }), false, 'no secret configured fails closed');
    assert.equal(verifyRazorpaySignature(SECRET, { signature: undefined, rawBody: raw }), false);
    pass('WEBHOOK_SIGNATURE_VERIFIED_SERVER_SIDE');

    const good = checkoutSig(ORDER, 'pay_OK1');
    assert.equal(verifyCheckoutSignature(KEY_SECRET, { orderId: ORDER, paymentId: 'pay_OK1', signature: good }), true);
    assert.equal(verifyCheckoutSignature(KEY_SECRET, { orderId: ORDER, paymentId: 'pay_OTHER', signature: good }), false, 'signature is bound to the payment');
    assert.equal(verifyCheckoutSignature(KEY_SECRET, { orderId: 'order_OTHER', paymentId: 'pay_OK1', signature: good }), false, 'signature is bound to the order');
    assert.equal(verifyCheckoutSignature(KEY_SECRET, { orderId: ORDER, paymentId: 'pay_OK1', signature: checkoutSig(ORDER, 'pay_OK1', SECRET) }), false, 'the webhook secret does not sign Checkout callbacks');
    assert.equal(verifyCheckoutSignature(undefined, { orderId: ORDER, paymentId: 'pay_OK1', signature: good }), false, 'no key secret fails closed');
    assert.equal(new RazorpayProvider().verifyCheckoutSignature({ orderId: ORDER, paymentId: 'pay_OK1', signature: good }), true, 'provider uses the Key Secret');
    pass('CHECKOUT_SIGNATURE_BOUND_TO_ORDER_AND_PAYMENT');
  }

  // ---- 3. order creation for Razorpay Checkout ----
  {
    stub([{ method: 'POST', match: /\/v1\/orders$/, reply: ({ body }) => json(200, { id: 'order_NEW0001', entity: 'order', status: 'created', amount: body.amount, currency: body.currency, receipt: body.receipt }) }]);
    const before = Date.now();
    const session = await new RazorpayProvider().createPaymentSession({
      merchantReference: REF, amountMinor: 249900, currency: 'INR', returnUrl: 'https://www.corcotton.in/checkout/payment?attempt=att-1',
      customer: { name: 'Test', email: 't@example.com', phone: '9999999999' },
    });
    const [call] = calls;
    assert.equal(calls.length, 1, 'one API call — no Payment Link');
    assert.equal(call.body.amount, 249900);
    assert.equal(call.body.currency, 'INR');
    assert.equal(call.body.receipt, REF);
    assert.equal(call.body.notes.merchant_reference, REF);
    assert.equal(call.body.partial_payment, false);
    assert.equal(call.headers.Authorization, `Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${KEY_SECRET}`).toString('base64')}`);
    assert.ok(!JSON.stringify(call.body).includes(KEY_SECRET), 'the key secret is never in the request body');
    assert.deepEqual([session.providerPaymentId, session.providerSessionReference, session.status], ['order_NEW0001', 'order_NEW0001', PAYMENT_STATES.PENDING]);
    const expiresIn = new Date(session.expiresAt).getTime() - before;
    assert.ok(expiresIn >= 1795000 && expiresIn <= 1810000, 'the Checkout window is bounded by the stock hold');
    pass('ORDER_CREATED_SERVER_SIDE_FOR_CHECKOUT');
  }

  // ---- 4. the storefront gets only public Checkout parameters ----
  {
    const orderAttempt = makeCheckoutService(pendingAttempt());
    const out = await orderAttempt.service.status('cust-1', 'chk-1');
    assert.deepEqual(out.attempt.checkout, { keyId: 'rzp_test_verifyKeyId', orderId: ORDER, amountMinor: 249900, currency: 'INR', merchantReference: REF });
    assert.equal(out.attempt.paymentUrl, null, 'no Payment Link for a Checkout attempt');
    assert.ok(!JSON.stringify(out).includes(KEY_SECRET), 'the key secret never reaches the storefront');

    const legacy = makeCheckoutService(pendingAttempt({ provider_session_reference: 'https://rzp.io/i/abc' }));
    const legacyOut = await legacy.service.status('cust-1', 'chk-1');
    assert.equal(legacyOut.attempt.checkout, null);
    assert.equal(legacyOut.attempt.paymentUrl, 'https://rzp.io/i/abc', 'an attempt opened before the switch keeps its link');
    pass('PUBLIC_CHECKOUT_PARAMS_ONLY');
  }

  // ---- 5. browser callback is verified, never trusted ----
  {
    const good = { orderId: ORDER, paymentId: 'pay_OK1', signature: checkoutSig(ORDER, 'pay_OK1') };

    stub(orderRoutes());
    const ok = makeCheckoutService(pendingAttempt());
    const verified = await ok.service.verifyRazorpayCheckout('cust-1', 'chk-1', good);
    assert.equal(verified.status, 'SUCCEEDED');
    assert.deepEqual(verified.order, { id: 'order-1' });
    assert.deepEqual(ok.seen.transition.map((t) => t.slice(0, 2)), [['SUCCEEDED', 'captured']]);
    assert.ok(calls.some((c) => /\/v1\/orders\/order_TEST0001\/payments$/.test(c.url)), 'Razorpay was asked, not the browser');
    pass('VERIFY_VALID_CALLBACK_READS_RAZORPAY_THEN_ORDERS');

    stub(orderRoutes());
    const forged = makeCheckoutService(pendingAttempt());
    await assert.rejects(() => forged.service.verifyRazorpayCheckout('cust-1', 'chk-1', { ...good, signature: checkoutSig(ORDER, 'pay_OK1', 'forged') }),
      (err) => err.code === 'PAYMENT_SIGNATURE_INVALID' && err.status === 400);
    assert.equal(calls.length, 0, 'a forged callback never reaches Razorpay');
    assert.equal(forged.seen.transition.length, 0);

    const otherOrder = makeCheckoutService(pendingAttempt());
    await assert.rejects(() => otherOrder.service.verifyRazorpayCheckout('cust-1', 'chk-1', { orderId: 'order_OTHER01', paymentId: 'pay_OK1', signature: checkoutSig('order_OTHER01', 'pay_OK1') }),
      (err) => err.code === 'PAYMENT_ATTEMPT_MISMATCH' && err.status === 409, 'a genuine signature for another order does not pay this checkout');

    const otherCustomer = makeCheckoutService(pendingAttempt());
    await assert.rejects(() => otherCustomer.service.verifyRazorpayCheckout('cust-2', 'chk-1', good),
      (err) => err.code === 'PAYMENT_ATTEMPT_MISMATCH', 'another customer cannot verify this checkout');
    assert.equal(otherOrder.seen.transition.length + otherCustomer.seen.transition.length, 0);
    pass('VERIFY_FORGED_FOREIGN_OR_MISMATCHED_CALLBACK_REFUSED');

    stub(orderRoutes({ status: 'attempted', payments: [{ id: 'pay_BAD1', status: 'failed', amount: 249900, currency: 'INR', error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment declined by bank', created_at: 1 }] }));
    const notPaid = makeCheckoutService(pendingAttempt());
    const pending = await notPaid.service.verifyRazorpayCheckout('cust-1', 'chk-1', { orderId: ORDER, paymentId: 'pay_BAD1', signature: checkoutSig(ORDER, 'pay_BAD1') });
    assert.equal(pending.status, 'PENDING', 'a valid signature is not payment: Razorpay says unpaid');
    assert.equal(pending.order, null, 'no order without a captured payment');
    assert.deepEqual(notPaid.seen.finalize, []);
    assert.equal(notPaid.seen.transition[0][2], 'Payment declined by bank', 'the failure reason is kept for the customer');
    pass('VERIFY_SIGNED_BUT_UNPAID_CREATES_NO_ORDER');
  }

  // ---- 6. webhooks through PaymentService with Razorpay's real headers ----
  {
    const { service, seen } = makeWebhookService({ attempt: pendingAttempt() });
    const out = await service.webhook('RAZORPAY', razorpayRequest(orderPaidEvent()));
    assert.deepEqual(out, { accepted: true });
    assert.deepEqual(seen.transition, [['SUCCEEDED', 'captured']]);
    assert.deepEqual(seen.finalize, [['chk-1', 'PAYMENT_WEBHOOK']], 'order.paid creates the order');
    assert.equal(seen.recordEvent[0].eventId, 'evt_Rzp001', 'de-duplicated on x-razorpay-event-id');
    assert.deepEqual(seen.finishEvent, [['evt-1', 'PROCESSED']]);
    pass('WEBHOOK_ORDER_PAID_CREATES_ORDER');

    const captured = makeWebhookService({ attempt: pendingAttempt() });
    await captured.service.webhook('RAZORPAY', razorpayRequest(paymentEvent('payment.captured', 'captured'), { eventId: 'evt_cap' }));
    assert.deepEqual(captured.seen.transition, [['SUCCEEDED', 'captured']], 'payment.captured maps via the payment notes');

    const legacy = makeWebhookService({ attempt: pendingAttempt({ provider_session_reference: 'https://rzp.io/i/abc' }) });
    await legacy.service.webhook('RAZORPAY', razorpayRequest(linkEvent('payment_link.paid', 'paid'), { eventId: 'evt_link' }));
    assert.deepEqual(legacy.seen.finalize, [['chk-1', 'PAYMENT_WEBHOOK']], 'a pre-switch Payment Link still completes');
    pass('WEBHOOK_CAPTURED_AND_LEGACY_LINK');

    const foreign = makeWebhookService({ attempt: pendingAttempt() });
    const raw = JSON.stringify(orderPaidEvent());
    await assert.rejects(
      () => foreign.service.webhook('RAZORPAY', { headers: { 'x-webhook-signature': sign(raw) }, rawBody: raw }),
      (err) => err.code === 'PAYMENT_WEBHOOK_INVALID' && err.status === 400,
    );
    await assert.rejects(
      () => foreign.service.webhook('RAZORPAY', razorpayRequest(orderPaidEvent(), { secret: 'forged' })),
      (err) => err.code === 'PAYMENT_WEBHOOK_INVALID',
    );
    assert.equal(foreign.seen.transition.length, 0);
    pass('WEBHOOK_BAD_OR_FOREIGN_SIGNATURE_REJECTED');

    const noEventId = makeWebhookService({ attempt: pendingAttempt() });
    const req = razorpayRequest(orderPaidEvent(), { eventId: null });
    await noEventId.service.webhook('RAZORPAY', req);
    assert.equal(noEventId.seen.recordEvent[0].eventId, crypto.createHash('sha256').update(req.rawBody).digest('hex'), 'falls back to the payload hash');
    pass('WEBHOOK_EVENT_ID_FALLBACK');

    const failedTry = makeWebhookService({ attempt: pendingAttempt() });
    await failedTry.service.webhook('RAZORPAY', razorpayRequest(paymentEvent('payment.failed', 'failed'), { eventId: 'evt_f' }));
    assert.deepEqual(failedTry.seen.transition, [['PENDING', 'failed']], 'a failed try leaves the order open for another try');
    assert.equal(failedTry.seen.finalize.length, 0);
    const expired = makeWebhookService({ attempt: pendingAttempt() });
    await expired.service.webhook('RAZORPAY', razorpayRequest(linkEvent('payment_link.expired', 'expired'), { eventId: 'evt_e' }));
    assert.deepEqual(expired.seen.transition, [['EXPIRED', 'expired']]);
    assert.equal(expired.seen.finalize.length, 0);
    pass('WEBHOOK_FAILED_OR_EXPIRED_NO_ORDER');

    const mismatch = makeWebhookService({ attempt: pendingAttempt({ amount_minor: 100 }) });
    await assert.rejects(
      () => mismatch.service.webhook('RAZORPAY', razorpayRequest(orderPaidEvent(), { eventId: 'evt_m' })),
      (err) => err.code === 'PAYMENT_PROVIDER_AMOUNT_MISMATCH' && err.status === 409,
    );
    assert.equal(mismatch.seen.transition.length, 0);
    assert.deepEqual(mismatch.seen.finishEvent, [['evt-1', 'REJECTED']]);
    pass('WEBHOOK_AMOUNT_MISMATCH_REJECTED');

    // An old Razorpay window paid after the customer switched gateway: flagged, not a second order.
    for (const closedStatus of ['CANCELLED', 'EXPIRED']) {
      const closed = makeWebhookService({ attempt: pendingAttempt({ status: closedStatus }) });
      const closedOut = await closed.service.webhook('RAZORPAY', razorpayRequest(orderPaidEvent(), { eventId: `evt_closed_${closedStatus}` }));
      assert.deepEqual(closedOut, { accepted: true, reviewRequired: true });
      assert.equal(closed.seen.transition.length, 0, `a ${closedStatus} attempt is not turned into a paid one`);
      assert.equal(closed.seen.finalize.length, 0, 'no second order');
      assert.deepEqual(closed.seen.finishEvent, [], 'the event stays RECEIVED for reconciliation');
      assert.equal(closed.seen.staff.length, 1);
      assert.deepEqual([closed.seen.staff[0].eventKey, closed.seen.staff[0].severity], ['PAYMENT_ON_CLOSED_ATTEMPT', 'CRITICAL']);
      assert.equal(closed.seen.staff[0].dedupeKey, 'payment_on_closed_attempt:att-1:pay_OK1', 'deduped per attempt and payment');
    }
    pass('WEBHOOK_PAYMENT_ON_CLOSED_ATTEMPT_FLAGGED_NOT_ORDERED');

    const dup = makeWebhookService({ attempt: pendingAttempt({ status: 'SUCCEEDED' }), recordEvent: { id: 'evt-d', duplicate: true } });
    const dupOut = await dup.service.webhook('RAZORPAY', razorpayRequest(orderPaidEvent()));
    assert.deepEqual(dupOut, { duplicate: true });
    assert.equal(dup.seen.transition.length, 0, 'a retried event never re-transitions');
    assert.deepEqual(dup.seen.finalize, [['chk-1', 'PAYMENT_WEBHOOK']], 'finalize is re-run idempotently');
    pass('WEBHOOK_RETRY_IDEMPOTENT');
  }

  // ---- 7. status lookup, server to server ----
  {
    const provider = new RazorpayProvider();
    stub(orderRoutes());
    let s = await provider.getPaymentStatus({ merchantReference: REF, providerSessionReference: ORDER });
    assert.deepEqual([s.status, s.amountMinor, s.providerPaymentId, s.paymentMethod], [PAYMENT_STATES.SUCCEEDED, 249900, 'pay_OK1', 'upi']);

    stub(orderRoutes({ status: 'attempted', payments: [{ id: 'pay_A', status: 'authorized', amount: 249900, currency: 'INR' }] }));
    s = await provider.getPaymentStatus({ merchantReference: REF, providerSessionReference: ORDER });
    assert.equal(s.status, PAYMENT_STATES.AUTHORIZED);

    stub(orderRoutes({ status: 'attempted', payments: [{ id: 'pay_F1', status: 'failed', error_description: 'Old failure', created_at: 1 }, { id: 'pay_F2', status: 'failed', error_description: 'Latest failure', created_at: 2 }] }));
    s = await provider.getPaymentStatus({ merchantReference: REF, providerSessionReference: ORDER });
    assert.deepEqual([s.status, s.failureMessage], [PAYMENT_STATES.PENDING, 'Latest failure'], 'failed tries: still payable, latest reason');

    stub([
      { method: 'GET', match: /\/v1\/orders\?receipt=/, reply: () => json(200, { items: [orderBody('paid')] }) },
      { method: 'GET', match: new RegExp(`/v1/orders/${ORDER}/payments$`), reply: () => json(200, { items: [{ id: 'pay_OK1', status: 'captured', amount: 249900, currency: 'INR' }] }) },
    ]);
    s = await provider.getPaymentStatus({ merchantReference: REF });
    assert.equal(s.status, PAYMENT_STATES.SUCCEEDED, 'found by receipt when no order id is known');

    stub([{ method: 'GET', match: /\/v1\/payment_links\?reference_id=/, reply: () => json(200, { payment_links: [{ id: 'plink_NEW1', status: 'paid', amount: 249900, amount_paid: 249900, currency: 'INR', payments: [{ payment_id: 'pay_OK1', status: 'captured' }] }] }) }]);
    s = await provider.getPaymentStatus({ merchantReference: REF, providerSessionReference: 'https://rzp.io/i/abc' });
    assert.deepEqual([s.status, s.providerPaymentId], [PAYMENT_STATES.SUCCEEDED, 'pay_OK1'], 'legacy link attempt');
    pass('STATUS_LOOKUP_SERVER_TO_SERVER');
  }

  // ---- 8. switching gateway: an order is only left when nothing is paid on it ----
  {
    const provider = new RazorpayProvider();
    stub(orderRoutes({ status: 'attempted', payments: [{ id: 'pay_F', status: 'failed' }] }));
    assert.deepEqual(await provider.cancelSession({ merchantReference: REF, providerSessionReference: ORDER }), { cancelled: true });
    stub(orderRoutes());
    await assert.rejects(() => provider.cancelSession({ merchantReference: REF, providerSessionReference: ORDER }), (err) => err.message === 'RAZORPAY_ORDER_ALREADY_PAID');
    stub(orderRoutes({ status: 'attempted', payments: [{ id: 'pay_A', status: 'authorized' }] }));
    await assert.rejects(() => provider.cancelSession({ merchantReference: REF, providerSessionReference: ORDER }), (err) => err.message === 'RAZORPAY_PAYMENT_IN_PROGRESS');

    stub([
      { method: 'GET', match: /\/v1\/payment_links\?reference_id=/, reply: () => json(200, { payment_links: [{ id: 'plink_OPEN1', status: 'created' }] }) },
      { method: 'POST', match: /\/v1\/payment_links\/plink_OPEN1\/cancel$/, reply: () => json(200, { id: 'plink_OPEN1', status: 'cancelled' }) },
    ]);
    assert.deepEqual(await provider.cancelSession({ merchantReference: REF, providerSessionReference: 'https://rzp.io/i/abc' }), { cancelled: true });
    assert.ok(calls.some((c) => c.method === 'POST' && /cancel$/.test(c.url)), 'a legacy link is closed at Razorpay');
    pass('CANCEL_REFUSED_WHILE_PAID_OR_IN_PROGRESS');
  }

  // ---- 9. refunds ----
  {
    const provider = new RazorpayProvider();
    const refundRoutes = [
      { method: 'GET', match: /\/v1\/payments\/pay_OK1\/refunds/, reply: () => json(200, { items: [] }) },
      { method: 'POST', match: /\/v1\/payments\/pay_OK1\/refund$/, reply: ({ body }) => json(200, { id: 'rfnd_1', status: 'processed', amount: body.amount }) },
    ];

    stub([{ method: 'GET', match: new RegExp(`/v1/orders/${ORDER}/payments$`), reply: () => json(200, { items: [{ id: 'pay_F', status: 'failed' }, { id: 'pay_OK1', status: 'captured' }] }) }, ...refundRoutes]);
    const refund = await provider.refund({ paymentRefundId: 'pr-1', providerPaymentId: ORDER, amountMinor: 50000, currency: 'INR', idempotencyKey: 'refund:pr-1' });
    assert.deepEqual(refund, { providerRefundId: 'rfnd_1', status: PAYMENT_STATES.SUCCEEDED, rawStatus: 'processed' });
    const post = calls.find((c) => c.method === 'POST');
    assert.deepEqual([post.body.amount, post.body.notes.idempotency_key], [50000, 'refund:pr-1'], 'refunds the captured payment, not the order');
    pass('REFUND_RESOLVES_CAPTURED_PAYMENT_FROM_ORDER');

    const linkRoute = { method: 'GET', match: /\/v1\/payment_links\/plink_NEW1$/, reply: () => json(200, { id: 'plink_NEW1', payments: [{ payment_id: 'pay_OK1', status: 'captured' }] }) };
    stub([linkRoute, ...refundRoutes]);
    const legacy = await provider.refund({ paymentRefundId: 'pr-5', providerPaymentId: 'plink_NEW1', amountMinor: 100, currency: 'INR', idempotencyKey: 'refund:pr-5' });
    assert.equal(legacy.providerRefundId, 'rfnd_1', 'a pre-switch link payment can still be refunded');

    stub([linkRoute, { method: 'GET', match: /\/v1\/payments\/pay_OK1\/refunds/, reply: () => json(200, { items: [{ id: 'rfnd_1', status: 'pending', notes: { idempotency_key: 'refund:pr-1' } }] }) }]);
    const retried = await provider.refund({ paymentRefundId: 'pr-1', providerPaymentId: 'plink_NEW1', amountMinor: 50000, currency: 'INR', idempotencyKey: 'refund:pr-1' });
    assert.deepEqual(retried, { providerRefundId: 'rfnd_1', status: PAYMENT_STATES.PENDING, rawStatus: 'pending' });
    assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'a retry never refunds twice');
    pass('REFUND_RETRY_IDEMPOTENT');

    stub([linkRoute, { method: 'GET', match: /\/v1\/payments\/pay_OK1\/refunds/, reply: () => json(200, { items: [] }) },
      { method: 'POST', match: /\/refund$/, reply: () => { throw new Error('socket hang up'); } }]);
    await assert.rejects(() => provider.refund({ paymentRefundId: 'pr-2', providerPaymentId: 'plink_NEW1', amountMinor: 1, idempotencyKey: 'refund:pr-2' }), (err) => err.ambiguous === true, 'a timeout is unknown, not failed');
    stub([linkRoute, { method: 'GET', match: /\/v1\/payments\/pay_OK1\/refunds/, reply: () => json(200, { items: [] }) },
      { method: 'POST', match: /\/refund$/, reply: () => json(400, { error: { code: 'BAD_REQUEST_ERROR' } }) }]);
    await assert.rejects(() => provider.refund({ paymentRefundId: 'pr-3', providerPaymentId: 'plink_NEW1', amountMinor: 1, idempotencyKey: 'refund:pr-3' }), (err) => err.message === 'RAZORPAY_REFUND_REJECTED' && !err.ambiguous);
    stub([{ method: 'GET', match: new RegExp(`/v1/orders/${ORDER}/payments$`), reply: () => json(200, { items: [{ id: 'pay_F', status: 'failed' }] }) }]);
    await assert.rejects(() => provider.refund({ paymentRefundId: 'pr-4', providerPaymentId: ORDER, amountMinor: 1, idempotencyKey: 'refund:pr-4' }), (err) => err.message === 'RAZORPAY_NO_CAPTURED_PAYMENT');
    pass('REFUND_TIMEOUT_UNKNOWN_REJECTION_FAILED');

    // A refund Razorpay itself failed — a closed card, a bank rejection. It was
    // reported as PENDING, which parks money that will never arrive in "with
    // the gateway" forever, with no reason and nothing to retry.
    stub([linkRoute, { method: 'GET', match: /\/v1\/payments\/pay_OK1\/refunds/, reply: () => json(200, { items: [] }) },
      { method: 'POST', match: /\/refund$/, reply: () => json(200, { id: 'rfnd_F', status: 'failed', error_description: 'Card is closed' }) }]);
    await assert.rejects(
      () => provider.refund({ paymentRefundId: 'pr-6', providerPaymentId: 'plink_NEW1', amountMinor: 100, idempotencyKey: 'refund:pr-6' }),
      (err) => err.message === 'RAZORPAY_REFUND_FAILED' && !err.ambiguous && err.providerRefundId === 'rfnd_F');
    pass('REFUND_FAILED_IS_NOT_REPORTED_AS_PENDING');

    const refunds = await import('../src/modules/returns/refundService.js');
    const instance = Object.values(refunds).find((v) => v?.registry && typeof v.registry.resolve === 'function');
    assert.ok(instance, 'refund service instance exported');
    assert.equal(instance.registry.resolve('RAZORPAY')?.code, 'RAZORPAY', 'refund service can reach Razorpay');
    pass('REFUND_SERVICE_REGISTERS_RAZORPAY');
  }

  assert.equal(unexpected, 0, 'no unrouted outbound call');
  pass('NO_EXTERNAL_PROVIDER_CALLS');
  console.log('\nRAZORPAY_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nRAZORPAY_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
