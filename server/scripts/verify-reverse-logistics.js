// Wave 8F-5 — reverse logistics + pickup completion (hardened).
//
// Hard serviceability gate (unsupported PIN -> manual, not forceable); frozen
// provider snapshot; commit-before-provider-call booking; UNKNOWN outcome +
// reconciliation (no blind retry); reverse-booking idempotency (no duplicate
// AWB); state-aware cancellation; tracking normalisation (no carrier
// vocabulary to the customer); authenticity-checked, deduplicating webhook
// inbox; out-of-order no-regress; policy-driven return-warehouse routing.
// REAL_REVERSE_PROVIDER_CALLS = 0.
//
//   npm run verify:reverse-logistics
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { warehouseService } = await import('../src/modules/warehouses/service.js');
const { returnRequestService } = await import('../src/modules/returns/returnRequestService.js');
const { returnLifecycleService } = await import('../src/modules/returns/returnLifecycleService.js');
const { reverseShipmentService } = await import('../src/modules/returns/reverseShipmentService.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [], warehouses: [] };
const SECRET = 'mock-reverse-secret';
const sign = (body) => createHmac('sha256', SECRET).update(JSON.stringify(body)).digest('hex');

async function customer(name) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'T','ACTIVE',NOW(3))", [id, name]);
  return id;
}

