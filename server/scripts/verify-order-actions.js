// Order-level canCancel / canReturn / canExchange.
//
// The storefront renders these instead of guessing from a status string, so
// the one property that actually matters is AGREEMENT: a flag must never
// offer an action the API then refuses, and never hide one the API allows.
// `order_status` alone cannot decide this — it stays PROCESSING from picking
// through out-for-delivery — so the flags read shipment state and the
// per-line return-eligibility engine instead.
//
//   npm run verify:order-actions --workspace=server
import assert from 'node:assert/strict';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { pool } = await import('../src/database/connection/pool.js');
const { cancelEligibility, returnExchangeEligibility, orderActionFlags } =
  await import('../src/modules/orderOps/orderActions.js');

const results = {};
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results[name] = 'PASS'; console.log(`  PASS  ${name}`); } catch (err) {
    results[name] = `FAIL: ${err.message}`; failures += 1; console.error(`  FAIL  ${name} — ${err.message}`);
  }
};

// The service's own guard, restated here so a change to either side breaks
// this test rather than silently diverging.
const MOVED = ['PICKUP_PENDING', 'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'RTO_IN_TRANSIT', 'RTO_RETURNED', 'LOST'];
const ship = (status) => ({ status, bookingStatus: 'BOOKED' });

console.log('\nOrder action flags\n');

await check('the_flag_matches_the_api_guard_for_every_shipment_state', async () => {
  // If the API refuses a moved shipment, the flag must not offer Cancel.
  for (const status of MOVED) {
    const out = cancelEligibility({ status: 'PROCESSING' }, [ship(status)]);
    assert.equal(out.allowed, false,
      `canCancel offered Cancel on a ${status} shipment, which cancellationService refuses`);
    assert.ok(out.reason && out.reason.length > 20, `${status} gives no customer-facing reason`);
  }
  // And where nothing has moved, it must be offered.
  for (const status of ['DRAFT', 'READY_TO_BOOK', 'BOOKED']) {
    assert.equal(cancelEligibility({ status: 'PROCESSING' }, [ship(status)]).allowed, true,
      `canCancel hid Cancel on a ${status} shipment the API would have allowed`);
  }
});

await check('out_for_delivery_is_refused_though_the_order_is_still_processing', async () => {
  // The exact case a status-only guess gets wrong.
  const out = cancelEligibility({ status: 'PROCESSING' }, [ship('OUT_FOR_DELIVERY')]);
  assert.equal(out.allowed, false);
  assert.equal(out.reasonCode, 'WITH_CARRIER');
  assert.match(out.reason, /out for delivery/i);
});

await check('a_cancelled_or_delivered_order_says_why', async () => {
  assert.equal(cancelEligibility({ status: 'CANCELLED' }, []).reasonCode, 'ALREADY_CANCELLED');
  assert.equal(cancelEligibility({ status: 'COMPLETED' }, []).reasonCode, 'ORDER_COMPLETED');
  assert.match(cancelEligibility({ status: 'COMPLETED' }, []).reason, /return/i);
});

await check('a_dead_shipment_never_blocks_cancellation', async () => {
  // A cancelled/failed parcel is not "in motion".
  for (const status of ['CANCELLED', 'FAILED']) {
    assert.equal(cancelEligibility({ status: 'PROCESSING' }, [ship(status)]).allowed, true,
      `a ${status} shipment wrongly blocked cancellation`);
  }
});

await check('return_and_exchange_come_from_the_eligibility_engine', async () => {
  const eligible = { items: [{ eligible: true, allowedActions: ['RETURN', 'REPLACEMENT'], reasonCode: null }] };
  const r = returnExchangeEligibility({ status: 'COMPLETED' }, eligible);
  assert.equal(r.canReturn.allowed, true);
  assert.equal(r.canExchange.allowed, true);

  // RETURN offered but no exchange action => exchange must be refused, not assumed.
  const returnOnly = { items: [{ eligible: true, allowedActions: ['RETURN'], reasonCode: null }] };
  const r2 = returnExchangeEligibility({ status: 'COMPLETED' }, returnOnly);
  assert.equal(r2.canReturn.allowed, true);
  assert.equal(r2.canExchange.allowed, false, 'exchange was offered with no exchange action available');
});

await check('the_blocking_reason_is_explained_in_customer_language', async () => {
  const cases = [
    ['NOT_DELIVERED', /delivered/i],
    ['WINDOW_EXPIRED', /window/i],
    ['FULLY_CONSUMED', /already/i],
  ];
  for (const [code, pattern] of cases) {
    const out = returnExchangeEligibility(
      { status: 'COMPLETED' },
      { items: [{ eligible: false, allowedActions: [], reasonCode: code }] },
    );
    assert.equal(out.canReturn.allowed, false);
    assert.equal(out.canReturn.reasonCode, code);
    assert.match(out.canReturn.reason, pattern, `${code} has no useful explanation`);
    assert.ok(!/[A-Z_]{6,}/.test(out.canReturn.reason), `${code} leaks a raw enum to the customer`);
  }
});

await check('a_cancelled_order_offers_nothing', async () => {
  const out = orderActionFlags({
    order: { status: 'CANCELLED' }, shipments: [],
    returnEligibility: { items: [{ eligible: true, allowedActions: ['RETURN'], reasonCode: null }] },
  });
  assert.equal(out.canCancel.allowed, false);
  assert.equal(out.canReturn.allowed, false, 'a cancelled order offered a return');
  assert.equal(out.canExchange.allowed, false);
});

await check('missing_eligibility_data_fails_closed', async () => {
  // evaluateOrder() can legitimately fail; the flags must not then invent a yes.
  const out = orderActionFlags({ order: { status: 'COMPLETED' }, shipments: [], returnEligibility: null });
  assert.equal(out.canReturn.allowed, false);
  assert.equal(out.canExchange.allowed, false);
  assert.ok(out.canReturn.reason, 'no reason given when eligibility is unavailable');
});

await check('every_flag_has_the_same_shape', async () => {
  const out = orderActionFlags({ order: { status: 'PROCESSING' }, shipments: [], returnEligibility: null });
  for (const key of ['canCancel', 'canReturn', 'canExchange']) {
    assert.ok(key in out, `${key} missing`);
    assert.equal(typeof out[key].allowed, 'boolean', `${key}.allowed is not a boolean`);
    assert.ok('reasonCode' in out[key] && 'reason' in out[key], `${key} has no reason fields`);
    if (!out[key].allowed) assert.ok(out[key].reason, `${key} is denied with no reason`);
  }
});

console.log(`\n${failures ? 'FAILURES' : 'ALL PASS'} — ${Object.keys(results).length} checks, ${failures} failed\n`);
await pool.end();
process.exit(failures ? 1 : 0);
