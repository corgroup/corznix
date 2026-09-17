// Paying for a whole order with store credit, through the real services.
//
// Production placed exactly this order and answered 500: the customer had ₹1
// of credit from a cancellation, applied it, the page correctly said no online
// payment was required — and Place Order failed with nothing recorded. The
// ledger was untouched, so the transaction had rolled back. Nothing existed
// that ran checkout -> credit -> place order end to end, so it could not be
// seen before it reached a customer.
//
// Drives cart -> checkout -> address -> shipping -> eligibility -> store credit
// -> finalize against the real database, with the mock carrier. Everything it
// creates is removed again.
//
//   npm run verify:store-credit-order
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { cartService } = await import('../src/modules/cart/service.js');
const { checkoutService } = await import('../src/modules/checkout/service.js');
const { checkoutStoreCreditService } = await import('../src/modules/checkout/storeCreditService.js');
const { addressService } = await import('../src/modules/addresses/service.js');
const { paymentEligibilityService } = await import('../src/modules/paymentEligibility/service.js');
const { paymentService } = await import('../src/modules/payments/service.js');
const { orderFinalizationService } = await import('../src/modules/orders/service.js');
const { storeCreditService } = await import('../src/modules/storeCredit/service.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

const customerId = randomUUID();
const createdOrderIds = [];
let checkoutId = null;

// Carrier metadata is preferred but not required: seed:shipping-profiles is
// not part of the CI seed, so on a freshly seeded database no product has it
// and this gate could not run at all. Created as a fixture when missing, and
// removed again — the same way the tax mapping is handled elsewhere.
const sku = await one(`SELECT s.id, s.size, s.price_minor, v.storefront_id, p.id AS product_id,
          EXISTS (SELECT 1 FROM product_shipping_profiles psp WHERE psp.product_id = p.id AND psp.weight_grams > 0) AS has_profile
   FROM skus s JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
   JOIN inventory i ON i.sku_id = s.id
  WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'
  GROUP BY s.id HAVING SUM(i.on_hand - i.reserved) > 2
  ORDER BY has_profile DESC LIMIT 1`);
assert(sku, 'need one stocked, active SKU — run npm run seed && seed:warehouses');
const createdShippingProfileFor = Number(sku.has_profile) ? null : sku.product_id;
if (createdShippingProfileFor) {
  await query(
    `INSERT INTO product_shipping_profiles (id, product_id, weight_grams, length_mm, width_mm, height_mm, created_at, updated_at)
     VALUES (?,?,?,?,?,?,NOW(3),NOW(3))`,
    [randomUUID(), sku.product_id, 250, 250, 200, 40]);
}

async function cleanup() {
  for (const id of createdOrderIds) {
    await query('DELETE FROM order_items WHERE order_id = ?', [id]).catch(() => {});
    await query('DELETE FROM payment_obligations WHERE order_id = ?', [id]).catch(() => {});
    await query('DELETE FROM orders WHERE id = ?', [id]).catch(() => {});
  }
  if (checkoutId) {
    await query('DELETE FROM payment_obligations WHERE checkout_id = ?', [checkoutId]).catch(() => {});
    await query('DELETE FROM checkout_payment_eligibility WHERE checkout_id = ?', [checkoutId]).catch(() => {});
    await query('DELETE FROM checkout_sessions WHERE id = ?', [checkoutId]).catch(() => {});
  }
  // Give the held stock back BEFORE deleting the reservation rows: deleting
  // them alone leaves inventory.reserved counting a hold that no longer
  // exists, which is exactly what verify:data-integrity checks.
  const held = await query(
    `SELECT ri.sku_id, ri.warehouse_id, ri.quantity FROM inventory_reservation_items ri
       JOIN inventory_reservations r ON r.id = ri.reservation_id
      WHERE r.customer_id = ? AND r.status = 'RESERVED'`, [customerId]).catch(() => []);
  for (const h of held) {
    // eslint-disable-next-line no-await-in-loop
    await query('UPDATE inventory SET reserved = GREATEST(reserved - ?, 0) WHERE sku_id = ? AND warehouse_id = ?',
      [h.quantity, h.sku_id, h.warehouse_id]).catch(() => {});
  }
  await query('DELETE FROM inventory_reservation_items WHERE reservation_id IN (SELECT id FROM inventory_reservations WHERE customer_id = ?)', [customerId]).catch(() => {});
  await query('DELETE FROM inventory_reservations WHERE customer_id = ?', [customerId]).catch(() => {});
  await query('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE customer_id = ?)', [customerId]).catch(() => {});
  await query('DELETE FROM carts WHERE customer_id = ?', [customerId]).catch(() => {});
  await query('DELETE FROM store_credit_entries WHERE customer_id = ?', [customerId]).catch(() => {});
  await query('DELETE FROM store_credit_accounts WHERE customer_id = ?', [customerId]).catch(() => {});
  await query('DELETE FROM addresses WHERE customer_id = ?', [customerId]).catch(() => {});
  await query('DELETE FROM customers WHERE id = ?', [customerId]).catch(() => {});
  if (createdShippingProfileFor) {
    await query('DELETE FROM product_shipping_profiles WHERE product_id = ?', [createdShippingProfileFor]).catch(() => {});
  }
}

try {
  await query(`INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at)
    VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), 'Credit', 'Order', 'ACTIVE', NOW(3))`, [customerId]);
  await cartService.addItem(customerId, { storefrontId: sku.storefront_id, size: sku.size, quantity: 1 });

  const checkout = await checkoutService.create(customerId, randomUUID());
  checkoutId = checkout.id;
  const address = await addressService.create(customerId, {
    firstName: 'Credit', lastName: 'Order', phone: '9812345671',
    addressLine1: '1 Test Street', city: 'Delhi', state: 'Delhi', postalCode: '110001', country: 'India',
  });
  await checkoutService.setAddress(customerId, checkout.id, { addressId: address.id });
  const serviceable = await checkoutService.checkServiceability(customerId, checkout.id);
  // A method carries its options; the quote id lives on the option.
  const option = (serviceable.shippingMethods || []).flatMap((m) => m.options || [])[0];
  assert(option?.quoteId, 'the mock carrier returned no shipping option');
  await checkoutService.selectShipping(customerId, checkout.id, option.quoteId);

  const total = Number((await one('SELECT total_minor FROM checkout_sessions WHERE id = ?', [checkout.id])).total_minor);
  await storeCreditService.applyEntry({
    customerId, amountMinor: total, entryType: 'GRANT', sourceType: 'VERIFY_FIXTURE',
    sourceId: checkout.id, idempotencyKey: `verify-credit-order-${randomUUID()}`, reason: 'fixture',
  });

  await paymentEligibilityService.evaluate(customerId, checkout.id);
  await paymentEligibilityService.selectMode(customerId, checkout.id, 'PREPAID');
  const applied = await checkoutStoreCreditService.apply(customerId, checkout.id, 'MAX');
  assert.equal(applied.appliedMinor, total, 'the whole order is covered by credit');

  // 1 — with the order fully covered, no gateway is involved at all
  const session = await paymentService.createSession(customerId, checkout.id, { providerCode: null });
  assert.equal(session.status, 'ONLINE_PAYMENT_NOT_REQUIRED', `expected no online payment, got ${session.status}`);
  assert.equal(session.paymentPlan.onlineDueMinor, 0);
  assert.equal(session.attempt, null, 'no payment attempt is created');
  pass('FULLY_COVERED_ORDER_NEEDS_NO_GATEWAY', `${total} minor`);

  // 2 — and it can actually be placed. This is the production 500.
  const order = await orderFinalizationService.finalize(checkout.id, { customerId, source: 'CUSTOMER_PLACE_ORDER' });
  assert.ok(order?.id, 'the order was created');
  createdOrderIds.push(order.id);
  assert.equal(order.payment_status, 'PAID', 'an order paid entirely from the balance is PAID');
  const row = await one('SELECT store_credit_applied_minor, online_paid_minor, cod_due_minor, total_minor FROM orders WHERE id = ?', [order.id]);
  assert.equal(Number(row.store_credit_applied_minor), total, 'what the balance paid is frozen on the order');
  assert.equal(Number(row.online_paid_minor) + Number(row.cod_due_minor) + Number(row.store_credit_applied_minor), Number(row.total_minor),
    'online + on delivery + balance = the order, exactly');
  pass('ORDER_IS_PLACED_AND_PAID_FROM_THE_BALANCE', order.order_number);

  // 3 — the ledger moved exactly once, and the balance is now zero
  const debits = await query("SELECT * FROM store_credit_entries WHERE source_type = 'ORDER_PAYMENT' AND source_id = ?", [order.id]);
  assert.equal(debits.length, 1, 'one debit');
  assert.equal(Number(debits[0].amount_minor), -total);
  assert.equal(await storeCreditService.getBalanceMinor(customerId), 0, 'the balance is spent');
  const [{ ledger }] = await query('SELECT COALESCE(SUM(amount_minor),0) ledger FROM store_credit_entries WHERE customer_id = ?', [customerId]);
  assert.equal(Number(ledger), 0, 'ledger and balance agree');
  pass('LEDGER_DEBITED_ONCE_AND_AGREES');

  console.log('\nStore credit order — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nSTORE_CREDIT_ORDER_VERIFICATION = FAIL');
  console.error(error?.code ? `${error.code}: ${error.message}` : error);
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
  await pool.end();
}
