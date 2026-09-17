// A confirmed order takes its items out of the cart — and takes ONLY those.
//
// Nothing did this at all: finalize() created the order, consumed the
// reservation and finished the checkout, but never touched the cart, so a
// customer who had paid still had the items they had just bought sitting in
// their cart. No code anywhere removed them except the customer's own
// "remove line" endpoint.
//
// Clearing it is not "empty the cart", though. The cart is the customer's, not
// a copy of the order: anything added after the checkout was created was not
// bought and must survive, and if the quantity was raised afterwards only the
// purchased part goes. The cart ROW is kept — checkout_sessions.cart_id is
// ON DELETE RESTRICT and the row is the cart's identity, not this order's
// basket.
//
// Drives the real services (cart -> checkout -> shipping -> verified payment
// -> finalize), not a stub, so it fails if any of that chain stops clearing.
//
// Requires:
//   PURCHASED_LINES_LEAVE_THE_CART      = PASS
//   LATER_ADDITIONS_SURVIVE             = PASS
//   RAISED_QUANTITY_KEEPS_THE_REMAINDER = PASS
//   REFINALIZE_IS_IDEMPOTENT            = PASS
//   CART_ROW_IS_KEPT                    = PASS
//
//   npm run verify:cart-clear
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { cartService } = await import('../src/modules/cart/service.js');
const { checkoutService } = await import('../src/modules/checkout/service.js');
const { paymentEligibilityService } = await import('../src/modules/paymentEligibility/service.js');
const { orderFinalizationService } = await import('../src/modules/orders/service.js');

const results = {};
const failures = [];
const pass = (name, detail) => { results[name] = detail ? `PASS (${detail})` : 'PASS'; console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`); };
const created = { customers: [] };

const skus = await query(`SELECT s.id, s.size, v.storefront_id FROM skus s
   JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
   JOIN inventory i ON i.sku_id=s.id
  WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE' AND i.on_hand > 20
  GROUP BY s.id ORDER BY s.id LIMIT 2`);
assert(skus.length >= 2, 'need two active, stocked SKUs — run npm run seed && seed:warehouses');

const cartLines = (cid) => query(
  'SELECT ci.sku_id, ci.quantity FROM cart_items ci JOIN carts c ON c.id=ci.cart_id WHERE c.customer_id=? ORDER BY ci.sku_id', [cid]);
const cartRow = (cid) => query('SELECT id FROM carts WHERE customer_id=?', [cid]);

async function newCustomer() {
  const cid = randomUUID();
  created.customers.push(cid);
  await query("INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),'CartClear','Verify','ACTIVE',NOW(3))", [cid]);
  await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
               VALUES (?,?, 'PHONE','+919319987171','+919319987171',1,NOW(3),'TEST',NOW(3),NOW(3))`, [randomUUID(), cid]);
  return cid;
}

/** cart -> checkout -> address -> shipping -> verified online payment. */
async function readyCheckout(cid) {
  const co = await checkoutService.create(cid, { idempotencyKey: randomUUID() });
  await checkoutService.setAddress(cid, co.id, {
    address: { firstName: 'CartClear', lastName: 'Verify', phone: '9319987171', addressLine1: '1 Test Street', city: 'Delhi', state: 'Delhi', postalCode: '110001' },
    saveInfo: false,
  });
  const serv = await checkoutService.checkServiceability(cid, co.id);
  await checkoutService.selectShipping(cid, co.id, serv.shippingMethods[0].options[0].quoteId);
  await paymentEligibilityService.evaluate(cid, co.id);
  await paymentEligibilityService.selectMode(cid, co.id, 'PREPAID');
  // Stand in for a settled gateway: the obligations a verified payment leaves.
  const [{ total_minor: total }] = await query('SELECT total_minor FROM checkout_sessions WHERE id=?', [co.id]);
  await query(`INSERT INTO payment_obligations (id, checkout_id, obligation_type, amount_minor, currency, status, source_payment_mode)
               VALUES (?,?,'ONLINE',?, 'INR','PAID','PREPAID'), (?,?,'COD',0,'INR','NOT_REQUIRED','PREPAID')
               ON DUPLICATE KEY UPDATE status=VALUES(status), amount_minor=VALUES(amount_minor)`,
  [randomUUID(), co.id, Number(total), randomUUID(), co.id]);
  return co.id;
}

