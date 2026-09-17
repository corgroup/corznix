// Cashfree payment-webhook characterization — Provider Platform Migration,
// Phase 1.
//
// Freezes the OBSERVABLE contract of the inbound payment webhook path so a
// future payment-provider swap can prove parity:
//   - HMAC signature verification (valid / tampered body / wrong secret /
//     missing fields)
//   - normalizeWebhook: provider status vocabulary -> PAYMENT_STATES,
//     amount -> minor units, merchant reference extraction
//   - PaymentService.webhook(): unknown provider, bad signature, no matching
//     attempt (IGNORED), amount/currency mismatch (REJECTED), successful
//     transition + order finalize, failed transition (no finalize),
//     duplicate-event idempotency
//
// Pure in-memory: the provider is the real CashfreeProvider, the repository
// and order-finalization collaborators are fakes. No DB writes, no network.
//
// Test-run override (documented): CASHFREE_CLIENT_SECRET is forced to a known
// value so this script can produce a valid signature; verifyWebhook reads the
// same env var, so the check is self-consistent.
//
//   npm run verify:payment-webhook
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.CASHFREE_CLIENT_SECRET = 'verify-payment-webhook-secret-value';
process.env.CASHFREE_CLIENT_ID ||= 'verify-cf-client-id';
process.env.CASHFREE_API_BASE_URL ||= 'https://sandbox.cashfree.test';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

let externalCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) externalCalls += 1;
  return realFetch(input, init);
};

const { pool } = await import('../src/database/connection/pool.js');
const { CashfreeProvider } = await import('../src/modules/payments/providers/cashfreeProvider.js');
const { PaymentProviderRegistry } = await import('../src/modules/payments/registry.js');
const { PaymentService } = await import('../src/modules/payments/service.js');
const { PAYMENT_STATES } = await import('../src/modules/payments/providerContract.js');

const SECRET = process.env.CASHFREE_CLIENT_SECRET;
const results = {};
const pass = (name) => { results[name] = 'PASS'; console.log(`  PASS  ${name}`); };

function sign(rawBody, { secret = SECRET, timestamp = String(Date.now()) } = {}) {
  return crypto.createHmac('sha256', secret).update(String(timestamp) + rawBody).digest('base64');
}
function signedRequest(payloadObj, { secret = SECRET, timestamp = String(Date.now()), idempotencyKey } = {}) {
  const rawBody = JSON.stringify(payloadObj);
  const headers = { 'x-webhook-timestamp': timestamp, 'x-webhook-signature': sign(rawBody, { secret, timestamp }) };
  if (idempotencyKey) headers['x-idempotency-key'] = idempotencyKey;
  return { headers, rawBody };
}

const cfPayload = (over = {}) => ({
  type: 'PAYMENT_SUCCESS_WEBHOOK',
  data: {
    order: { order_id: 'COR-WEBHOOK-TEST-0001', order_amount: 50.97, order_currency: 'INR' },
    payment: { cf_payment_id: 987654321, payment_status: 'SUCCESS', payment_amount: 50.97, payment_currency: 'INR' },
  },
  ...over,
});

// A fake repository whose method calls are recorded for assertions.
function makeFakes({ attempt = null, recordEvent = { id: 'evt-1', duplicate: false } } = {}) {
  const calls = { finishEvent: [], transition: [], schedule: [], finalize: [], recordEvent: [] };
  const payments = {
    findAttemptByMerchant: async (ref) => (attempt && attempt.merchant_reference === ref ? attempt : null),
    recordEvent: async (arg) => { calls.recordEvent.push(arg); return recordEvent; },
    finishEvent: async (id, outcome) => { calls.finishEvent.push([id, outcome]); },
    transition: async (a, status, rawStatus) => { calls.transition.push([status, rawStatus]); return { ...a, status }; },
  };
  const orders = {
    schedule: async (checkoutId) => { calls.schedule.push(checkoutId); },
    finalize: async (checkoutId, opts) => { calls.finalize.push([checkoutId, opts?.source]); return { id: 'order-1' }; },
  };
  const service = new PaymentService({
    payments,
    orders,
    providerRegistry: new PaymentProviderRegistry([new CashfreeProvider()]),
  });
  return { service, calls };
}

