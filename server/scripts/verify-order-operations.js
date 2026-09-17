// Order operations + mocked shipment lifecycle verification.
//
// Order confirmation boundary, ADMIN start-processing, provider-neutral mock
// booking with idempotency + ambiguous-outcome handling, and the normalised
// tracking state machine (dedupe / stale / invalid). No real carrier is
// contacted — REAL_PROVIDER_CALLS must be 0.
//
//   npm run verify:order-operations
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { warehouseService } = await import('../src/modules/warehouses/service.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { shippingService } = await import('../src/modules/shipping/service.js');
const { orderConfirmationService, shipmentBookingService, shipmentEventService } = await import('../src/modules/orderOps/service.js');

let providerBookCalls = 0;
const realBook = shippingService.bookShipment.bind(shippingService);
shippingService.bookShipment = (req) => { providerBookCalls += 1; return realBook(req); };
const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [], warehouses: [] };

async function makeSku() {
  return (await query(
    `SELECT s.id, s.sku, s.price_minor, v.id variant_id, p.id product_id, p.name
       FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 1`,
  ))[0];
}

async function buildOrder({ warehouseIds, sku, qty = 1, postalCode = '226001', paymentMode = 'FULL_COD' }) {
  const customerId = randomUUID();
  created.customers.push(customerId);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),'OrderOps','T','ACTIVE',NOW(3))", [customerId]);
  const cartId = randomUUID();
  await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']);
  const reservationId = randomUUID();
  await query(
    `INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`,
    [reservationId, customerId, `oo:${randomUUID()}`, '0'.repeat(64)],
  );
  for (const whId of warehouseIds) {
    await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
      [randomUUID(), reservationId, whId, sku.id, qty]);
  }
  const checkoutId = randomUUID();
  const subtotal = Number(sku.price_minor || 50000) * qty * warehouseIds.length;
  const codDue = paymentMode === 'PREPAID' ? 0 : subtotal;
  await query(
    `INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `oo:co:${randomUUID()}`, 'f'.repeat(64), subtotal, subtotal],
  );
  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'OrderOps', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode, country: 'IN' };
  await query(
    `INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?,?, 'INR', ?,0,?,?,?,?,?, 'ORDER_OPS_TEST')`,
    [orderId, `COR-OO-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
      codDue > 0 ? 'COD_DUE' : 'PAID', paymentMode, subtotal, subtotal, subtotal - codDue, codDue,
      JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })],
  );
  for (const whId of warehouseIds) void whId;
  await query(
    `INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), orderId, sku.product_id, sku.variant_id, sku.id, sku.name, sku.sku, qty * warehouseIds.length, Number(sku.price_minor || 50000), subtotal],
  );
  await fulfillmentService.ensureForOrder(orderId);
  // Bypass the readiness gate — this script tests booking / tracking, not metadata.
  await query(
    `UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id
        SET s.status='READY_TO_BOOK', s.booking_status='READY',
            s.package_snapshot_json=JSON_OBJECT('weightGrams',500,'lengthMm',200,'breadthMm',150,'heightMm',80)
      WHERE f.order_id=?`, [orderId],
  );
  return { orderId, customerId };
}

const shipmentsOf = (orderId) => query(
  `SELECT s.* FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=? ORDER BY s.shipment_number`, [orderId]);

try {
  const sku = await makeSku();
  const def = await warehouseService.getDefault();
  const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const lko = await warehouseService.create({ code: `WH-OO-${tag}`, name: 'OrderOps LKO', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN', priority: 5, brandId: cottonBrand.id });
  created.warehouses.push(lko.id);

  // ================= 1. Confirmation boundary =================
  const split = await buildOrder({ warehouseIds: [def.id, lko.id], sku, qty: 1 });
  const fp = await orderConfirmationService.currentFingerprint(split.orderId);
  assert.equal(fp.length, 64);

  await assert.rejects(
    () => orderConfirmationService.confirm({ orderId: split.orderId, expectedAllocationFingerprint: 'a'.repeat(64) }),
    (e) => e.code === 'ALLOCATION_CHANGED',
  );
  const confirmed = await orderConfirmationService.confirm({ orderId: split.orderId, expectedAllocationFingerprint: fp, staffUserId: null });
  assert.equal(confirmed.status, 'CONFIRMED');
  // idempotent
  const again = await orderConfirmationService.confirm({ orderId: split.orderId, expectedAllocationFingerprint: fp });
  assert.equal(again.status, 'CONFIRMED');
  results.orderConfirmation = 'PASS (stale rejected, confirm idempotent)';

  // ================= 2. Processing transition =================
  const early = await buildOrder({ warehouseIds: [def.id], sku, qty: 1 });
  const earlyShip = (await shipmentsOf(early.orderId))[0];
  await assert.rejects(() => shipmentBookingService.book({ shipmentId: earlyShip.id, idempotencyKey: 'early-key-1' }), (e) => e.code === 'ORDER_NOT_PROCESSING');
  await assert.rejects(() => orderConfirmationService.startProcessing({ orderId: early.orderId }), (e) => e.code === 'ORDER_NOT_PROCESSABLE');
  const proc = await orderConfirmationService.startProcessing({ orderId: split.orderId });
  assert.equal(proc.status, 'PROCESSING');
  results.startProcessing = 'PASS (blocked before confirm, then CONFIRMED -> PROCESSING)';

  // ================= 3. Mock booking + AWB + idempotency =================
  const [shpA, shpB] = await shipmentsOf(split.orderId);
  const b1 = await shipmentBookingService.book({ shipmentId: shpA.id, idempotencyKey: `book:${shpA.id}:v1` });
  assert.equal(b1.shipment.status, 'BOOKED');
  assert.equal(b1.shipment.bookingStatus, 'BOOKED');
  assert.ok(/^MOCKAWB/.test(b1.shipment.awbNumber), `AWB assigned: ${b1.shipment.awbNumber}`);
  assert.equal(b1.realProviderCallPerformed, false);
  const callsAfterFirst = providerBookCalls;
  const b1replay = await shipmentBookingService.book({ shipmentId: shpA.id, idempotencyKey: `book:${shpA.id}:v1` });
  assert.equal(b1replay.shipment.awbNumber, b1.shipment.awbNumber, 'same idempotency key -> same AWB');
  assert.equal(providerBookCalls, callsAfterFirst, 'replay performs no second provider call');

  const b2 = await shipmentBookingService.book({ shipmentId: shpB.id, idempotencyKey: `book:${shpB.id}:v1` });
  assert.notEqual(b2.shipment.awbNumber, b1.shipment.awbNumber, 'split order -> independent AWBs');
  const codSum = (await shipmentsOf(split.orderId)).reduce((s, r) => s + Number(r.cod_collection_minor), 0);
  const orderCod = Number((await query('SELECT cod_due_minor FROM orders WHERE id=?', [split.orderId]))[0].cod_due_minor);
  assert.equal(codSum, orderCod, 'SUM(shipment COD) == order COD due');
  results.mockBooking = 'PASS (AWB persisted, idempotent replay, split AWBs distinct, COD sum exact)';

  // ================= 4. Ambiguous outcome + key reuse =================
  const amb = await buildOrder({ warehouseIds: [def.id], sku, qty: 1 });
  await orderConfirmationService.confirm({ orderId: amb.orderId });
  await orderConfirmationService.startProcessing({ orderId: amb.orderId });
  const ambShip = (await shipmentsOf(amb.orderId))[0];
  await assert.rejects(
    () => shipmentBookingService.book({ shipmentId: ambShip.id, idempotencyKey: 'ambiguous-key-1', simulate: 'AMBIGUOUS' }),
    (e) => e.code === 'BOOKING_RECONCILIATION_REQUIRED',
  );
  assert.equal((await query('SELECT booking_status FROM shipments WHERE id=?', [ambShip.id]))[0].booking_status, 'UNKNOWN');
  assert.equal((await query("SELECT status FROM shipment_booking_attempts WHERE idempotency_key='ambiguous-key-1'"))[0].status, 'UNKNOWN');
  const callsBeforeRetry = providerBookCalls;
  await assert.rejects(
    () => shipmentBookingService.book({ shipmentId: ambShip.id, idempotencyKey: 'ambiguous-key-1', simulate: 'AMBIGUOUS' }),
    (e) => e.code === 'BOOKING_RECONCILIATION_REQUIRED',
  );
  assert.equal(providerBookCalls, callsBeforeRetry, 'no blind retry of an ambiguous booking');
  await assert.rejects(
    () => shipmentBookingService.book({ shipmentId: ambShip.id, idempotencyKey: 'ambiguous-key-1' }),
    (e) => e.code === 'IDEMPOTENCY_KEY_REUSED',
  );
  results.ambiguousOutcome = 'PASS (UNKNOWN persisted, no blind retry, key-reuse rejected)';

  // ================= 5. Provider failure -> safe FAILED attempt =================
  const failOrder = await buildOrder({ warehouseIds: [def.id], sku, qty: 1, postalCode: '999999' });
  await orderConfirmationService.confirm({ orderId: failOrder.orderId });
  await orderConfirmationService.startProcessing({ orderId: failOrder.orderId });
  const failShip = (await shipmentsOf(failOrder.orderId))[0];
  await assert.rejects(
    () => shipmentBookingService.book({ shipmentId: failShip.id, idempotencyKey: 'fail-key-1' }),
    (e) => e.code === 'SHIPPING_PROVIDER_ERROR',
  );
  assert.equal((await query('SELECT booking_status FROM shipments WHERE id=?', [failShip.id]))[0].booking_status, 'FAILED');
  assert.equal((await query("SELECT status FROM shipment_booking_attempts WHERE idempotency_key='fail-key-1'"))[0].status, 'FAILED');
  results.bookingFailure = 'PASS (provider error -> FAILED attempt, no partial state)';

  // ================= 6. Tracking state machine =================
  const ev = (over) => ({ shipmentId: shpA.id, providerCode: 'MOCK', ...over });
  const t = (min) => new Date(Date.now() + min * 60000);
  assert.equal((await shipmentEventService.ingest(ev({ providerEventKey: 'e-pick', normalizedStatus: 'PICKED_UP', occurredAt: t(1) }))).applied, true);
  assert.equal((await shipmentEventService.ingest(ev({ providerEventKey: 'e-tr', normalizedStatus: 'IN_TRANSIT', occurredAt: t(2) }))).applied, true);
  assert.equal((await shipmentEventService.ingest(ev({ providerEventKey: 'e-tr', normalizedStatus: 'IN_TRANSIT', occurredAt: t(2) }))).deduped, true);
  assert.equal((await shipmentEventService.ingest(ev({ providerEventKey: 'e-ofd', normalizedStatus: 'OUT_FOR_DELIVERY', occurredAt: t(3) }))).applied, true);
  const stale = await shipmentEventService.ingest(ev({ providerEventKey: 'e-late', normalizedStatus: 'IN_TRANSIT', occurredAt: t(2.5) }));
  assert.equal(stale.applied, false, 'a late in-transit scan does not regress OUT_FOR_DELIVERY');
  assert.equal((await query('SELECT status FROM shipments WHERE id=?', [shpA.id]))[0].status, 'OUT_FOR_DELIVERY');
  assert.equal((await shipmentEventService.ingest(ev({ providerEventKey: 'e-del', normalizedStatus: 'DELIVERED', occurredAt: t(4) }))).applied, true);
  // shpB is BOOKED — a direct DELIVERED event is a protocol violation.
  await assert.rejects(
    () => shipmentEventService.ingest({ shipmentId: shpB.id, providerCode: 'MOCK', providerEventKey: 'e-bad', normalizedStatus: 'DELIVERED', occurredAt: t(1) }),
    (e) => e.code === 'INVALID_SHIPMENT_TRANSITION',
  );
  results.tracking = 'PASS (dedupe, stale no-regress, invalid rejected, DELIVERED reached)';

  // ================= 7. Customer projection =================
  const summary = await fulfillmentService.summaryForOrder(split.orderId);
  assert.equal(summary.shipments.length, 2, 'one package per fulfillment');
  const pkgA = summary.shipments.find((s) => s.awbNumber === b1.shipment.awbNumber);
  assert.ok(pkgA.timeline.length >= 4 && pkgA.status === 'DELIVERED', 'package A timeline + delivered');
  const pkgB = summary.shipments.find((s) => s.awbNumber === b2.shipment.awbNumber);
  assert.equal(pkgB.status, 'BOOKED', 'package B independent — still just booked');
  results.customerProjection = 'PASS (per-package timeline, independent states)';

  assert.equal(networkCalls, 0, 'no outbound network calls');
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nORDER_OPERATIONS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nORDER_OPERATIONS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  shippingService.bookShipment = realBook;
  for (const orderId of created.orders) {
    await safe(() => query('DELETE FROM print_jobs WHERE document_id IN (SELECT id FROM documents WHERE order_id=?)', [orderId]));
    await safe(() => query('DELETE ii FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM credit_notes WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM invoices WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM documents WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE se FROM shipment_events se JOIN shipments s ON s.id=se.shipment_id JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE ba FROM shipment_booking_attempts ba JOIN shipments s ON s.id=ba.shipment_id JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM order_items WHERE order_id=?', [orderId]));
    const chk = (await query('SELECT checkout_id, inventory_reservation_id FROM orders WHERE id=?', [orderId]))[0];
    await safe(() => query('DELETE FROM orders WHERE id=?', [orderId]));
    if (chk) {
      await safe(() => query('DELETE FROM checkout_sessions WHERE id=?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [chk.inventory_reservation_id]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [chk.inventory_reservation_id]));
    }
  }
  for (const cid of created.customers) {
    await safe(() => query('DELETE ri FROM inventory_reservation_items ri JOIN inventory_reservations r ON r.id=ri.reservation_id WHERE r.customer_id=?', [cid]));
    await safe(() => query('DELETE FROM checkout_sessions WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM inventory_reservations WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  for (const wid of created.warehouses) {
    await safe(() => query('DELETE FROM inventory WHERE warehouse_id=?', [wid]));
    await safe(() => query('DELETE FROM warehouses WHERE id=? AND is_default=0', [wid]));
  }
  await pool.end();
}
