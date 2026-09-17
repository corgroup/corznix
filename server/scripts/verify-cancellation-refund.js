// Refunding a cancelled order to the method the customer paid with.
//
// Exists because production cancelled a paid order and the money stayed put:
// the cascade computed "Refund of ₹1 required", raised a staff task, and there
// the trail ended — refund execution only existed inside the returns flow, and
// Cashfree had no refund implementation at all.
//
// Drives the REAL CancellationRefundService against the REAL database with a
// stub provider (no external call — NO_EXTERNAL_PROVIDER_CALLS asserts it), so
// every state a gateway can answer with is exercised: success, pending,
// declined, and an ambiguous timeout. The fixture order is restored at the end.
//
//   npm run verify:cancellation-refund
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

let externalCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) externalCalls += 1;
  return realFetch(input, init);
};

const { pool, query } = await import('../src/database/connection/pool.js');
const { CancellationRefundService, CANCELLATION_REFUND_ORIGIN } = await import('../src/modules/orderOps/cancellationRefundService.js');
const { PaymentProviderRegistry } = await import('../src/modules/payments/registry.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

// A paid, cancelled order to refund. Taken from the seeded graph and put back
// exactly as found — including the order status, which this flips to CANCELLED.
// VERIFY_FORCE_FIXTURE=1 ignores any paid order that already exists, so the
// fixture path — the only one CI ever takes — can be exercised on a developer's
// database too. Without it that path was never run until CI ran it.
let order = process.env.VERIFY_FORCE_FIXTURE === '1' ? null : await one(
  `SELECT o.* FROM orders o
    WHERE o.online_paid_minor > 0
      AND EXISTS (SELECT 1 FROM payment_obligations po
                   JOIN payment_attempts pa ON pa.obligation_id = po.id AND pa.status = 'SUCCEEDED'
                  WHERE po.order_id = o.id AND po.obligation_type = 'ONLINE')
    ORDER BY o.created_at DESC LIMIT 1`);

// A freshly seeded database — CI's, every run — has orders but no captured
// online payment, and a refund gate cannot run without one. Rather than skip
// (the tier that hides failures), it builds the missing half itself from a
// seeded order and removes it again in restore().
const fixture = { obligationId: null, attemptId: null, orderId: null, paidBefore: null };
if (!order) {
  const base = await one(
    `SELECT o.* FROM orders o
      WHERE o.checkout_id IS NOT NULL AND o.order_status IN ('PLACED','CONFIRMED','PROCESSING')
      ORDER BY o.created_at DESC LIMIT 1`);
  assert(base, 'need one seeded order with a checkout — run npm run seed:orders');
  const amount = Math.max(100, Number(base.total_minor) || 100);
  fixture.orderId = base.id;
  fixture.paidBefore = Number(base.online_paid_minor || 0);
  fixture.obligationId = randomUUID();
  fixture.attemptId = randomUUID();
  const [provider] = await query("SELECT provider_code FROM payment_providers ORDER BY priority LIMIT 1");
  await query(
    // order_id matters: the refund finds the captured payment through the
    // obligation's ORDER, not its checkout. Without it the fixture inserts
    // cleanly and the lookup still finds nothing — which is how this passed
    // locally (where a real paid order existed) and failed in CI.
    `INSERT INTO payment_obligations (id, checkout_id, order_id, obligation_type, amount_minor, currency, status, source_payment_mode)
     VALUES (?,?,?,'ONLINE',?,?,'PAID','PREPAID')`,
    [fixture.obligationId, base.checkout_id, base.id, amount, base.currency || 'INR']);
  await query(
    `INSERT INTO payment_attempts (id, obligation_id, checkout_id, provider_code, merchant_reference, provider_payment_id,
       amount_minor, currency, status, idempotency_key)
     VALUES (?,?,?,?,?,?,?,?,'SUCCEEDED',?)`,
    [fixture.attemptId, fixture.obligationId, base.checkout_id, provider.provider_code,
      // idempotency_key is CHAR(36): a prefixed uuid does not fit, and MySQL
      // refuses the row outright rather than truncating it.
      `VERIFY-RFND-${Date.now()}`, `verify-pay-${Date.now()}`, amount, base.currency || 'INR', randomUUID()]);
  await query('UPDATE orders SET online_paid_minor = ? WHERE id = ?', [amount, base.id]);
  order = await one('SELECT * FROM orders WHERE id = ?', [base.id]);
}
assert(order, 'need one order with a SUCCEEDED online payment');

const before = { status: order.order_status, cancelledAt: order.cancelled_at, reason: order.cancellation_reason };
const notifications = [];
const staffTasks = [];
const stubNotifications = { emit: async (key, ctx) => { notifications.push({ key, amount: ctx.amount, orderNumber: ctx.orderNumber }); } };
const stubStaff = { record: async (task) => { staffTasks.push(task); } };

// One stub provider, answering whatever the current scenario needs.
let answer = { kind: 'SUCCESS' };
const provider = {
  code: 'STUB',
  calls: 0,
  supportsRefund: () => true,
  refund: async (req) => {
    provider.calls += 1;
    provider.lastRequest = req;
    if (answer.kind === 'SUCCESS') return { providerRefundId: `stub-rfnd-${req.paymentRefundId}`, status: 'SUCCEEDED', rawStatus: 'REFUNDED' };
    if (answer.kind === 'PENDING') return { providerRefundId: `stub-rfnd-${req.paymentRefundId}`, status: 'PENDING', rawStatus: 'ONHOLD' };
    if (answer.kind === 'AMBIGUOUS') throw Object.assign(new Error('STUB_TIMEOUT'), { ambiguous: true });
    throw new Error('STUB_DECLINED');
  },
};
const service = (p = provider) => new CancellationRefundService({
  // The stub is registered under the order's OWN provider code: provider_code
  // on payment_attempts is a foreign key, so the fixture cannot be renamed.
  registry: new PaymentProviderRegistry([{ ...p, code: originalProviderCode }]),
  notifications: stubNotifications,
  staffNotifications: stubStaff,
});

// The order's real provider code is whatever it was paid with; the stub stands
// in for it so no gateway is ever called from a gate.
const sourceAttempt = await one(
  `SELECT pa.* FROM payment_attempts pa JOIN payment_obligations po ON po.id = pa.obligation_id
    WHERE po.order_id = ? AND po.obligation_type = 'ONLINE' AND pa.status = 'SUCCEEDED' ORDER BY pa.created_at DESC LIMIT 1`, [order.id]);
const originalProviderCode = sourceAttempt.provider_code;

// The ledger is append-only in production; this gate created its own entries
// and puts the account back exactly where it found it.
const [accountAtStart] = await query('SELECT id, balance_minor FROM store_credit_accounts WHERE customer_id = ?', [order.customer_id]);
const balanceAtStart = Number(accountAtStart?.balance_minor || 0);

async function restore() {
  await query("DELETE FROM store_credit_entries WHERE source_type IN ('ORDER_CANCELLATION','ORDER_CANCELLATION_CREDIT_REVERSAL') AND source_id = ?", [order.id]);
  // Rebuild the balance from what is actually left in the ledger rather than
  // writing back a remembered number: this gate can CREATE the account (the
  // customer had none), and then "restore" wrote the granted balance onto an
  // account with no entries — drift that verify:reporting is right to fail on.
  const [account] = await query('SELECT id FROM store_credit_accounts WHERE customer_id = ?', [order.customer_id]);
  if (account) {
    const [{ ledger }] = await query('SELECT COALESCE(SUM(amount_minor),0) ledger FROM store_credit_entries WHERE account_id = ?', [account.id]);
    if (!accountAtStart && Number(ledger) === 0) await query('DELETE FROM store_credit_accounts WHERE id = ?', [account.id]);
    else await query('UPDATE store_credit_accounts SET balance_minor = ? WHERE id = ?', [accountAtStart ? balanceAtStart : Number(ledger), account.id]);
  }
  await query('DELETE FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
  await query('UPDATE orders SET order_status = ?, cancelled_at = ?, cancellation_reason = ? WHERE id = ?',
    [before.status, before.cancelledAt, before.reason, order.id]);
  if (fixture.attemptId) {
    await query('DELETE FROM payment_attempts WHERE id = ?', [fixture.attemptId]);
    await query('DELETE FROM payment_obligations WHERE id = ?', [fixture.obligationId]);
    await query('UPDATE orders SET online_paid_minor = ? WHERE id = ?', [fixture.paidBefore, fixture.orderId]);
  }
}
const reset = async () => {
  await query('DELETE FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
  notifications.length = 0; staffTasks.length = 0; provider.calls = 0;
};

try {
  await query("UPDATE orders SET order_status = 'CANCELLED', cancelled_at = NOW(3) WHERE id = ?", [order.id]);
  const expected = Math.max(0, Number(order.online_paid_minor) - Math.min(Number(order.non_refundable_advance_minor || 0), Number(order.online_paid_minor)));

  // 1 — a cancelled order is refunded to the original payment, for the exact amount
  {
    answer = { kind: 'SUCCESS' };
    const out = await service().refundCancelledOrder(order.id);
    assert.equal(out.status, 'SUCCEEDED');
    assert.equal(out.amountMinor, expected, 'refunds exactly what was paid, less any disclosed non-refundable advance');
    const row = await one('SELECT * FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
    assert.equal(row.method, 'ORIGINAL_PAYMENT', 'never store credit for a staff cancellation');
    assert.equal(Number(row.amount_minor), expected);
    assert.equal(row.source_payment_attempt_id, sourceAttempt.id, 'reverses the payment the customer actually made');
    assert.ok(row.provider_refund_id, 'the provider reference is stored');
    assert.ok(row.completed_at, 'completed_at stamped');
    assert.equal(row.idempotency_key, `order_cancel_refund:${order.id}`);
    assert.equal(provider.lastRequest.amountMinor, expected, 'the amount sent to the provider matches');
    pass('REFUNDED_TO_ORIGINAL_PAYMENT', `${expected} minor, ref ${row.provider_refund_id}`);

    // 2 — the customer is told, and told only about a refund that happened
    assert.deepEqual(notifications.map((n) => n.key), ['REFUND_INITIATED', 'REFUND_COMPLETED']);
    assert.equal(notifications[1].orderNumber, order.order_number);
    pass('CUSTOMER_NOTIFIED', notifications.map((n) => n.key).join(' -> '));

    // 3 — retrying cannot pay twice
    const again = await service().refundCancelledOrder(order.id, { retry: true });
    assert.equal(again.status, 'REPLAY');
    assert.equal(provider.calls, 1, 'the provider is not called a second time');
    const rows = await query('SELECT id FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
    assert.equal(rows.length, 1, 'still exactly one refund');
    pass('RETRY_IS_NOT_A_SECOND_REFUND');
  }

  // 4 — a provider that says "pending" has not paid yet
  {
    await reset();
    answer = { kind: 'PENDING' };
    const out = await service().refundCancelledOrder(order.id);
    assert.equal(out.status, 'PROCESSING', 'pending is not success');
    const row = await one('SELECT * FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
    assert.equal(row.completed_at, null, 'nothing is marked completed until it is');
    assert.deepEqual(notifications.map((n) => n.key), ['REFUND_INITIATED'], 'no "refund completed" message for a pending refund');
    assert.ok(staffTasks.some((t) => t.severity === 'CRITICAL'), 'staff are told it is unsettled');
    pass('PENDING_IS_HELD_OPEN');
  }

  // 5 — a decline is recorded with its reason, and can be retried
  {
    await reset();
    answer = { kind: 'DECLINE' };
    const out = await service().refundCancelledOrder(order.id);
    assert.equal(out.status, 'FAILED');
    const row = await one('SELECT * FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
    assert.equal(row.failure_code, 'STUB_DECLINED');
    assert.ok(staffTasks.some((t) => t.eventKey === 'ORDER_REFUND_NEEDS_ATTENTION'));

    answer = { kind: 'SUCCESS' };
    const retried = await service().refundCancelledOrder(order.id, { retry: true });
    assert.equal(retried.status, 'SUCCEEDED', 'a failed refund can be sent again');
    const after = await query('SELECT id FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
    assert.equal(after.length, 1, 'the retry reuses the same refund row');
    pass('FAILURE_RECORDED_AND_RETRYABLE');
  }

  // 6 — an ambiguous timeout is never called success, and never auto-retried
  {
    await reset();
    answer = { kind: 'AMBIGUOUS' };
    const out = await service().refundCancelledOrder(order.id);
    assert.equal(out.status, 'UNKNOWN');
    const row = await one('SELECT * FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
    assert.equal(row.failure_code, 'STUB_TIMEOUT');
    assert.equal(row.completed_at, null);
    pass('AMBIGUOUS_STAYS_UNKNOWN');
  }

  // 7 — a provider with no refund support blocks instead of pretending
  {
    await reset();
    const out = await service({ supportsRefund: () => false, refund: async () => { throw new Error('should not be called'); } })
      .refundCancelledOrder(order.id);
    assert.equal(out.status, 'BLOCKED');
    const row = await one('SELECT * FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
    assert.equal(row.failure_code, 'REFUND_PROVIDER_NOT_ENABLED');
    pass('UNSUPPORTED_PROVIDER_IS_BLOCKED_NOT_SILENT');
  }

  // 8 — an order that is not cancelled is refused
  {
    await reset();
    await query('UPDATE orders SET order_status = ? WHERE id = ?', ['PROCESSING', order.id]);
    await assert.rejects(() => service().refundCancelledOrder(order.id), (e) => e.code === 'ORDER_NOT_CANCELLED');
    await query("UPDATE orders SET order_status = 'CANCELLED' WHERE id = ?", [order.id]);
    pass('ONLY_A_CANCELLED_ORDER_IS_REFUNDED');
  }

  // 9 — the customer's own choice: store credit instead of the gateway
  {
    await reset();
    const [accountBefore] = await query('SELECT balance_minor FROM store_credit_accounts WHERE customer_id = ?', [order.customer_id]);
    const balanceBefore = Number(accountBefore?.balance_minor || 0);

    const out = await service().creditCancelledOrderToStoreCredit(order.id);
    assert.equal(out.status, 'SUCCEEDED');
    assert.equal(out.amountMinor, expected);

    const row = await one('SELECT * FROM refund_attempts WHERE order_id = ? AND origin = ?', [order.id, CANCELLATION_REFUND_ORIGIN]);
    assert.equal(row.method, 'STORE_CREDIT');
    assert.equal(row.provider_code, null, 'no gateway is involved');
    assert.equal(row.status, 'SUCCEEDED');
    assert.ok(row.completed_at, 'store credit is instant, so it is complete');

    const entries = await query(
      "SELECT * FROM store_credit_entries WHERE source_type = 'ORDER_CANCELLATION' AND source_id = ?", [order.id]);
    assert.equal(entries.length, 1, 'one ledger entry');
    assert.equal(entries[0].entry_type, 'GRANT');
    assert.equal(Number(entries[0].amount_minor), expected, 'credited exactly the refundable amount');
    assert.equal(entries[0].id, row.provider_refund_id, 'the refund points at the ledger entry that carries the money');
    const [accountAfter] = await query('SELECT balance_minor FROM store_credit_accounts WHERE customer_id = ?', [order.customer_id]);
    assert.equal(Number(accountAfter.balance_minor), balanceBefore + expected, 'the balance moved by exactly that amount');
    assert.deepEqual(notifications.map((n) => n.key), ['REFUND_COMPLETED']);
    pass('STORE_CREDIT_REFUND', `${expected} minor, balance ${balanceBefore} -> ${Number(accountAfter.balance_minor)}`);

    // 10 — a double-tapped Cancel cannot credit twice
    const replay = await service().creditCancelledOrderToStoreCredit(order.id);
    assert.equal(replay.status, 'REPLAY');
    const entriesAfter = await query(
      "SELECT id FROM store_credit_entries WHERE source_type = 'ORDER_CANCELLATION' AND source_id = ?", [order.id]);
    assert.equal(entriesAfter.length, 1, 'still one ledger entry');
    const [accountReplay] = await query('SELECT balance_minor FROM store_credit_accounts WHERE customer_id = ?', [order.customer_id]);
    assert.equal(Number(accountReplay.balance_minor), balanceBefore + expected, 'the balance did not move again');
    pass('STORE_CREDIT_IS_NOT_CREDITED_TWICE');
  }

  assert.equal(externalCalls, 0, 'no external provider was contacted');
  pass('NO_EXTERNAL_PROVIDER_CALLS');

  console.log('\nCancellation refund — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nCANCELLATION_REFUND_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  await restore();
  await pool.end();
}