async function deliveredOrder({ customerId, sku, warehouseId, postalCode = '226001' }) {
  let cartId = (await query('SELECT id FROM carts WHERE customer_id=? LIMIT 1', [customerId]))[0]?.id;
  if (!cartId) { cartId = randomUUID(); await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']); }
  const reservationId = randomUUID();
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`, [reservationId, customerId, `rl:${randomUUID()}`, '0'.repeat(64)]);
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
    [randomUUID(), reservationId, warehouseId, sku.id, 1]);
  const unit = Number(sku.price_minor || 50000);
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `rl:co:${randomUUID()}`, 'f'.repeat(64), unit, unit]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'RL', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode, country: 'IN' };
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,?,?, 'RL_TEST')`,
    [orderId, `COR-RL-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
      unit, unit, unit, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })]);
  const orderItemId = randomUUID();
  await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,1,?,?)`,
    [orderItemId, orderId, sku.product_id, sku.variant_id, sku.id, sku.name, sku.sku, unit, unit]);
  await fulfillmentService.ensureForOrder(orderId);
  await query(`UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id
      SET s.status='DELIVERED', s.delivered_at=?, s.booking_status='BOOKED', s.provider_code='MOCK',
          s.external_shipment_id=?, s.tracking_number=?, s.booked_at=? WHERE f.order_id=?`,
    [new Date(Date.now() - 86400000), `EXT-${tag}`, `AWB-${tag}`, new Date(Date.now() - 86400000), orderId]);
  return { orderId, orderItemId };
}

async function makeReturnAtPickup(customerId, o) {
  const req = await returnRequestService.createRequest({
    customerId, orderId: o.orderId, requestType: 'RETURN', reasonCode: 'DEFECTIVE',
    idempotencyKey: `rl-${randomUUID().slice(0, 12)}`, items: [{ orderItemId: o.orderItemId, quantity: 1 }],
  });
  await returnLifecycleService.approve({ requestId: req.id });
  const summary = await returnLifecycleService.preparePickup({ requestId: req.id });
  return { req, summary };
}
const shipmentRow = (reqId) => query('SELECT * FROM return_shipments WHERE return_request_id=?', [reqId]).then((r) => r[0]);

try {
  const sku = (await query("SELECT s.id, s.sku, s.price_minor, s.variant_id, v.product_id, p.name FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 1"))[0];
  const def = await warehouseService.getDefault();
  const cust = await customer('RLCust');

  // ============ 1. Serviceability HARD gate ============
  {
    const o = await deliveredOrder({ customerId: cust, sku, warehouseId: def.id, postalCode: '999999' });
    const { req, summary } = await makeReturnAtPickup(cust, o);
    assert.equal(summary.status, 'MANUAL_RETURN_LOGISTICS_REQUIRED', 'unsupported pickup PIN -> manual, not forceable (§72)');
    const shp = await shipmentRow(req.id);
    assert.equal(Number(shp.serviceable), 0);
    assert.equal(shp.status, 'MANUAL_RETURN_LOGISTICS_REQUIRED');
    const booked = await returnLifecycleService.bookPickup({ requestId: req.id, idempotencyKey: `b-${req.id}` });
    assert.equal(booked.reverseShipment.status, 'MANUAL_RETURN_LOGISTICS_REQUIRED');
    assert.equal(booked.reverseShipment.reverseAwb, null, 'no AWB for an unserviceable pickup');
    results.reverseServiceability = 'PASS (hard gate)';
  }

  // ============ 2. Booking + provider snapshot + idempotency ============
  let bookedShipmentId;
  {
    const o = await deliveredOrder({ customerId: cust, sku, warehouseId: def.id });
    const { req } = await makeReturnAtPickup(cust, o);
    const shpBefore = await shipmentRow(req.id);
    assert.equal(Number(shpBefore.serviceable), 1);
    assert.ok(shpBefore.provider_snapshot_json, 'provider snapshot frozen at serviceability check (§73)');
    const snapAtCheck = JSON.stringify(shpBefore.provider_snapshot_json);

    const b1 = await returnLifecycleService.bookPickup({ requestId: req.id, idempotencyKey: `bk-${req.id}` });
    assert.equal(b1.reverseShipment.status, 'BOOKED');
    assert.ok(/^MOCKAWB/.test(b1.reverseShipment.reverseAwb));
    assert.equal(b1.reverseShipment.realProviderCallPerformed ?? false, false);
    bookedShipmentId = b1.reverseShipment.id;

    const b2 = await returnLifecycleService.bookPickup({ requestId: req.id, idempotencyKey: `bk-${req.id}` });
    assert.equal((await shipmentRow(req.id)).reverse_awb, b1.reverseShipment.reverseAwb, 'same key -> same AWB');
    void b2;
    const attempts = await query('SELECT status FROM return_shipment_booking_attempts WHERE return_shipment_id=?', [bookedShipmentId]);
    assert.equal(attempts.filter((a) => a.status === 'SUCCEEDED').length, 1);
    assert.equal(JSON.stringify((await shipmentRow(req.id)).provider_snapshot_json), snapAtCheck, 'provider snapshot not rerouted by booking');
    results.reverseBooking = 'PASS';
    results.reverseIdempotency = 'PASS (REVERSE_BOOKING_DUPLICATES = 0)';
  }

  // ============ 3. UNKNOWN outcome + reconciliation ============
  {
    const o = await deliveredOrder({ customerId: cust, sku, warehouseId: def.id });
    const { req } = await makeReturnAtPickup(cust, o);
    const shp = await shipmentRow(req.id);
    await assert.rejects(
      () => reverseShipmentService.book({ returnShipmentId: shp.id, idempotencyKey: `u-${req.id}`, simulate: 'AMBIGUOUS' }),
      (e) => e.code === 'REVERSE_BOOKING_RECONCILIATION_REQUIRED',
    );
    assert.equal((await shipmentRow(req.id)).status, 'UNKNOWN');
    assert.equal((await query("SELECT status FROM return_shipment_booking_attempts WHERE idempotency_key=?", [`u-${req.id}`]))[0].status, 'UNKNOWN');
    // blind retry denied
    await assert.rejects(
      () => reverseShipmentService.book({ returnShipmentId: shp.id, idempotencyKey: `u-${req.id}`, simulate: 'AMBIGUOUS' }),
      (e) => e.code === 'REVERSE_BOOKING_RECONCILIATION_REQUIRED',
    );
    assert.equal((await query('SELECT COUNT(*) c FROM return_shipment_booking_attempts WHERE return_shipment_id=?', [shp.id]))[0].c, 1, 'no second attempt row');
    const rec = await reverseShipmentService.reconcile({ returnShipmentId: shp.id, providerOutcome: 'CONFIRMED' });
    assert.equal(rec.status, 'BOOKED');
    assert.ok(/^MOCKAWB/.test(rec.reverseAwb));
    results.reverseUnknownOutcome = 'PASS (no blind retry; reconciled)';
  }

  // ============ 4. State-aware cancellation ============
  {
    const o = await deliveredOrder({ customerId: cust, sku, warehouseId: def.id });
    const { req } = await makeReturnAtPickup(cust, o);
    const shp = await shipmentRow(req.id);
    await reverseShipmentService.book({ returnShipmentId: shp.id, idempotencyKey: `c-${req.id}` });
    const cancelled = await reverseShipmentService.cancelPickup({ returnShipmentId: shp.id, reason: 'customer changed mind' });
    assert.equal(cancelled.status, 'CANCELLED');

    const o2 = await deliveredOrder({ customerId: cust, sku, warehouseId: def.id });
    const r2 = await makeReturnAtPickup(cust, o2);
    const shp2 = await shipmentRow(r2.req.id);
    await reverseShipmentService.book({ returnShipmentId: shp2.id, idempotencyKey: `c2-${r2.req.id}` });
    await reverseShipmentService.ingestEvent({ returnShipmentId: shp2.id, providerEventKey: `${shp2.id}-pu`, normalizedStatus: 'PICKED_UP', occurredAt: new Date() });
    await assert.rejects(
      () => reverseShipmentService.cancelPickup({ returnShipmentId: shp2.id }),
      (e) => e.code === 'REVERSE_CANCEL_NOT_ALLOWED',
    );
    results.reverseCancellation = 'PASS (picked-up cannot be cancelled)';
  }

  // ============ 5. Webhook inbox: normalize, dedupe, auth, out-of-order ============
  {
    const o = await deliveredOrder({ customerId: cust, sku, warehouseId: def.id });
    const { req } = await makeReturnAtPickup(cust, o);
    const shp = await shipmentRow(req.id);
    const bk = await reverseShipmentService.book({ returnShipmentId: shp.id, idempotencyKey: `w-${req.id}` });
    const awb = bk.shipment.reverseAwb;
    const providerShipmentId = (await shipmentRow(req.id)).provider_shipment_id;

    const evt = (over) => ({ event_id: `EVT-${randomUUID().slice(0, 8)}`, awb, shipment_id: providerShipmentId, scan_time: new Date().toISOString(), ...over });

    // normalization: raw carrier scan -> normalized status
    const pu = evt({ scan_code: 'RT-PICKUP-DONE', location: 'Lucknow Hub' });
    const r1 = await reverseShipmentService.ingestWebhook({ rawBody: pu, signature: sign(pu) });
    assert.equal(r1.applied, true);
    assert.equal((await shipmentRow(req.id)).status, 'PICKED_UP');

    // duplicate event id -> no effect
    const r1dup = await reverseShipmentService.ingestWebhook({ rawBody: pu, signature: sign(pu) });
    assert.equal(r1dup.deduped, true);
    assert.equal(r1dup.applied, false);

    // bad signature -> rejected, not applied
    const bad = evt({ scan_code: 'RT-RECEIVED-AT-FC' });
    const rbad = await reverseShipmentService.ingestWebhook({ rawBody: bad, signature: 'deadbeef' });
    assert.equal(rbad.applied, false);
    assert.equal(rbad.reason, 'BAD_SIGNATURE');
    assert.equal((await query("SELECT status FROM return_shipment_webhook_events WHERE provider_event_id=?", [bad.event_id]))[0].status, 'REJECTED');

    // advance to RECEIVED, then a delayed IN_TRANSIT must not regress
    const rc = evt({ scan_code: 'RT-RECEIVED-AT-FC' });
    await reverseShipmentService.ingestWebhook({ rawBody: rc, signature: sign(rc) });
    assert.equal((await shipmentRow(req.id)).status, 'RECEIVED');
    const late = evt({ scan_code: 'RT-IN-TRANSIT', scan_time: new Date(Date.now() - 3600000).toISOString() });
    const rlate = await reverseShipmentService.ingestWebhook({ rawBody: late, signature: sign(late) });
    assert.equal(rlate.applied, false);
    assert.equal((await shipmentRow(req.id)).status, 'RECEIVED', 'out-of-order scan does not regress state');

    // customer timeline uses normalized labels, never carrier vocabulary
    const timeline = await reverseShipmentService.customerTimeline(shp.id);
    const labels = timeline.map((t) => t.status);
    assert.ok(labels.includes('Picked Up') && labels.includes('Received at Warehouse'));
    assert.ok(!labels.some((l) => /RT-|scan|MOCK/i.test(l)), 'RAW_REVERSE_PROVIDER_RESPONSE_LEAK = 0');
    results.reverseTracking = 'PASS';
    results.reverseEventDedupe = 'PASS (DUPLICATE_REVERSE_EVENT_EFFECTS = 0)';
    results.reverseOutOfOrderProtection = 'PASS';
    results.webhookInbox = 'PASS (auth + dedupe + normalize)';
  }

  // ============ 6. Return-warehouse routing (policy-driven) ============
  {
    const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
    const wh2 = await warehouseService.create({ code: `WH-RL-${tag}`, name: 'RL Secondary', city: 'Delhi', state: 'DL', postalCode: '110001', country: 'IN', priority: 50, brandId: cottonBrand.id });
    created.warehouses.push(wh2.id);

    // Order fulfilled from WH2.
    const o = await deliveredOrder({ customerId: cust, sku, warehouseId: wh2.id });
    // ORIGIN_FULFILLMENT (default) -> destination = WH2
    const a = await makeReturnAtPickup(cust, o);
    assert.equal((await shipmentRow(a.req.id)).destination_warehouse_id, wh2.id, 'ORIGIN_FULFILLMENT -> origin warehouse');

    // Switch policy -> DEFAULT_WAREHOUSE
    await query("UPDATE return_policy SET return_destination_strategy='DEFAULT_WAREHOUSE' WHERE id=1");
    const { returnPolicyService } = await import('../src/modules/returns/returnPolicyService.js');
    returnPolicyService.invalidate();
    const o2 = await deliveredOrder({ customerId: cust, sku, warehouseId: wh2.id });
    const b = await makeReturnAtPickup(cust, o2);
    assert.equal((await shipmentRow(b.req.id)).destination_warehouse_id, def.id, 'DEFAULT_WAREHOUSE -> default warehouse');
    await query("UPDATE return_policy SET return_destination_strategy='ORIGIN_FULFILLMENT' WHERE id=1");
    returnPolicyService.invalidate();
    results.returnWarehouseRouting = 'PASS (policy-driven, not hardcoded)';
  }

  assert.equal(networkCalls, 0, 'no outbound network calls');
  results.realReverseProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nREVERSE_LOGISTICS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nREVERSE_LOGISTICS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query("UPDATE return_policy SET return_destination_strategy='ORIGIN_FULFILLMENT' WHERE id=1"));
  // Webhook events not tied to a surviving reverse shipment (bad-signature /
  // shipment-not-found paths this script deliberately exercises).
  await safe(() => query('DELETE FROM return_shipment_webhook_events WHERE return_shipment_id IS NULL'));
  for (const orderId of created.orders) {
    const reqIds = (await query('SELECT id FROM return_requests WHERE order_id=?', [orderId])).map((r) => r.id);
    for (const rid of reqIds) {
      await safe(() => query('DELETE FROM return_shipment_webhook_events WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipment_booking_attempts WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipment_events WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipments WHERE return_request_id=?', [rid]));
    }
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE e FROM return_request_events e JOIN return_requests r ON r.id=e.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE i FROM return_request_items i JOIN return_requests r ON r.id=i.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM return_requests WHERE order_id=?', [orderId]));
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
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  for (const wid of created.warehouses) {
    await safe(() => query('DELETE FROM inventory WHERE warehouse_id=?', [wid]));
    await safe(() => query('DELETE FROM staff_warehouse_assignments WHERE warehouse_id=?', [wid]));
    await safe(() => query('DELETE FROM warehouses WHERE id=? AND is_default=0', [wid]));
  }
  await pool.end();
}
