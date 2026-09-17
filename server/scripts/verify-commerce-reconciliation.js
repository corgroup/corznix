import assert from 'node:assert/strict';
import { pool, query } from '../src/database/connection/pool.js';
import { CashfreeProvider } from '../src/modules/payments/providers/cashfreeProvider.js';

const evidence = {
  prepaid: 'COR-20260828-FB74739F0984',
  partial: 'COR-20260828-0050D9E4F941',
  fullCod: 'COR-20260828-9393AD82EBEC',
};

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => new Response(JSON.stringify(String(url).endsWith('/payments') ? [{
  cf_payment_id: 'failed-payment', payment_status: 'FAILED', payment_amount: 5097,
  payment_currency: 'INR', payment_time: '2026-08-28T12:00:00+05:30',
  error_details: { error_code: 'TEST_FAILURE' },
}] : { cf_order_id: 'order', order_status: 'ACTIVE', order_amount: 5097, order_currency: 'INR' }), { status: 200 });
const failedNormalization = await new CashfreeProvider().getPaymentStatus({ merchantReference: 'test-order' });
globalThis.fetch = originalFetch;
assert.equal(failedNormalization.status, 'FAILED');
assert.equal(failedNormalization.amountMinor, 509700);
assert.equal(failedNormalization.failureMessage, 'Payment was not completed.');

async function verifyOrder(orderNumber, mode, onlinePaid, codDue) {
  const order = (await query('SELECT * FROM orders WHERE order_number=?', [orderNumber]))[0];
  assert(order, `${orderNumber} is missing`);
  assert.equal(order.payment_mode, mode);
  assert.equal(Number(order.online_paid_minor), onlinePaid);
  assert.equal(Number(order.cod_due_minor), codDue);
  assert.equal(Number(order.total_minor), onlinePaid + codDue);
  assert.equal(Number((await query('SELECT COUNT(*) n FROM orders WHERE checkout_id=?', [order.checkout_id]))[0].n), 1);
  const reservation = (await query('SELECT status FROM inventory_reservations WHERE id=?', [order.inventory_reservation_id]))[0];
  assert.equal(reservation?.status, 'CONSUMED');
  const itemCount = Number((await query('SELECT COUNT(*) n FROM inventory_reservation_items WHERE reservation_id=?', [order.inventory_reservation_id]))[0].n);
  const consumeCount = Number((await query("SELECT COUNT(*) n FROM inventory_movements WHERE reference_id=? AND movement_type='INVENTORY_CONSUMED'", [order.inventory_reservation_id]))[0].n);
  assert.equal(consumeCount, itemCount);
  const obligations = await query('SELECT * FROM payment_obligations WHERE checkout_id=?', [order.checkout_id]);
  assert(obligations.every((value) => value.order_id === order.id));
  if (onlinePaid) {
    const successes = Number((await query("SELECT COUNT(*) n FROM payment_attempts WHERE checkout_id=? AND status='SUCCEEDED'", [order.checkout_id]))[0].n);
    assert.equal(successes, 1);
  } else {
    assert.equal(Number((await query('SELECT COUNT(*) n FROM payment_attempts WHERE checkout_id=?', [order.checkout_id]))[0].n), 0);
  }
  return { checkoutId: order.checkout_id, orderId: order.id, reservationId: order.inventory_reservation_id };
}

const prepaid = await verifyOrder(evidence.prepaid, 'PREPAID', 509700, 0);
const partial = await verifyOrder(evidence.partial, 'PARTIAL_COD', 50000, 459700);
const fullCod = await verifyOrder(evidence.fullCod, 'FULL_COD', 0, 509700);

const failed = (await query(`SELECT cs.id checkout_id,ir.status reservation_status,
  SUM(pa.status='FAILED') failed_attempts,SUM(pa.status='SUCCEEDED') successful_attempts,
  SUM(pa.status IN ('CREATED','PENDING','AUTHORIZED')) active_attempts,
  (SELECT COUNT(*) FROM orders o WHERE o.checkout_id=cs.id) order_count
  FROM checkout_sessions cs JOIN inventory_reservations ir ON ir.id=cs.inventory_reservation_id
  JOIN payment_attempts pa ON pa.checkout_id=cs.id GROUP BY cs.id,ir.status
  HAVING failed_attempts>0 ORDER BY MAX(pa.created_at) DESC LIMIT 1`))[0];
assert(failed, 'Failed-payment evidence is missing');
assert.equal(Number(failed.successful_attempts), 0);
assert.equal(Number(failed.order_count), 0);
assert.notEqual(failed.reservation_status, 'CONSUMED');
assert.equal(Number(failed.active_attempts), 1);

const audits = {
  duplicateOrders: Number((await query('SELECT COUNT(*) n FROM (SELECT checkout_id FROM orders WHERE checkout_id IS NOT NULL GROUP BY checkout_id HAVING COUNT(*)>1) x'))[0].n),
  duplicateActiveAttempts: Number((await query("SELECT COUNT(*) n FROM (SELECT obligation_id FROM payment_attempts WHERE status IN ('CREATED','PENDING','AUTHORIZED') GROUP BY obligation_id HAVING COUNT(*)>1) x"))[0].n),
  overpayments: Number((await query("SELECT COUNT(*) n FROM (SELECT obligation_id FROM payment_attempts WHERE status='SUCCEEDED' GROUP BY obligation_id HAVING COUNT(*)>1) x"))[0].n),
  orderItemOrphans: Number((await query('SELECT COUNT(*) n FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL'))[0].n),
  invalidInventory: Number((await query('SELECT COUNT(*) n FROM inventory WHERE on_hand<0 OR reserved<0 OR reserved>on_hand'))[0].n),
  invalidSplits: Number((await query('SELECT COUNT(*) n FROM orders WHERE online_paid_minor+cod_due_minor+COALESCE(exchange_credit_applied_minor,0)<>total_minor'))[0].n),
  unlinkedFinalizedObligations: Number((await query("SELECT COUNT(*) n FROM payment_obligations po JOIN checkout_sessions cs ON cs.id=po.checkout_id WHERE cs.status='FINALIZED' AND po.order_id IS NULL"))[0].n),
};
for (const [name, count] of Object.entries(audits)) assert.equal(count, 0, name);

console.log(JSON.stringify({ cashfreeFailedPaymentNormalization: 'PASS', prepaid, partial, fullCod, failed, audits }, null, 2));
await pool.end();
