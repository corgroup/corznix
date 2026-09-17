// WP-12 (standalone Inventory CMS) verification.
//
// Proves, against the local dev database:
//   - adminInventoryService.list() returns cross-warehouse rows with derived
//     `available` + a low-stock flag; the q / warehouseId / lowStockOnly
//     filters and pagination `total` work;
//   - warehouse scoping — a staff member with no assignment sees nothing and
//     is 403'd on a detail they cannot access; an assigned one sees it;
//   - a manual adjustment now records actor_staff_id + balance_after, and
//     detail() surfaces the actor email + resulting on-hand;
//   - detail() shows open reservations for the (warehouse, sku);
//   - setThreshold() updates the row, writes a staff_audit_logs entry, flips
//     the low-stock flag, and null clears it.
//
// The inventory AUTHORITY is untouched — this only reads it and edits the
// low_stock_threshold hint. Isolated + self-cleaning: it uses one SKU that
// has no inventory row yet and removes everything it creates.
//
//   npm run verify:admin-inventory
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.INVENTORY_RESERVATION_EXPIRY_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { adminInventoryService } = await import('../src/modules/adminInventory/service.js');
const { inventoryService } = await import('../src/modules/inventory/service.js');
const { reconciliationService } = await import('../src/modules/reporting/reconciliationService.js');
const [__b] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
const BRAND_ID = __b.id;

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];
const tag = randomUUID().slice(0, 8);
// A few seconds of slack — staff_audit_logs writes created_at via NOW()
// (whole-second precision), so a millisecond-precise "now" can sort after it.
const scriptStartedAt = new Date(Date.now() - 5000);

const wh = await one('SELECT id, name FROM warehouses WHERE is_default = 1 LIMIT 1')
  || await one('SELECT id, name FROM warehouses ORDER BY priority LIMIT 1');
assert(wh, 'need at least one warehouse');

// The header's promise — a SKU with NO inventory row in this warehouse, whose
// row this script creates and drops again.
//
// It used to BORROW whatever row happened to sit at on_hand=0/reserved=0
// instead, which is why this script is quarantined in the CI advisory tier: a
// freshly seeded database stocks every SKU, so there was nothing to borrow and
// the run died on the assert; on an accumulated dev database it borrowed a row
// that already carried an OPEN reservation and then failed the
// `openReservations.length === 1` check. Owning the row removes both — the
// pair starts with no stock, no reservations and no history by construction.
const skuRow = await one(
  `SELECT s.id, s.sku FROM skus s
     LEFT JOIN inventory i ON i.sku_id = s.id AND i.warehouse_id = ?
    WHERE i.sku_id IS NULL AND s.status = 'ACTIVE'
    ORDER BY s.id LIMIT 1`, [wh.id]);
assert(skuRow, 'need one ACTIVE sku with no inventory row in the default warehouse');
const sku = { id: skuRow.id, sku: skuRow.sku };
await query(
  'INSERT INTO inventory (id, brand_id, warehouse_id, sku_id, on_hand, reserved) VALUES (?, ?, ?, ?, 0, 0)',
  [randomUUID(), BRAND_ID, wh.id, sku.id]);

const globalActor = { id: null, role: 'SUPER_ADMIN', email: `wp12-super-${tag}@x.test` };
let scopedStaffId = null;
let assignedStaffId = null;
let custId = null;
let reservationId = null;

async function makeStaff(label, role) {
  const id = randomUUID();
  const email = `wp12-${label}-${id.slice(0, 8)}-${tag}@x.test`;
  await query(
    "INSERT INTO staff_users (id,email,email_normalized,password_hash,first_name,last_name,role,status) VALUES (?,?,?,?,?,?,?,'ACTIVE')",
    [id, email, email, 'scrypt$1$1$1$x$x', 'W', 'P', role],
  );
  return { id, email };
}

