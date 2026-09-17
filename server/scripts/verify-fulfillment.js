// Forward fulfillment foundation verification.
// Runs against the local development database. Non-destructive to commerce
// state: it only writes/reads the fulfillment tables (fulfillments, fulfillment_
// items, shipments, fulfillment_events) and clears those at the start so the
// script is rerunnable. Every commerce-table mutation used for a scenario is
// done inside a transaction that is rolled back.
import assert from 'node:assert/strict';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

// Prove REAL_PROVIDER_BOOKING_CALLS = 0 — any outbound HTTP in the fulfillment foundation is a defect.
let providerCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { providerCalls += 1; return realFetch?.(...args); };

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService, FulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { fulfillmentRepository } = await import('../src/modules/fulfillment/repository.js');
const { bootstrapFulfillmentForOrder } = await import('../src/modules/fulfillment/bootstrap.js');
const { backfillFulfillments } = await import('../src/modules/fulfillment/backfill.js');
const { evaluateReadiness } = await import('../src/modules/fulfillment/readiness.js');
const { assertTransition, canTransition } = await import('../src/modules/fulfillment/transitions.js');
const { orderFinalizationService } = await import('../src/modules/orders/service.js');
const { recoverMissingFulfillmentsBatch } = await import('../src/modules/fulfillment/recoveryWorker.js');
const { randomUUID } = await import('node:crypto');

const results = {};
const one = async (sql, params) => (await query(sql, params))[0];

async function inventorySignature() {
  const inv = await query('SELECT sku_id,on_hand,reserved FROM inventory ORDER BY sku_id');
  const mv = await one('SELECT COUNT(*) n FROM inventory_movements');
  const res = await one("SELECT COUNT(*) n, COALESCE(SUM(status='CONSUMED'),0) c FROM inventory_reservations");
  return JSON.stringify({ inv, movements: Number(mv.n), reservations: Number(res.n), consumed: Number(res.c) });
}

async function orderSignature(orderId) {
  return JSON.stringify(await one('SELECT * FROM orders WHERE id=?', [orderId]));
}

// ---- shipping metadata: owned by this script, not inherited -----------------
// The readiness gates below assert BOTH branches of MISSING_SHIPPING_METADATA,
// so this script has to control that data rather than depend on whatever the
// local database happens to hold. It previously assumed
// `product_shipping_profiles` was empty -- true only until someone seeded real
// carrier weights -- and its cleanup DELETEd rows it had never created,
// destroying seeded merchandising data outright.
const PROFILE_COLS = ['id', 'product_id', 'weight_grams', 'length_mm', 'width_mm', 'height_mm', 'created_at', 'updated_at'];
const profileSnapshot = await query(`SELECT ${PROFILE_COLS.join(', ')} FROM product_shipping_profiles`);

