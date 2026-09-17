// Cart quantity limits and the checkout stock hold.
//
// - A stock refusal says how many are available, and how many are already in
//   the cart (the storefront shows those numbers).
// - A customer's OWN live checkout hold is not counted against them, in the
//   cart's availability or when they change a quantity. Other customers' holds
//   still are.
// - Keep-alive extends a live hold, never past its maximum lifetime and never
//   shortening a longer hold.
// - Renew takes a fresh hold on the SAME checkout (address kept); when stock is
//   short it names the item and how many are left, and the checkout stays expired.
// - An expired checkout is still "current" so it can be renewed; once its cart
//   changes it is cancelled instead.
//
//   npm run verify:cart-quantity-hold
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { cartService } = await import('../src/modules/cart/service.js');
const { checkoutService } = await import('../src/modules/checkout/service.js');
const { inventoryService } = await import('../src/modules/inventory/service.js');

const customers = [randomUUID(), randomUUID()];
const results = {};
const codeOf = async (promise) => { try { await promise; return { code: 'OK' }; } catch (error) { return { code: error?.code, details: error?.details }; } };
const minutesUntil = (date) => (new Date(date).getTime() - Date.now()) / 60000;

const [sku] = await query(`SELECT s.id, s.size, v.storefront_id FROM skus s
  JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
  WHERE s.status = 'ACTIVE' AND v.status = 'ACTIVE' AND p.status = 'ACTIVE' ORDER BY s.id LIMIT 1`);
const originals = await query('SELECT warehouse_id, on_hand, reserved FROM inventory WHERE sku_id = ?', [sku.id]);
const setStock = async (onHand) => {
  await query('UPDATE inventory SET on_hand = 0, reserved = 0 WHERE sku_id = ?', [sku.id]);
  await query('UPDATE inventory SET on_hand = ? WHERE sku_id = ? ORDER BY warehouse_id LIMIT 1', [onHand, sku.id]);
};
const reservedNow = async () => Number((await query('SELECT COALESCE(SUM(reserved), 0) r FROM inventory WHERE sku_id = ?', [sku.id]))[0].r);
const line = { storefrontId: sku.storefront_id, size: sku.size };

