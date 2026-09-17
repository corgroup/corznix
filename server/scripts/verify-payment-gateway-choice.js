// Customer-chosen payment gateway — which gateways are offered, choosing one,
// and switching after a session was already opened on another.
//
// The Payment Method step lets the customer pick Cashfree or Razorpay. Only a
// gateway that can take a payment right now may be offered, and switching must
// never leave the old session payable: that is how one order gets paid twice.
//
// Pure: providers, repository and order finalization are fakes. No DB writes,
// no network.
//
//   npm run verify:payment-gateway-choice
import assert from 'node:assert/strict';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool } = await import('../src/database/connection/pool.js');
const { PaymentOrchestrator } = await import('../src/modules/payments/orchestrator.js');
const { PaymentProviderRegistry } = await import('../src/modules/payments/registry.js');
const { PaymentService } = await import('../src/modules/payments/service.js');
const { PaymentProvider } = await import('../src/modules/payments/providerContract.js');

const results = {};
const pass = (name) => { results[name] = 'PASS'; console.log(`  PASS  ${name}`); };

class FakeGateway extends PaymentProvider {
  constructor(code, { configured = true, implemented = true, remote = 'PENDING', amountMinor = 249900, canCancel = true, statusFails = false, cancelFails = false } = {}) {
    super({ code, configured, implemented });
    Object.assign(this, { remote, amountMinor, statusFails, cancelFails, calls: [] });
    if (!canCancel) this.cancelSession = undefined;
  }
  async createPaymentSession(request) { this.calls.push(['create', request.merchantReference]); return { providerPaymentId: `${this.code}-1`, providerSessionReference: `${this.code}-session`, status: 'PENDING', rawStatus: 'created', expiresAt: null }; }
  async getPaymentStatus({ merchantReference }) { this.calls.push(['status', merchantReference]); if (this.statusFails) throw new Error('unreachable'); return { status: this.remote, rawStatus: this.remote.toLowerCase(), amountMinor: this.amountMinor, currency: 'INR' }; }
  async cancelSession({ merchantReference }) { this.calls.push(['cancel', merchantReference]); if (this.cancelFails) throw new Error('unreachable'); return { cancelled: true }; }
}

const orchestratorWith = (gateways, enabledCodes) => new PaymentOrchestrator({
  repository: { enabledProviders: async () => enabledCodes.map((provider_code) => ({ provider_code })) },
  registry: new PaymentProviderRegistry(gateways),
});

function serviceWith(gateway) {
  const transitions = [];
  const payments = { transition: async (attempt, status, rawStatus) => { transitions.push([status, rawStatus]); return { ...attempt, status }; } };
  const registry = new PaymentProviderRegistry([gateway]);
  const service = new PaymentService({ payments, providerRegistry: registry, paymentOrchestrator: orchestratorWith([gateway], [gateway.code]) });
  return { service, transitions };
}
const openAttempt = (over = {}) => ({ id: 'att-1', provider_code: 'CASHFREE', merchant_reference: 'pay_ref_1', amount_minor: 249900, currency: 'INR', status: 'PENDING', provider_session_reference: 'CASHFREE-session', ...over });