try {
  // ---- seed: adjust the borrowed row up, with a real staff actor ----
  const scoped = await makeStaff('unassigned', 'OPERATIONS');
  const assigned = await makeStaff('assigned', 'OPERATIONS');
  scopedStaffId = scoped.id;
  assignedStaffId = assigned.id;
  await query('INSERT INTO staff_warehouse_assignments (id,staff_user_id,warehouse_id) VALUES (?,?,?)', [randomUUID(), assignedStaffId, wh.id]);

  await inventoryService.adjustStock({
    warehouseId: wh.id, skuId: sku.id, delta: 10, reason: `WP-12 verify ${tag}`, actorStaffId: assignedStaffId,
  });

  // ================= 1. list — global actor sees the row ================
  {
    const res = await adminInventoryService.list(globalActor, { q: sku.sku, limit: 50, offset: 0 });
    const row = res.items.find((r) => r.skuId === sku.id && r.warehouseId === wh.id);
    assert(row, 'the seeded row must appear in a q-filtered list');
    assert.equal(row.onHand, 10);
    assert.equal(row.reserved, 0);
    assert.equal(row.available, 10);
    assert.equal(row.lowStock, false);
    assert(res.total >= 1);
    pass('LIST_GLOBAL_ACTOR', `q filter + derived available; total=${res.total}`);
  }

  // ================= 2. warehouse filter + scope ========================
  {
    const scoped = await adminInventoryService.list({ id: scopedStaffId, role: 'OPERATIONS' }, { limit: 50 });
    assert.equal(scoped.items.length, 0);
    assert.equal(scoped.total, 0);
    const assigned = await adminInventoryService.list({ id: assignedStaffId, role: 'OPERATIONS' }, { q: sku.sku, limit: 50 });
    assert(assigned.items.some((r) => r.skuId === sku.id));
    pass('WAREHOUSE_SCOPE', 'unassigned staff see nothing; assigned staff see their warehouse');
  }

  // ================= 3. detail — actor + balance_after on the movement ==
  {
    await assert.rejects(
      () => adminInventoryService.detail({ id: scopedStaffId, role: 'OPERATIONS' }, wh.id, sku.id),
      (e) => e.code === 'WAREHOUSE_ACCESS_DENIED',
    );
    const d = await adminInventoryService.detail(globalActor, wh.id, sku.id);
    assert.equal(d.onHand, 10);
    const adj = d.movements.find((m) => m.type === 'MANUAL_ADJUSTMENT');
    assert(adj, 'the manual adjustment movement must be listed');
    assert.equal(adj.quantityDelta, 10);
    assert.equal(adj.balanceAfter, 10, 'balance_after must be recorded');
    assert.equal(adj.actor, assigned.email, 'the movement must carry the actor email');
    pass('DETAIL_MOVEMENT_AUDIT', 'movement viewer shows actor + on-hand-after');
  }

  // ================= 4. open reservations surface ======================
  {
    custId = randomUUID();
    await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,'T','ACTIVE',NOW(3))", [custId, `WP12-${tag}`]);
    const reservation = await inventoryService.reserve(
      [{ warehouseId: wh.id, skuId: sku.id, quantity: 3 }],
      { customerId: custId, idempotencyKey: `wp12-res-${tag}` },
    );
    reservationId = reservation.id;
    const d = await adminInventoryService.detail(globalActor, wh.id, sku.id);
    assert.equal(d.reserved, 3);
    assert.equal(d.available, 7);
    assert.equal(d.openReservations.length, 1);
    assert.equal(d.openReservations[0].quantity, 3);
    assert.equal(d.openReservations[0].customerId, custId);
    pass('OPEN_RESERVATIONS');
  }

  // ================= 5. threshold editor + audit + low-stock flag ======
  {
    const updated = await adminInventoryService.setThreshold(globalActor, wh.id, sku.id, 8);
    assert.equal(updated.lowStockThreshold, 8);
    assert.equal(updated.lowStock, true, 'available 7 <= threshold 8 -> low stock');

    const auditRow = await one(
      "SELECT * FROM staff_audit_logs WHERE action = 'INVENTORY_THRESHOLD_CHANGED' AND created_at >= ? ORDER BY created_at DESC LIMIT 1",
      [scriptStartedAt]);
    assert(auditRow, 'a staff_audit_logs row must be written');
    const meta = typeof auditRow.metadata_json === 'string' ? JSON.parse(auditRow.metadata_json) : auditRow.metadata_json;
    assert.equal(meta.to, 8);

    const cleared = await adminInventoryService.setThreshold(globalActor, wh.id, sku.id, null);
    assert.equal(cleared.lowStockThreshold, null);
    assert.equal(cleared.lowStock, false, 'no threshold -> never low stock');
    pass('THRESHOLD_EDITOR', 'set flips low-stock flag + audits; null clears');
  }

  // ================= 6. lowStockOnly filter ============================
  {
    await adminInventoryService.setThreshold(globalActor, wh.id, sku.id, 20); // 7 available <= 20
    const res = await adminInventoryService.list(globalActor, { lowStockOnly: true, limit: 200 });
    assert(res.items.some((r) => r.skuId === sku.id && r.warehouseId === wh.id), 'low-stock row must appear when lowStockOnly=true');
    await adminInventoryService.setThreshold(globalActor, wh.id, sku.id, null);
    pass('LOW_STOCK_FILTER');
  }

  // ================= 7. reconciliation catches reserved drift ==========
  {
    // Release the step-4 reservation first so the only drift is the one we induce.
    if (reservationId) { await inventoryService.releaseReservation(reservationId); reservationId = null; }
    // Induce drift: bump inventory.reserved with no matching reservation.
    await query('UPDATE inventory SET reserved = reserved + 2 WHERE warehouse_id = ? AND sku_id = ?', [wh.id, sku.id]);
    const scan = await reconciliationService.runScan(BRAND_ID);
    assert(scan.raised.INVENTORY_RESERVED_DRIFT >= 1, 'runScan must raise INVENTORY_RESERVED_DRIFT');
    const ex = await one(
      "SELECT * FROM reconciliation_exceptions WHERE exception_type = 'INVENTORY_RESERVED_DRIFT' AND reference_id = ?",
      [`${wh.id}:${sku.id}`]);
    assert(ex, 'an exception row must exist for the drifted (warehouse, sku)');
    assert.equal(Number(ex.actual_minor), 2, 'actual = the wrong reserved value');
    assert.equal(Number(ex.expected_minor), 0, 'expected = 0 (no open reservations)');
    // undo the induced drift + the exception
    await query('UPDATE inventory SET reserved = reserved - 2 WHERE warehouse_id = ? AND sku_id = ?', [wh.id, sku.id]);
    await query('DELETE FROM reconciliation_events WHERE exception_id = ?', [ex.id]);
    await query('DELETE FROM reconciliation_exceptions WHERE id = ?', [ex.id]);
    pass('RECONCILIATION_RESERVED_DRIFT', 'runScan raises INVENTORY_RESERVED_DRIFT with actual/expected');
  }

  console.log('\nWP-12 standalone Inventory CMS — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  if (reservationId) await safe(() => inventoryService.releaseReservation(reservationId));
  await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id IN (SELECT id FROM inventory_reservations WHERE idempotency_key LIKE ?)', [`wp12-res-${tag}%`]));
  await safe(() => query('DELETE FROM inventory_reservations WHERE idempotency_key LIKE ?', [`wp12-res-${tag}%`]));
  await safe(() => query('DELETE FROM inventory_movements WHERE warehouse_id = ? AND sku_id = ? AND created_at >= ?', [wh.id, sku.id, scriptStartedAt]));
  // The row is ours, so it goes rather than being reset to a remembered state.
  await safe(() => query('DELETE FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [wh.id, sku.id]));
  await safe(() => query("DELETE FROM staff_audit_logs WHERE action = 'INVENTORY_THRESHOLD_CHANGED' AND resource_id LIKE ?", [`${wh.id}%`]));
  if (custId) await safe(() => query('DELETE FROM customers WHERE id = ?', [custId]));
  for (const sid of [scopedStaffId, assignedStaffId]) {
    if (!sid) continue;
    await safe(() => query('DELETE FROM staff_warehouse_assignments WHERE staff_user_id = ?', [sid]));
    await safe(() => query('DELETE FROM staff_audit_logs WHERE staff_user_id = ?', [sid]));
    await safe(() => query('DELETE FROM staff_users WHERE id = ?', [sid]));
  }
  await pool.end();
}