try {
  assert.ok(originals.length, 'test SKU has inventory rows');
  await setStock(4);
  for (const id of customers) {
    await query("INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), 'QtyHold', 'Test', 'ACTIVE', NOW(3))", [id]);
  }
  const [me, other] = customers;

  // 1 -- a refusal carries the numbers -----------------------------------------
  await cartService.addItem(me, { ...line, quantity: 3 });
  const tooMany = await codeOf(cartService.addItem(me, { ...line, quantity: 2 }));
  assert.equal(tooMany.code, 'INSUFFICIENT_STOCK');
  assert.deepEqual(
    { available: tooMany.details.available, inCart: tooMany.details.inCart, requested: tooMany.details.requested, maxAddable: tooMany.details.maxAddable },
    { available: 4, inCart: 3, requested: 2, maxAddable: 1 }, 'add refusal says 1 more can be added');
  const cartBefore = await cartService.getCart(me);
  assert.equal(cartBefore.items[0].availability.maxQuantity, 4, 'a cart line knows its ceiling');
  results.refusalCarriesNumbers = 'PASS';

  // 2 -- own hold is theirs; others' holds still count -----------------------------
  const checkout = await checkoutService.create(me, randomUUID());
  assert.equal(await reservedNow(), 3, 'checkout holds 3');
  const cartHolding = await cartService.getCart(me);
  assert.equal(cartHolding.items[0].availability.status, 'AVAILABLE', 'the cart does not call the customer\'s own held items unavailable');
  assert.equal(cartHolding.items[0].availability.maxQuantity, 4);
  const otherAdd = await codeOf(cartService.addItem(other, { ...line, quantity: 2 }));
  assert.equal(otherAdd.code, 'INSUFFICIENT_STOCK', 'another customer still sees the hold');
  assert.equal(otherAdd.details.available, 1);
  const overCeiling = await codeOf(cartService.updateQuantity(me, cartHolding.items[0].lineId, 5));
  assert.deepEqual([overCeiling.code, overCeiling.details?.maxQuantity], ['INSUFFICIENT_STOCK', 4], 'update refusal names the ceiling');
  results.ownHoldExcluded = 'PASS';

  // 3 -- keep-alive: capped, never shortens ---------------------------------------
  const row = (await query('SELECT inventory_reservation_id id FROM checkout_sessions WHERE id = ?', [checkout.id]))[0];
  await query('UPDATE inventory_reservations SET created_at = DATE_SUB(NOW(3), INTERVAL 50 MINUTE), expires_at = DATE_ADD(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?', [row.id]);
  await checkoutService.keepAlive(me, checkout.id);
  let hold = (await query('SELECT expires_at FROM inventory_reservations WHERE id = ?', [row.id]))[0];
  const capped = minutesUntil(hold.expires_at);
  assert.ok(capped > 9 && capped < 11, `extension stops at 60 min from the hold's start (got ${capped.toFixed(2)} min)`);
  const session = (await query('SELECT reservation_expires_at FROM checkout_sessions WHERE id = ?', [checkout.id]))[0];
  assert.equal(new Date(session.reservation_expires_at).getTime(), new Date(hold.expires_at).getTime(), 'checkout mirrors the hold expiry');
  await query('UPDATE inventory_reservations SET created_at = NOW(3), expires_at = DATE_ADD(NOW(3), INTERVAL 40 MINUTE) WHERE id = ?', [row.id]);
  await checkoutService.keepAlive(me, checkout.id);
  hold = (await query('SELECT expires_at FROM inventory_reservations WHERE id = ?', [row.id]))[0];
  assert.ok(minutesUntil(hold.expires_at) > 39, 'a longer (payment) hold is never shortened');
  results.keepAlive = 'PASS';

  // 4 -- renew on the same checkout, address kept --------------------------------
  await checkoutService.setAddress(me, checkout.id, {
    address: { firstName: 'Qty', lastName: 'Hold', phone: '9319987171', addressLine1: '1 Test Street', addressLine2: '', city: 'Delhi', state: 'Delhi', postalCode: '110001' },
    saveInfo: false,
  });
  const heldRow = (await query('SELECT inventory_reservation_id id FROM checkout_sessions WHERE id = ?', [checkout.id]))[0];
  await query('UPDATE inventory_reservations SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id = ?', [heldRow.id]);
  const lapsed = await checkoutService.get(me, checkout.id);
  assert.equal(lapsed.status, 'EXPIRED');
  assert.equal(await reservedNow(), 0, 'lapsed hold gave the stock back');
  const stillCurrent = await checkoutService.current(me);
  assert.equal(stillCurrent?.id, checkout.id, 'an expired checkout is still current, so it can be renewed');
  const renewed = await checkoutService.renew(me, checkout.id);
  assert.equal(renewed.id, checkout.id, 'same checkout');
  assert.equal(renewed.status, 'ACTIVE');
  assert.equal(renewed.inventory.reservationStatus, 'RESERVED');
  assert.equal(renewed.shippingAddress?.postalCode, '110001', 'address kept');
  assert.equal(await reservedNow(), 3, 'stock held again');
  const again = await checkoutService.renew(me, checkout.id);
  assert.equal(again.status, 'ACTIVE', 'renewing a live hold is a no-op');
  assert.equal(await reservedNow(), 3, 'no double hold');
  results.renewKeepsCheckout = 'PASS';

  // 5 -- renew when stock ran short names the item --------------------------------
  const renewedRow = (await query('SELECT inventory_reservation_id id FROM checkout_sessions WHERE id = ?', [checkout.id]))[0];
  await query('UPDATE inventory_reservations SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id = ?', [renewedRow.id]);
  await checkoutService.get(me, checkout.id);
  await query('UPDATE inventory SET on_hand = 2 WHERE sku_id = ? ORDER BY warehouse_id LIMIT 1', [sku.id]);
  const short = await codeOf(checkoutService.renew(me, checkout.id));
  assert.equal(short.code, 'INSUFFICIENT_STOCK');
  assert.equal(short.details?.unavailable?.length, 1, 'the short item is named');
  assert.deepEqual([short.details.unavailable[0].requested, short.details.unavailable[0].available, short.details.unavailable[0].size], [3, 2, sku.size]);
  assert.equal((await checkoutService.get(me, checkout.id)).status, 'EXPIRED', 'a failed renewal leaves the checkout expired');
  assert.equal(await reservedNow(), 0, 'and holds nothing');
  results.renewShortageNamed = 'PASS';

  // 6 -- expired + cart changed = cancelled, not renewed ---------------------------
  const myLine = (await cartService.getCart(me)).items[0];
  await cartService.updateQuantity(me, myLine.lineId, 2);
  assert.equal(await checkoutService.current(me), null, 'a changed cart retires the expired checkout');
  assert.equal((await checkoutService.renew(me, checkout.id)).status, 'CANCELLED', 'and it is never renewed with old items');
  results.changedCartCancels = 'PASS';

  results.status = 'PASS';
  console.log('\nCART_QUANTITY_HOLD_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nCART_QUANTITY_HOLD_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  const sessions = await query(`SELECT inventory_reservation_id id FROM checkout_sessions WHERE customer_id IN (${customers.map(() => '?').join(',')})`, customers);
  for (const s of sessions) await inventoryService.releaseReservation(s.id).catch(() => {});
  await query(`DELETE FROM checkout_sessions WHERE customer_id IN (${customers.map(() => '?').join(',')})`, customers);
  const reservations = await query(`SELECT id FROM inventory_reservations WHERE customer_id IN (${customers.map(() => '?').join(',')})`, customers);
  for (const r of reservations) {
    await query("DELETE FROM inventory_movements WHERE reference_type='INVENTORY_RESERVATION' AND reference_id=?", [r.id]);
    await query('DELETE FROM inventory_reservations WHERE id = ?', [r.id]);
  }
  await query(`DELETE FROM carts WHERE customer_id IN (${customers.map(() => '?').join(',')})`, customers);
  await query(`DELETE FROM addresses WHERE customer_id IN (${customers.map(() => '?').join(',')})`, customers);
  await query(`DELETE FROM customers WHERE id IN (${customers.map(() => '?').join(',')})`, customers);
  for (const o of originals) {
    await query('UPDATE inventory SET on_hand = ?, reserved = ? WHERE sku_id = ? AND warehouse_id = ?', [o.on_hand, o.reserved, sku.id, o.warehouse_id]);
  }
  await pool.end();
}
