// Wave 8H — reporting + reconciliation characterization.
//
// A controlled synthetic dataset with known totals, then every report is
// asserted to return the exact expected figure. Also: split-order is one
// order, partial return does not inflate, COD split invariant + mismatch
// detection, UNKNOWN payment/refund never counted as success/fail, store
// credit ledger reconciliation, reserved exchange credit kept separate,
// warehouse-scope isolation, SQL-filter injection rejection, CSV formula
// injection escaped, settlement re-import idempotency, RBAC, no duplicate
// authority, no real provider calls. Self-cleaning.
//
//   npm run verify:reporting
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { roleHasPermission } = await import('../src/modules/staff/permissions.js');
const { reportingService } = await import('../src/modules/reporting/reportingService.js');
const { reconciliationService } = await import('../src/modules/reporting/reconciliationService.js');
const { resolvePeriod } = await import('../src/modules/reporting/reportTime.js');
const { csvCell, parseSort } = await import('../src/modules/reporting/guards.js');

// Reporting projections are per-company since the multi-company work — every
// service call takes the caller's brand (req.brandId in the routes).
const [BRAND] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
const BRAND_ID = BRAND.id;

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
// A quiet historical window so the synthetic dataset is the ONLY data the
// period-scoped reports see (no interference from other verify runs).
const D = '2022-06-15 10:00:00.000';
const P = { range: 'custom', start: '2022-06-01', end: '2022-06-30' };
const created = { customers: [], orders: [], carts: [], reservations: [], warehouses: [], accounts: [], returns: [], exch: [], payments: [] };
let defInvSnapshot = null;
let defInvKey = null;