async function restoreShippingProfiles() {
  await query('DELETE FROM product_shipping_profiles');
  for (const row of profileSnapshot) {
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO product_shipping_profiles (${PROFILE_COLS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      PROFILE_COLS.map((col) => row[col]));
  }
}

// A failed assertion halfway through must not leave real carrier metadata
// deleted, so restore as the process dies rather than only on the happy path.
//
// SIGINT/SIGTERM are covered as well as thrown errors: a Ctrl-C, or a runner
// enforcing a timeout, kills this between the delete above and the restore at
// the end, and the seeded weights are simply gone. That is not hypothetical —
// it is how four real catalogue products lost their shipping profiles during
// this audit, which then surfaced two suites later as an unrelated-looking
// SHIPPING_DIMENSION_DATA_MISSING.
for (const event of ['uncaughtException', 'unhandledRejection']) {
  process.on(event, async (err) => {
    try { await restoreShippingProfiles(); } catch (e) { console.error('  profile restore failed:', e.message); }
    console.error(err);
    process.exit(1);
  });
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(signal, async () => {
    try { await restoreShippingProfiles(); } catch (e) { console.error('  profile restore failed:', e.message); }
    console.error(`\n${signal} — shipping profiles restored before exit.`);
    process.exit(130);
  });
}

// Deterministic baseline: no carrier metadata anywhere, whatever the operator
// has seeded locally. Restored verbatim at the end.
await query('DELETE FROM product_shipping_profiles');

// ---- clean slate for THIS SCRIPT'S OWN FIXTURE ONLY --------------------------
// These deletes used to be unqualified — `DELETE FROM shipments`, `DELETE FROM
// invoices`, and six more, table-wide. "The fulfilment tables only" is not the
// same as "this script's own rows": run anywhere holding real data, it
// destroyed every invoice, credit note, document, fulfilment and shipment in
// the database, including booked shipments carrying real carrier AWBs — which
// then exist at the provider with no record on our side.
//
// The read below already scopes itself to the named fixture, for exactly the
// reason stated there. The destructive prelude now uses the same scope: a
// wrong read only fails this test, a wrong delete fails everything else.
//
// Cascade order mirrors seed-orders.js — derived paperwork first, because
// documents and invoices RESTRICT-reference shipments, fulfilments and orders.
const fixtureOrderIds = (await query(
  "SELECT id FROM orders WHERE finalization_source = 'FIXTURE_SEED'")).map((o) => o.id);
if (fixtureOrderIds.length) {
  const marks = fixtureOrderIds.map(() => '?').join(',');
  await query(`DELETE pj FROM print_jobs pj JOIN documents d ON d.id = pj.document_id WHERE d.order_id IN (${marks})`, fixtureOrderIds);
  await query(`DELETE FROM credit_notes WHERE order_id IN (${marks})`, fixtureOrderIds);
  await query(`DELETE ii FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.order_id IN (${marks})`, fixtureOrderIds);
  await query(`DELETE FROM invoices WHERE order_id IN (${marks})`, fixtureOrderIds);
  await query(`DELETE FROM documents WHERE order_id IN (${marks})`, fixtureOrderIds);
  await query(`DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id = fe.fulfillment_id WHERE f.order_id IN (${marks})`, fixtureOrderIds);
  await query(`DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id WHERE f.order_id IN (${marks})`, fixtureOrderIds);
  await query(`DELETE s FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id IN (${marks})`, fixtureOrderIds);
  await query(`DELETE FROM fulfillments WHERE order_id IN (${marks})`, fixtureOrderIds);
}

// Named fixture, not "whatever orders this database happens to hold". Reading
// ambient orders is what let these assertions drift: the rows other scripts
// leave behind get advanced to PROCESSING or CANCELLED, and readiness then
// blocks on INVALID_ORDER_STATE rather than the gate under test.
const orders = await query(
  "SELECT * FROM orders WHERE finalization_source = 'FIXTURE_SEED' ORDER BY payment_mode, order_number");
assert(orders.length >= 4,
  'no order fixture — run: npm run seed:orders --workspace=server');
const byMode = (mode) => orders.find((order) => order.payment_mode === mode);
const prepaid = byMode('PREPAID');
const partial = byMode('PARTIAL_COD');
const fullCod = byMode('FULL_COD');
const spare = orders.find((order) => ![prepaid.id, partial.id, fullCod.id].includes(order.id)) || prepaid;

const invBefore = await inventorySignature();

// ---- K / L / M / N : ensureForOrder per payment mode ------------------------
async function ensureAndAssert(order, expectedCodCollection, label) {
  const orderItems = await query('SELECT * FROM order_items WHERE order_id=? ORDER BY id', [order.id]);
  const f = await fulfillmentService.ensureForOrder(order.id);

  assert.equal(f.orderId, order.id);
  assert.equal(f.type, 'INITIAL');
  assert.equal(f.sequence, 1);
  // exactly one fulfillment for the order
  assert.equal(Number((await one('SELECT COUNT(*) n FROM fulfillments WHERE order_id=?', [order.id])).n), 1);
  // item allocation mirrors the immutable OrderItem quantities exactly
  assert.equal(f.items.length, orderItems.length);
  for (const item of orderItems) {
    const allocation = f.items.find((entry) => entry.orderItemId === item.id);
    assert(allocation, `${label}: missing allocation for order item ${item.id}`);
    assert.equal(allocation.quantity, Number(item.quantity));
    assert.equal(allocation.skuId, item.sku_id);
  }
  // financial snapshot is copied from immutable Order truth, never repriced
  assert.equal(f.financial.orderTotalMinor, Number(order.total_minor));
  assert.equal(f.financial.onlinePaidMinor, Number(order.online_paid_minor));
  assert.equal(f.financial.codDueMinor, Number(order.cod_due_minor));
  assert.equal(f.financial.codCollectionMinor, expectedCodCollection);
  // one DRAFT shipment, provider-neutral, never READY_TO_BOOK in the foundation
  assert.equal(f.shipments.length, 1);
  const shipment = f.shipments[0];
  assert.equal(shipment.status, 'DRAFT');
  assert.equal(shipment.providerCode, null);
  assert.equal(shipment.externalShipmentId, null);
  assert.equal(shipment.trackingNumber, null);
  assert.notEqual(shipment.status, 'READY_TO_BOOK');
  assert.equal(shipment.codCollectionMinor, expectedCodCollection);
  // local data gap: no product_shipping_profiles rows -> readiness BLOCKED, no fake package
  assert.equal(f.readinessStatus, 'BLOCKED');
  assert.equal(f.blockReason, 'MISSING_SHIPPING_METADATA');
  assert.equal(shipment.package, null);
  assert.equal(shipment.bookingStatus, 'NOT_READY');
  return f;
}

results.prepaid = (await ensureAndAssert(prepaid, 0, 'PREPAID')) && 'PASS';
results.partialCod = (await ensureAndAssert(partial, Number(partial.cod_due_minor), 'PARTIAL_COD')) && 'PASS';
assert.notEqual(Number(partial.cod_due_minor), Number(partial.total_minor)); // remainder, not full total
results.fullCod = (await ensureAndAssert(fullCod, Number(fullCod.cod_due_minor), 'FULL_COD')) && 'PASS';
results.partialCodCollectionSource = 'orders.cod_due_minor (remainder only)';

// ---- Multi-item exact quantity preservation (§57) ---------------------------
{
  const multi = orders.find((order) => order.id === prepaid.id);
  const items = await query('SELECT sku_id, quantity FROM order_items WHERE order_id=?', [multi.id]);
  const f = await fulfillmentService.ensureForOrder(multi.id); // idempotent re-call
  const allocByItem = new Map();
  for (const alloc of f.items) allocByItem.set(alloc.orderItemId, alloc.quantity);
  const ordered = await query('SELECT id, quantity FROM order_items WHERE order_id=?', [multi.id]);
  for (const row of ordered) assert.equal(allocByItem.get(row.id), Number(row.quantity));
  results.multiItem = 'PASS';
}

// ---- K : inventory isolation ----------------------------------------------
const invAfter = await inventorySignature();
assert.equal(invBefore, invAfter, 'FULFILLMENT_CREATION_INVENTORY_EFFECT must be 0');
results.inventoryEffect = 0;

// ---- Duplicate ensure x10 (§54) ------------------------------------------
{
  for (let i = 0; i < 10; i += 1) await fulfillmentService.ensureForOrder(prepaid.id);
  const fCount = Number((await one('SELECT COUNT(*) n FROM fulfillments WHERE order_id=?', [prepaid.id])).n);
  const iCount = Number((await one(
    'SELECT COUNT(*) n FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?',
    [prepaid.id],
  )).n);
  const sCount = Number((await one(
    'SELECT COUNT(*) n FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?',
    [prepaid.id],
  )).n);
  assert.equal(fCount, 1);
  assert.equal(iCount, (await query('SELECT id FROM order_items WHERE order_id=?', [prepaid.id])).length);
  assert.equal(sCount, 1);
  results.duplicateEnsure = 'PASS (1 fulfillment, no duplicate items/shipments)';
}

// ---- Concurrent ensure (§55) --------------------------------------------
{
  const target = spare.id === prepaid.id ? fullCod : spare;
  await query('DELETE FROM fulfillment_events WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [target.id]);
  await query('DELETE FROM fulfillment_items WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [target.id]);
  await query('DELETE FROM shipments WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [target.id]);
  await query('DELETE FROM fulfillments WHERE order_id=?', [target.id]);

  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, () => fulfillmentService.ensureForOrder(target.id)),
  );
  const failed = outcomes.filter((o) => o.status === 'rejected');
  assert.equal(failed.length, 0, `concurrent ensure had failures: ${failed.map((f) => f.reason?.message).join('; ')}`);
  const ids = new Set(outcomes.map((o) => o.value.id));
  assert.equal(ids.size, 1);
  assert.equal(Number((await one('SELECT COUNT(*) n FROM fulfillments WHERE order_id=?', [target.id])).n), 1);
  assert.equal(Number((await one(
    'SELECT COUNT(*) n FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?',
    [target.id],
  )).n), (await query('SELECT id FROM order_items WHERE order_id=?', [target.id])).length);
  results.concurrentEnsure = 'PASS (single fulfillment, no duplicated allocation, no deadlock)';
}

// ---- Overallocation invariant (§56) — isolated, rolled back --------------
{
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[orderItem]] = await conn.execute(
      'SELECT id, sku_id, quantity FROM order_items WHERE order_id=? LIMIT 1', [fullCod.id],
    );
    const seq = await fulfillmentRepository.nextSequence(conn, fullCod.id);
    const created = await fulfillmentRepository.insertFulfillment(conn, {
      orderId: fullCod.id,
      warehouseId: '00000000-0000-4000-8000-000000000001',
      fulfillmentNumber: `FUL-${fullCod.order_number}-OVERALLOC-${seq}`,
      fulfillmentType: 'SUPPLEMENTARY',
      sequence: seq,
      status: 'PENDING',
      readinessStatus: 'BLOCKED',
      blockReason: 'MISSING_SHIPPING_METADATA',
      shippingAddressSnapshot: {}, shippingMethodSnapshot: {}, financialSnapshot: {},
    });
    await fulfillmentRepository.insertItems(conn, created.id, [
      { orderItemId: orderItem.id, skuId: orderItem.sku_id, quantity: Number(orderItem.quantity) + 1 },
    ]);
    await assert.rejects(
      () => fulfillmentRepository.assertAllocationWithinOrderedQuantity(conn, fullCod.id),
      (error) => error.code === 'FULFILLMENT_ALLOCATION_EXCEEDED',
    );
    await conn.rollback();
  } finally {
    conn.release();
  }
  // existing valid allocations untouched
  const stillOne = Number((await one('SELECT COUNT(*) n FROM fulfillments WHERE order_id=?', [fullCod.id])).n);
  assert.equal(stillOne, 1);
  results.overallocation = 'PASS (transaction rejected, existing allocations intact)';
}

