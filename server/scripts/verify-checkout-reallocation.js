// Checkout address-change reallocation proof.
//
// `CheckoutService.reallocateForAddress` is ONE transaction: lock the checkout,
// re-run allocation for the new destination, and only if the warehouse split
// actually changed — reserve the new split, release the old, swap the pointer.
// Any failure after the lock rolls back and leaves the EXISTING reservation
// fully valid. This script proves both the happy swap and the rollback.
//
//   npm run verify:checkout:reallocation
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { cartService } = await import('../src/modules/cart/service.js');
const { checkoutService } = await import('../src/modules/checkout/service.js');
const { warehouseService } = await import('../src/modules/warehouses/service.js');
const { inventoryService } = await import('../src/modules/inventory/service.js');

let providerCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { providerCalls += 1; return realFetch?.(...args); };

const results = {};
const TAG = `realloc-${Date.now()}`;
const ADDR = { firstName: 'Realloc', lastName: 'Test', phone: '9319987171', addressLine1: '1 Test Street', addressLine2: '', city: 'Delhi', state: 'Delhi', postalCode: '110001' };

const customers = [];
let lkoId = null;
const GZ = (await query('SELECT id FROM warehouses WHERE is_default = 1 LIMIT 1'))[0].id;

const sku = (await query(
  `SELECT s.id, s.size, v.storefront_id
     FROM skus s JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
     JOIN inventory i ON i.sku_id = s.id AND i.warehouse_id = ?
    WHERE s.status = 'ACTIVE' AND v.status = 'ACTIVE' AND p.status = 'ACTIVE' ORDER BY s.id LIMIT 1`, [GZ],
))[0];
assert.ok(sku, 'an active SKU with inventory at the default warehouse is required');

