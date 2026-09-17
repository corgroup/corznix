// Wave 8F-3 — same-style exchange verification.
//
// Backend re-validates the target (exists / active / SAME product / in stock);
// a different-product target is DENIED and routed to different-style; the
// price-difference policy is honoured (equal -> proceed; differ + no policy ->
// SAME_STYLE_PRICE_POLICY_REQUIRED; differ + EVEN_EXCHANGE -> proceed, no money);
// the outgoing target ships via the normal fulfillment spine with a
// transactional reservation; OVERSELL = 0. No provider / network calls.
//
//   npm run verify:same-style-exchange
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { inventoryService } = await import('../src/modules/inventory/service.js');
const { returnPolicyService } = await import('../src/modules/returns/returnPolicyService.js');
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
const priceEdits = [];

const skuRow = (id) => query(
  `SELECT s.id, s.sku, s.price_minor, s.sale_price_minor, s.variant_id, v.product_id, p.name
     FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
    WHERE s.id=?`, [id]).then((r) => r[0]);

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
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`, [reservationId, customerId, `se:${randomUUID()}`, '0'.repeat(64)]);
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
    [randomUUID(), reservationId, def.id, sku.id, qty]);
  const unit = Number(sku.price_minor);
  const subtotal = unit * qty;
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `se:co:${randomUUID()}`, 'f'.repeat(64), subtotal, subtotal]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'SE', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN' };
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,?,?, 'SE_TEST')`,
    [orderId, `COR-SE-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
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

const mkExchange = (customerId, o, targetSkuId) => returnRequestService.createRequest({
  customerId, orderId: o.orderId, requestType: 'SAME_STYLE_EXCHANGE', reasonCode: 'SIZE_FIT',
  idempotencyKey: `se-${randomUUID().slice(0, 12)}`,
  items: [{ orderItemId: o.orderItemId, quantity: 1, target: { skuId: targetSkuId } }],
});

async function driveToQcPass(customerId, o, targetSkuId) {
  const req = await mkExchange(customerId, o, targetSkuId);
  await returnLifecycleService.approve({ requestId: req.id });
  await returnLifecycleService.preparePickup({ requestId: req.id });
  const b = await returnLifecycleService.bookPickup({ requestId: req.id, idempotencyKey: `revbook-${req.id}` });
  await reverseShipmentService.ingestEvent({ returnShipmentId: b.reverseShipment.id, providerEventKey: `${req.id}-it`, normalizedStatus: 'IN_TRANSIT', occurredAt: new Date() });
  await returnLifecycleService.markReceived({ requestId: req.id });
  await returnLifecycleService.recordQc({ requestId: req.id, result: 'PASS' });
  return req;
}

try {
  // THREE same-style SKUs at one price is what this test actually needs: an
  // origin, an equal-priced target for the price-policy case, and another for
  // the last-unit race, which runs with the policy back at BLOCK and so also
  // has to cost the same.
  //
  // Ask the database for that directly. Picking the product with the most
  // siblings and hoping their prices line up is what kept breaking: first by
  // assuming every size shares a price, then — once tEqual was chosen by price
  // — by leaving tRace to whatever order GROUP_CONCAT returned, and finally by
  // asserting a condition the search itself never required, which is how a
  // fresh catalogue could fail it outright. Grouping by price cannot.
  const grp = (await query(
    `SELECT v.product_id, COALESCE(s.sale_price_minor, s.price_minor) AS price,
            GROUP_CONCAT(s.id) skus, COUNT(*) n
       FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'
      GROUP BY v.product_id, price HAVING n >= 3 ORDER BY n DESC LIMIT 1`))[0];
  assert.ok(grp, 'need three same-style SKUs sharing one price');
  const samePriced = await Promise.all(grp.skus.split(',').map(skuRow));
  const [origin, tEqual, tRace] = samePriced;

  // tDiffPrice only has to be a sibling of the same product; section 3 shifts
  // its price by hand, so its starting price is irrelevant. Prefer one outside
  // the equal-priced group, and fall back into the group when the product
  // prices every size alike.
  const others = await query(
    `SELECT s.id FROM skus s JOIN product_variants v ON v.id=s.variant_id
      WHERE v.product_id=? AND s.status='ACTIVE' AND s.id NOT IN (?,?,?) LIMIT 1`,
    [grp.product_id, origin.id, tEqual.id, tRace.id]);
  const tDiffPrice = others[0] ? await skuRow(others[0].id) : samePriced[3];
  assert.ok(tDiffPrice, 'need a fourth same-style sibling to shift the price of');
  const otherProductSku = await query(
    `SELECT s.id FROM skus s JOIN product_variants v ON v.id=s.variant_id
      WHERE v.product_id <> ? AND s.status='ACTIVE' LIMIT 1`, [origin.product_id]).then((r) => r[0].id);
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  const cust = await customer('SECust');

  // Give every target sibling stock.
  for (const s of [tEqual, tDiffPrice, tRace]) await inventoryService.adjustOnHand(def.id, s.id, 5);

  // ============ 1. Target validation ============
  const oV = await deliveredOrder({ customerId: cust, sku: origin, qty: 1 });
  await assert.rejects(() => mkExchange(cust, oV, randomUUID()), (e) => e.code === 'EXCHANGE_TARGET_NOT_FOUND');
  await assert.rejects(() => mkExchange(cust, oV, origin.id), (e) => e.code === 'SAME_STYLE_NO_CHANGE');
  await query("UPDATE skus SET status='ARCHIVED' WHERE id=?", [tRace.id]);
  await assert.rejects(() => mkExchange(cust, oV, tRace.id), (e) => e.code === 'EXCHANGE_TARGET_INACTIVE');
  await query("UPDATE skus SET status='ACTIVE' WHERE id=?", [tRace.id]);
  results.targetVariantValidation = 'PASS';

  // ============ 2. Different-product target DENIED ============
  await assert.rejects(() => mkExchange(cust, oV, otherProductSku), (e) => e.code === 'SAME_STYLE_DIFFERENT_PRODUCT');
  results.differentProductTarget = 'DENIED';

  // ============ 3. Price-difference policy ============
  // 3a. equal price -> NOT_REQUIRED
  const oP = await deliveredOrder({ customerId: cust, sku: origin, qty: 1 });
  const reqEqual = await mkExchange(cust, oP, tEqual.id);
  const persisted = (await query('SELECT * FROM return_request_items WHERE return_request_id=?', [reqEqual.id]))[0];
  assert.equal(Number(persisted.target_sku_id ? 1 : 0), 1);
  assert.equal(reqEqual.eligibilitySnapshot.lines[0].pricePolicyOutcome, 'NOT_REQUIRED');
  results.priceDifferenceEqual = 'NOT_REQUIRED';

  // 3b. differ + BLOCK (default) -> SAME_STYLE_PRICE_POLICY_REQUIRED
  await query('UPDATE skus SET price_minor=price_minor+10000 WHERE id=?', [tDiffPrice.id]);
  priceEdits.push(tDiffPrice.id);
  returnPolicyService.invalidate();
  const oP2 = await deliveredOrder({ customerId: cust, sku: origin, qty: 1 });
  await assert.rejects(() => mkExchange(cust, oP2, tDiffPrice.id), (e) => e.code === 'SAME_STYLE_PRICE_POLICY_REQUIRED');

  // 3c. differ + EVEN_EXCHANGE -> CONFIGURED, proceeds, no money
  await query("UPDATE return_policy SET same_style_price_difference_policy='EVEN_EXCHANGE' WHERE id=1");
  returnPolicyService.invalidate();
  const reqDiff = await mkExchange(cust, oP2, tDiffPrice.id);
  assert.equal(reqDiff.eligibilitySnapshot.lines[0].pricePolicyOutcome, 'CONFIGURED');
  await query("UPDATE return_policy SET same_style_price_difference_policy='BLOCK' WHERE id=1");
  returnPolicyService.invalidate();
  results.priceDifferencePolicy = 'BLOCKED_REQUIRING_POLICY (default) + CONFIGURED (EVEN_EXCHANGE)';

  // ============ 4. Same-style exchange end to end (equal price) ============
  const oX = await deliveredOrder({ customerId: cust, sku: origin, qty: 1 });
  const beforeOrigin = await onHand(def.id, origin.id);
  const beforeTarget = await onHand(def.id, tEqual.id);
  const reqX = await driveToQcPass(cust, oX, tEqual.id);
  const afterRestock = await onHand(def.id, origin.id);
  assert.equal(afterRestock.onHand, beforeOrigin.onHand + 1, 'returned original restocked at QC PASS');

  const doneX = await returnLifecycleService.completeResolution({ requestId: reqX.id });
  assert.equal(doneX.status, 'COMPLETED');
  const rf = (await query('SELECT * FROM fulfillments WHERE return_request_id=?', [reqX.id]))[0];
  assert.ok(rf && rf.fulfillment_type === 'SUPPLEMENTARY', 'WAREHOUSE_ALLOCATION — exchange fulfillment created');
  assert.ok(rf.source_reservation_id, 'TARGET_RESERVATION — reservation created');
  const rfi = (await query('SELECT * FROM fulfillment_items WHERE fulfillment_id=?', [rf.id]))[0];
  assert.equal(rfi.sku_id, tEqual.id, 'outgoing line ships the TARGET sku');
  assert.equal(rfi.order_item_id, oX.orderItemId, 'linked to the original order item (§37)');
  const resv = (await query('SELECT status FROM inventory_reservations WHERE id=?', [rf.source_reservation_id]))[0];
  assert.equal(resv.status, 'CONSUMED');
  const afterTarget = await onHand(def.id, tEqual.id);
  assert.equal(afterTarget.onHand, beforeTarget.onHand - 1, 'target sku decremented by the exchange');
  assert.equal((await query('SELECT COUNT(*) c FROM shipments WHERE fulfillment_id=?', [rf.id]))[0].c, 1);
  results.sameStyleExchange = 'PASS';
  results.warehouseAllocation = 'PASS';
  results.targetReservation = 'PASS';

  // ============ 5. OVERSELL = 0 (target last-unit race) ============
  await inventoryService.adjustOnHand(def.id, tRace.id, 1);
  const oA = await deliveredOrder({ customerId: cust, sku: origin, qty: 1 });
  const oB = await deliveredOrder({ customerId: cust, sku: origin, qty: 1 });
  const reqA = await mkExchange(cust, oA, tRace.id);
  const reqB = await mkExchange(cust, oB, tRace.id);
  for (const r of [reqA, reqB]) {
    await query("UPDATE return_requests SET status='QC_PASSED', qc_result='PASS', return_warehouse_id=? WHERE id=?", [def.id, r.id]);
  }
  const race = await Promise.allSettled([replacementService.releaseFor(reqA.id), replacementService.releaseFor(reqB.id)]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one exchange wins the last unit');
  const raceInv = await onHand(def.id, tRace.id);
  assert.ok(raceInv.onHand >= 0 && raceInv.reserved <= raceInv.onHand, 'inventory invariant intact');
  assert.equal(Number((await query('SELECT COUNT(*) c FROM fulfillments WHERE return_request_id IN (?,?)', [reqA.id, reqB.id]))[0].c), 1, 'OVERSELL = 0');
  results.oversell = 0;

  assert.equal(networkCalls, 0, 'no outbound network calls');
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nSAME_STYLE_EXCHANGE_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nSAME_STYLE_EXCHANGE_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query("UPDATE return_policy SET same_style_price_difference_policy='BLOCK' WHERE id=1"));
  for (const id of priceEdits) await safe(() => query('UPDATE skus SET price_minor=price_minor-10000 WHERE id=?', [id]));
  for (const orderId of created.orders) {
    const reqIds = (await query('SELECT id FROM return_requests WHERE order_id=?', [orderId])).map((r) => r.id);
    for (const rid of reqIds) {
      await safe(() => query('DELETE FROM return_shipment_booking_attempts WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipment_events WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipments WHERE return_request_id=?', [rid]));
    }
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]));
    const resvIds = (await query('SELECT source_reservation_id FROM fulfillments WHERE order_id=? AND source_reservation_id IS NOT NULL', [orderId])).map((r) => r.source_reservation_id);
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [orderId]));
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
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  await pool.end();
}