// ---- Cancelled order (§65) — isolated, rolled back ----------------------
{
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute("UPDATE orders SET order_status='CANCELLED' WHERE id=?", [spare.id]);
    await conn.execute('DELETE FROM fulfillments WHERE order_id=?', [spare.id]);
    const svc = new FulfillmentService();
    const f = await svc.ensureForOrder(spare.id, { connection: conn });
    assert.equal(f.status, 'CANCELLED');
    assert.equal(f.readinessStatus, 'BLOCKED');
    assert.equal(f.blockReason, 'ORDER_CANCELLED');
    assert.equal(f.shipments.length, 0, 'cancelled order must not produce a shippable shipment');
    await conn.rollback();
  } finally {
    conn.release();
  }
  results.cancelledOrder = 'PASS (no active shippable fulfillment)';
}

// ---- Shipping metadata: blocked now, ready with legitimate fixture ------
{
  const readyEval = evaluateReadiness({
    orderStatus: 'PLACED',
    shippingAddress: { firstName: 'A', addressLine1: 'X', city: 'Y', state: 'Z', postalCode: '110001', phone: '9999999999', country: 'IN' },
    allocations: [{ skuId: 's', quantity: 1 }],
    packageItems: [{ skuId: 's', quantity: 1, fulfillment: { weightGrams: 500, lengthMm: 100, widthMm: 100, heightMm: 50 } }],
  });
  assert.deepEqual(readyEval, { readinessStatus: 'READY', blockReason: null });
  const blockedEval = evaluateReadiness({
    orderStatus: 'PLACED',
    shippingAddress: { firstName: 'A', addressLine1: 'X', city: 'Y', state: 'Z', postalCode: '110001', phone: '9', country: 'IN' },
    allocations: [{ skuId: 's', quantity: 1 }],
    packageItems: [{ skuId: 's', quantity: 1, fulfillment: null }],
  });
  assert.equal(blockedEval.blockReason, 'MISSING_SHIPPING_METADATA');
  const noAddr = evaluateReadiness({ orderStatus: 'PLACED', shippingAddress: null, allocations: [{ skuId: 's', quantity: 1 }], packageItems: [] });
  assert.equal(noAddr.blockReason, 'MISSING_SHIPPING_ADDRESS');
  results.shippingMetadata = 'PASS (BLOCKED without real metadata, READY only with legitimate fixture, never fabricated)';
  results.missingMetadataBlocks = 'with product_shipping_profiles emptied by this script, every order fulfillment is readiness=BLOCKED/MISSING_SHIPPING_METADATA and carries no fabricated package';
}