try {
  const provider = new CashfreeProvider();

  // ---- 1..4 signature verification ------------------------------------
  {
    const { headers, rawBody } = signedRequest(cfPayload());
    assert.equal(provider.verifyWebhook({ timestamp: headers['x-webhook-timestamp'], signature: headers['x-webhook-signature'], rawBody }), true);
    pass('SIGNATURE_VALID_ACCEPTED');

    assert.equal(provider.verifyWebhook({ timestamp: headers['x-webhook-timestamp'], signature: headers['x-webhook-signature'], rawBody: `${rawBody} ` }), false);
    pass('SIGNATURE_TAMPERED_BODY_REJECTED');

    const wrong = signedRequest(cfPayload(), { secret: 'a-different-secret' });
    assert.equal(provider.verifyWebhook({ timestamp: wrong.headers['x-webhook-timestamp'], signature: wrong.headers['x-webhook-signature'], rawBody: wrong.rawBody }), false);
    pass('SIGNATURE_WRONG_SECRET_REJECTED');

    assert.equal(provider.verifyWebhook({ timestamp: '', signature: '', rawBody: '' }), false);
    assert.equal(provider.verifyWebhook({ timestamp: headers['x-webhook-timestamp'], signature: undefined, rawBody }), false);
    pass('SIGNATURE_MISSING_FIELDS_REJECTED');
  }

  // ---- 5 normalizeWebhook: success -----------------------------------
  {
    const event = provider.normalizeWebhook(cfPayload());
    assert.deepEqual(event, {
      merchantReference: 'COR-WEBHOOK-TEST-0001',
      providerPaymentId: '987654321',
      status: PAYMENT_STATES.SUCCEEDED,
      rawStatus: 'SUCCESS',
      amountMinor: 5097,
      currency: 'INR',
      // The instrument the customer paid with. Null here because this fixture
      // omits it, and a webhook that does not say is never guessed into a
      // bucket — the monitoring surface reports those as "Not recorded".
      paymentGroup: null,
      paymentMethod: null,
      eventType: 'PAYMENT_SUCCESS_WEBHOOK',
    });
    pass('NORMALIZE_WEBHOOK_SUCCESS');
  }

  // ---- 5b normalizeWebhook: the payment instrument -------------------
  // Cashfree sends the family in `payment_group` and the detail in
  // `payment_method`, whose shape differs per family — an object keyed by the
  // method for UPI/cards, a bare string elsewhere. Both shapes are read, and
  // the group is lower-cased so the dashboard can group on it.
  {
    const upi = provider.normalizeWebhook(cfPayload({
      data: {
        order: { order_id: 'COR-WEBHOOK-TEST-0001', order_amount: 50.97, order_currency: 'INR' },
        payment: {
          cf_payment_id: 987654321, payment_status: 'SUCCESS', payment_amount: 50.97, payment_currency: 'INR',
          payment_group: 'UPI', payment_method: { upi: { channel: 'collect', upi_id: 'x@y' } },
        },
      },
    }));
    assert.equal(upi.paymentGroup, 'upi');
    assert.equal(upi.paymentMethod, 'upi');

    const netbanking = provider.normalizeWebhook(cfPayload({
      data: {
        order: { order_id: 'COR-WEBHOOK-TEST-0001', order_amount: 50.97, order_currency: 'INR' },
        payment: {
          cf_payment_id: 987654321, payment_status: 'SUCCESS', payment_amount: 50.97, payment_currency: 'INR',
          payment_group: 'net_banking', payment_method: 'netbanking',
        },
      },
    }));
    assert.equal(netbanking.paymentGroup, 'net_banking');
    assert.equal(netbanking.paymentMethod, 'netbanking');
    pass('NORMALIZE_WEBHOOK_PAYMENT_INSTRUMENT');
  }

  // ---- 6 normalizeWebhook: status vocabulary ------------------------
  {
    const statusFor = (payment_status) => provider.normalizeWebhook(cfPayload({
      data: { order: { order_id: 'o', order_currency: 'INR' }, payment: { cf_payment_id: 1, payment_status, payment_amount: 1, payment_currency: 'INR' } },
    })).status;
    assert.equal(statusFor('FAILED'), PAYMENT_STATES.FAILED);
    assert.equal(statusFor('USER_DROPPED'), PAYMENT_STATES.CANCELLED);
    assert.equal(statusFor('CANCELLED'), PAYMENT_STATES.CANCELLED);
    assert.equal(statusFor('PENDING'), PAYMENT_STATES.PENDING);
    assert.equal(statusFor('SOMETHING_NEW'), PAYMENT_STATES.PENDING, 'unknown provider status is conservative PENDING');
    pass('NORMALIZE_WEBHOOK_STATUS_VOCABULARY');
  }

  // ---- 7 service: bad signature -> 400 -----------------------------
  {
    const { service } = makeFakes();
    await assert.rejects(
      () => service.webhook('CASHFREE', { headers: { 'x-webhook-timestamp': '1', 'x-webhook-signature': 'nope' }, rawBody: JSON.stringify(cfPayload()) }),
      (err) => err.code === 'PAYMENT_WEBHOOK_INVALID' && err.status === 400,
    );
    pass('SERVICE_REJECTS_BAD_SIGNATURE');
  }

  // ---- 8 service: unknown provider -> 404 --------------------------
  {
    const { service } = makeFakes();
    const { headers, rawBody } = signedRequest(cfPayload());
    await assert.rejects(
      () => service.webhook('PAYU', { headers, rawBody }),
      (err) => err.code === 'PAYMENT_PROVIDER_NOT_FOUND' && err.status === 404,
    );
    pass('SERVICE_REJECTS_UNKNOWN_PROVIDER');
  }

  // ---- 9 service: no matching attempt -> recorded IGNORED, accepted -
  {
    const { service, calls } = makeFakes({ attempt: null, recordEvent: { id: 'evt-9', duplicate: false } });
    const { headers, rawBody } = signedRequest(cfPayload());
    const out = await service.webhook('CASHFREE', { headers, rawBody });
    assert.deepEqual(out, { accepted: true });
    assert.deepEqual(calls.finishEvent, [['evt-9', 'IGNORED']]);
    assert.equal(calls.transition.length, 0);
    pass('SERVICE_NO_ATTEMPT_IGNORED');
  }

  // ---- 10 service: amount mismatch -> recorded REJECTED, 409 -------
  {
    const attempt = { id: 'att-10', checkout_id: 'chk-10', merchant_reference: 'COR-WEBHOOK-TEST-0001', amount_minor: 5097, currency: 'INR', status: 'PENDING' };
    const { service, calls } = makeFakes({ attempt, recordEvent: { id: 'evt-10', duplicate: false } });
    const mismatched = cfPayload({
      data: { order: { order_id: 'COR-WEBHOOK-TEST-0001', order_currency: 'INR' }, payment: { cf_payment_id: 1, payment_status: 'SUCCESS', payment_amount: 99.99, payment_currency: 'INR' } },
    });
    const { headers, rawBody } = signedRequest(mismatched);
    await assert.rejects(
      () => service.webhook('CASHFREE', { headers, rawBody }),
      (err) => err.code === 'PAYMENT_PROVIDER_AMOUNT_MISMATCH' && err.status === 409,
    );
    assert.deepEqual(calls.finishEvent, [['evt-10', 'REJECTED']]);
    assert.equal(calls.transition.length, 0);
    pass('SERVICE_AMOUNT_MISMATCH_REJECTED');
  }

  // ---- 11 service: success -> transition + finalize ---------------
  {
    const attempt = { id: 'att-11', checkout_id: 'chk-11', merchant_reference: 'COR-WEBHOOK-TEST-0001', amount_minor: 5097, currency: 'INR', status: 'PENDING' };
    const { service, calls } = makeFakes({ attempt, recordEvent: { id: 'evt-11', duplicate: false } });
    const { headers, rawBody } = signedRequest(cfPayload());
    const out = await service.webhook('CASHFREE', { headers, rawBody });
    assert.deepEqual(out, { accepted: true });
    assert.deepEqual(calls.transition, [['SUCCEEDED', 'SUCCESS']]);
    assert.deepEqual(calls.finishEvent, [['evt-11', 'PROCESSED']]);
    assert.deepEqual(calls.schedule, ['chk-11']);
    assert.deepEqual(calls.finalize, [['chk-11', 'PAYMENT_WEBHOOK']]);
    pass('SERVICE_SUCCESS_TRANSITIONS_AND_FINALIZES');
  }

  // ---- 12 service: failed status -> transition, no finalize -------
  {
    const attempt = { id: 'att-12', checkout_id: 'chk-12', merchant_reference: 'COR-WEBHOOK-TEST-0001', amount_minor: 100, currency: 'INR', status: 'PENDING' };
    const { service, calls } = makeFakes({ attempt, recordEvent: { id: 'evt-12', duplicate: false } });
    const failed = cfPayload({
      type: 'PAYMENT_FAILED_WEBHOOK',
      data: { order: { order_id: 'COR-WEBHOOK-TEST-0001', order_currency: 'INR' }, payment: { cf_payment_id: 1, payment_status: 'FAILED', payment_amount: 1, payment_currency: 'INR' } },
    });
    const { headers, rawBody } = signedRequest(failed);
    const out = await service.webhook('CASHFREE', { headers, rawBody });
    assert.deepEqual(out, { accepted: true });
    assert.deepEqual(calls.transition, [['FAILED', 'FAILED']]);
    assert.deepEqual(calls.finishEvent, [['evt-12', 'PROCESSED']]);
    assert.equal(calls.finalize.length, 0, 'a failed payment does not finalize an order');
    pass('SERVICE_FAILED_STATUS_NO_FINALIZE');
  }

  // ---- 13 service: duplicate event is idempotent ------------------
  {
    // duplicate + attempt already SUCCEEDED -> re-run finalize, never re-transition
    const succeeded = { id: 'att-13', checkout_id: 'chk-13', merchant_reference: 'COR-WEBHOOK-TEST-0001', amount_minor: 5097, currency: 'INR', status: 'SUCCEEDED' };
    const dup = makeFakes({ attempt: succeeded, recordEvent: { id: 'evt-13', duplicate: true } });
    const { headers, rawBody } = signedRequest(cfPayload(), { idempotencyKey: 'cf-evt-abc' });
    const out = await dup.service.webhook('CASHFREE', { headers, rawBody });
    assert.deepEqual(out, { duplicate: true });
    assert.equal(dup.calls.transition.length, 0, 'no re-transition on a duplicate');
    assert.deepEqual(dup.calls.finalize, [['chk-13', 'PAYMENT_WEBHOOK']]);

    // duplicate + attempt not yet SUCCEEDED -> pure no-op
    const pending = { id: 'att-13b', checkout_id: 'chk-13b', merchant_reference: 'COR-WEBHOOK-TEST-0001', amount_minor: 5097, currency: 'INR', status: 'PENDING' };
    const dup2 = makeFakes({ attempt: pending, recordEvent: { id: 'evt-13b', duplicate: true } });
    const out2 = await dup2.service.webhook('CASHFREE', { headers, rawBody });
    assert.deepEqual(out2, { duplicate: true });
    assert.equal(dup2.calls.transition.length, 0);
    assert.equal(dup2.calls.finalize.length, 0);
    pass('SERVICE_DUPLICATE_EVENT_IDEMPOTENT');
  }

  // ---- 14 provider independence --------------------------------
  {
    assert.equal(externalCalls, 0, 'webhook verification path makes no outbound call');
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nPAYMENT_WEBHOOK_CHARACTERIZATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nPAYMENT_WEBHOOK_CHARACTERIZATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