const originalGz = (await query('SELECT on_hand, reserved FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [GZ, sku.id]))[0];

const setStock = (warehouseId, onHand, reserved = 0) => query(
  `INSERT INTO inventory (id, brand_id, warehouse_id, sku_id, on_hand, reserved, created_at, updated_at)
   VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?, ?, ?, ?, NOW(3), NOW(3))
   ON DUPLICATE KEY UPDATE on_hand = VALUES(on_hand), reserved = VALUES(reserved), updated_at = NOW(3)`,
  [randomUUID(), warehouseId, sku.id, onHand, reserved],
);
const reservedAt = async (warehouseId) => Number(
  (await query('SELECT reserved FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [warehouseId, sku.id]))[0]?.reserved ?? 0,
);
const checkoutRow = (id) => query('SELECT inventory_reservation_id, warehouse_allocation_json FROM checkout_sessions WHERE id = ?', [id]).then((r) => r[0]);
const fingerprintOf = (row) => {
  const j = typeof row.warehouse_allocation_json === 'string' ? JSON.parse(row.warehouse_allocation_json) : row.warehouse_allocation_json;
  return j?.itemsFingerprint;
};
const reservationItems = (rid) => query('SELECT warehouse_id, sku_id, quantity FROM inventory_reservation_items WHERE reservation_id = ?', [rid]);

async function freshCheckout(emailPart, qty = 2) {
  const cid = randomUUID();
  customers.push(cid);
  await query("INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), 'Realloc', ?, 'ACTIVE', NOW(3))", [cid, emailPart]);
  await cartService.addItem(cid, { storefrontId: sku.storefront_id, size: sku.size, quantity: qty });
  const created = await checkoutService.create(cid, randomUUID());
  return { cid, checkoutId: created.id };
}

try {
  const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const lko = await warehouseService.create({ code: `WH-LKO-${TAG.slice(-8)}`, name: 'Lucknow Realloc FC', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN', priority: 10, brandId: cottonBrand.id });
  lkoId = lko.id;

  // ---------------------------------------------------------------------
  // A. Happy path — address change flips the origin warehouse
  // ---------------------------------------------------------------------
  {
    await setStock(GZ, 0, 0);
    await setStock(lkoId, 5, 0);
    const { cid, checkoutId } = await freshCheckout('A', 2);

    let row = await checkoutRow(checkoutId);
    const firstReservation = row.inventory_reservation_id;
    const firstFingerprint = fingerprintOf(row);
    let items = await reservationItems(firstReservation);
    assert.equal(items.length, 1);
    assert.equal(items[0].warehouse_id, lkoId, 'initial allocation is Lucknow (only warehouse with stock)');
    assert.equal(Number(items[0].quantity), 2);
    assert.equal(await reservedAt(lkoId), 2);
    assert.equal(await reservedAt(GZ), 0);

    // Address set — allocation unchanged, no-op reallocation.
    await checkoutService.setAddress(cid, checkoutId, { address: ADDR, saveInfo: false });
    row = await checkoutRow(checkoutId);
    assert.equal(row.inventory_reservation_id, firstReservation, 'no swap when the split is unchanged');
    assert.equal(fingerprintOf(row), firstFingerprint, 'fingerprint unchanged');

    // Stock moves: Lucknow drained (on_hand == reserved => available 0), the
    // default warehouse restocked. Never touch `reserved` under a live hold.
    await query('UPDATE inventory SET on_hand = 2, updated_at = NOW(3) WHERE warehouse_id = ? AND sku_id = ?', [lkoId, sku.id]);
    await setStock(GZ, 5, 0);

    // Address change -> reallocation -> atomic swap.
    await checkoutService.setAddress(cid, checkoutId, { address: { ...ADDR, postalCode: '110002' }, saveInfo: false });
    row = await checkoutRow(checkoutId);
    const secondReservation = row.inventory_reservation_id;
    assert.notEqual(secondReservation, firstReservation, 'reservation pointer swapped');
    assert.notEqual(fingerprintOf(row), firstFingerprint, 'allocation fingerprint changed');

    const oldStatus = (await query('SELECT status FROM inventory_reservations WHERE id = ?', [firstReservation]))[0].status;
    const newStatus = (await query('SELECT status FROM inventory_reservations WHERE id = ?', [secondReservation]))[0].status;
    assert.equal(oldStatus, 'RELEASED', 'old reservation released exactly once');
    assert.equal(newStatus, 'RESERVED', 'new reservation active');

    items = await reservationItems(secondReservation);
    assert.equal(items.length, 1);
    assert.equal(items[0].warehouse_id, GZ, 'new allocation is the default warehouse');
    assert.equal(Number(items[0].quantity), 2);

    assert.equal(await reservedAt(lkoId), 0, 'Lucknow reserved decremented exactly once — no leak');
    assert.equal(await reservedAt(GZ), 2, 'default warehouse reserved incremented exactly once');
    results.addressChangeSwap = 'PASS (LKO -> GZP, old released, new reserved, no leak)';

    await checkoutService.cancel(cid, checkoutId);
    assert.equal(await reservedAt(GZ), 0, 'cancel releases the swapped reservation');
  }

  // ---------------------------------------------------------------------
  // B. Rollback — a failing new reservation leaves the old one fully valid
  // ---------------------------------------------------------------------
  {
    await setStock(GZ, 0, 0);
    await setStock(lkoId, 5, 0);
    const { cid, checkoutId } = await freshCheckout('B', 2);
    await checkoutService.setAddress(cid, checkoutId, { address: ADDR, saveInfo: false });

    let row = await checkoutRow(checkoutId);
    const beforeReservation = row.inventory_reservation_id;
    const beforeFingerprint = fingerprintOf(row);
    assert.equal(await reservedAt(lkoId), 2);

    // Make the default warehouse the winner, then force the reservation to fail.
    await query('UPDATE inventory SET on_hand = 2 WHERE warehouse_id = ? AND sku_id = ?', [lkoId, sku.id]); // LKO available 0
    await setStock(GZ, 5, 0);
    const realReserve = inventoryService.reserve.bind(inventoryService);
    inventoryService.reserve = async () => { throw Object.assign(new Error('injected reservation failure'), { code: 'INJECTED_FAILURE' }); };
    try {
      // best-effort reallocation swallows the failure; the address still updates
      await checkoutService.setAddress(cid, checkoutId, { address: { ...ADDR, postalCode: '110003' }, saveInfo: false });
    } finally {
      inventoryService.reserve = realReserve;
    }

    row = await checkoutRow(checkoutId);
    assert.equal(row.inventory_reservation_id, beforeReservation, 'reservation pointer unchanged after failed reallocation');
    assert.equal(fingerprintOf(row), beforeFingerprint, 'allocation snapshot unchanged');
    assert.equal((await query('SELECT status FROM inventory_reservations WHERE id = ?', [beforeReservation]))[0].status, 'RESERVED', 'old reservation still active');
    assert.equal(await reservedAt(lkoId), 2, 'old reserved units intact — no half-move');
    assert.equal(await reservedAt(GZ), 0, 'no phantom reservation at the target warehouse');

    // Recovery: with reserve working again, the swap completes cleanly.
    await checkoutService.setAddress(cid, checkoutId, { address: { ...ADDR, postalCode: '110004' }, saveInfo: false });
    row = await checkoutRow(checkoutId);
    assert.notEqual(row.inventory_reservation_id, beforeReservation, 'swap succeeds once reserve recovers');
    assert.equal(await reservedAt(lkoId), 0);
    assert.equal(await reservedAt(GZ), 2);
    assert.equal((await query('SELECT status FROM inventory_reservations WHERE id = ?', [beforeReservation]))[0].status, 'RELEASED');
    results.reallocationRollback = 'PASS (failed swap => old reservation intact; recovery clean)';

    await checkoutService.cancel(cid, checkoutId);
  }

  assert.equal(providerCalls, 0, 'no outbound provider calls');
  results.reservationLeak = 0;
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nCHECKOUT_REALLOCATION_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCHECKOUT_REALLOCATION_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  // Restore first, delete the fixture warehouse last — and never let one
  // failed step abort the rest of the teardown.
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup step failed:', e.message); } };
  if (originalGz) {
    await safe(() => query('UPDATE inventory SET on_hand = ?, reserved = ?, updated_at = NOW(3) WHERE warehouse_id = ? AND sku_id = ?',
      [Number(originalGz.on_hand), Number(originalGz.reserved), GZ, sku.id]));
  }
  for (const cid of customers) {
    await safe(() => query('DELETE ci FROM inventory_reservation_items ci JOIN inventory_reservations r ON r.id = ci.reservation_id WHERE r.customer_id = ?', [cid]));
    await safe(() => query('DELETE m FROM inventory_movements m JOIN inventory_reservations r ON r.id = m.reference_id WHERE r.customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM checkout_sessions WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM inventory_reservations WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE ci FROM cart_items ci JOIN carts c ON c.id = ci.cart_id WHERE c.customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM carts WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id = ?', [cid]));
  }
  if (lkoId) {
    await safe(() => query('DELETE FROM inventory_movements WHERE warehouse_id = ?', [lkoId]));
    await safe(() => query('DELETE FROM inventory_reservation_items WHERE warehouse_id = ?', [lkoId]));
    await safe(() => query('DELETE FROM inventory WHERE warehouse_id = ?', [lkoId]));
    await safe(() => query('DELETE FROM warehouses WHERE id = ? AND is_default = 0', [lkoId]));
  }
  await pool.end();
}
