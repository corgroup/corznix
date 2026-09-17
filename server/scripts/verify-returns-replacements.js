// Wave 8F-2 — normal return + replacement verification.
//
// Named lifecycle transitions (no PATCH status); reverse pickup (MOCK AWB,
// idempotent); receive != restock; QC PASS restocks exactly once
// (RETURN_RESTOCKED); QC FAIL restocks nothing and parks for manual review;
// replacement reuses the warehouse allocator + reservations + fulfillment;
// REPLACEMENT_OVERSOLD = 0. No provider / network calls.
//
//   npm run verify:returns-replacements
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { inventoryService } = await import('../src/modules/inventory/service.js');
const { returnRequestService } = await import('../src/modules/returns/returnRequestService.js');
const { returnLifecycleService } = await import('../src/modules/returns/returnLifecycleService.js');
const { replacementService } = await import('../src/modules/returns/replacementService.js');
const { reverseShipmentService } = await import('../src/modules/returns/reverseShipmentService.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [] };
// Inventory rows this gate changes, as they were before it ran. adjustOnHand is
// an ABSOLUTE set and QC PASS restocks, so without this every run rewrote real
// stock numbers on the first ACTIVE SKUs and never put them back.
let inventorySnapshot = null;

async function skus(n) {
  return query(
    `SELECT s.id, s.sku, s.price_minor, v.id variant_id, p.id product_id, p.name
       FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE' ORDER BY s.id LIMIT ${Number(n)}`);
}
async function customer(name) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'T','ACTIVE',NOW(3))", [id, name]);
  return id;
}
const onHand = async (whId, skuId) => {
  const r = (await query('SELECT on_hand, reserved FROM inventory WHERE warehouse_id=? AND sku_id=?', [whId, skuId]))[0];
  return r ? { onHand: Number(r.on_hand), reserved: Number(r.reserved) } : { onHand: 0, reserved: 0 };
};

