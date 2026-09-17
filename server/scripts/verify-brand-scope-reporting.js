// Brand isolation for the reporting + reconciliation projections.
//
// The reporting module was built before multi-company and had NO brand
// predicate anywhere: every figure — revenue, orders, payments, COD, store
// credit, credit notes — summed both companies together. It was invisible
// only because Cor-Znix had no orders yet.
//
// This proves the predicate is real: it plants one distinctively-priced order
// on Cor-Znix, then asserts Cor-Cotton's numbers do not move and Cor-Znix's
// do. Everything it creates is removed again, so the script is re-runnable.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query, pool } from '../src/database/connection/pool.js';
import { reportingRepository as R } from '../src/modules/reporting/reportingRepository.js';
import { reconciliationRepository as X } from '../src/modules/reporting/reconciliationRepository.js';

const results = {};
const pass = (name, detail = '') => { results[name] = detail ? `PASS (${detail})` : 'PASS'; console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`); };

// A number no real fixture will collide with, so the assertions are unambiguous.
const MARKER_MINOR = 987654321;
const created = { orders: [], customers: [], reservations: [] };
const createdExceptions = [];
const createdImports = [];

const period = () => {
  const end = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const start = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
  return { start, end };
};

async function brandIds() {
  const rows = await query("SELECT id, slug FROM brands WHERE slug IN ('corcotton','corznix')");
  const by = Object.fromEntries(rows.map((r) => [r.slug, r.id]));
  assert.ok(by.corcotton && by.corznix, 'both brands must exist (run npm run seed)');
  return by;
}

async function plantOrder(brandId) {
  const customerId = randomUUID();
  const reservationId = randomUUID();
  const orderId = randomUUID();
  await query("INSERT INTO customers (id, brand_id, status) VALUES (?, ?, 'ACTIVE')", [customerId, brandId]);
  created.customers.push(customerId);
  await query(
    `INSERT INTO inventory_reservations (id, brand_id, customer_id, idempotency_key, request_fingerprint, status, expires_at)
     VALUES (?, ?, ?, ?, ?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`,
    [reservationId, brandId, customerId, `bsr-${reservationId}`, `bsr-${reservationId}`]);
  created.reservations.push(reservationId);
  await query(
    `INSERT INTO orders
       (id, brand_id, order_number, customer_id, inventory_reservation_id, payment_status, payment_mode, currency,
        subtotal_minor, shipping_minor, total_minor, online_paid_minor, cod_due_minor,
        shipping_address_snapshot, shipping_snapshot, finalization_source, placed_at)
     VALUES (?, ?, ?, ?, ?, 'PAID', 'PREPAID', 'INR', ?, 0, ?, ?, 0, ?, ?, 'BRAND_SCOPE_REPORTING_TEST', NOW(3))`,
    [orderId, brandId, `BSR-${orderId.slice(0, 8).toUpperCase()}`, customerId, reservationId,
      MARKER_MINOR, MARKER_MINOR, MARKER_MINOR, JSON.stringify({ city: 'Test' }), JSON.stringify({ serviceLevel: 'STANDARD' })]);
  created.orders.push(orderId);
  return orderId;
}

async function cleanup() {
  if (createdExceptions.length) {
    const ph = createdExceptions.map(() => '?').join(',');
    await query(`DELETE FROM reconciliation_events WHERE exception_id IN (${ph})`, createdExceptions);
    await query(`DELETE FROM reconciliation_exceptions WHERE id IN (${ph})`, createdExceptions);
  }
  if (createdImports.length) await query(`DELETE FROM provider_settlement_imports WHERE id IN (${createdImports.map(() => '?').join(',')})`, createdImports);
  if (created.orders.length) await query(`DELETE FROM orders WHERE id IN (${created.orders.map(() => '?').join(',')})`, created.orders);
  if (created.reservations.length) await query(`DELETE FROM inventory_reservations WHERE id IN (${created.reservations.map(() => '?').join(',')})`, created.reservations);
  if (created.customers.length) await query(`DELETE FROM customers WHERE id IN (${created.customers.map(() => '?').join(',')})`, created.customers);
}

try {
  const B = await brandIds();
  const P = period();

  // ---- 1. a missing brand is refused, never silently aggregated ----
  {
    await assert.rejects(
      () => Promise.resolve().then(() => R.salesSummary({ ...P })),
      (e) => e.code === 'BRAND_REQUIRED',
      'salesSummary without a brandId must throw, not sum every company');
    await assert.rejects(
      () => Promise.resolve().then(() => R.storeCreditLiability()),
      (e) => e.code === 'BRAND_REQUIRED');
    pass('BRAND_REQUIRED_ENFORCED', 'an omitted brandId throws instead of returning a cross-company total');
  }

  // ---- 2. baseline, then plant one Cor-Znix order ----
  const before = {
    cotton: await R.salesSummary({ ...P, brandId: B.corcotton }),
    znix: await R.salesSummary({ ...P, brandId: B.corznix }),
  };
  await plantOrder(B.corznix);
  const after = {
    cotton: await R.salesSummary({ ...P, brandId: B.corcotton }),
    znix: await R.salesSummary({ ...P, brandId: B.corznix }),
  };

  {
    assert.equal(Number(after.cotton.orders), Number(before.cotton.orders),
      "Cor-Cotton's order count moved when a Cor-Znix order was created");
    assert.equal(Number(after.cotton.net_minor), Number(before.cotton.net_minor),
      "Cor-Cotton's revenue moved when a Cor-Znix order was created");
    pass('SALES_SUMMARY_ISOLATED', 'a new Cor-Znix order does not alter Cor-Cotton revenue or order count');
  }
  {
    assert.equal(Number(after.znix.orders), Number(before.znix.orders) + 1, 'the planted order must appear for Cor-Znix');
    assert.equal(Number(after.znix.net_minor), Number(before.znix.net_minor) + MARKER_MINOR, "Cor-Znix's revenue must include the planted order");
    pass('SALES_SUMMARY_ATTRIBUTED', 'the planted order is counted for the company that owns it');
  }

  // ---- 3. the marker never leaks into the other company's projections ----
  {
    const cottonRows = await R.ordersDetail({ ...P, brandId: B.corcotton, sort: { column: 'placed_at', direction: 'DESC' }, offset: 0, limit: 500 });
    assert.ok(!cottonRows.some((o) => Number(o.total_minor) === MARKER_MINOR), 'the Cor-Znix order appeared in Cor-Cotton ordersDetail');
    const znixRows = await R.ordersDetail({ ...P, brandId: B.corznix, sort: { column: 'placed_at', direction: 'DESC' }, offset: 0, limit: 500 });
    assert.ok(znixRows.some((o) => Number(o.total_minor) === MARKER_MINOR), 'the planted order is missing from Cor-Znix ordersDetail');
    pass('ORDERS_DETAIL_ISOLATED', 'row-level order listing is scoped, not just the aggregates');
  }
  {
    const cottonCount = await R.ordersCount({ ...P, brandId: B.corcotton });
    const znixCount = await R.ordersCount({ ...P, brandId: B.corznix });
    const [{ total }] = await query('SELECT COUNT(*) AS total FROM orders WHERE placed_at >= ? AND placed_at < ?', [P.start, P.end]);
    assert.equal(cottonCount + znixCount, Number(total), 'per-brand counts must partition the table, never double-count or drop rows');
    pass('COUNTS_PARTITION_CLEANLY', `corcotton=${cottonCount} + corznix=${znixCount} = ${total} total`);
  }

  // ---- 4. customer projections are per-company ----
  {
    const cotton = await R.customerSummary({ ...P, brandId: B.corcotton });
    const znix = await R.customerSummary({ ...P, brandId: B.corznix });
    const [{ total }] = await query('SELECT COUNT(*) AS total FROM customers');
    assert.equal(Number(cotton.total_customers) + Number(znix.total_customers), Number(total),
      'total_customers must partition by brand');
    pass('CUSTOMER_SUMMARY_ISOLATED', `corcotton=${cotton.total_customers} + corznix=${znix.total_customers} = ${total}`);
  }

  // ---- 5. every remaining projection runs brand-scoped without error ----
  {
    const scoped = { ...P, brandId: B.corcotton };
    await Promise.all([
      R.capturedRevenue(scoped), R.salesTimeSeries(scoped), R.orderStatusBreakdown(scoped),
      R.paymentModeBreakdown(scoped), R.splitFulfilmentCount(scoped), R.topProducts(scoped),
      R.topSkus(scoped), R.categoryPerformanceCurrent(scoped), R.returnsSummary(scoped),
      R.returnUnits(scoped), R.reasonBreakdown(scoped), R.deliveredUnits(scoped),
      R.exchangeSummary(scoped), R.reservedExchangeCredit(B.corcotton), R.repeatRate(B.corcotton),
      R.inventoryByWarehouse({ warehouseIds: [], brandId: B.corcotton }),
      R.lowStock({ warehouseIds: [], threshold: null, brandId: B.corcotton }),
      R.stockMovements({ ...scoped, warehouseIds: [], offset: 0, limit: 10 }),
      R.warehouseOps({ ...scoped, warehouseIds: [] }),
      R.forwardShipments(scoped), R.reverseShipments(scoped), R.providerBreakdown(scoped),
      R.rtoSummary(scoped), R.paymentSummary(scoped), R.paymentFailureCategories(scoped),
      R.refundSummary(scoped), R.refundsDetail({ ...scoped, offset: 0, limit: 10 }),
      R.codSummary(scoped), R.codSplitMismatches(B.corcotton),
      R.storeCreditLiability(B.corcotton), R.storeCreditLedgerDrift(B.corcotton),
      R.creditNoteSummary(scoped), R.creditNoteDuplicates(B.corcotton),
      R.refundUnknown(B.corcotton), R.paymentUnknown(B.corcotton),
      R.inventoryReservedDrift(B.corcotton), R.reviewSummary(scoped),
      R.promotionSummary(scoped), R.communicationSummary(scoped),
    ]);
    pass('ALL_PROJECTIONS_EXECUTE_SCOPED', '39 projections run with a brand predicate and valid SQL');
  }
  // ---- 6. reconciliation exceptions are per-company, read AND write ----
  // Before migration 085 these rows had no brand at all: one company's staff
  // could list another's financial exceptions and, worse, resolve or reopen
  // them by id straight from the URL.
  {
    const mk = (brandId, key) => X.upsertException({
      brandId, exceptionType: 'COD_SPLIT_MISMATCH', sourceDomain: 'cod',
      referenceType: 'order', referenceId: `bsr-${key}`, expectedMinor: 100, actualMinor: 1,
      detail: { plantedBy: 'verify-brand-scope-reporting' }, dedupeKey: `BSR_TEST:${key}`,
    });
    const znix = await mk(B.corznix, 'znix');
    createdExceptions.push(znix.id);

    const cottonList = await X.list({ status: null, type: null, offset: 0, limit: 200, brandId: B.corcotton });
    assert.ok(!cottonList.some((r) => r.id === znix.id), "Cor-Znix's exception appeared in Cor-Cotton's queue");
    const znixList = await X.list({ status: null, type: null, offset: 0, limit: 200, brandId: B.corznix });
    assert.ok(znixList.some((r) => r.id === znix.id), 'the planted exception is missing from its own company queue');
    pass('RECONCILIATION_LIST_ISOLATED', 'each company sees only its own exceptions');

    assert.equal(await X.byId(znix.id, B.corcotton), null, 'byId leaked another company\u2019s exception');
    assert.ok(await X.byId(znix.id, B.corznix), 'byId lost the exception for its owner');
    pass('RECONCILIATION_BYID_ISOLATED', 'a known id from another company resolves to null, not the row');

    // The important one: a WRITE reached by id from the URL.
    const stolen = await X.transition(znix.id, {
      toStatus: 'RESOLVED', eventType: 'RESOLVED_WITH_EVIDENCE', note: 'cross-company attempt',
      staffId: null, assignStaffId: null, brandId: B.corcotton,
    });
    assert.equal(stolen, null, 'a staff member resolved another company\u2019s financial exception');
    const untouched = await X.byId(znix.id, B.corznix);
    assert.notEqual(untouched.status, 'RESOLVED', 'the cross-company transition mutated the row anyway');
    pass('RECONCILIATION_TRANSITION_REFUSED', 'resolving another company\u2019s exception by id is refused and mutates nothing');

    // Same dedupe key in both companies must be two independent rows, not one.
    const cotton = await mk(B.corcotton, 'znix');
    createdExceptions.push(cotton.id);
    assert.notEqual(cotton.id, znix.id, 'the same dedupe key collapsed two companies into one row');
    pass('RECONCILIATION_DEDUPE_PER_COMPANY', 'dedupe_key is unique per company, not globally');
  }

  // ---- 7. a settlement file hash is per-company ----
  {
    const hash = `bsr-hash-${randomUUID()}`;
    const importId = await X.insertSettlementImport({
      brandId: B.corznix, providerCode: 'MOCK_PAYMENT', kind: 'PAYMENT', fileName: 'bsr.csv',
      fileHash: hash, rowCount: 0, matchedCount: 0, exceptionCount: 0, staffId: null,
    });
    createdImports.push(importId);
    assert.ok(await X.settlementImportByHash(hash, B.corznix), 'the import is missing for its owner');
    assert.equal(await X.settlementImportByHash(hash, B.corcotton), null,
      "one company's settlement upload was visible as a duplicate to another");
    pass('SETTLEMENT_HASH_PER_COMPANY', 'an identical file uploaded by two companies is not deduped across them');
  }


  console.log('\nBRAND_SCOPE_REPORTING_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await cleanup();
  await pool.end();
}