// ---- Address immutability (§60) --------------------------------------------
{
  const f = await fulfillmentService.ensureForOrder(prepaid.id);
  const snapBefore = JSON.stringify(f.shippingAddress);
  const addrs = await query('SELECT id, city FROM addresses WHERE customer_id=?', [prepaid.customer_id]);
  if (addrs.length) {
    await query("UPDATE addresses SET city='MUTATED_AFTER_SNAPSHOT' WHERE customer_id=?", [prepaid.customer_id]);
    const after = await fulfillmentService.ensureForOrder(prepaid.id);
    assert.equal(JSON.stringify(after.shippingAddress), snapBefore);
    for (const row of addrs) await query('UPDATE addresses SET city=? WHERE id=?', [row.city, row.id]);
  }
  results.addressImmutability = `PASS (snapshot frozen; ${addrs.length} live address row(s) mutated + restored)`;
}

// ---- Price immutability (§61) --------------------------------------------
{
  const f = await fulfillmentService.ensureForOrder(prepaid.id);
  const financialBefore = JSON.stringify(f.financial);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.execute('UPDATE skus SET price_minor = price_minor + 100000 WHERE id IN (SELECT sku_id FROM order_items WHERE order_id=?)', [prepaid.id]);
    const reread = await new FulfillmentService().ensureForOrder(prepaid.id, { connection: conn });
    assert.equal(JSON.stringify(reread.financial), financialBefore);
    await conn.rollback();
  } finally { conn.release(); }
  results.priceImmutability = 'PASS (financial/COD snapshot unchanged after live catalog price change)';
}