async function deliveredOrder({ customerId, sku, qty = 1 }) {
  let cartId = (await query('SELECT id FROM carts WHERE customer_id=? LIMIT 1', [customerId]))[0]?.id;
  if (!cartId) { cartId = randomUUID(); await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']); }
  const reservationId = randomUUID();
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`, [reservationId, customerId, `rr:${randomUUID()}`, '0'.repeat(64)]);
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
    [randomUUID(), reservationId, def.id, sku.id, qty]);
  const unit = Number(sku.price_minor || 50000);
  const subtotal = unit * qty;
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `rr:co:${randomUUID()}`, 'f'.repeat(64), subtotal, subtotal]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'RR', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN' };
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,?,?, 'RR_TEST')`,
    [orderId, `COR-RR-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
      subtotal, subtotal, subtotal, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })]);
  const orderItemId = randomUUID();
  await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [orderItemId, orderId, sku.product_id, sku.variant_id, sku.id, sku.name, sku.sku, qty, unit, subtotal]);
  await fulfillmentService.ensureForOrder(orderId);
  const deliveredAt = new Date(Date.now() - 86400000);
  await query(`UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id
      SET s.status='DELIVERED', s.delivered_at=?, s.booking_status='BOOKED', s.provider_code='MOCK',
          s.external_shipment_id=?, s.tracking_number=?, s.booked_at=? WHERE f.order_id=?`,
    [deliveredAt, `EXT-${randomUUID().slice(0, 8)}`, `AWB-${randomUUID().slice(0, 8)}`, deliveredAt, orderId]);
  return { orderId, orderItemId, unit, warehouseId: def.id };
}

const mkRequest = (customerId, o, type) => returnRequestService.createRequest({
  customerId, orderId: o.orderId, requestType: type, reasonCode: 'DEFECTIVE',
  idempotencyKey: `rr-${type}-${randomUUID().slice(0, 12)}`,
  items: [{ orderItemId: o.orderItemId, quantity: 1 }],
});

async function driveToReceived(customerId, o, type) {
  const req = await mkRequest(customerId, o, type);
  await returnLifecycleService.approve({ requestId: req.id });
  await returnLifecycleService.preparePickup({ requestId: req.id });
  const booked = await returnLifecycleService.bookPickup({ requestId: req.id, idempotencyKey: `revbook-${req.id}` });
  assert.equal(booked.reverseShipment.status, 'BOOKED');
  assert.ok(/^MOCKAWB/.test(booked.reverseShipment.reverseAwb), 'mock reverse AWB assigned');
  const rs = booked.reverseShipment;
  await reverseShipmentService.ingestEvent({ returnShipmentId: rs.id, providerEventKey: `${req.id}-pu`, normalizedStatus: 'PICKED_UP', occurredAt: new Date() });
  await reverseShipmentService.ingestEvent({ returnShipmentId: rs.id, providerEventKey: `${req.id}-it`, normalizedStatus: 'IN_TRANSIT', occurredAt: new Date() });
  await returnLifecycleService.markReceived({ requestId: req.id });
  return req;
}

try {
  const [sku1, sku2, sku3] = await skus(3);
  assert.ok(sku3, 'need 3 ACTIVE skus');
  const cust = await customer('RRCust');
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  {
    const touched = await skus(4);
    const rows = await query(
      `SELECT sku_id, on_hand, reserved, allocated, non_sellable FROM inventory WHERE warehouse_id=? AND sku_id IN (${touched.map(() => '?').join(',')})`,
      [def.id, ...touched.map((t) => t.id)]);
    inventorySnapshot = { warehouseId: def.id, skuIds: touched.map((t) => t.id), rows };
  }

  // ============ 1. Normal return — restock only after QC PASS ============
  const o1 = await deliveredOrder({ customerId: cust, sku: sku1, qty: 1 });
  const before1 = await onHand(def.id, sku1.id);
  const req1 = await driveToReceived(cust, o1, 'RETURN');

  const atReceived = await onHand(def.id, sku1.id);
  assert.equal(atReceived.onHand, before1.onHand, 'RESTOCK_BEFORE_QC = 0 — receive does not restock');
  results.restockBeforeQc = 0;

  const qc1 = await returnLifecycleService.recordQc({ requestId: req1.id, result: 'PASS' });
  assert.equal(qc1.status, 'RESOLUTION_PENDING');
  const afterQc = await onHand(def.id, sku1.id);
  assert.equal(afterQc.onHand, before1.onHand + 1, 'QC PASS restocks the unit');
  const mv = await query("SELECT * FROM inventory_movements WHERE movement_type='RETURN_RESTOCKED' AND reference_id=?", [req1.id]);
  assert.equal(mv.length, 1, 'exactly one RETURN_RESTOCKED movement');
  results.returnRestock = 'PASS';

  // idempotent QC + receive
  await returnLifecycleService.markReceived({ requestId: req1.id });
  await returnLifecycleService.recordQc({ requestId: req1.id, result: 'PASS' });
  const afterDup = await onHand(def.id, sku1.id);
  assert.equal(afterDup.onHand, before1.onHand + 1, 'DOUBLE_RESTOCK = 0');
  results.doubleRestock = 0;

  const done1 = await returnLifecycleService.completeResolution({ requestId: req1.id });
  assert.equal(done1.status, 'COMPLETED');
  // 8F-6 wired financial resolution in; this synthetic order has no captured
  // payment_attempt, so the refund is deterministically BLOCKED (not a crash).
  assert.equal(done1.resolution.financial, 'BLOCKED');
  assert.equal(done1.resolution.refund.failureCode ?? (await query('SELECT failure_code FROM refund_attempts WHERE return_request_id=?', [req1.id]))[0]?.failure_code, 'REFUND_SOURCE_PAYMENT_NOT_FOUND');
  results.normalReturn = 'PASS';

  // ============ 2. QC FAIL — no restock, manual review ============
  const o2 = await deliveredOrder({ customerId: cust, sku: sku2, qty: 1 });
  const before2 = await onHand(def.id, sku2.id);
  const req2 = await driveToReceived(cust, o2, 'RETURN');
  const qc2 = await returnLifecycleService.recordQc({ requestId: req2.id, result: 'FAIL' });
  assert.equal(qc2.qcResult, 'FAIL');
  assert.equal(qc2.status, 'RESOLUTION_PENDING');
  assert.equal(qc2.resolution.financial, 'BLOCKED_QC_FAIL');
  const afterFail = await onHand(def.id, sku2.id);
  assert.equal(afterFail.onHand, before2.onHand, 'QC FAIL restocks nothing');
  // recording PASS after FAIL is rejected (no silent override)
  await assert.rejects(() => returnLifecycleService.recordQc({ requestId: req2.id, result: 'PASS' }), (e) => e.code === 'QC_ALREADY_RECORDED');
  results.qcFlow = 'PASS (fail -> no restock, manual review, no override)';

  // ============ 3. Request cancellation (state-aware) ============
  const o3 = await deliveredOrder({ customerId: cust, sku: sku1, qty: 1 });
  const req3 = await mkRequest(cust, o3, 'RETURN');
  await returnLifecycleService.approve({ requestId: req3.id });
  const cancelled = await returnRequestService.cancelRequest({ customerId: cust, requestId: req3.id });
  assert.equal(cancelled.status, 'CANCELLED');
  const o3b = await deliveredOrder({ customerId: cust, sku: sku1, qty: 1 });
  const req3b = await mkRequest(cust, o3b, 'RETURN');
  await returnLifecycleService.approve({ requestId: req3b.id });
  await returnLifecycleService.preparePickup({ requestId: req3b.id });
  await returnLifecycleService.bookPickup({ requestId: req3b.id, idempotencyKey: `revbook-${req3b.id}` });
  await assert.rejects(() => returnRequestService.cancelRequest({ customerId: cust, requestId: req3b.id }), (e) => e.code === 'RETURN_REQUEST_NOT_CANCELLABLE');
  results.requestCancellation = 'PASS';

  // ============ 4. Replacement — allocation, reservation, fulfillment ============
  await inventoryService.adjustOnHand(def.id, sku3.id, 5);
  const oR = await deliveredOrder({ customerId: cust, sku: sku3, qty: 1 });
  const beforeR = await onHand(def.id, sku3.id);
  const reqR = await driveToReceived(cust, oR, 'REPLACEMENT');
  await returnLifecycleService.recordQc({ requestId: reqR.id, result: 'PASS' }); // restocks returned unit (+1)
  const afterRestockR = await onHand(def.id, sku3.id);
  assert.equal(afterRestockR.onHand, beforeR.onHand + 1);

  const doneR = await returnLifecycleService.completeResolution({ requestId: reqR.id });
  assert.equal(doneR.status, 'COMPLETED');
  assert.ok(doneR.resolution.outbound?.fulfillmentId, 'replacement fulfillment linked in resolution');

  const rf = (await query('SELECT * FROM fulfillments WHERE return_request_id=?', [reqR.id]))[0];
  assert.ok(rf, 'REPLACEMENT_FULFILLMENT — a fulfillment exists for the request');
  assert.equal(rf.fulfillment_type, 'SUPPLEMENTARY');
  assert.ok(rf.source_reservation_id, 'REPLACEMENT_RESERVATION — a reservation was created');
  const rfi = await query('SELECT * FROM fulfillment_items WHERE fulfillment_id=?', [rf.id]);
  assert.equal(rfi[0].order_item_id, oR.orderItemId, 'linked to the original order item (§37)');
  const rshp = await query('SELECT * FROM shipments WHERE fulfillment_id=?', [rf.id]);
  assert.equal(rshp.length, 1, 'replacement forward shipment created');
  const resv = (await query('SELECT status FROM inventory_reservations WHERE id=?', [rf.source_reservation_id]))[0];
  assert.equal(resv.status, 'CONSUMED', 'replacement reservation consumed');
  const afterReplace = await onHand(def.id, sku3.id);
  assert.equal(afterReplace.onHand, beforeR.onHand, 'net stock effect: +1 restock, -1 replacement = 0');
  results.replacement = 'PASS';
  results.replacementAllocation = 'PASS';
  results.replacementReservation = 'PASS';
  results.replacementFulfillment = 'PASS';

  // idempotent release
  const doneR2 = await returnLifecycleService.completeResolution({ requestId: reqR.id });
  assert.equal(doneR2.resolution.outbound.fulfillmentId, rf.id, 'replacement release is idempotent');
  const rfCount = await query('SELECT COUNT(*) c FROM fulfillments WHERE return_request_id=?', [reqR.id]);
  assert.equal(Number(rfCount[0].c), 1);

  // ============ 5. REPLACEMENT_OVERSOLD = 0 (last-unit race) ============
  const lastSkus = await skus(4);
  const raceSku = lastSkus[3];
  assert.ok(raceSku, 'need a 4th sku for the oversell race');
  await inventoryService.adjustOnHand(def.id, raceSku.id, 1); // exactly one unit
  const oX = await deliveredOrder({ customerId: cust, sku: raceSku, qty: 1 });
  const oY = await deliveredOrder({ customerId: cust, sku: raceSku, qty: 1 });
  const reqX = await mkRequest(cust, oX, 'REPLACEMENT');
  const reqY = await mkRequest(cust, oY, 'REPLACEMENT');
  // Park both at QC_PASSED without restock, so both compete for the single unit.
  for (const r of [reqX, reqY]) {
    await query("UPDATE return_requests SET status='QC_PASSED', qc_result='PASS', return_warehouse_id=? WHERE id=?", [def.id, r.id]);
  }
  const race = await Promise.allSettled([
    replacementService.releaseFor(reqX.id),
    replacementService.releaseFor(reqY.id),
  ]);
  const wins = race.filter((r) => r.status === 'fulfilled');
  assert.equal(wins.length, 1, 'exactly one replacement wins the last unit');
  const inv = await onHand(def.id, raceSku.id);
  assert.ok(inv.onHand >= 0 && inv.reserved >= 0 && inv.reserved <= inv.onHand, 'inventory invariant intact');
  const rfRace = await query('SELECT COUNT(*) c FROM fulfillments WHERE return_request_id IN (?,?)', [reqX.id, reqY.id]);
  assert.equal(Number(rfRace[0].c), 1, 'REPLACEMENT_OVERSOLD = 0');
  results.replacementOversold = 0;
  // Clean the parked losers so teardown is simple.

  assert.equal(networkCalls, 0, 'no outbound network calls');
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nRETURNS_REPLACEMENTS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nRETURNS_REPLACEMENTS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  let cleanupFailures = 0;
  const safe = async (fn) => { try { await fn(); } catch (e) { cleanupFailures += 1; console.error('  cleanup:', e.message); } };
  // Quarantine batches and stock movements point at return requests by id.
  // Deleting the requests below used to orphan them: every QC FAIL left a
  // quarantined unit (non_sellable +1) and every restock left a movement.
  const returnIds = [];
  for (const cid of created.customers) {
    for (const r of await query('SELECT id FROM return_requests WHERE customer_id=?', [cid])) returnIds.push(r.id);
  }
  for (const rid of returnIds) {
    await safe(() => query("DELETE FROM inventory_quarantine WHERE source_type='RETURN_QC_FAIL' AND source_ref=?", [rid]));
    await safe(() => query("DELETE FROM inventory_movements WHERE reference_type='RETURN_REQUEST' AND reference_id=?", [rid]));
  }
  for (const orderId of created.orders) {
    const reqIds = (await query('SELECT id FROM return_requests WHERE order_id=?', [orderId])).map((r) => r.id);
    for (const rid of reqIds) {
      await safe(() => query('DELETE FROM return_shipment_booking_attempts WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipment_events WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipments WHERE return_request_id=?', [rid]));
    }
    await safe(() => query('DELETE se FROM shipment_events se JOIN shipments s ON s.id=se.shipment_id JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]));
    const resvIds = (await query('SELECT source_reservation_id FROM fulfillments WHERE order_id=? AND source_reservation_id IS NOT NULL', [orderId])).map((r) => r.source_reservation_id);
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE ci FROM credit_note_items ci JOIN credit_notes c ON c.id=ci.credit_note_id WHERE c.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM credit_notes WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM refund_attempts WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE e FROM return_request_events e JOIN return_requests r ON r.id=e.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE i FROM return_request_items i JOIN return_requests r ON r.id=i.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM return_requests WHERE order_id=?', [orderId]));
    for (const rv of resvIds) {
      await safe(() => query('DELETE FROM inventory_movements WHERE reference_id=?', [rv]));
      await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [rv]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [rv]));
    }
    await safe(() => query('DELETE ii FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM invoices WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM documents WHERE order_id=?', [orderId]));
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
    await safe(() => query('DELETE FROM return_requests WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  // Put the stock back exactly as it was. (The old reset deleted movements
  // with reason LIKE 'RETURN COR-RR-%', which never matched: return reasons
  // carry the COR-RET- request number, and no counter was ever restored.)
  if (inventorySnapshot) {
    const { warehouseId, skuIds, rows } = inventorySnapshot;
    for (const skuId of skuIds) {
      const before = rows.find((r) => r.sku_id === skuId);
      if (before) {
        await safe(() => query('UPDATE inventory SET on_hand=?, reserved=?, allocated=?, non_sellable=? WHERE warehouse_id=? AND sku_id=?',
          [before.on_hand, before.reserved, before.allocated, before.non_sellable, warehouseId, skuId]));
      } else {
        await safe(() => query('DELETE FROM inventory WHERE warehouse_id=? AND sku_id=?', [warehouseId, skuId]));
      }
    }
  }
  if (cleanupFailures) {
    console.error(`
RETURNS_REPLACEMENTS_CLEANUP = FAIL (${cleanupFailures} statement(s)) — the database was left changed`);
    process.exitCode = 1;
  }
  await pool.end();
}