try {
  // 1 + 5. The purchased line goes; the cart row itself stays.
  {
    const cid = await newCustomer();
    await cartService.addItem(cid, { storefrontId: skus[0].storefront_id, size: skus[0].size, quantity: 2 });
    assert.equal((await cartLines(cid)).length, 1);
    const checkoutId = await readyCheckout(cid);
    const order = await orderFinalizationService.finalize(checkoutId, { customerId: cid, source: 'PAYMENT_RECONCILIATION' });
    assert(order, 'the order must be created');
    assert.equal((await cartLines(cid)).length, 0, 'the purchased line must leave the cart');
    pass('PURCHASED_LINES_LEAVE_THE_CART', '2 units bought, 0 left');
    assert.equal((await cartRow(cid)).length, 1, 'the cart row must survive (FK is ON DELETE RESTRICT)');
    pass('CART_ROW_IS_KEPT', 'cart_items emptied, carts row intact');

    // 4. A recovery-worker re-finalize must not throw or disturb anything.
    const again = await orderFinalizationService.finalize(checkoutId, { customerId: cid, source: 'RECOVERY_WORKER' });
    assert.equal(again.orderNumber ?? again.order_number, order.orderNumber ?? order.order_number, 're-finalize must return the same order');
    assert.equal((await cartLines(cid)).length, 0);
    pass('REFINALIZE_IS_IDEMPOTENT', 'same order, nothing further removed');
  }

  // 2. Something added AFTER the checkout was built was not bought.
  {
    const cid = await newCustomer();
    await cartService.addItem(cid, { storefrontId: skus[0].storefront_id, size: skus[0].size, quantity: 1 });
    const checkoutId = await readyCheckout(cid);
    await cartService.addItem(cid, { storefrontId: skus[1].storefront_id, size: skus[1].size, quantity: 3 });
    await orderFinalizationService.finalize(checkoutId, { customerId: cid, source: 'PAYMENT_RECONCILIATION' });
    const left = await cartLines(cid);
    assert.equal(left.length, 1, 'only the later addition may remain');
    assert.equal(left[0].sku_id, skus[1].id);
    assert.equal(Number(left[0].quantity), 3, 'the later addition keeps its quantity');
    pass('LATER_ADDITIONS_SURVIVE', 'bought 1 of A, kept 3 of B');
  }

  // 3. Quantity raised after the checkout: only the purchased part goes.
  {
    const cid = await newCustomer();
    await cartService.addItem(cid, { storefrontId: skus[0].storefront_id, size: skus[0].size, quantity: 2 });
    const checkoutId = await readyCheckout(cid);
    await cartService.addItem(cid, { storefrontId: skus[0].storefront_id, size: skus[0].size, quantity: 3 }); // now 5
    assert.equal(Number((await cartLines(cid))[0].quantity), 5);
    await orderFinalizationService.finalize(checkoutId, { customerId: cid, source: 'PAYMENT_RECONCILIATION' });
    const left = await cartLines(cid);
    assert.equal(left.length, 1, 'the remainder must stay as a line');
    assert.equal(Number(left[0].quantity), 3, '5 in the cart minus 2 bought = 3');
    pass('RAISED_QUANTITY_KEEPS_THE_REMAINDER', '5 in cart, 2 bought, 3 left');
  }
} catch (error) {
  failures.push(error.message);
  console.error(`  FAIL  ${error.message}`);
} finally {
  // checkout_sessions.cart_id is ON DELETE RESTRICT, so the checkout rows go first.
  for (const cid of created.customers) {
    const safe = async (fn) => { try { await fn(); } catch { /* cleanup is best-effort */ } };
    await safe(() => query('DELETE FROM order_finalization_jobs WHERE checkout_id IN (SELECT id FROM checkout_sessions WHERE customer_id=?)', [cid]));
    await safe(() => query('DELETE FROM payment_obligations WHERE checkout_id IN (SELECT id FROM checkout_sessions WHERE customer_id=?)', [cid]));
    await safe(() => query('DELETE FROM orders WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM checkout_sessions WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  console.log('');
  console.log(JSON.stringify(results, null, 2));
  console.log('');
  console.log(`CART_CLEAR_VERIFICATION = ${failures.length ? 'FAIL' : 'PASS'}`);
  await pool.end();
  process.exit(failures.length ? 1 : 0);
}