// ---- Post-commit recovery (§63) -----------------------------------------
{
  const orderSigBefore = await orderSignature(prepaid.id);
  const invSig = await inventorySignature();
  await query('DELETE FROM fulfillments WHERE order_id=?', [prepaid.id]); // simulate bootstrap failure
  assert.equal(Number((await one('SELECT COUNT(*) n FROM fulfillments WHERE order_id=?', [prepaid.id])).n), 0);
  const recovered = await bootstrapFulfillmentForOrder(prepaid.id);
  assert.equal(recovered.ok, true);
  assert.equal(Number((await one('SELECT COUNT(*) n FROM fulfillments WHERE order_id=?', [prepaid.id])).n), 1);
  assert.equal(await orderSignature(prepaid.id), orderSigBefore, 'recovery must not mutate the Order');
  assert.equal(await inventorySignature(), invSig, 'recovery must not mutate inventory');
  results.postCommitRecovery = 'PASS (one recovered fulfillment, no Order/inventory mutation)';
}

// ---- Backfill idempotency (§62) ----------------------------------------
{
  // leave one order without a fulfillment
  await query('DELETE FROM fulfillment_events WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [fullCod.id]);
  await query('DELETE FROM fulfillment_items WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [fullCod.id]);
  await query('DELETE FROM shipments WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [fullCod.id]);
  await query('DELETE FROM fulfillments WHERE order_id=?', [fullCod.id]);

  const first = await backfillFulfillments();
  const second = await backfillFulfillments();
  assert(first.created >= 1);
  assert.equal(second.created, 0, 'second backfill pass must create nothing');
  assert.equal(second.eligible, 0);
  // Only the INITIAL fulfilment is unique per order. A same-style exchange or a
  // replacement legitimately adds a SUPPLEMENTARY one to the SAME order (this
  // file asserts exactly that a few hundred lines below), so counting every
  // fulfilment made any order that had ever been exchanged look duplicated.
  const dupFulfillments = await query(
    "SELECT order_id, COUNT(*) n FROM fulfillments WHERE fulfillment_type = 'INITIAL' GROUP BY order_id HAVING n > 1");
  assert.equal(dupFulfillments.length, 0, 'an order may have at most one INITIAL fulfilment');
  results.backfill = { eligibleFirst: first.eligible, created: first.created, reused: first.reused, blocked: first.blocked, errors: first.errors, secondRunCreated: second.created };
}

// ---- Customer authorization (§64) -------------------------------------
{
  const owned = await orderFinalizationService.getOwnedFulfillment(prepaid.customer_id, prepaid.id);
  assert.equal(owned.orderId, prepaid.id);
  assert(owned.fulfillments.length >= 1);
  await assert.rejects(
    () => orderFinalizationService.getOwnedFulfillment('00000000-0000-0000-0000-000000000000', prepaid.id),
    (error) => error.code === 'ORDER_NOT_FOUND',
  );
  // a different real customer (if any) also cannot see it
  const otherCustomer = orders.find((order) => order.customer_id !== prepaid.customer_id);
  if (otherCustomer) {
    await assert.rejects(
      () => orderFinalizationService.getOwnedFulfillment(otherCustomer.customer_id, prepaid.id),
      (error) => error.code === 'ORDER_NOT_FOUND',
    );
  }
  results.customerAuthorization = 'PASS (cross-customer fulfillment/shipment read denied)';
}

// ---- State transition authority (§41) --------------------------------
{
  assertTransition('PENDING', 'READY');
  assertTransition('READY', 'PROCESSING');
  assert.equal(canTransition('FULFILLED', 'PENDING'), false);
  await assert.rejects(async () => assertTransition('PENDING', 'DELIVERED'), (e) => e.code === 'FULFILLMENT_TRANSITION_INVALID');
  results.stateTransitions = 'PASS (centralized transition graph enforced)';
}

// ---- Provider / AWB proof ------------------------------------------------
assert.equal(providerCalls, 0, 'no outbound HTTP is permitted in the fulfillment foundation');
results.realProviderBookingCalls = providerCalls;
results.awbGeneration = 'DISABLED';
results.realDelhivery = 'NOT_VERIFIED';

// ======================================================================
// READINESS RE-EVALUATION + RECOVERY HARDENING
// ======================================================================

const delFulfillmentGraph = async (orderId) => {
  await query('DELETE FROM fulfillment_events WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [orderId]);
  await query('DELETE FROM fulfillment_items WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [orderId]);
  await query('DELETE FROM shipments WHERE fulfillment_id IN (SELECT id FROM fulfillments WHERE order_id=?)', [orderId]);
  await query('DELETE FROM fulfillments WHERE order_id=?', [orderId]);
};
const countF = async (orderId) => Number((await one('SELECT COUNT(*) n FROM fulfillments WHERE order_id=?', [orderId])).n);
const countS = async (orderId) => Number((await one('SELECT COUNT(*) n FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId])).n);
const countI = async (orderId) => Number((await one('SELECT COUNT(*) n FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId])).n);
const orderItemCount = async (orderId) => (await query('SELECT id FROM order_items WHERE order_id=?', [orderId])).length;

// ---- Recovery worker: missing fulfillment (§16) ------------------------
{
  const invSig = await inventorySignature();
  const provBefore = providerCalls;
  await delFulfillmentGraph(fullCod.id);
  assert.equal(await countF(fullCod.id), 0);
  const summary = await recoverMissingFulfillmentsBatch();
  assert(summary.created >= 1, 'recovery must create the missing fulfillment');
  assert.equal(await countF(fullCod.id), 1);
  assert.equal(await countS(fullCod.id), 1);
  assert.equal(await countI(fullCod.id), await orderItemCount(fullCod.id));
  assert.equal(await inventorySignature(), invSig, 'FULFILLMENT_RECOVERY_INVENTORY_EFFECT must be 0');
  assert.equal(providerCalls, provBefore, 'recovery must make no provider calls');
  results.recoveryMissing = 'PASS';
}

// ---- Recovery worker: second run is a no-op (§17, §55) ----------------
{
  const second = await recoverMissingFulfillmentsBatch();
  assert.equal(second.created, 0);
  assert.equal(second.scanned, 0);
  results.recoverySecondRun = 'PASS (0 new fulfillments / shipments / allocations)';
}

// ---- Recovery worker: concurrent cycles (§18, §72) -------------------
{
  await delFulfillmentGraph(fullCod.id);
  const cycles = await Promise.allSettled(Array.from({ length: 5 }, () => recoverMissingFulfillmentsBatch()));
  assert.equal(cycles.filter((c) => c.status === 'rejected').length, 0);
  assert.equal(await countF(fullCod.id), 1);
  assert.equal(await countS(fullCod.id), 1);
  assert.equal(await countI(fullCod.id), await orderItemCount(fullCod.id));
  results.recoveryConcurrent = 'PASS (one initial fulfillment, one shipment, no duplicated allocation)';
}

// ---- Recovery worker: failure isolation (§19) -----------------------
{
  await delFulfillmentGraph(fullCod.id);
  await delFulfillmentGraph(partial.id);
  const flakyService = {
    ensureForOrder: async (orderId) => {
      if (orderId === fullCod.id) { const e = new Error('injected'); e.code = 'INJECTED_FAILURE'; throw e; }
      return fulfillmentService.ensureForOrder(orderId);
    },
  };
  const summary = await recoverMissingFulfillmentsBatch({ service: flakyService });
  assert.equal(summary.errors, 1);
  assert(summary.details.some((d) => d.orderId === fullCod.id && d.error === 'INJECTED_FAILURE' && d.at));
  assert.equal(await countF(partial.id), 1, 'a healthy order in the same batch still recovers');
  assert.equal(await countF(fullCod.id), 0, 'the failing order did not partially write');
  await recoverMissingFulfillmentsBatch(); // heal fullCod for real
  assert.equal(await countF(fullCod.id), 1);
  results.recoveryFailureIsolation = 'PASS';
}
results.fulfillmentAutoRecovery = 'PASS';

// ---- Cancelled preserves history (§27, §74) ------------------------
{
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const svc = new FulfillmentService({ transaction: (fn) => fn(conn) });
    const [[f0]] = await conn.execute("SELECT * FROM fulfillments WHERE order_id=? AND fulfillment_type='INITIAL'", [prepaid.id]);
    const itemsBefore = Number((await conn.execute('SELECT COUNT(*) n FROM fulfillment_items WHERE fulfillment_id=?', [f0.id]))[0][0].n);
    const shipBefore = Number((await conn.execute('SELECT COUNT(*) n FROM shipments WHERE fulfillment_id=?', [f0.id]))[0][0].n);
    await svc.transitionStatus(f0.id, 'CANCELLED', { detail: { reason: 'verify' } });
    const [[fAfter]] = await conn.execute('SELECT * FROM fulfillments WHERE id=?', [f0.id]);
    assert.equal(fAfter.status, 'CANCELLED');
    assert(fAfter.cancelled_at);
    assert.equal(Number((await conn.execute('SELECT COUNT(*) n FROM fulfillments WHERE id=?', [f0.id]))[0][0].n), 1, 'fulfillment row preserved');
    assert.equal(Number((await conn.execute('SELECT COUNT(*) n FROM fulfillment_items WHERE fulfillment_id=?', [f0.id]))[0][0].n), itemsBefore, 'items preserved');
    const [[ship]] = await conn.execute('SELECT COUNT(*) n, MAX(status) s FROM shipments WHERE fulfillment_id=?', [f0.id]);
    assert.equal(Number(ship.n), shipBefore, 'shipment row preserved');
    assert.equal(ship.s, 'CANCELLED', 'draft shipment cancelled, not deleted');
    assert(Number((await conn.execute("SELECT COUNT(*) n FROM fulfillment_events WHERE fulfillment_id=? AND event_type='STATUS_TRANSITION'", [f0.id]))[0][0].n) >= 1, 'event recorded');
    await conn.rollback();
  } finally { conn.release(); }
  results.cancelledHistory = 'PASS (fulfillment / items / shipment / events all preserved on CANCELLED)';
}

// ---- No runtime hard-delete surface (§21, §26) --------------------
{
  assert.equal(typeof fulfillmentRepository.delete, 'undefined');
  assert.equal(typeof fulfillmentRepository.destroy, 'undefined');
  assert.equal(typeof fulfillmentRepository.remove, 'undefined');
  assert.equal(typeof fulfillmentRepository.hardDelete, 'undefined');
  assert.equal(typeof fulfillmentService.delete, 'undefined');
  assert.equal(typeof fulfillmentService.destroy, 'undefined');
  results.hardDeleteFulfillment = 'DISALLOWED';
}

// ---- Readiness re-evaluation BLOCKED -> READY (§43, §75) ----------
{
  const orderSig = await orderSignature(partial.id);
  const invSig = await inventorySignature();
  const provBefore = providerCalls;
  const productIds = [...new Set((await query(
    'SELECT DISTINCT p.id FROM order_items oi JOIN skus s ON s.id=oi.sku_id JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE oi.order_id=?',
    [partial.id],
  )).map((r) => r.id))];
  try {
    for (const pid of productIds) {
      await query(
        `INSERT INTO product_shipping_profiles (id,product_id,weight_grams,length_mm,width_mm,height_mm)
         VALUES (?,?,?,?,?,?) ON DUPLICATE KEY UPDATE weight_grams=VALUES(weight_grams)`,
        [randomUUID(), pid, 400, 250, 200, 40],
      );
    }
    const first = await fulfillmentService.reevaluateReadiness(partial.id);
    assert.equal(first.changed, true);
    assert.equal(first.readinessStatus, 'READY');
    assert.equal(first.blockReason, null);
    assert.equal(first.shipments[0].status, 'DRAFT');
    assert.equal(first.shipments[0].bookingStatus, 'READY');
    assert(first.shipments[0].package && first.shipments[0].package.totalWeightGrams > 0);
    assert.notEqual(first.shipments[0].status, 'READY_TO_BOOK');
    const second = await fulfillmentService.reevaluateReadiness(partial.id);
    assert.equal(second.changed, false, 'idempotent: unchanged readiness writes nothing');
    const evs = Number((await one("SELECT COUNT(*) n FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=? AND fe.event_type='READINESS_REEVALUATED'", [partial.id])).n);
    assert.equal(evs, 1, 'only the meaningful transition emitted an event');
  } finally {
    for (const pid of productIds) await query('DELETE FROM product_shipping_profiles WHERE product_id=?', [pid]);
  }
  const back = await fulfillmentService.reevaluateReadiness(partial.id);
  assert.equal(back.readinessStatus, 'BLOCKED');
  assert.equal(back.blockReason, 'MISSING_SHIPPING_METADATA');
  assert.equal(await orderSignature(partial.id), orderSig, 're-evaluation must not mutate the Order');
  assert.equal(await inventorySignature(), invSig, 're-evaluation must not mutate inventory');
  assert.equal(providerCalls, provBefore, 're-evaluation must make no provider calls');
  results.readinessReevaluation = 'PASS (BLOCKED -> READY -> BLOCKED, idempotent, no Order/inventory/provider effect)';
}

// ---- Provider tripwire: writes rejected by DB (§38, §77) ---------
{
  const fid = (await one("SELECT id FROM fulfillments WHERE order_id=? AND fulfillment_type='INITIAL'", [prepaid.id])).id;
  const tryInsert = (cols, vals) => query(
    `INSERT INTO shipments (id, brand_id,fulfillment_id,shipment_number,sequence,status,booking_status,cod_collection_minor${cols}) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?,?${vals})`,
    [randomUUID(), fid, `SHP-TRIPWIRE-${randomUUID().slice(0, 8)}`, 90, 'DRAFT', 'NOT_READY', 0],
  );
  await assert.rejects(() => tryInsert(',provider_code', ",'DELHIVERY'"), (e) => /CONSTRAINT|CHECK|3819/i.test(`${e.code} ${e.message}`));
  await assert.rejects(() => tryInsert(',tracking_number', ",'AWB123'"), (e) => /CONSTRAINT|CHECK|3819/i.test(`${e.code} ${e.message}`));
  results.providerTripwire = 'PASS (provider_code and tracking_number writes DB-rejected)';
  results.providerFieldsWriteGuard = 'PASS';
}

// ---- Readiness consistency check rejected by DB (§37, §76) ------
{
  const bad = (readiness, reason) => query(
    `INSERT INTO fulfillments (id, brand_id,order_id,warehouse_id,fulfillment_number,fulfillment_type,sequence,status,readiness_status,block_reason,
       shipping_address_snapshot_json,shipping_method_snapshot_json,financial_snapshot_json)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), prepaid.id, '00000000-0000-4000-8000-000000000001', `FUL-BADCHK-${randomUUID().slice(0, 8)}`, 'SUPPLEMENTARY', 900 + Math.floor(Math.random() * 90),
      'PENDING', readiness, reason, '{}', '{}', '{}'],
  );
  await assert.rejects(() => bad('READY', 'ORDER_CANCELLED'), (e) => /CONSTRAINT|CHECK|3819/i.test(`${e.code} ${e.message}`));
  await assert.rejects(() => bad('BLOCKED', null), (e) => /CONSTRAINT|CHECK|3819/i.test(`${e.code} ${e.message}`));
  results.readinessConsistency = 'PASS (READY+reason and BLOCKED+NULL both DB-rejected)';
}

// ---- Initial guard: one INITIAL, many SUPPLEMENTARY (§35, §36) --
{
  await assert.rejects(
    () => query(
      `INSERT INTO fulfillments (id, brand_id,order_id,warehouse_id,fulfillment_number,fulfillment_type,sequence,status,readiness_status,block_reason,
         shipping_address_snapshot_json,shipping_method_snapshot_json,financial_snapshot_json)
       VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?,?,?,?,?,?,?)`,
      [randomUUID(), prepaid.id, '00000000-0000-4000-8000-000000000001', `FUL-DUPINIT-${randomUUID().slice(0, 8)}`, 'INITIAL', 800, 'PENDING', 'BLOCKED', 'MISSING_SHIPPING_METADATA', '{}', '{}', '{}'],
    ),
    (e) => e.code === 'ER_DUP_ENTRY',
  );
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const seq of [810, 811]) {
      await conn.execute(
        `INSERT INTO fulfillments (id, brand_id,order_id,warehouse_id,fulfillment_number,fulfillment_type,sequence,status,readiness_status,block_reason,
           shipping_address_snapshot_json,shipping_method_snapshot_json,financial_snapshot_json)
         VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?,?,?,?,?,?,?)`,
        [randomUUID(), prepaid.id, '00000000-0000-4000-8000-000000000001', `FUL-SUP-${seq}-${randomUUID().slice(0, 6)}`, 'SUPPLEMENTARY', seq, 'PENDING', 'BLOCKED', 'MISSING_SHIPPING_METADATA', '{}', '{}', '{}'],
      );
    }
    const n = Number((await conn.execute("SELECT COUNT(*) n FROM fulfillments WHERE order_id=? AND fulfillment_type='SUPPLEMENTARY'", [prepaid.id]))[0][0].n);
    assert.equal(n, 2, 'schema permits multiple future SUPPLEMENTARY fulfillments');
    await conn.rollback();
  } finally { conn.release(); }
  results.initialGuard = 'PASS (2nd INITIAL rejected; INITIAL + 2 SUPPLEMENTARY permitted)';
}

// ---- Post-worker backfill re-run (§55) ---------------------------
{
  const run = await backfillFulfillments();
  assert.equal(run.eligible, 0);
  assert.equal(run.created, 0);
  const dup = await query("SELECT order_id FROM fulfillments WHERE fulfillment_type='INITIAL' GROUP BY order_id HAVING COUNT(*)>1");
  assert.equal(dup.length, 0);
  results.backfillPostWorker = 'PASS (eligible 0, created 0, no duplicates)';
}

results.fulfillmentRecoveryInventoryEffect = 0;

// ---- schema assertions -------------------------------------------------
const idx = await query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='fulfillments' AND NON_UNIQUE=0");
assert(idx.some((r) => r.INDEX_NAME === 'uk_fulfillments_initial_order_warehouse'));
assert(idx.some((r) => r.INDEX_NAME === 'uk_fulfillments_order_sequence'));
const chk = await query("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='shipments' AND CONSTRAINT_TYPE='CHECK'");
assert(chk.some((r) => r.CONSTRAINT_NAME === 'chk_shipment_unbooked_clean'));
assert(chk.some((r) => r.CONSTRAINT_NAME === 'chk_shipment_booked_complete'));
assert(!chk.some((r) => r.CONSTRAINT_NAME === 'chk_shipment_wave7a_no_provider'), 'legacy provider guard must be replaced');
results.schemaGuards = 'PASS (initial-fulfillment uniqueness + state-aware shipment provider CHECKs present)';

await restoreShippingProfiles();
const restored = await query('SELECT COUNT(*) n FROM product_shipping_profiles');
assert.equal(Number(restored[0].n), profileSnapshot.length,
  'seeded shipping metadata must be left exactly as it was found');
results.shippingMetadataRestored = `${profileSnapshot.length} product_shipping_profiles rows restored`;

console.log(JSON.stringify(results, null, 2));
await pool.end();