try {
  // ---- 1. only gateways that can take a payment are offered ----
  {
    const orchestrator = orchestratorWith(
      [new FakeGateway('CASHFREE'), new FakeGateway('RAZORPAY'), new FakeGateway('NO_KEYS', { configured: false }), new FakeGateway('UNBUILT', { implemented: false })],
      ['CASHFREE', 'NO_KEYS', 'RAZORPAY', 'UNBUILT', 'UNKNOWN'],
    );
    assert.deepEqual((await orchestrator.availableProviders()).map((p) => p.code), ['CASHFREE', 'RAZORPAY'], 'unconfigured, unbuilt and unknown gateways are never offered; CMS order kept');
    const service = new PaymentService({ paymentOrchestrator: orchestrator, providerRegistry: new PaymentProviderRegistry([]) });
    assert.deepEqual(await service.availableGateways(), [{ code: 'CASHFREE', label: 'Cashfree' }, { code: 'RAZORPAY', label: 'Razorpay' }]);
    pass('OFFERS_ONLY_AVAILABLE_GATEWAYS');
  }

  // ---- 2. choosing a gateway ----
  {
    const cashfree = new FakeGateway('CASHFREE');
    const razorpay = new FakeGateway('RAZORPAY');
    const orchestrator = orchestratorWith([cashfree, razorpay, new FakeGateway('NO_KEYS', { configured: false })], ['CASHFREE', 'RAZORPAY', 'NO_KEYS']);
    assert.equal((await orchestrator.selectProvider()).code, 'CASHFREE', 'no choice: first in CMS order');
    assert.equal((await orchestrator.selectProvider('RAZORPAY')).code, 'RAZORPAY', 'the customer’s choice is honoured');
    await assert.rejects(() => orchestrator.selectProvider('NO_KEYS'), (err) => err.code === 'PAYMENT_PROVIDER_UNAVAILABLE' && err.status === 409);
    await assert.rejects(() => orchestratorWith([], []).selectProvider(), (err) => err.code === 'PAYMENT_PROVIDER_UNAVAILABLE' && err.status === 503);

    await orchestrator.create({ provider_code: 'RAZORPAY' }, { merchantReference: 'pay_ref_2' });
    assert.deepEqual([cashfree.calls, razorpay.calls], [[], [['create', 'pay_ref_2']]], 'the session opens on the attempt’s own gateway, not the first one');
    pass('CUSTOMER_CHOICE_HONOURED');
  }

  // ---- 3. switching gateway closes the old session first ----
  {
    const noSession = serviceWith(new FakeGateway('CASHFREE'));
    assert.deepEqual(await noSession.service.releaseAttemptForSwitch(openAttempt({ provider_session_reference: null })), { succeeded: false });
    assert.deepEqual(noSession.transitions, [['CANCELLED', 'SWITCHED_PAYMENT_METHOD']], 'an attempt that never reached the gateway is simply cancelled');

    const open = new FakeGateway('CASHFREE');
    const switched = serviceWith(open);
    assert.deepEqual(await switched.service.releaseAttemptForSwitch(openAttempt()), { succeeded: false });
    assert.deepEqual(open.calls, [['status', 'pay_ref_1'], ['cancel', 'pay_ref_1']], 'checked, then closed at the gateway');
    assert.deepEqual(switched.transitions, [['CANCELLED', 'SWITCHED_PAYMENT_METHOD']]);
    pass('SWITCH_CLOSES_OLD_SESSION');

    const paid = new FakeGateway('CASHFREE', { remote: 'SUCCEEDED' });
    const alreadyPaid = serviceWith(paid);
    const out = await alreadyPaid.service.releaseAttemptForSwitch(openAttempt());
    assert.equal(out.succeeded, true, 'a payment that went through is kept');
    assert.deepEqual(alreadyPaid.transitions, [['SUCCEEDED', 'succeeded']]);
    assert.ok(!paid.calls.some(([op]) => op === 'cancel'), 'a paid session is never cancelled');
    pass('SWITCH_KEEPS_A_COMPLETED_PAYMENT');
  }

  // ---- 4. a switch that cannot be made safely is refused ----
  {
    const refused = async (gateway, message) => {
      const { service, transitions } = serviceWith(gateway);
      await assert.rejects(() => service.releaseAttemptForSwitch(openAttempt()), (err) => err.status === 409, message);
      assert.equal(transitions.length, 0, `${message}: the old attempt is left untouched`);
    };
    await refused(new FakeGateway('CASHFREE', { statusFails: true }), 'gateway unreachable for status');
    await refused(new FakeGateway('CASHFREE', { cancelFails: true }), 'gateway cannot close the session');
    await refused(new FakeGateway('CASHFREE', { canCancel: false }), 'gateway has no way to close a session');
    await refused(new FakeGateway('CASHFREE', { remote: 'SUCCEEDED', amountMinor: 100 }), 'paid amount does not match');
    pass('UNSAFE_SWITCH_REFUSED');
  }

  // ---- 5. changing the plan closes an online session that no longer fits ----
  // createSession itself, with fake collaborators: a session opened for one
  // plan must never stay payable after the customer picks another.
  {
    const planService = ({ mode, existing = null, gateways, total = 249900, payNow = 50000 }) => {
      const seen = { transitions: [], created: [], finalized: [] };
      let current = existing;
      const payments = {
        openAttemptForCheckout: async () => current,
        upsertObligation: async ({ type, amountMinor }) => ({ id: `obl-${type}`, checkout_id: 'chk-1', amount_minor: amountMinor }),
        extendReservationForPayment: async () => true,
        reusableAttempt: async () => (current && ['CREATED', 'PENDING', 'AUTHORIZED', 'SUCCEEDED'].includes(current.status) ? current : null),
        transition: async (attempt, status, rawStatus) => { seen.transitions.push([attempt.provider_code, status, rawStatus]); current = { ...attempt, status }; return current; },
        createAttempt: async ({ obligation, providerCode }) => {
          seen.created.push([providerCode, obligation.amount_minor]);
          current = { id: 'att-new', provider_code: providerCode, merchant_reference: 'pay_ref_new', amount_minor: obligation.amount_minor, currency: 'INR', status: 'CREATED', idempotency_key: 'k' };
          return current;
        },
        attachSession: async (_id, result) => { current = { ...current, provider_session_reference: result.providerSessionReference, status: 'PENDING' }; return current; },
      };
      const eligibility = { selected_payment_mode: mode, eligible_amount_minor: total, cod_available: 1, prepaid_available: 1, partial_cod_available: 1, pay_now_minor: payNow, pay_on_delivery_minor: total - payNow };
      const service = new PaymentService({
        payments,
        eligibilityRepo: { findForCheckout: async () => eligibility, selectMode: async () => true },
        eligibilityService: { evaluate: async () => ({}) },
        checkouts: { findOwned: async () => ({ shipping_quote_snapshot: null, shipping_address_snapshot: JSON.stringify({ phone: '9999999999' }) }) },
        contactRepo: { findForCustomer: async () => [] },
        orders: { schedule: async () => {}, finalize: async (_checkoutId, opts) => { seen.finalized.push(opts?.source); return { id: 'order-1' }; } },
        providerRegistry: new PaymentProviderRegistry(gateways),
        paymentOrchestrator: orchestratorWith(gateways, gateways.map((g) => g.code)),
      });
      return { service, seen };
    };

    // COD after an unpaid Cashfree session: the session is closed first.
    const cashfreeA = new FakeGateway('CASHFREE');
    const toCod = planService({ mode: 'FULL_COD', existing: openAttempt(), gateways: [cashfreeA] });
    assert.equal((await toCod.service.createSession('cust-1', 'chk-1')).status, 'ONLINE_PAYMENT_NOT_REQUIRED');
    assert.deepEqual(cashfreeA.calls, [['status', 'pay_ref_1'], ['cancel', 'pay_ref_1']], 'the open online session is closed before COD');
    assert.deepEqual(toCod.seen.transitions, [['CASHFREE', 'CANCELLED', 'SWITCHED_PAYMENT_METHOD']]);

    // COD, but the earlier session was actually paid: the paid order stands.
    const cashfreePaid = new FakeGateway('CASHFREE', { remote: 'SUCCEEDED' });
    const paidThenCod = planService({ mode: 'FULL_COD', existing: openAttempt(), gateways: [cashfreePaid] });
    const paidOut = await paidThenCod.service.createSession('cust-1', 'chk-1');
    assert.equal(paidOut.status, 'SUCCEEDED', 'money already taken is never turned into a COD order');
    assert.deepEqual(paidThenCod.seen.finalized, ['PAYMENT_RECONCILIATION']);
    assert.ok(!cashfreePaid.calls.some(([op]) => op === 'cancel'));
    pass('PLAN_CHANGE_TO_COD_CLOSES_OR_KEEPS_PAYMENT');

    // Partial COD advance after a full-amount session: new session for the advance.
    const cashfreeB = new FakeGateway('CASHFREE');
    const toPartial = planService({ mode: 'PARTIAL_COD', existing: openAttempt(), gateways: [cashfreeB] });
    const partialOut = await toPartial.service.createSession('cust-1', 'chk-1');
    assert.deepEqual(toPartial.seen.transitions, [['CASHFREE', 'CANCELLED', 'SWITCHED_PAYMENT_METHOD']], 'the full-amount session is closed');
    assert.deepEqual(toPartial.seen.created, [['CASHFREE', 50000]], 'a new session is opened for the advance only');
    assert.equal(partialOut.attempt.status, 'PENDING');

    // Same gateway, same amount: the open session is simply reused.
    const cashfreeC = new FakeGateway('CASHFREE');
    const same = planService({ mode: 'PREPAID', existing: openAttempt(), gateways: [cashfreeC] });
    await same.service.createSession('cust-1', 'chk-1', { providerCode: 'CASHFREE' });
    assert.deepEqual([cashfreeC.calls, same.seen.transitions, same.seen.created], [[], [], []], 'nothing is closed or re-created');
    pass('PLAN_CHANGE_AMOUNT_REOPENS_SAME_PLAN_REUSES');

    // Prepaid, customer picks Razorpay over an open Cashfree session.
    const cashfreeD = new FakeGateway('CASHFREE');
    const razorpayD = new FakeGateway('RAZORPAY');
    const switched = planService({ mode: 'PREPAID', existing: openAttempt(), gateways: [cashfreeD, razorpayD] });
    const switchedOut = await switched.service.createSession('cust-1', 'chk-1', { providerCode: 'RAZORPAY' });
    assert.deepEqual(cashfreeD.calls, [['status', 'pay_ref_1'], ['cancel', 'pay_ref_1']]);
    assert.deepEqual(switched.seen.created, [['RAZORPAY', 249900]]);
    assert.deepEqual([switchedOut.attempt.providerCode, razorpayD.calls], ['RAZORPAY', [['create', 'pay_ref_new']]]);
    pass('SESSION_SWITCHES_GATEWAY_END_TO_END');
  }

  console.log('\nPAYMENT_GATEWAY_CHOICE_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nPAYMENT_GATEWAY_CHOICE_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
