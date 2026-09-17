// Multi-warehouse commerce foundation verification.
//
// Proves the inventory / allocation / reservation / fulfillment stack is
// GENERIC over the number of warehouses: the same code path serves 1, 3 or 4
// warehouses, and adding another warehouse is data-only (a CMS insert), never
// a code change. Runs against the local dev DB and fully cleans up after
// itself — every row it creates is removed in the finally block.
//
//   node scripts/verify-multi-warehouse-commerce.js
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { inventoryService } = await import('../src/modules/inventory/service.js');
const { warehouseService } = await import('../src/modules/warehouses/service.js');
const { warehouseRepository } = await import('../src/modules/warehouses/repository.js');
const { warehouseAllocationService, ALLOCATION_STATUS } = await import('../src/modules/warehouses/allocationService.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { StaffWarehouseAssignmentRepository } = await import('../src/modules/staff/repositories.js');
const { warehouseScopeForStaff, staffCanAccessWarehouse } = await import('../src/middleware/requireWarehouseAccess.js');

const results = {};
const assignments = new StaffWarehouseAssignmentRepository();

// --- throwaway identifiers -------------------------------------------------
const tag = randomUUID().slice(0, 8);
const created = { warehouses: [], reservations: [], checkouts: [], orders: [], customers: [], staff: [], carts: [] };
// Warehouses that pre-exist this run (the default warehouse + any fixtures).
// Parked as DISABLED for the duration so the allocation assertions see ONLY
// the warehouses this script controls, then restored verbatim in `finally`.
let parkedWarehouses = [];

const sig = () => query('SELECT warehouse_id,sku_id,on_hand,reserved FROM inventory ORDER BY warehouse_id,sku_id');

async function makeWarehouse(code, name, priority) {
  const [corcottonMW] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const w = await warehouseService.create({ code: `${code}-${tag}`, name, priority, city: name, state: 'UP', postalCode: '226001', country: 'IN', brandId: corcottonMW.id });
  created.warehouses.push(w.id);
  return w;
}

async function setStock(warehouseId, skuId, onHand) {
  await query(
    `INSERT INTO inventory (id, brand_id,warehouse_id,sku_id,on_hand,reserved,created_at,updated_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,0,NOW(3),NOW(3))
     ON DUPLICATE KEY UPDATE on_hand=VALUES(on_hand), reserved=0`,
    [randomUUID(), warehouseId, skuId, onHand],
  );
}

try {
  const skus = await query(
    `SELECT s.id, s.sku, s.price_minor, v.id AS variant_id, p.id AS product_id, p.name
       FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 2`,
  );
  assert(skus.length === 2, 'need two active SKUs seeded');
  const [skuA, skuB] = skus;

  parkedWarehouses = await query("SELECT id, status FROM warehouses WHERE status='ACTIVE'");
  if (parkedWarehouses.length) {
    await query(
      `UPDATE warehouses SET status='DISABLED' WHERE id IN (${parkedWarehouses.map(() => '?').join(',')})`,
      parkedWarehouses.map((w) => w.id),
    );
  }

  // ---------------------------------------------------------------------
  // 1. Warehouses are created as pure data — no code change, no migration
  // ---------------------------------------------------------------------
  const wLucknow = await makeWarehouse('WH-LKO', 'Lucknow', 10);
  const wGhazipur = await makeWarehouse('WH-GZP', 'Ghazipur', 20);
  const wVaranasi = await makeWarehouse('WH-VNS', 'Varanasi', 30);
  results.dynamicWarehouseCreation = 'PASS (3 warehouses created via service, data-only)';

  const active = await warehouseRepository.activeOrderedByPriority();
  const testIds = [wLucknow.id, wGhazipur.id, wVaranasi.id];
  assert(testIds.every((id) => active.some((w) => w.id === id)), 'new warehouses must be allocation candidates immediately');
  // priority order is honoured
  const testOrder = active.filter((w) => testIds.includes(w.id)).map((w) => w.id);
  assert.deepEqual(testOrder, [wLucknow.id, wGhazipur.id, wVaranasi.id], 'candidates must be priority-ordered');
  results.priorityOrdering = 'PASS';

  // ---------------------------------------------------------------------
  // 2. Single-warehouse allocation when one site can cover the whole order
  // ---------------------------------------------------------------------
  await setStock(wLucknow.id, skuA.id, 10);
  await setStock(wLucknow.id, skuB.id, 10);
  const single = await warehouseAllocationService.allocate({ items: [{ skuId: skuA.id, quantity: 2 }, { skuId: skuB.id, quantity: 1 }] });
  assert.equal(single.status, ALLOCATION_STATUS.ALLOCATED);
  assert.equal(single.strategy, 'SINGLE');
  assert.equal(single.allocations.length, 1);
  assert.equal(single.allocations[0].warehouseId, wLucknow.id);
  results.singleWarehouseAllocation = 'PASS';

  // ---------------------------------------------------------------------
  // 3. Split allocation across warehouses, minimal splits, priority first
  // ---------------------------------------------------------------------
  // No single warehouse can cover qty 5 (3 + 2 + 4) -> forces a split.
  await setStock(wLucknow.id, skuA.id, 3);
  await setStock(wGhazipur.id, skuA.id, 2);
  await setStock(wVaranasi.id, skuA.id, 4);
  const split = await warehouseAllocationService.allocate({ items: [{ skuId: skuA.id, quantity: 5 }] });
  assert.equal(split.status, ALLOCATION_STATUS.ALLOCATED);
  assert.equal(split.strategy, 'SPLIT');
  const totalSplit = split.allocations.reduce((sum, a) => sum + a.items.reduce((s, i) => s + i.quantity, 0), 0);
  assert.equal(totalSplit, 5, 'split quantities must sum to the requested quantity');
  assert.equal(split.allocations[0].warehouseId, wLucknow.id, 'highest-priority warehouse is used first');
  assert.equal(split.allocations[0].items[0].quantity, 3, 'takes all it can from the first warehouse');
  results.splitAllocation = 'PASS';

  // ---------------------------------------------------------------------
  // 4. Unallocatable when nothing anywhere can cover it
  // ---------------------------------------------------------------------
  const impossible = await warehouseAllocationService.allocate({ items: [{ skuId: skuA.id, quantity: 999 }] });
  assert.equal(impossible.status, ALLOCATION_STATUS.PARTIALLY_UNAVAILABLE);
  assert(impossible.unmet.some((u) => u.skuId === skuA.id));
  const nothing = await warehouseAllocationService.allocate({ items: [{ skuId: skuB.id, quantity: 1 }] });
  // skuB only stocked at Lucknow (10) from step 2 — still available
  assert.equal(nothing.status, ALLOCATION_STATUS.ALLOCATED);
  results.unallocatable = 'PASS';

  // ---------------------------------------------------------------------
  // 5. Warehouse-scoped reservation: reserved increments per warehouse only
  // ---------------------------------------------------------------------
  const before = JSON.stringify(await sig());
  const resv = await inventoryService.reserve(
    warehouseAllocationService.toReservationItems(split),
    { idempotencyKey: `mw-verify:resv:${tag}`, ttlSeconds: 120 },
  );
  created.reservations.push(resv.id);
  const lkoRow = (await query('SELECT reserved FROM inventory WHERE warehouse_id=? AND sku_id=?', [wLucknow.id, skuA.id]))[0];
  const gzpRow = (await query('SELECT reserved FROM inventory WHERE warehouse_id=? AND sku_id=?', [wGhazipur.id, skuA.id]))[0];
  assert.equal(Number(lkoRow.reserved), 3);
  assert.equal(Number(gzpRow.reserved), 2);
  const vnsRow = (await query('SELECT reserved FROM inventory WHERE warehouse_id=? AND sku_id=?', [wVaranasi.id, skuA.id]))[0];
  assert.equal(Number(vnsRow.reserved), 0, 'untouched warehouse is unaffected');
  await inventoryService.releaseReservation(resv.id);
  assert.equal(JSON.stringify(await sig()), before, 'release restores every warehouse exactly');
  results.warehouseScopedReservation = 'PASS';

  // ---------------------------------------------------------------------
  // 6. Per-warehouse availability probe is isolated
  // ---------------------------------------------------------------------
  const probeLko = await inventoryService.getWarehouseAvailability(wLucknow.id, [{ skuId: skuA.id, quantity: 4 }]);
  assert.equal(probeLko[0].status, 'INSUFFICIENT_STOCK'); // only 3 at Lucknow
  const probeVns = await inventoryService.getWarehouseAvailability(wVaranasi.id, [{ skuId: skuA.id, quantity: 4 }]);
  assert.equal(probeVns[0].status, 'AVAILABLE'); // exactly 4 at Varanasi
  const probeMissing = await inventoryService.getWarehouseAvailability(wGhazipur.id, [{ skuId: skuB.id, quantity: 1 }]);
  assert.equal(probeMissing[0].status, 'INVENTORY_NOT_CONFIGURED'); // skuB never stocked at Ghazipur
  results.warehouseScopedAvailability = 'PASS';

  // ---------------------------------------------------------------------
  // 7. Signed stock adjustment: movement + guard against < reserved
  // ---------------------------------------------------------------------
  const adj = await inventoryService.adjustStock({ warehouseId: wVaranasi.id, skuId: skuA.id, delta: 5, reason: `mw-verify ${tag}` });
  assert.equal(adj.onHandAfter - adj.onHandBefore, 5); // Varanasi 4 -> 9
  const mv = (await query(
    "SELECT * FROM inventory_movements WHERE warehouse_id=? AND sku_id=? AND movement_type='MANUAL_ADJUSTMENT' ORDER BY created_at DESC LIMIT 1",
    [wVaranasi.id, skuA.id],
  ))[0];
  assert(mv && Number(mv.quantity_delta) === 5, 'manual adjustment movement recorded');
  await query('DELETE FROM inventory_movements WHERE id=?', [mv.id]);
  // reserve most of it, then try to drop on-hand below reserved
  const guardResv = await inventoryService.reserve([{ warehouseId: wVaranasi.id, skuId: skuA.id, quantity: 8 }], { idempotencyKey: `mw-verify:guard:${tag}`, ttlSeconds: 120 });
  created.reservations.push(guardResv.id);
  await assert.rejects(
    () => inventoryService.adjustStock({ warehouseId: wVaranasi.id, skuId: skuA.id, delta: -5, reason: 'below reserved' }),
    (e) => e.code === 'INVENTORY_BELOW_RESERVED',
  );
  await inventoryService.releaseReservation(guardResv.id);
  results.signedAdjustmentAndGuard = 'PASS';

  // ---------------------------------------------------------------------
  // 8. THE proof: a 4th warehouse is added later with ZERO code change
  // ---------------------------------------------------------------------
  const wKanpur = await makeWarehouse('WH-KNP', 'Kanpur', 5); // best priority
  await setStock(wKanpur.id, skuA.id, 50);
  const afterFourth = await warehouseAllocationService.allocate({ items: [{ skuId: skuA.id, quantity: 5 }] });
  assert.equal(afterFourth.status, ALLOCATION_STATUS.ALLOCATED);
  assert.equal(afterFourth.strategy, 'SINGLE', 'the new highest-priority warehouse now covers it alone');
  assert.equal(afterFourth.allocations[0].warehouseId, wKanpur.id);
  results.fourthWarehouseZeroCodeChange = 'PASS (new warehouse participates immediately, data-only)';

  // ---------------------------------------------------------------------
  // 9. Split fulfillment: one Order -> one INITIAL fulfillment per warehouse,
  //    immutable warehouse snapshot, COD split == orders.cod_due_minor
  // ---------------------------------------------------------------------
  const customerId = randomUUID();
  created.customers.push(customerId);
  await query("INSERT INTO customers (id, brand_id,status) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), 'ACTIVE')", [customerId]);
  const cartId = randomUUID();
  created.carts.push(cartId);
  await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']);

  const price = Number(skuA.price_minor) || 50000;
  const qty = 5;              // 3 from Lucknow + 2 from Ghazipur
  const subtotal = price * qty;
  const codDue = subtotal;    // FULL_COD so the split invariant is non-trivial

  const reservationId = randomUUID();
  created.reservations.push(reservationId);
  await query(
    `INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`,
    [reservationId, customerId, `mw-verify:ful:${tag}`, '0'.repeat(64)],
  );
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)', [randomUUID(), reservationId, wLucknow.id, skuA.id, 3]);
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)', [randomUUID(), reservationId, wGhazipur.id, skuA.id, 2]);

  const checkoutId = randomUUID();
  created.checkouts.push(checkoutId);
  await query(
    `INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
        subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED', 'INR', ?, 0, ?, DATE_ADD(NOW(3), INTERVAL 1 DAY), DATE_ADD(NOW(3), INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `mw-verify:co:${tag}`, 'f'.repeat(64), subtotal, subtotal],
  );

  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'MW', lastName: 'Test', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN', phone: '9999999999' };
  await query(
    `INSERT INTO orders
       (id,brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
        subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,
        shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?,(SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'COD_DUE', 'FULL_COD', 'INR', ?, 0, ?, 0, ?, ?, ?, 'MULTI_WAREHOUSE_TEST')`,
    [orderId, `COR-MW-${tag.toUpperCase()}`, checkoutId, customerId, reservationId,
      subtotal, subtotal, codDue, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })],
  );
  await query(
    `INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [randomUUID(), orderId, skuA.product_id, skuA.variant_id, skuA.id, skuA.name, skuA.sku, qty, price, price * qty],
  );

  const primary = await fulfillmentService.ensureForOrder(orderId);
  assert.equal(primary.fulfillments.length, 2, 'one INITIAL fulfillment per origin warehouse');
  const fWarehouses = primary.fulfillments.map((f) => f.warehouseId).sort();
  assert.deepEqual(fWarehouses, [wLucknow.id, wGhazipur.id].sort());
  // immutable warehouse snapshot present + frozen
  for (const f of primary.fulfillments) {
    assert(f.warehouse && f.warehouse.warehouseId === f.warehouseId, 'warehouse snapshot embedded');
    assert(f.warehouse.code && f.warehouse.name, 'snapshot carries identity');
  }
  // COD split invariant
  const codRows = await query(
    `SELECT COALESCE(SUM(s.cod_collection_minor),0) AS total
       FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?`, [orderId],
  );
  assert.equal(Number(codRows[0].total), codDue, 'SUM(shipment.cod_collection_minor) must equal orders.cod_due_minor');
  const perFulfilmentCod = primary.fulfillments.map((f) => f.financial.codCollectionMinor).reduce((a, b) => a + b, 0);
  assert.equal(perFulfilmentCod, codDue);
  // idempotent
  const again = await fulfillmentService.ensureForOrder(orderId);
  assert.equal(again.fulfillments.length, 2);
  assert.equal(Number((await query("SELECT COUNT(*) n FROM fulfillments WHERE order_id=? AND fulfillment_type='INITIAL'", [orderId]))[0].n), 2);
  results.splitFulfillment = 'PASS (2 fulfillments, frozen snapshots, COD split exact, idempotent)';

  // snapshot immutability after rename
  await warehouseService.update(wLucknow.id, { name: 'Lucknow RENAMED' });
  const reread = await fulfillmentService.summaryForOrder(orderId);
  assert(reread.fulfillments.length === 2);
  const frozen = (await query('SELECT warehouse_snapshot_json FROM fulfillments WHERE order_id=? AND warehouse_id=?', [orderId, wLucknow.id]))[0];
  const snap = typeof frozen.warehouse_snapshot_json === 'string' ? JSON.parse(frozen.warehouse_snapshot_json) : frozen.warehouse_snapshot_json;
  assert.equal(snap.name, 'Lucknow', 'fulfillment warehouse snapshot is immutable after a later rename');
  results.immutableWarehouseSnapshot = 'PASS';

  // ---------------------------------------------------------------------
  // 10. Staff warehouse scoping
  // ---------------------------------------------------------------------
  const staffId = randomUUID();
  created.staff.push(staffId);
  await query(
    `INSERT INTO staff_users (id,email,email_normalized,password_hash,first_name,last_name,role,status,created_at,updated_at)
     VALUES (?,?,?,?,?,?, 'OPERATIONS', 'ACTIVE', NOW(), NOW())`,
    [staffId, `mw-${tag}@example.com`, `mw-${tag}@example.com`, 'x', 'MW', 'Ops'],
  );
  const opsStaff = { id: staffId, role: 'OPERATIONS' };
  // deny-by-default: an ordinary role with no assignments has NO warehouse access
  const unassigned = await warehouseScopeForStaff(opsStaff);
  assert.equal(unassigned.all, false, 'unassigned ordinary staff are not global');
  assert.deepEqual(unassigned.warehouseIds, [], 'unassigned ordinary staff see zero warehouses');
  assert.equal(await staffCanAccessWarehouse(opsStaff, wGhazipur.id), false, 'no assignment => no access');
  await assignments.assign(staffId, wGhazipur.id);
  const scoped = await warehouseScopeForStaff(opsStaff);
  assert.equal(scoped.all, false);
  assert.deepEqual(scoped.warehouseIds, [wGhazipur.id]);
  assert.equal(await staffCanAccessWarehouse(opsStaff, wGhazipur.id), true);
  assert.equal(await staffCanAccessWarehouse(opsStaff, wLucknow.id), false);
  // Company-wide administrative roles always see all warehouses.
  assert.equal((await warehouseScopeForStaff({ id: randomUUID(), role: 'SUPER_ADMIN' })).all, true);
  assert.equal((await warehouseScopeForStaff({ id: randomUUID(), role: 'ADMIN' })).all, true);
  results.staffWarehouseScoping = 'PASS';

  results.status = 'PASS';
  results.realProviderCalls = 0;
  console.log(JSON.stringify(results, null, 2));
} finally {
  // -------- cleanup (reverse dependency order) --------
  for (const w of parkedWarehouses) {
    await query('UPDATE warehouses SET status=? WHERE id=?', [w.status, w.id]);
  }
  for (const orderId of created.orders) {
    await query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]);
    await query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]);
    await query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]);
    await query('DELETE FROM fulfillments WHERE order_id=?', [orderId]);
    await query('DELETE FROM order_items WHERE order_id=?', [orderId]);
    await query('DELETE FROM orders WHERE id=?', [orderId]);
  }
  for (const checkoutId of created.checkouts) await query('DELETE FROM checkout_sessions WHERE id=?', [checkoutId]);
  for (const reservationId of created.reservations) {
    await query('DELETE FROM inventory_movements WHERE reference_id=?', [reservationId]);
    await query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [reservationId]);
    await query('DELETE FROM inventory_reservations WHERE id=?', [reservationId]);
  }
  for (const staffId of created.staff) {
    await query('DELETE FROM staff_warehouse_assignments WHERE staff_user_id=?', [staffId]);
    await query('DELETE FROM staff_audit_logs WHERE staff_user_id=?', [staffId]);
    await query('DELETE FROM staff_users WHERE id=?', [staffId]);
  }
  for (const cartId of created.carts) await query('DELETE FROM carts WHERE id=?', [cartId]);
  for (const customerId of created.customers) await query('DELETE FROM customers WHERE id=?', [customerId]);
  for (const warehouseId of created.warehouses) {
    await query('DELETE FROM inventory_movements WHERE warehouse_id=?', [warehouseId]);
    await query('DELETE FROM inventory WHERE warehouse_id=?', [warehouseId]);
    await query('DELETE FROM staff_warehouse_assignments WHERE warehouse_id=?', [warehouseId]);
    await query('DELETE FROM warehouses WHERE id=?', [warehouseId]);
  }
  await pool.end();
}