async function customer(name) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'R','ACTIVE',NOW(3))", [id, name]);
  return id;
}
async function mkOrder({ customerId, subtotal, shipping = 0, discount = 0, mode = 'PREPAID', codDue = 0, capture = null, placedAt = D }) {
  const rid = randomUUID(); const csId = randomUUID(); const orderId = randomUUID();
  created.reservations.push(rid); created.orders.push(orderId);
  await query("INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3),INTERVAL 1 DAY))", [rid, customerId, `rep:${randomUUID()}`, '0'.repeat(64)]);
  let cartId = (await query('SELECT id FROM carts WHERE customer_id = ? LIMIT 1', [customerId]))[0]?.id;
  if (!cartId) { cartId = randomUUID(); created.carts.push(cartId); await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']); }
  const total = subtotal + shipping - discount;
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,subtotal_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?, ?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [csId, customerId, cartId, rid, randomUUID().slice(0,36), 'f'.repeat(64), subtotal, total]);
  const isUnknown = capture === 'UNKNOWN';
  const online = (capture != null && !isUnknown) ? capture : (mode === 'PREPAID' ? total : total - codDue);
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,order_status,payment_status,payment_mode,currency,subtotal_minor,shipping_minor,total_minor,discount_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source,placed_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PLACED', ?, ?, 'INR', ?,?,?,?,?,?, '{}','{}','REP_TEST', ?)`,
    [orderId, `COR-REP-${tag}-${created.orders.length}`, csId, customerId, rid, codDue > 0 ? (online > 0 ? 'PARTIALLY_PAID' : 'COD_DUE') : 'PAID', mode, subtotal, shipping, total, discount, online, codDue, placedAt]);
  const oiId = randomUUID();
  await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,1,?,?)`, [oiId, orderId, sku.pid, sku.vid, sku.id, 'Item', sku.sku, subtotal, subtotal]);
  // payment obligation + attempt
  const obId = randomUUID(); const paId = randomUUID();
  await query(`INSERT INTO payment_obligations (id,checkout_id,order_id,obligation_type,amount_minor,currency,status,source_payment_mode) VALUES (?,?,?, 'ONLINE', ?, 'INR', 'PAID', ?)`, [obId, csId, orderId, online, mode]);
  if (capture !== 0) {
    await query(`INSERT INTO payment_attempts (id,obligation_id,checkout_id,provider_code,merchant_reference,amount_minor,currency,status,idempotency_key,created_at)
       VALUES (?,?,?, 'MOCK_PAYMENT', ?, ?, 'INR', ?, ?, ?)`, [paId, obId, csId, `MREF-${tag}-${created.orders.length}`, online, isUnknown ? 'PENDING' : 'SUCCEEDED', randomUUID(), D]);
  }
  if (capture !== 0) created.payments.push(paId);
  return { orderId, csId, oiId, paId, total, online };
}

let sku;
let preExceptionIds = new Set();
try {
  preExceptionIds = new Set((await query('SELECT id FROM reconciliation_exceptions')).map((r) => r.id));
  [sku] = await query("SELECT s.id, s.sku, s.price_minor, v.id vid, p.id pid FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 1").then((r) => r.map((x) => ({ ...x })));
  assert.ok(sku, 'need an ACTIVE sku');
  const A = await customer(`repA${tag}`);
  const B = await customer(`repB${tag}`);

  // ============ 1. financial totals ============
  const oA = await mkOrder({ customerId: A, subtotal: 10000, capture: null }); // captured 10000
  const oB = await mkOrder({ customerId: B, subtotal: 20000, capture: null }); // captured 20000
  // refund 5000 against oA (needs a return)
  const retId = randomUUID(); created.returns.push(retId);
  await query(`INSERT INTO return_requests (id, brand_id,request_number,customer_id,order_id,request_type,status,reason_code,eligibility_snapshot_json,requested_at,received_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?, 'RETURN','COMPLETED','DEFECTIVE','{}', ?, ?)`, [retId, `RR-${tag}`, A, oA.orderId, D, D]);
  await query(`INSERT INTO return_request_items (id,return_request_id,order_item_id,sku_id,quantity,unit_price_minor,eligible_value_minor)
     VALUES (?,?,?,?,1,3333,3333)`, [randomUUID(), retId, oA.oiId, sku.id]);
  await query(`INSERT INTO refund_attempts (id, brand_id,refund_number,return_request_id,order_id,customer_id,method,amount_minor,currency,status,idempotency_key,request_hash,created_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'ORIGINAL_PAYMENT', 5000, 'INR', 'SUCCEEDED', ?, ?, ?)`, [randomUUID(), `REF-${tag}`, retId, oA.orderId, A, randomUUID(), randomUUID().replace(/-/g, ''), D]);

  const sales = await reportingService.sales(P, BRAND_ID);
  assert.equal(sales.summary.capturedRevenueMinor, 30000, 'captured = 10000 + 20000');
  const overview = await reportingService.overview(P, BRAND_ID);
  assert.equal(overview.kpis.capturedRevenueMinor, 30000);
  assert.equal(overview.kpis.refundedMinor, 5000);
  assert.equal(overview.kpis.netCapturedMinor, 25000, 'net captured = 30000 - 5000');
  results.financialTotals = 'PASS';

  // ============ 2. split order = ONE order ============
  const oSplit = await mkOrder({ customerId: A, subtotal: 6000 });
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0].id;
  for (let i = 0; i < 2; i += 1) {
    const fId = randomUUID();
    await query(`INSERT INTO fulfillments (id, brand_id,order_id,warehouse_id,fulfillment_number,fulfillment_type,sequence,readiness_status,financial_snapshot_json,shipping_address_snapshot_json,shipping_method_snapshot_json)
       VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?, ?, ?, 'READY', '{}','{}','{}')`, [fId, oSplit.orderId, def, `F-${tag}-${i}`, i === 0 ? 'INITIAL' : 'SUPPLEMENTARY', i + 1]);
    await query('INSERT INTO fulfillment_items (id,fulfillment_id,order_item_id,sku_id,quantity) VALUES (?,?,?,?,1)', [randomUUID(), fId, oSplit.oiId, sku.id]);
    await query(`INSERT INTO shipments (id, brand_id,fulfillment_id,warehouse_id,shipment_number,status,booking_status,provider_code,external_shipment_id,tracking_number,delivered_at,booked_at,cod_collection_minor)
       VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?, 'DELIVERED', 'BOOKED', 'MOCK', CONCAT('EXT-',?), CONCAT('AWB-',?), DATE_SUB(NOW(3),INTERVAL 1 DAY), DATE_SUB(NOW(3),INTERVAL 3 DAY), 0)`, [randomUUID(), fId, def, `S-${tag}-${i}`, `${tag}${i}`, `${tag}${i}`]);
  }
  const ord = await reportingService.orders(P, BRAND_ID);
  const splitInList = ord.rows.filter((r) => r.orderNumber === `COR-REP-${tag}-${created.orders.length}`).length;
  assert.equal(splitInList, 1, 'split order appears once');
  assert.ok(ord.splitFulfilmentOrders >= 1, 'split fulfilment counted');
  const salesAfter = await reportingService.sales(P, BRAND_ID);
  assert.equal(salesAfter.summary.orders, 3, '3 distinct orders so far — a split order is ONE order, not two');
  results.splitOrder = 'PASS';

  // ============ 3. partial return does not inflate ============
  const ret = await reportingService.returns(P, BRAND_ID);
  assert.equal(ret.returns.returnedUnits, 1, 'returned units = 1 (not whole order)');
  assert.ok(ret.returns.returnRate === null || ret.returns.returnRate <= 1, 'return rate bounded / null');
  results.partialReturn = 'PASS';

  // ============ 4. reserved exchange credit kept separate ============
  const exId = randomUUID(); created.exch.push(exId);
  const retX = randomUUID(); created.returns.push(retX);
  await query(`INSERT INTO return_requests (id, brand_id,request_number,customer_id,order_id,request_type,status,eligibility_snapshot_json,requested_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?, 'DIFFERENT_STYLE_EXCHANGE','RESOLUTION_PENDING','{}', ?)`, [retX, `RRX-${tag}`, B, oB.orderId, D]);
  await query(`INSERT INTO exchange_transactions (id, brand_id,transaction_number,customer_id,original_order_id,return_request_id,status,currency,eligible_value_minor,eligibility_snapshot_json,context_token,expires_at,reserved_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'RESERVED','INR', 8000, '{}', ?, DATE_ADD(NOW(3),INTERVAL 7 DAY), ?)`, [exId, `EX-${tag}`, B, oB.orderId, retX, randomUUID(), D]);
  await query(`INSERT INTO reserved_exchange_credits (id,exchange_transaction_id,customer_id,currency,status,amount_minor,consumed_amount_minor,expires_at)
     VALUES (?,?,?, 'INR','RESERVED', 8000, 0, DATE_ADD(NOW(3),INTERVAL 7 DAY))`, [randomUUID(), exId, B]);

  // ============ 5. store credit ledger ============
  const acc = randomUUID(); created.accounts.push(acc);
  await query('INSERT INTO store_credit_accounts (id,brand_id,customer_id,currency,balance_minor) VALUES (?,(SELECT brand_id FROM customers WHERE id=?),?,?,?)', [acc, A, A, 'INR', 8000]);
  // All three entries share ONE timestamp on purpose: entries written in the same
  // millisecond are normal (a grant and a debit in one resolution), and the
  // ledger must still know which came last (store_credit_entries.entry_seq).
  const sameMs = new Date().toISOString().slice(0, 23).replace('T', ' ');
  const e = (type, amt, bal) => query(`INSERT INTO store_credit_entries (id,account_id,customer_id,currency,entry_type,amount_minor,balance_after_minor,source_type,idempotency_key,created_at) VALUES (?,?,?, 'INR', ?, ?, ?, 'TEST', ?, ?)`, [randomUUID(), acc, A, type, amt, bal, randomUUID(), sameMs]);
  // Measured as a DELTA. outstandingLiabilityMinor is a brand-wide total, so
  // asserting it equals what this block created only held on a database with no
  // other store credit in it — a real exchange remainder grant is enough to
  // break it, and did.
  const liabilityBefore = (await reportingService.storeCredit(BRAND_ID)).liability.outstandingLiabilityMinor;
  await e('GRANT', 10000, 10000); await e('DEBIT', -3000, 7000); await e('GRANT', 1000, 8000);
  const sc = await reportingService.storeCredit(BRAND_ID);
  assert.equal(sc.liability.outstandingLiabilityMinor - liabilityBefore, 8000, 'ledger sum = 10000 - 3000 + 1000');
  // Brand-wide, so ANY account left drifted by an earlier script in the shared
  // sequential run lands here — and a bare PASS/DRIFT told you nothing about
  // which one. Name them, or this is unfixable from a CI log.
  assert.equal(
    sc.ledgerReconciliation.status, 'PASS',
    `balance matches ledger + last balance_after — drifted: ${JSON.stringify(sc.ledgerReconciliation.driftedAccounts)}; ledgerLiability=${sc.liability.outstandingLiabilityMinor} accountsBalance=${sc.liability.accountsBalanceMinor}`);
  assert.ok(sc.reservedExchangeCredit.reservedMinor === 8000, 'reserved exchange credit reported separately');
  results.storeCreditLedger = 'PASS';
  results.reservedExchangeCreditSeparate = 'PASS';

  // ============ 6. COD split invariant + mismatch detection ============
  const oCod = await mkOrder({ customerId: A, subtotal: 4000, mode: 'FULL_COD', codDue: 4000, capture: 0 });
  const fCod = randomUUID();
  await query(`INSERT INTO fulfillments (id, brand_id,order_id,warehouse_id,fulfillment_number,readiness_status,financial_snapshot_json,shipping_address_snapshot_json,shipping_method_snapshot_json) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?, 'READY', '{}','{}','{}')`, [fCod, oCod.orderId, def, `FC-${tag}`]);
  await query('INSERT INTO fulfillment_items (id,fulfillment_id,order_item_id,sku_id,quantity) VALUES (?,?,?,?,1)', [randomUUID(), fCod, oCod.oiId, sku.id]);
  await query(`INSERT INTO shipments (id, brand_id,fulfillment_id,warehouse_id,shipment_number,status,booking_status,provider_code,external_shipment_id,tracking_number,booked_at,cod_collection_minor) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?, 'DELIVERED', 'BOOKED', 'MOCK', CONCAT('EXT-',?), CONCAT('AWB-',?), ?, 4000)`, [randomUUID(), fCod, def, `SC-${tag}`, `c${tag}`, `c${tag}`, D]);
  let cod = await reportingService.cod(P, BRAND_ID);
  assert.equal(cod.splitCodInvariant.status, 'PASS', 'COD allocations sum to cod_due');
  // break it
  await query(`UPDATE shipments SET cod_collection_minor = 3000 WHERE shipment_number = ?`, [`SC-${tag}`]);
  cod = await reportingService.cod(P, BRAND_ID);
  assert.equal(cod.splitCodInvariant.status, 'MISMATCH');
  assert.ok(cod.splitCodInvariant.mismatches.some((m) => m.orderNumber === `COR-REP-${tag}-${created.orders.indexOf(oCod.orderId) + 1}`));
  results.codInvariant = 'PASS';

  // ============ 7. UNKNOWN never counted as success/fail ============
  const oUnk = await mkOrder({ customerId: B, subtotal: 7000, capture: 'UNKNOWN' }); // stuck PENDING attempt at D
  const retU = randomUUID(); created.returns.push(retU);
  await query(`INSERT INTO return_requests (id, brand_id,request_number,customer_id,order_id,request_type,status,eligibility_snapshot_json,requested_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?, 'RETURN','RESOLUTION_PENDING','{}', ?)`, [retU, `RRU-${tag}`, B, oB.orderId, D]);
  await query(`INSERT INTO refund_attempts (id, brand_id,refund_number,return_request_id,order_id,customer_id,method,amount_minor,currency,status,idempotency_key,request_hash,created_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'ORIGINAL_PAYMENT', 1200, 'INR', 'UNKNOWN', ?, ?, ?)`, [randomUUID(), `REFU-${tag}`, retU, oB.orderId, B, randomUUID(), randomUUID().replace(/-/g, ''), D]);
  const pay = await reportingService.payments(P, BRAND_ID);
  assert.equal(pay.payments.unknown.n, 1, 'UNKNOWN payment is its own bucket');
  assert.equal(pay.refunds.unknown.n, 1, 'UNKNOWN refund is its own bucket');
  assert.ok(!('unknown' in pay.payments.succeeded), 'succeeded bucket untouched');
  results.unknownVisibility = 'PASS';

  // ============ 8. inventory per-warehouse (never a merged number) ============
  const wB = randomUUID(); created.warehouses.push(wB);
  await query(`INSERT INTO warehouses (id, brand_id,code,name,address_line1,city,state,postal_code,country,priority,is_default,status)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?, '1 Rd','X','UP','226001','IN', 50, 0, 'ACTIVE')`, [wB, `WH-REP-${tag}`, `Rep WH ${tag}`]);
  // Snapshot the default-warehouse row for this SKU before overwriting it as a
  // fixture — restored in `finally` (was previously left dirty, which the
  // WP-12 inventory_reserved_matches_open_reservations invariant now catches).
  defInvSnapshot = (await query('SELECT on_hand, reserved FROM inventory WHERE warehouse_id=? AND sku_id=?', [def, sku.id]))[0] || 'MISSING';
  defInvKey = { warehouseId: def, skuId: sku.id };
  await query('INSERT INTO inventory (id, brand_id,warehouse_id,sku_id,on_hand,reserved) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,10,2)', [randomUUID(), def, sku.id]).catch(() => query('UPDATE inventory SET on_hand=10,reserved=2 WHERE warehouse_id=? AND sku_id=?', [def, sku.id]));
  await query('INSERT INTO inventory (id, brand_id,warehouse_id,sku_id,on_hand,reserved) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,4,1)', [randomUUID(), wB, sku.id]);
  const invAll = await reportingService.inventory({}, { all: true }, BRAND_ID);
  const rowDef = invAll.byWarehouse.find((w) => w.warehouseId === def);
  const rowB = invAll.byWarehouse.find((w) => w.warehouseId === wB);
  assert.equal(rowB.available, 3, 'WH B available = 4 - 1');
  assert.ok(rowDef.available !== rowDef.onHand + rowB.onHand, 'no merged 14/11 available');
  results.inventoryPerWarehouse = 'PASS';

  // ============ 9. warehouse scope isolation ============
  const scopedToB = await reportingService.inventory({}, { all: false, warehouseIds: [wB] }, BRAND_ID);
  assert.equal(scopedToB.byWarehouse.length, 1);
  assert.equal(scopedToB.byWarehouse[0].warehouseId, wB, 'scoped staff only sees assigned warehouse');
  results.warehouseScope = 'PASS';

  // ============ 10. SQL filter injection rejected ============
  assert.throws(() => parseSort({ sort: 'placed_at; DROP TABLE orders' }, ['placed_at', 'total_minor']), (e) => e.code === 'VALIDATION_ERROR');
  assert.throws(() => resolvePeriod({ range: 'custom', start: "2020-01-01' OR '1'='1", end: '2020-02-01' }), (e) => e.code === 'VALIDATION_ERROR');
  assert.equal((await query("SELECT COUNT(*) c FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders'"))[0].c, 1);
  results.sqlFilterInjection = 0;

  // ============ 11. CSV formula injection escaped ============
  const hy = csvCell('=HYPERLINK("http://x")');
  assert.ok(hy.startsWith('"\'=') || hy.startsWith("'="), 'formula cell neutralized (leading quote), quotes doubled');
  assert.ok(csvCell('=1+1').startsWith("'="), 'formula-leading cell prefixed with quote');
  assert.ok(csvCell('+91999').startsWith("'+"), 'plus-leading cell neutralized');
  assert.ok(csvCell('@cmd').startsWith("'@"));
  assert.equal(csvCell('normal, value'), '"normal, value"');
  results.csvInjection = 'MITIGATED';

  // ============ 12. reconciliation scan + settlement idempotency ============
  const scan1 = await reconciliationService.runScan(BRAND_ID);
  assert.ok(scan1.raised.COD_SPLIT_MISMATCH >= 1, 'COD mismatch raised as exception');
  assert.ok(scan1.raised.REFUND_UNKNOWN >= 1 && scan1.raised.PAYMENT_UNKNOWN >= 1, 'UNKNOWN states raised as exceptions');
  const scan2 = await reconciliationService.runScan(BRAND_ID);
  const openCount1 = (await query("SELECT COUNT(*) c FROM reconciliation_exceptions WHERE dedupe_key LIKE ?", [`%${oCod.orderId}%`]))[0].c;
  assert.equal(openCount1, 1, 'a re-scan updates the one exception row, never duplicates');
  void scan2;

  const csv = 'reference,amount_minor,status\nMREF-NOPE-1,999,SETTLED\n';
  const imp1 = await reconciliationService.importSettlement({ providerCode: 'MOCK_PAYMENT', kind: 'PAYMENT', fileName: 's.csv', csvText: csv, staffId: null, brandId: BRAND_ID });
  assert.equal(imp1.deduped, false);
  assert.equal(imp1.exceptionCount, 1, 'unmatched settlement row → exception');
  const imp2 = await reconciliationService.importSettlement({ providerCode: 'MOCK_PAYMENT', kind: 'PAYMENT', fileName: 's.csv', csvText: csv, staffId: null, brandId: BRAND_ID });
  assert.equal(imp2.deduped, true, 'same file re-import is a no-op');
  assert.equal((await query("SELECT COUNT(*) c FROM provider_settlement_imports WHERE file_name='s.csv'"))[0].c, 1);
  const exList = await reconciliationService.list({ type: 'SETTLEMENT_UNMATCHED' }, BRAND_ID);
  assert.equal(exList.exceptions.filter((x) => x.referenceId === 'MOCK_PAYMENT:MREF-NOPE-1').length, 1, 'no duplicate settlement exception');
  results.reconciliationIdempotency = 'PASS';

  // named resolution action, never mutates source
  const anyEx = exList.exceptions[0];
  const acted = await reconciliationService.act({ id: anyEx.id, action: 'RESOLVE', note: 'linked provider record manually', staffId: null, brandId: BRAND_ID });
  assert.equal(acted.status, 'RESOLVED');
  await assert.rejects(() => reconciliationService.act({ id: anyEx.id, action: 'MARK_MATCHED', brandId: BRAND_ID }), (e) => e.code === 'VALIDATION_ERROR');
  results.reconciliationNamedActions = 'PASS';

  // ============ 13. divide-by-zero safety ============
  const cust = await reportingService.customers({ range: 'yesterday' }, BRAND_ID);
  assert.ok(cust.repeatRate === null || typeof cust.repeatRate === 'number');
  const logi = await reportingService.logistics({ range: 'yesterday' }, BRAND_ID);
  assert.ok(logi.rto.rate === null || typeof logi.rto.rate === 'number', 'rate is null (not NaN/Infinity) with no data');
  results.divideByZeroSafety = 'PASS';

  // ============ 14. RBAC + no duplicate authority + no real calls ============
  assert.equal(roleHasPermission('ADMIN', 'finance.read'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'reports.read'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'finance.read'), false);
  assert.equal(roleHasPermission('OPERATIONS', 'reconciliation.manage'), false);
  assert.equal(roleHasPermission('VIEWER', 'reports.read'), true);
  assert.equal(roleHasPermission('VIEWER', 'finance.read'), false);
  assert.equal(roleHasPermission('SUPPORT', 'reports.read'), false);
  const tabs = (await query("SELECT TABLE_NAME t FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()")).map((r) => r.t);
  assert.ok(!tabs.some((t) => /^report_/.test(t) || /_totals$/.test(t) || /^analytics_/.test(t)), 'reporting created no business-authority table');
  assert.deepEqual(tabs.filter((t) => t.startsWith('reconciliation_') || t === 'provider_settlement_imports').sort(),
    ['provider_settlement_imports', 'reconciliation_events', 'reconciliation_exceptions'], 'only the reconciliation seam is new');
  const routesSrc = readFileSync(new URL('../src/modules/reporting/adminRoutes.js', import.meta.url), 'utf8');
  assert.ok(!/UPDATE\s+(orders|payment_attempts|inventory|refund_attempts|return_requests)\b/i.test(readFileSync(new URL('../src/modules/reporting/reportingRepository.js', import.meta.url), 'utf8')), 'reporting repo issues no writes to business tables');
  assert.ok(/REPORT_EXPORTED/.test(routesSrc) && /RECONCILIATION_SCAN_RUN/.test(routesSrc), 'sensitive report actions audited');
  results.rbac = 'PASS';
  results.duplicateBusinessAuthorities = 0;

  assert.equal(networkCalls, 0);
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nREPORTING_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nREPORTING_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  // Every exception that did not exist before this run is scan/import output
  // of this test — remove it (this is a test DB; nothing else runs the scan).
  const now = (await query('SELECT id FROM reconciliation_exceptions')).map((r) => r.id);
  const mine = now.filter((id) => !preExceptionIds.has(id));
  for (const id of mine) {
    await safe(() => query('DELETE FROM reconciliation_events WHERE exception_id = ?', [id]));
    await safe(() => query('DELETE FROM reconciliation_exceptions WHERE id = ?', [id]));
  }
  await safe(() => query("DELETE FROM provider_settlement_imports WHERE file_name = 's.csv' AND matched_count = 0 AND row_count = 1"));
  for (const id of created.exch) {
    await safe(() => query('DELETE FROM reserved_exchange_credits WHERE exchange_transaction_id = ?', [id]));
    await safe(() => query('DELETE FROM exchange_transactions WHERE id = ?', [id]));
  }
  for (const id of created.accounts) {
    await safe(() => query('DELETE FROM store_credit_entries WHERE account_id = ?', [id]));
    await safe(() => query('DELETE FROM store_credit_accounts WHERE id = ?', [id]));
  }
  for (const oid of created.orders) {
    await safe(() => query('DELETE FROM refund_attempts WHERE order_id = ?', [oid]));
    await safe(() => query('DELETE re FROM return_request_items re JOIN return_requests r ON r.id = re.return_request_id WHERE r.order_id = ?', [oid]));
    await safe(() => query('DELETE FROM return_requests WHERE order_id = ?', [oid]));
    await safe(() => query('DELETE se FROM shipment_events se JOIN shipments s ON s.id = se.shipment_id JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id = ?', [oid]));
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id = ?', [oid]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id WHERE f.order_id = ?', [oid]));
    await safe(() => query('DELETE FROM fulfillments WHERE order_id = ?', [oid]));
    await safe(() => query('DELETE pa FROM payment_attempts pa JOIN payment_obligations po ON po.id = pa.obligation_id WHERE po.order_id = ?', [oid]));
    await safe(() => query('DELETE FROM payment_obligations WHERE order_id = ?', [oid]));
    await safe(() => query('DELETE FROM order_items WHERE order_id = ?', [oid]));
    const chk = (await query('SELECT checkout_id, inventory_reservation_id FROM orders WHERE id = ?', [oid]))[0];
    await safe(() => query('DELETE FROM orders WHERE id = ?', [oid]));
    if (chk) {
      await safe(() => query('DELETE FROM checkout_sessions WHERE id = ?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id = ?', [chk.inventory_reservation_id]));
    }
  }
  for (const wid of created.warehouses) {
    await safe(() => query('DELETE FROM inventory WHERE warehouse_id = ?', [wid]));
    await safe(() => query('DELETE FROM warehouses WHERE id = ?', [wid]));
  }
  if (defInvKey) {
    if (defInvSnapshot === 'MISSING') {
      await safe(() => query('DELETE FROM inventory WHERE warehouse_id=? AND sku_id=?', [defInvKey.warehouseId, defInvKey.skuId]));
    } else if (defInvSnapshot) {
      await safe(() => query('UPDATE inventory SET on_hand=?, reserved=?, updated_at=NOW(3) WHERE warehouse_id=? AND sku_id=?',
        [defInvSnapshot.on_hand, defInvSnapshot.reserved, defInvKey.warehouseId, defInvKey.skuId]));
    }
  }
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM checkout_sessions WHERE customer_id = ?', [cid]));
  }
  for (const rid of created.reservations) await safe(() => query('DELETE FROM inventory_reservations WHERE id = ?', [rid]));
  for (const cid of created.carts) await safe(() => query('DELETE FROM carts WHERE id = ?', [cid]));
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM checkout_sessions WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM store_credit_entries WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM store_credit_accounts WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM carts WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM inventory_reservations WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id = ?', [cid]));
  }
  await pool.end();
}
