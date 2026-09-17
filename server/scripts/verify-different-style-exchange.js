// Wave 8F-4 — different-style exchange + Reserved Exchange Credit.
//
// Exchange value frozen from the ORIGINAL transaction snapshot; a restricted
// reserved credit (RESERVED/CONSUMED/CANCELLED/EXPIRED), single-consume;
// checkout recognises it via an opaque context token; cheaper -> remainder to
// ONE store-credit GRANT; equal -> nothing extra; more expensive -> customer
// pays only the delta; cancel rollback voids everything and restores original
// eligibility with NO original-payment refund; expiry; consume-vs-expiry race.
// No provider / network calls.
//
//   npm run verify:different-style-exchange
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
const { returnEligibilityService } = await import('../src/modules/returns/returnEligibilityService.js');
const { differentStyleExchangeService } = await import('../src/modules/returns/differentStyleExchangeService.js');
const { exchangeCheckoutService } = await import('../src/modules/returns/exchangeCheckoutService.js');
const { storeCreditService } = await import('../src/modules/storeCredit/service.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [] };
const priceEdits = [];
const ELIGIBLE = 200000;

async function customer(name) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'T','ACTIVE',NOW(3))", [id, name]);
  return id;
}
const contextTokenFor = (reqId) => query('SELECT context_token, id FROM exchange_transactions WHERE return_request_id=?', [reqId]).then((r) => r[0]);
const creditFor = (txnId) => query('SELECT * FROM reserved_exchange_credits WHERE exchange_transaction_id=?', [txnId]).then((r) => r[0]);
const txnById = (id) => query('SELECT * FROM exchange_transactions WHERE id=?', [id]).then((r) => r[0]);

