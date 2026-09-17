// Spending store credit, end to end.
//
// The ledger could only ever grow: refunds, exchange remainders and (now)
// cancellations grant credit, and checkout had no idea it existed — so a refund
// "to store credit" was money the customer could not use. This drives the REAL
// services against the REAL database: choose an amount, see the payment plan
// shrink, place the order, see the ledger debited once, and see it come back
// when the order is cancelled.
//
//   npm run verify:store-credit-checkout
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { CheckoutStoreCreditService } = await import('../src/modules/checkout/storeCreditService.js');
const { storeCreditService } = await import('../src/modules/storeCredit/service.js');
const { CancellationRefundService } = await import('../src/modules/orderOps/cancellationRefundService.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

const checkout = await one(
  `SELECT cs.* FROM checkout_sessions cs
    WHERE cs.customer_id IS NOT NULL AND cs.total_minor > 0
    ORDER BY cs.created_at DESC LIMIT 1`);
assert(checkout, 'need one checkout with a customer and a total — run npm run seed:orders');

const service = new CheckoutStoreCreditService();
const customerId = checkout.customer_id;
const GRANT_MINOR = Math.max(200, Math.floor(Number(checkout.total_minor) / 2));
const grantKey = `verify-credit-${randomUUID()}`;
const appliedBefore = Number(checkout.store_credit_applied_minor || 0);
const modeBefore = (await one('SELECT selected_payment_mode FROM checkout_payment_eligibility WHERE checkout_id = ?', [checkout.id]))?.selected_payment_mode ?? null;

async function restore() {
  await query('UPDATE checkout_sessions SET store_credit_applied_minor = ? WHERE id = ?', [appliedBefore, checkout.id]);
  await query('DELETE FROM store_credit_entries WHERE idempotency_key = ?', [grantKey]);
  await query("DELETE FROM store_credit_entries WHERE source_type IN ('ORDER_PAYMENT','ORDER_CANCELLATION_CREDIT_REVERSAL') AND reason LIKE 'VERIFY %'");
  // The balance is rebuilt from what is left, so the account is exactly as found.
  const [account] = await query('SELECT id FROM store_credit_accounts WHERE customer_id = ?', [customerId]);
  if (account) {
    const [{ ledger }] = await query('SELECT COALESCE(SUM(amount_minor),0) ledger FROM store_credit_entries WHERE account_id = ?', [account.id]);
    await query('UPDATE store_credit_accounts SET balance_minor = ? WHERE id = ?', [ledger, account.id]);
  }
  if (modeBefore !== null) {
    await query('UPDATE checkout_payment_eligibility SET selected_payment_mode = ? WHERE checkout_id = ?', [modeBefore, checkout.id]);
  }
}

try {
  await storeCreditService.applyEntry({
    customerId, amountMinor: GRANT_MINOR, entryType: 'GRANT', sourceType: 'VERIFY_FIXTURE',
    sourceId: checkout.id, idempotencyKey: grantKey, reason: 'VERIFY fixture grant',
  });
  const balanceAfterGrant = await storeCreditService.getBalanceMinor(customerId);

  // 1 — what can be used is bounded by the balance AND the order
  {
    const info = await service.availability(customerId, checkout.id);
    assert.equal(info.balanceMinor, balanceAfterGrant);
    assert.equal(info.maxApplicableMinor, Math.min(balanceAfterGrant, Number(checkout.total_minor)),
      'never more than the balance, never more than the order costs');
    pass('AVAILABILITY_IS_BOUNDED', `${info.maxApplicableMinor} of ${checkout.total_minor}`);
  }

  // 2 — asking for more than that is refused, not silently capped
  {
    await assert.rejects(
      () => service.apply(customerId, checkout.id, balanceAfterGrant + Number(checkout.total_minor) + 1),
      (e) => e.code === 'STORE_CREDIT_INSUFFICIENT');
    const row = await one('SELECT store_credit_applied_minor FROM checkout_sessions WHERE id = ?', [checkout.id]);
    assert.equal(Number(row.store_credit_applied_minor), appliedBefore, 'a refused request changes nothing');
    pass('OVER_BALANCE_IS_REFUSED');
  }

  // 3 — applying records the amount, and removing takes it off again
  {
    const applied = await service.apply(customerId, checkout.id, 'MAX');
    const expected = Math.min(balanceAfterGrant, Number(checkout.total_minor));
    assert.equal(applied.appliedMinor, expected);
    const row = await one('SELECT store_credit_applied_minor FROM checkout_sessions WHERE id = ?', [checkout.id]);
    assert.equal(Number(row.store_credit_applied_minor), expected, 'it survives a page reload');
    // Choosing an amount must NOT touch the ledger — nothing is spent until an
    // order exists, or an abandoned checkout would eat the balance.
    assert.equal(await storeCreditService.getBalanceMinor(customerId), balanceAfterGrant, 'the balance is untouched until the order is placed');
    await service.remove(customerId, checkout.id);
    assert.equal(Number((await one('SELECT store_credit_applied_minor FROM checkout_sessions WHERE id = ?', [checkout.id])).store_credit_applied_minor), 0);
    pass('APPLY_AND_REMOVE_DO_NOT_SPEND');
  }

  // 4 — COD is refused: the courier's figure is printed and manifested
  {
    await query("UPDATE checkout_payment_eligibility SET selected_payment_mode = 'FULL_COD' WHERE checkout_id = ?", [checkout.id]);
    const info = await service.availability(customerId, checkout.id);
    assert.equal(info.usable, false);
    assert.equal(info.maxApplicableMinor, 0);
    await assert.rejects(() => service.apply(customerId, checkout.id, 100), (e) => e.code === 'STORE_CREDIT_NOT_USABLE');
    await query("UPDATE checkout_payment_eligibility SET selected_payment_mode = 'PREPAID' WHERE checkout_id = ?", [checkout.id]);
    pass('COD_CANNOT_BE_PAID_WITH_CREDIT');
  }

  // 5 — the spend itself: one debit, and only one however often it is retried
  {
    const spendAmount = Math.min(balanceAfterGrant, Number(checkout.total_minor));
    await service.apply(customerId, checkout.id, spendAmount);
    const fresh = await one('SELECT * FROM checkout_sessions WHERE id = ?', [checkout.id]);
    const order = {
      id: randomUUID(), customer_id: customerId, order_number: `VERIFY ${Date.now()}`, currency: 'INR',
    };
    const spent = await service.spendForOrder(null, { order, checkout: fresh });
    assert.equal(spent, spendAmount);
    assert.equal(await storeCreditService.getBalanceMinor(customerId), balanceAfterGrant - spendAmount, 'the balance moved by exactly what was spent');
    const debits = await query("SELECT * FROM store_credit_entries WHERE source_type = 'ORDER_PAYMENT' AND source_id = ?", [order.id]);
    assert.equal(debits.length, 1);
    assert.equal(Number(debits[0].amount_minor), -spendAmount, 'a debit is negative');

    await service.spendForOrder(null, { order, checkout: fresh });
    const again = await query("SELECT id FROM store_credit_entries WHERE source_type = 'ORDER_PAYMENT' AND source_id = ?", [order.id]);
    assert.equal(again.length, 1, 'a retried placement does not spend twice');
    assert.equal(await storeCreditService.getBalanceMinor(customerId), balanceAfterGrant - spendAmount);
    pass('SPENT_ONCE_ONLY', `${spendAmount} minor`);

    // 6 — cancelling returns it, once
    const refunds = new CancellationRefundService();
    const cancelledOrder = { ...order, store_credit_applied_minor: spendAmount };
    const returned = await refunds.reverseStoreCreditSpent(cancelledOrder);
    assert.equal(returned.status, 'RETURNED');
    assert.equal(returned.amountMinor, spendAmount);
    assert.equal(await storeCreditService.getBalanceMinor(customerId), balanceAfterGrant, 'the customer has their credit back');
    await refunds.reverseStoreCreditSpent(cancelledOrder);
    const reversals = await query("SELECT id FROM store_credit_entries WHERE source_type = 'ORDER_CANCELLATION_CREDIT_REVERSAL' AND source_id = ?", [order.id]);
    assert.equal(reversals.length, 1, 'a re-cancel does not return it twice');
    assert.equal(await storeCreditService.getBalanceMinor(customerId), balanceAfterGrant);
    pass('CANCELLATION_RETURNS_IT_ONCE');

    await query("DELETE FROM store_credit_entries WHERE source_id = ?", [order.id]);
  }

  console.log('\nStore credit at checkout — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nSTORE_CREDIT_CHECKOUT_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  await restore();
  await pool.end();
}
