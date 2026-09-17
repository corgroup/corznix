// Canonical CORCOTTON Credit ledger verification (Wave 8F-1).
//
// One closed-loop ledger: signed append-only entries, a cached account
// balance moved only under a row lock, idempotent grants/debits, and a hard
// floor at zero. No second wallet.
//
//   npm run verify:store-credit
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { storeCreditService } = await import('../src/modules/storeCredit/service.js');

const results = {};
const created = { customers: [] };

async function makeCustomer() {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),'SC','T','ACTIVE',NOW(3))", [id]);
  return id;
}

try {
  const customerId = await makeCustomer();

  // 1. Empty balance
  assert.equal(await storeCreditService.getBalanceMinor(customerId), 0);

  // 2. Grant + balance projection
  const g1 = await storeCreditService.applyEntry({
    customerId, amountMinor: 50000, entryType: 'GRANT', sourceType: 'MANUAL',
    sourceId: 'test-1', idempotencyKey: `sc-grant-${customerId}-1`, reason: 'test grant',
  });
  assert.equal(g1.balanceAfterMinor, 50000);
  assert.equal(await storeCreditService.getBalanceMinor(customerId), 50000);

  // 3. Idempotent grant — no double effect
  const g1replay = await storeCreditService.applyEntry({
    customerId, amountMinor: 50000, entryType: 'GRANT', sourceType: 'MANUAL',
    sourceId: 'test-1', idempotencyKey: `sc-grant-${customerId}-1`,
  });
  assert.equal(g1replay.balanceAfterMinor, 50000);
  assert.equal(await storeCreditService.getBalanceMinor(customerId), 50000, 'replayed grant does not double the balance');
  results.idempotentGrant = 'PASS';

  // 4. Concurrent grants (distinct keys) — no lost update
  await Promise.all(Array.from({ length: 5 }, (_, i) => storeCreditService.applyEntry({
    customerId, amountMinor: 1000, entryType: 'GRANT', sourceType: 'MANUAL',
    idempotencyKey: `sc-conc-${customerId}-${i}`,
  })));
  assert.equal(await storeCreditService.getBalanceMinor(customerId), 55000, '5 concurrent 1000 grants all land');
  results.concurrentGrants = 'PASS (no lost update)';

  // 5. Debit
  const d1 = await storeCreditService.applyEntry({
    customerId, amountMinor: -20000, entryType: 'DEBIT', sourceType: 'CHECKOUT',
    sourceId: 'ord-x', idempotencyKey: `sc-debit-${customerId}-1`,
  });
  assert.equal(d1.balanceAfterMinor, 35000);

  // 6. Overdraft rejected
  await assert.rejects(
    () => storeCreditService.applyEntry({
      customerId, amountMinor: -999999, entryType: 'DEBIT', sourceType: 'CHECKOUT',
      idempotencyKey: `sc-debit-${customerId}-2`,
    }),
    (e) => e.code === 'INSUFFICIENT_STORE_CREDIT',
  );
  assert.equal(await storeCreditService.getBalanceMinor(customerId), 35000, 'rejected debit left balance untouched');
  results.overdraftProtection = 'PASS';

  // 7. Wrong-sign rejected
  await assert.rejects(
    () => storeCreditService.applyEntry({
      customerId, amountMinor: -100, entryType: 'GRANT', sourceType: 'MANUAL',
      idempotencyKey: `sc-badsign-${customerId}`,
    }),
    (e) => e.code === 'VALIDATION_ERROR',
  );

  // 8. Idempotency conflict — same key, different amount
  await assert.rejects(
    () => storeCreditService.applyEntry({
      customerId, amountMinor: 999, entryType: 'GRANT', sourceType: 'MANUAL',
      idempotencyKey: `sc-grant-${customerId}-1`,
    }),
    (e) => e.code === 'IDEMPOTENCY_CONFLICT',
  );
  results.idempotencyConflict = 'PASS';

  // 9. History + summary
  const summary = await storeCreditService.getSummary(customerId);
  assert.equal(summary.balanceMinor, 35000);
  assert.ok(summary.entries.length >= 7);
  results.summary = 'PASS';

  // 10. Ledger sum == balance
  const [{ total }] = await query('SELECT COALESCE(SUM(amount_minor),0) total FROM store_credit_entries WHERE customer_id=?', [customerId]);
  assert.equal(Number(total), 35000, 'sum of ledger entries equals the account balance');
  results.ledgerIntegrity = 'PASS';

  results.status = 'PASS';
  console.log('\nSTORE_CREDIT_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nSTORE_CREDIT_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const id of created.customers) {
    await safe(() => query('DELETE FROM store_credit_entries WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM store_credit_accounts WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [id]));
  }
  await pool.end();
}