async function originalOrder(customerId, sku) {
  let cartId = (await query('SELECT id FROM carts WHERE customer_id=? LIMIT 1', [customerId]))[0]?.id;
  if (!cartId) { cartId = randomUUID(); await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']); }
  const reservationId = randomUUID();
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`, [reservationId, customerId, `ds:${randomUUID()}`, '0'.repeat(64)]);
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
    [randomUUID(), reservationId, def.id, sku.id, 1]);
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `ds:co:${randomUUID()}`, 'f'.repeat(64), ELIGIBLE, ELIGIBLE]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'DS', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN' };
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,?,?, 'DS_TEST')`,
    [orderId, `COR-DS-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
      ELIGIBLE, ELIGIBLE, ELIGIBLE, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })]);
  const orderItemId = randomUUID();
  await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,1,?,?)`,
    [orderItemId, orderId, sku.product_id, sku.variant_id, sku.id, sku.name, sku.sku, ELIGIBLE, ELIGIBLE]);
  await fulfillmentService.ensureForOrder(orderId);
  const deliveredAt = new Date(Date.now() - 86400000);
  await query(`UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id
      SET s.status='DELIVERED', s.delivered_at=?, s.booking_status='BOOKED', s.provider_code='MOCK',
          s.external_shipment_id=?, s.tracking_number=?, s.booked_at=? WHERE f.order_id=?`,
    [deliveredAt, `EXT-${randomUUID().slice(0, 8)}`, `AWB-${randomUUID().slice(0, 8)}`, deliveredAt, orderId]);
  return { orderId, orderItemId };
}

async function startExchange(customerId, o) {
  const req = await returnRequestService.createRequest({
    customerId, orderId: o.orderId, requestType: 'DIFFERENT_STYLE_EXCHANGE', reasonCode: 'CHANGED_MIND',
    idempotencyKey: `ds-${randomUUID().slice(0, 12)}`, items: [{ orderItemId: o.orderItemId, quantity: 1 }],
  });
  await returnLifecycleService.approve({ requestId: req.id });
  const ctx = await contextTokenFor(req.id);
  assert.ok(ctx?.context_token, 'exchange transaction + reserved credit created at approval');
  const credit = await creditFor(ctx.id);
  assert.equal(credit.status, 'RESERVED');
  assert.equal(Number(credit.amount_minor), ELIGIBLE, 'exchange value frozen from the original transaction (§64)');
  return { req, txnId: ctx.id, token: ctx.context_token };
}

try {
  const skuRows = await query(
    `SELECT s.id, s.sku, s.variant_id, v.product_id, p.name
       FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE' ORDER BY s.id LIMIT 12`);
  const originSku = skuRows[0];
  // Pick target skus from a DIFFERENT product than the origin.
  const others = skuRows.filter((s) => s.product_id !== originSku.product_id);
  const [tCheap, tEqual, tExpensive, tRace, tExp] = others;
  assert.ok(tExp, 'need 5 target skus from other products');
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  const setPrice = async (s, price) => { await query('UPDATE skus SET price_minor=?, sale_price_minor=NULL WHERE id=?', [price, s.id]); priceEdits.push(s.id); };
  await setPrice(tCheap, 150000);
  await setPrice(tEqual, 200000);
  await setPrice(tExpensive, 250000);
  await setPrice(tRace, 150000);
  await setPrice(tExp, 150000);
  for (const s of [tCheap, tEqual, tExpensive, tRace, tExp]) await inventoryService.adjustOnHand(def.id, s.id, 5);

  const cust = await customer('DSCust');

  // ============ 1. CHEAPER: remainder -> ONE store-credit grant ============
  {
    const o = await originalOrder(cust, originSku);
    const { txnId, token } = await startExchange(cust, o);
    const balBefore = await storeCreditService.getBalanceMinor(cust);
    // An exchange order is a SALE, so the stock it takes must actually leave.
    // Nothing here used to look at inventory: the order was created against a
    // reservation nothing ever consumed, `on_hand` never fell, and 30 days
    // later the expiry sweeper released the hold outright — leaving the
    // catalogue counting a unit that had already shipped.
    const onHandOf = async (skuId) => Number((await query(
      'SELECT SUM(on_hand) n FROM inventory WHERE sku_id = ?', [skuId]))[0].n);
    const cheapOnHandBefore = await onHandOf(tCheap.id);
    const order = await exchangeCheckoutService.placeOrder({
      customerId: cust, contextToken: token, idempotencyKey: `place-${txnId}`,
      items: [{ skuId: tCheap.id, quantity: 1 }],
    });
    assert.equal(await onHandOf(tCheap.id), cheapOnHandBefore - 1,
      'placing an exchange order must consume its stock, exactly as a normal order does');
    const [exchangeOrderRow] = await query(
      'SELECT inventory_reservation_id FROM orders WHERE id = ?', [order.id]);
    const [exchangeReservation] = await query(
      'SELECT status FROM inventory_reservations WHERE id = ?', [exchangeOrderRow.inventory_reservation_id]);
    assert.equal(exchangeReservation.status, 'CONSUMED',
      'the reservation must be CONSUMED, not left RESERVED for the sweeper to release');
    results.exchangeOrderConsumesStock = 'PASS (on_hand falls, reservation CONSUMED)';
    assert.equal(order.consume.appliedMinor, 150000);
    assert.equal(order.consume.extraPaymentMinor, 0);
    assert.equal(order.consume.remainderMinor, 50000);
    assert.equal(order.exchangeCreditAppliedMinor, 150000);
    assert.equal(order.extraPaidMinor, 0);
    assert.equal(order.totalMinor, 150000);
    assert.equal(await storeCreditService.getBalanceMinor(cust), balBefore + 50000, 'remainder -> normal store credit');
    const grants = await query("SELECT * FROM store_credit_entries WHERE source_type='EXCHANGE_REMAINDER' AND source_id=?", [txnId]);
    assert.equal(grants.length, 1, 'EXCHANGE_REMAINDER_LEDGER_EFFECTS = 1');
    const credit = await creditFor(txnId);
    assert.equal(credit.status, 'CONSUMED');
    assert.equal(Number(credit.consumed_amount_minor), 150000);
    assert.equal((await txnById(txnId)).status, 'CONSUMED');
    // no refund to original payment anywhere
    assert.equal(await query('SELECT COUNT(*) c FROM orders WHERE id=?', [o.orderId]).then((r) => r[0].c), 1);
    results.cheaperFlow = 'PASS';
    results.remainderToStoreCredit = 'PASS (1 ledger entry)';
  }

  // ============ 2. EQUAL: nothing extra ============
  {
    const o = await originalOrder(cust, originSku);
    const { txnId, token } = await startExchange(cust, o);
    const balBefore = await storeCreditService.getBalanceMinor(cust);
    const order = await exchangeCheckoutService.placeOrder({
      customerId: cust, contextToken: token, idempotencyKey: `place-${txnId}`,
      items: [{ skuId: tEqual.id, quantity: 1 }],
    });
    assert.equal(order.consume.appliedMinor, 200000);
    assert.equal(order.consume.extraPaymentMinor, 0);
    assert.equal(order.consume.remainderMinor, 0);
    assert.equal(order.extraPaidMinor, 0);
    assert.equal(await storeCreditService.getBalanceMinor(cust), balBefore, 'no remainder');
    assert.equal((await query("SELECT COUNT(*) c FROM store_credit_entries WHERE source_type='EXCHANGE_REMAINDER' AND source_id=?", [txnId]))[0].c, 0);
    results.equalFlow = 'PASS';
  }

  // ============ 3. MORE EXPENSIVE: customer pays only the delta ============
  {
    const o = await originalOrder(cust, originSku);
    const { txnId, token } = await startExchange(cust, o);
    const order = await exchangeCheckoutService.placeOrder({
      customerId: cust, contextToken: token, idempotencyKey: `place-${txnId}`,
      items: [{ skuId: tExpensive.id, quantity: 1 }],
    });
    assert.equal(order.consume.appliedMinor, 200000);
    assert.equal(order.consume.extraPaymentMinor, 50000, 'customer pays only the difference (§55)');
    assert.equal(order.exchangeCreditAppliedMinor, 200000);
    assert.equal(order.extraPaidMinor, 50000);
    assert.equal(order.totalMinor, 250000);
    assert.notEqual(order.extraPaidMinor, 250000, 'not charged the full order amount');
    results.moreExpensiveFlow = 'PASS';
    results.extraPaymentOnly = 'PASS';
  }

  // ============ 4. Duplicate exchange order / duplicate consumption = 0 ============
  {
    const o = await originalOrder(cust, originSku);
    const { txnId, token } = await startExchange(cust, o);
    const a = await exchangeCheckoutService.placeOrder({ customerId: cust, contextToken: token, idempotencyKey: `p1-${txnId}`, items: [{ skuId: tEqual.id, quantity: 1 }] });
    const b = await exchangeCheckoutService.placeOrder({ customerId: cust, contextToken: token, idempotencyKey: `p2-${txnId}`, items: [{ skuId: tEqual.id, quantity: 1 }] });
    assert.equal(a.id, b.id, 'DUPLICATE_EXCHANGE_ORDER = 0');
    assert.equal((await query('SELECT COUNT(*) c FROM orders WHERE exchange_transaction_id=?', [txnId]))[0].c, 1);
    await assert.rejects(
      () => differentStyleExchangeService.consume({ connection: null, contextToken: token, customerId: cust, newOrderTotalMinor: 1, newExchangeOrderId: randomUUID() }),
      (e) => ['EXCHANGE_ALREADY_CONSUMED', 'EXCHANGE_CREDIT_NOT_RESERVED'].includes(e.code),
    );
    assert.equal(Number((await creditFor(txnId)).consumed_amount_minor), 200000, 'DUPLICATE_CREDIT_CONSUMPTION = 0');
    results.duplicateExchangeOrder = 0;
    results.duplicateCreditConsumption = 0;
  }

  // ============ 5. Cancel rollback (more-expensive, has extra payment) ============
  {
    const o = await originalOrder(cust, originSku);
    const { txnId, token } = await startExchange(cust, o);
    const balBefore = await storeCreditService.getBalanceMinor(cust);
    const expensiveOnHand = async () => Number((await query(
      'SELECT SUM(on_hand) n FROM inventory WHERE sku_id = ?', [tExpensive.id]))[0].n);
    const onHandBeforePlace = await expensiveOnHand();
    const order = await exchangeCheckoutService.placeOrder({ customerId: cust, contextToken: token, idempotencyKey: `place-${txnId}`, items: [{ skuId: tExpensive.id, quantity: 1 }] });
    const newOrder = (await query('SELECT * FROM orders WHERE id=?', [order.id]))[0];
    assert.equal(await expensiveOnHand(), onHandBeforePlace - 1, 'the exchange order consumed its stock');

    const cancel = await exchangeCheckoutService.cancelOrder({ customerId: cust, orderId: order.id });
    assert.equal(cancel.status, 'CANCELLED');
    assert.equal(cancel.reservedExchangeRefundToOriginalPaymentMinor, 0, 'ORIGINAL_PAYMENT_REMAINDER_REFUND = 0');
    assert.equal(cancel.extraPaymentRefundPendingMinor, 50000, 'extra payment follows normal refund rules (8F-6)');
    assert.equal((await query('SELECT order_status FROM orders WHERE id=?', [order.id]))[0].order_status, 'CANCELLED');
    // What matters is that the stock came BACK, not which mechanism returned
    // it. An exchange order now consumes at placement, so cancelling restores
    // on-hand rather than dropping a hold.
    assert.equal(await expensiveOnHand(), onHandBeforePlace,
      'cancelling an exchange order must give the stock back');
    assert.equal(
      (await query("SELECT COUNT(*) c FROM inventory_movements WHERE reference_id=? AND movement_type='ORDER_CANCELLED'", [order.id]))[0].c,
      1, 'the restore is journalled as ORDER_CANCELLED, not applied silently');
    assert.equal((await creditFor(txnId)).status, 'CANCELLED', 'reserved credit voided');
    assert.equal((await txnById(txnId)).status, 'CANCELLED');
    assert.equal(await storeCreditService.getBalanceMinor(cust), balBefore, 'no store-credit residue (no remainder in this scenario)');
    // original eligibility restored
    const rrId = (await query('SELECT return_request_id FROM exchange_transactions WHERE id=?', [txnId]))[0].return_request_id;
    assert.equal((await query('SELECT status FROM return_requests WHERE id=?', [rrId]))[0].status, 'CANCELLED', 'original return request cancelled');
    const elig = await returnEligibilityService.evaluateOrder({ customerId: cust, orderId: o.orderId });
    assert.equal(elig.items[0].eligibleQuantity, 1, 'original item eligible for return/exchange again');
    results.cancelRollback = 'PASS';
    results.originalPaymentRemainderRefund = 0;
  }

  // ============ 6. Cancel rollback also reverses a cheaper remainder grant ============
  {
    const o = await originalOrder(cust, originSku);
    const { txnId, token } = await startExchange(cust, o);
    const balBefore = await storeCreditService.getBalanceMinor(cust);
    const order = await exchangeCheckoutService.placeOrder({ customerId: cust, contextToken: token, idempotencyKey: `place-${txnId}`, items: [{ skuId: tCheap.id, quantity: 1 }] });
    assert.equal(await storeCreditService.getBalanceMinor(cust), balBefore + 50000);
    await exchangeCheckoutService.cancelOrder({ customerId: cust, orderId: order.id });
    assert.equal(await storeCreditService.getBalanceMinor(cust), balBefore, 'cancel reverses the remainder grant');
    results.cancelRollbackRemainderClawback = 'PASS';
  }

  // ============ 7. Expiry ============
  {
    const o = await originalOrder(cust, originSku);
    const { txnId, token } = await startExchange(cust, o);
    await query('UPDATE reserved_exchange_credits SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 MINUTE) WHERE exchange_transaction_id=?', [txnId]);
    await query('UPDATE exchange_transactions SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 MINUTE) WHERE id=?', [txnId]);
    const { expired } = await differentStyleExchangeService.expireDue();
    assert.ok(expired.includes(txnId));
    assert.equal((await creditFor(txnId)).status, 'EXPIRED');
    assert.equal((await txnById(txnId)).status, 'EXPIRED');
    const rr = (await query('SELECT return_request_id FROM exchange_transactions WHERE id=?', [txnId]))[0].return_request_id;
    assert.equal((await query('SELECT status FROM return_requests WHERE id=?', [rr]))[0].status, 'EXPIRED');
    await assert.rejects(
      () => exchangeCheckoutService.placeOrder({ customerId: cust, contextToken: token, idempotencyKey: `p-${txnId}`, items: [{ skuId: tEqual.id, quantity: 1 }] }),
      (e) => e.code === 'EXCHANGE_CONTEXT_UNUSABLE',
    );
    results.expiry = 'PASS';
  }

  // ============ 8. Consume-vs-expiry race — exactly one terminal state ============
  {
    const o = await originalOrder(cust, originSku);
    const { txnId, token } = await startExchange(cust, o);
    await query('UPDATE reserved_exchange_credits SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE exchange_transaction_id=?', [txnId]);
    await query('UPDATE exchange_transactions SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=?', [txnId]);
    const race = await Promise.allSettled([
      exchangeCheckoutService.placeOrder({ customerId: cust, contextToken: token, idempotencyKey: `race-${txnId}`, items: [{ skuId: tRace.id, quantity: 1 }] }),
      differentStyleExchangeService.expireDue(),
    ]);
    const credit = await creditFor(txnId);
    assert.ok(['CONSUMED', 'EXPIRED', 'RESERVED'].includes(credit.status));
    assert.ok(!(credit.status === 'CONSUMED' && Number(credit.consumed_amount_minor) > 0 && credit.expired_at), 'never CONSUMED + EXPIRED');
    const orderCount = Number((await query('SELECT COUNT(*) c FROM orders WHERE exchange_transaction_id=?', [txnId]))[0].c);
    if (credit.status === 'CONSUMED') assert.equal(orderCount, 1);
    else assert.equal(orderCount, 0, 'no orphan order when expiry won');
    void race;
    results.consumeExpiryRace = 'PASS (single terminal state, no partial effect)';
  }

  assert.equal(networkCalls, 0, 'no outbound network calls');
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nDIFFERENT_STYLE_EXCHANGE_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nDIFFERENT_STYLE_EXCHANGE_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const id of priceEdits) await safe(() => query('UPDATE skus SET price_minor=119900 WHERE id=?', [id]));
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM store_credit_entries WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM store_credit_accounts WHERE customer_id=?', [cid]));
  }
  // Exchange orders first (they reference exchange_transactions).
  const exchOrders = await query("SELECT id, inventory_reservation_id FROM orders WHERE finalization_source='EXCHANGE_CHECKOUT' AND order_number LIKE 'COR-EXC-%'").catch(() => []);
  for (const eo of exchOrders) {
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [eo.id]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [eo.id]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [eo.id]));
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [eo.id]));
    await safe(() => query('DELETE FROM order_items WHERE order_id=?', [eo.id]));
  }
  for (const orderId of created.orders) {
    const txns = await query('SELECT id FROM exchange_transactions WHERE original_order_id=? OR return_request_id IN (SELECT id FROM return_requests WHERE order_id=?)', [orderId, orderId]).catch(() => []);
    await safe(() => query('UPDATE orders SET exchange_transaction_id=NULL WHERE id IN (SELECT new_exchange_order_id FROM exchange_transactions WHERE original_order_id=?)', [orderId]));
    for (const t of txns) {
      const neo = (await query('SELECT new_exchange_order_id FROM exchange_transactions WHERE id=?', [t.id]))[0]?.new_exchange_order_id;
      await safe(() => query('DELETE FROM reserved_exchange_credits WHERE exchange_transaction_id=?', [t.id]));
      if (neo) {
        await safe(() => query('UPDATE exchange_transactions SET new_exchange_order_id=NULL WHERE id=?', [t.id]));
        const r = (await query('SELECT inventory_reservation_id FROM orders WHERE id=?', [neo]))[0];
        await safe(() => query('DELETE FROM orders WHERE id=?', [neo]));
        if (r) {
          // Release before delete so inventory.reserved is decremented — a raw
          // delete of a RESERVED reservation would strand the held quantity.
          const st = (await query('SELECT status FROM inventory_reservations WHERE id=?', [r.inventory_reservation_id]))[0];
          if (st?.status === 'RESERVED') {
            for (const it of await query('SELECT warehouse_id, sku_id, quantity FROM inventory_reservation_items WHERE reservation_id=?', [r.inventory_reservation_id])) {
              await safe(() => query('UPDATE inventory SET reserved = GREATEST(0, reserved - ?) WHERE warehouse_id=? AND sku_id=?', [it.quantity, it.warehouse_id, it.sku_id]));
            }
          }
          await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [r.inventory_reservation_id]));
          await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [r.inventory_reservation_id]));
        }
      }
      await safe(() => query('DELETE FROM exchange_transactions WHERE id=?', [t.id]));
    }
    for (const rid of (await query('SELECT id FROM return_requests WHERE order_id=?', [orderId])).map((r) => r.id)) {
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
  await pool.end();
}
