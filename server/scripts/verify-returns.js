// Wave 8F-1 — return / exchange domain + eligibility verification.
//
// Backend is the sole eligibility authority; item-level + partial-quantity
// accounting; the 7-day window from PACKAGE delivery; double-use protection;
// concurrent last-unit safety (OVER_RETURN = 0); persistent request
// idempotency; frozen eligibility snapshots; state-aware cancellation;
// cross-customer denial with no existence leak. No provider calls.
//
//   npm run verify:returns
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { returnEligibilityService } = await import('../src/modules/returns/returnEligibilityService.js');
const { returnRequestService } = await import('../src/modules/returns/returnRequestService.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [] };

async function makeSkus(n = 1) {
  return query(
    `SELECT s.id, s.sku, s.price_minor, v.id variant_id, p.id product_id, p.name
       FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE' ORDER BY s.id LIMIT ${Number(n)}`,
  );
}

async function makeCustomer(name = 'Ret') {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'T','ACTIVE',NOW(3))", [id, name]);
  return id;
}

/** Build a delivered order. `lines` = [{ qty, sku }] — one order_item per line. */
async function buildDeliveredOrder({ customerId, sku, lines = [{ qty: 1 }], deliveredDaysAgo = 1 }) {
  lines = lines.map((l) => ({ qty: l.qty, sku: l.sku || sku }));
  let cartId = (await query('SELECT id FROM carts WHERE customer_id=? LIMIT 1', [customerId]))[0]?.id;
  if (!cartId) {
    cartId = randomUUID();
    await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']);
  }
  const reservationId = randomUUID();
  await query(
    `INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`,
    [reservationId, customerId, `ret:${randomUUID()}`, '0'.repeat(64)],
  );
  const priceOf = (s) => Number(s.price_minor || 50000);
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  const bySku = new Map();
  for (const l of lines) bySku.set(l.sku.id, (bySku.get(l.sku.id) || 0) + l.qty);
  for (const [skuId, qty] of bySku) {
    await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
      [randomUUID(), reservationId, def.id, skuId, qty]);
  }

  const checkoutId = randomUUID();
  const subtotal = lines.reduce((s, l) => s + priceOf(l.sku) * l.qty, 0);
  await query(
    `INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `ret:co:${randomUUID()}`, 'f'.repeat(64), subtotal, subtotal],
  );

  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'Ret', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN' };
  await query(
    `INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,?,?, 'RETURNS_TEST')`,
    [orderId, `COR-RET-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
      subtotal, subtotal, subtotal, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })],
  );
  const orderItemIds = [];
  for (const line of lines) {
    const oiId = randomUUID();
    orderItemIds.push(oiId);
    const u = priceOf(line.sku);
    await query(
      `INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [oiId, orderId, line.sku.product_id, line.sku.variant_id, line.sku.id, line.sku.name, line.sku.sku, line.qty, u, u * line.qty],
    );
  }
  await fulfillmentService.ensureForOrder(orderId);
  const deliveredAt = new Date(Date.now() - deliveredDaysAgo * 86400000);
  await query(
    `UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id
        SET s.status='DELIVERED', s.delivered_at=?, s.booking_status='BOOKED',
            s.provider_code='MOCK', s.external_shipment_id=?, s.tracking_number=?, s.booked_at=?
      WHERE f.order_id=?`,
    [deliveredAt, `EXT-${tag}`, `AWB-${tag}`, deliveredAt, orderId],
  );
  return { orderId, orderItemIds, unit: priceOf(lines[0].sku), deliveredAt };
}

try {
  const skus = await makeSkus(2);
  const sku = skus[0];
  assert.ok(sku, 'an ACTIVE sku exists to build test orders');
  const A = await makeCustomer('CustA');
  const B = await makeCustomer('CustB');

  // ============ 1. Eligibility engine — delivered & in window ============
  const o1 = await buildDeliveredOrder({ customerId: A, sku, lines: [{ qty: 3 }], deliveredDaysAgo: 1 });
  const elig1 = await returnEligibilityService.evaluateOrder({ customerId: A, orderId: o1.orderId });
  assert.equal(elig1.items.length, 1);
  const line1 = elig1.items[0];
  assert.equal(line1.eligible, true);
  assert.equal(line1.orderedQuantity, 3);
  assert.equal(line1.eligibleQuantity, 3);
  assert.equal(line1.financialEligibleValueMinor, o1.unit * 3);
  assert.ok(line1.returnDeadline && new Date(line1.returnDeadline) > new Date(), 'deadline is in the future');
  assert.deepEqual([...line1.allowedActions].sort(), ['DIFFERENT_STYLE_EXCHANGE', 'REPLACEMENT', 'RETURN', 'SAME_STYLE_EXCHANGE']);
  results.eligibilityEngine = 'PASS';

  // ============ 2. Return window — delivered 10 days ago ============
  const oOld = await buildDeliveredOrder({ customerId: A, sku, lines: [{ qty: 1 }], deliveredDaysAgo: 10 });
  const eligOld = await returnEligibilityService.evaluateOrder({ customerId: A, orderId: oOld.orderId });
  assert.equal(eligOld.items[0].eligible, false);
  assert.equal(eligOld.items[0].reasonCode, 'WINDOW_EXPIRED');
  await assert.rejects(
    () => returnRequestService.createRequest({
      customerId: A, orderId: oOld.orderId, requestType: 'RETURN',
      idempotencyKey: `k-old-${tag}`, items: [{ orderItemId: oOld.orderItemIds[0], quantity: 1 }],
    }),
    (e) => e.code === 'RETURN_WINDOW_EXPIRED',
  );
  results.returnWindow = 'PASS (7 days from package delivery; expired blocked)';

  // ============ 3. Not delivered -> not eligible ============
  const oPending = await buildDeliveredOrder({ customerId: A, sku, lines: [{ qty: 1 }], deliveredDaysAgo: 1 });
  await query("UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id SET s.status='IN_TRANSIT', s.delivered_at=NULL WHERE f.order_id=?", [oPending.orderId]);
  const eligPending = await returnEligibilityService.evaluateOrder({ customerId: A, orderId: oPending.orderId });
  assert.equal(eligPending.items[0].reasonCode, 'NOT_DELIVERED');
  results.deliveryAuthority = 'PASS (window starts at package delivery, not order date)';

  // ============ 4. Partial quantity + double-use protection ============
  const req1 = await returnRequestService.createRequest({
    customerId: A, orderId: o1.orderId, requestType: 'RETURN', reasonCode: 'SIZE_FIT',
    idempotencyKey: `k1-${tag}`, items: [{ orderItemId: o1.orderItemIds[0], quantity: 1 }],
  });
  assert.equal(req1.status, 'REQUESTED');
  assert.equal(req1.items[0].quantity, 1);
  assert.equal(req1.items[0].eligibleValueMinor, o1.unit);

  const eligAfter = await returnEligibilityService.evaluateOrder({ customerId: A, orderId: o1.orderId });
  assert.equal(eligAfter.items[0].eligibleQuantity, 2, 'partial return leaves 2 eligible');
  assert.equal(eligAfter.items[0].alreadyConsumedQuantity, 1);
  results.partialQuantity = 'PASS (3 ordered, 1 returned, 2 remain)';

  await assert.rejects(
    () => returnRequestService.createRequest({
      customerId: A, orderId: o1.orderId, requestType: 'REPLACEMENT',
      idempotencyKey: `k1-over-${tag}`, items: [{ orderItemId: o1.orderItemIds[0], quantity: 3 }],
    }),
    (e) => e.code === 'RETURN_QUANTITY_EXCEEDED',
  );
  results.doubleUseProtection = 'PASS (returned + reserved cannot exceed ordered)';

  // ============ 5. Concurrent last-unit -> OVER_RETURN = 0 ============
  const oLast = await buildDeliveredOrder({ customerId: A, sku, lines: [{ qty: 1 }], deliveredDaysAgo: 1 });
  const attempts = await Promise.allSettled([
    returnRequestService.createRequest({
      customerId: A, orderId: oLast.orderId, requestType: 'RETURN',
      idempotencyKey: `race-a-${tag}`, items: [{ orderItemId: oLast.orderItemIds[0], quantity: 1 }],
    }),
    returnRequestService.createRequest({
      customerId: A, orderId: oLast.orderId, requestType: 'RETURN',
      idempotencyKey: `race-b-${tag}`, items: [{ orderItemId: oLast.orderItemIds[0], quantity: 1 }],
    }),
  ]);
  const fulfilled = attempts.filter((a) => a.status === 'fulfilled');
  const rejected = attempts.filter((a) => a.status === 'rejected');
  assert.equal(fulfilled.length, 1, 'exactly one concurrent request wins the last unit');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'RETURN_QUANTITY_EXCEEDED');
  const heldRows = await query(
    `SELECT COALESCE(SUM(rri.quantity),0) held FROM return_request_items rri
       JOIN return_requests rr ON rr.id=rri.return_request_id
      WHERE rri.order_item_id=? AND rr.status NOT IN ('REJECTED','CANCELLED','EXPIRED')`,
    [oLast.orderItemIds[0]],
  );
  assert.equal(Number(heldRows[0].held), 1, 'OVER_RETURN = 0');
  results.concurrentOverReturn = 0;

  // ============ 6. Request idempotency ============
  const rIdem1 = await returnRequestService.createRequest({
    customerId: A, orderId: o1.orderId, requestType: 'RETURN',
    idempotencyKey: `k-idem-${tag}`, items: [{ orderItemId: o1.orderItemIds[0], quantity: 1 }],
  });
  const rIdem2 = await returnRequestService.createRequest({
    customerId: A, orderId: o1.orderId, requestType: 'RETURN',
    idempotencyKey: `k-idem-${tag}`, items: [{ orderItemId: o1.orderItemIds[0], quantity: 1 }],
  });
  assert.equal(rIdem1.id, rIdem2.id, 'same idempotency key -> same request');
  const dupCount = await query('SELECT COUNT(*) c FROM return_requests WHERE idempotency_key=?', [`ret:${o1.orderId}:k-idem-${tag}`]);
  assert.equal(Number(dupCount[0].c), 1, 'no duplicate request row');
  results.requestIdempotency = 'PASS';

  // ============ 7. Frozen eligibility snapshot ============
  const snap = rIdem1.eligibilitySnapshot;
  assert.ok(snap && Array.isArray(snap.lines) && snap.lines[0].unitPriceMinor === o1.unit);
  const persistedItem = (await query('SELECT * FROM return_request_items WHERE return_request_id=?', [rIdem1.id]))[0];
  // Mutate the live catalog price — the request history must not move.
  await query('UPDATE order_items SET unit_price_minor=unit_price_minor+12345, line_total_minor=unit_price_minor*quantity WHERE id=?', [o1.orderItemIds[0]]);
  const reread = await returnRequestService.getRequest(A, rIdem1.id);
  assert.equal(reread.items[0].unitPriceMinor, Number(persistedItem.unit_price_minor), 'snapshot immune to later catalog edits');
  assert.equal(reread.eligibilitySnapshot.lines[0].unitPriceMinor, o1.unit);
  await query('UPDATE order_items SET unit_price_minor=unit_price_minor-12345, line_total_minor=unit_price_minor*quantity WHERE id=?', [o1.orderItemIds[0]]);
  results.requestSnapshot = 'PASS';

  // ============ 8. Cancellation eligibility (state-aware) ============
  assert.equal(reread.canCancel, true);
  const cancelled = await returnRequestService.cancelRequest({ customerId: A, requestId: rIdem1.id });
  assert.equal(cancelled.status, 'CANCELLED');
  // Cancel releases the held unit.
  const eligPostCancel = await returnEligibilityService.evaluateOrder({ customerId: A, orderId: o1.orderId });
  // req1 (1) still holds; rIdem1 released -> consumed back to 1.
  assert.equal(eligPostCancel.items[0].alreadyConsumedQuantity, 1, 'cancel returns the reserved unit to the eligible pool');
  // Idempotent re-cancel.
  assert.equal((await returnRequestService.cancelRequest({ customerId: A, requestId: rIdem1.id })).status, 'CANCELLED');
  // Past the irreversible boundary -> denied.
  await query("UPDATE return_requests SET status='PICKUP_BOOKED' WHERE id=?", [req1.id]);
  await assert.rejects(
    () => returnRequestService.cancelRequest({ customerId: A, requestId: req1.id }),
    (e) => e.code === 'RETURN_REQUEST_NOT_CANCELLABLE',
  );
  await query("UPDATE return_requests SET status='REQUESTED' WHERE id=?", [req1.id]);
  results.requestCancelEligibility = 'PASS';

  // ============ 9. Cross-customer denial (no existence leak) ============
  await assert.rejects(
    () => returnRequestService.getRequest(B, req1.id),
    (e) => e.code === 'RETURN_REQUEST_NOT_FOUND',
  );
  await assert.rejects(
    () => returnEligibilityService.evaluateOrder({ customerId: B, orderId: o1.orderId }),
    (e) => e.code === 'ORDER_NOT_FOUND',
  );
  await assert.rejects(
    () => returnRequestService.createRequest({
      customerId: B, orderId: o1.orderId, requestType: 'RETURN',
      idempotencyKey: `k-b-${tag}`, items: [{ orderItemId: o1.orderItemIds[0], quantity: 1 }],
    }),
    (e) => e.code === 'ORDER_NOT_FOUND',
  );
  results.crossCustomerAccess = 'DENIED';

  // ============ 10. Item-level independence ============
  const o2 = await buildDeliveredOrder({
    customerId: A, sku, deliveredDaysAgo: 2,
    lines: [{ qty: 1, sku: skus[0] }, { qty: 1, sku: skus[1] || skus[0] }],
  });
  assert.ok(skus[1], 'a second ACTIVE sku exists for the multi-line test');
  await returnRequestService.createRequest({
    customerId: A, orderId: o2.orderId, requestType: 'RETURN',
    idempotencyKey: `k-o2-${tag}`, items: [{ orderItemId: o2.orderItemIds[0], quantity: 1 }],
  });
  const eligO2 = await returnEligibilityService.evaluateOrder({ customerId: A, orderId: o2.orderId });
  const byId = new Map(eligO2.items.map((i) => [i.orderItemId, i]));
  assert.equal(byId.get(o2.orderItemIds[0]).eligibleQuantity, 0);
  assert.equal(byId.get(o2.orderItemIds[1]).eligibleQuantity, 1, 'other line untouched');
  results.itemLevelEligibility = 'PASS';

  assert.equal(networkCalls, 0, 'no outbound network calls');
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nRETURNS_DOMAIN_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nRETURNS_DOMAIN_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const orderId of created.orders) {
    await safe(() => query('DELETE e FROM return_request_events e JOIN return_requests r ON r.id=e.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE i FROM return_request_items i JOIN return_requests r ON r.id=i.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM return_requests WHERE order_id=?', [orderId]));
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
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  await pool.end();
}
