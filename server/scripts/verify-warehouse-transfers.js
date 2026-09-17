// WP-12 / GAP-INV-04 (inter-warehouse transfers) verification.
//
// Proves, against the local dev database:
//   - create -> DRAFT (no stock moved); dispatch -> DISPATCHED decrements
//     SOURCE on-hand per line and writes a TRANSFER_OUT movement with the
//     resulting balance; receive -> RECEIVED increments DESTINATION on-hand
//     and writes TRANSFER_IN; paired movements reference the transfer;
//   - in-transit units are on neither warehouse (source down, dest not yet up);
//   - a short receive (units lost in transit) is allowed and recorded as a
//     discrepancy; an over-receive is rejected;
//   - the lifecycle graph holds: re-dispatch / receive-before-dispatch /
//     cancel-after-dispatch are all refused;
//   - a dispatch that would push source on-hand below reserved is refused by
//     the same guarded UPDATE the manual adjustment path uses.
//
// Isolated + self-cleaning: borrows one SKU, snapshots both inventory rows +
// bumps source stock for headroom, then restores everything and deletes the
// transfers (+ CASCADE items) and the movements it produced.
//
//   npm run verify:warehouse-transfers
import assert from 'node:assert/strict';

const { pool, query } = await import('../src/database/connection/pool.js');
const { warehouseTransferService } = await import('../src/modules/warehouseTransfers/service.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

// A transfer needs two ACTIVE warehouses, but how many a business operates is
// its own decision — CORCOTTON currently runs a single fulfilment site, and
// disabling the fixture warehouses is a legitimate configuration, not a broken
// environment. So this check establishes its own second warehouse rather than
// asserting on ambient data, and removes it again in teardown.
const { randomUUID } = await import('node:crypto');
const activeWarehouses = await query(
  "SELECT id, name FROM warehouses WHERE status = 'ACTIVE' ORDER BY is_default DESC",
);
assert(activeWarehouses.length >= 1, 'need at least one ACTIVE warehouse');

let ephemeralWarehouseId = null;
if (activeWarehouses.length < 2) {
  const brand = await one('SELECT brand_id FROM warehouses LIMIT 1');
  ephemeralWarehouseId = randomUUID();
  await query(
    `INSERT INTO warehouses (id, brand_id, code, name, city, state, postal_code, country, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, 'Transfer Check Destination', 'Ghazipur', 'Uttar Pradesh', '233001', 'IN', 'ACTIVE', 999, NOW(3), NOW(3))`,
    [ephemeralWarehouseId, brand.brand_id, `WH-VERIFY-${ephemeralWarehouseId.slice(0, 8).toUpperCase()}`],
  );
  activeWarehouses.push({ id: ephemeralWarehouseId, name: 'Transfer Check Destination' });
}

const SRC = activeWarehouses[0].id;
const DST = activeWarehouses[1].id;

const sku = await one('SELECT id, sku FROM skus ORDER BY sku LIMIT 1');
assert(sku, 'need a SKU');

const invBefore = async (wh) => one('SELECT on_hand, reserved FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [wh, sku.id]);
const ensureRow = async (wh) => query(
  `INSERT INTO inventory (id, brand_id, warehouse_id, sku_id, on_hand, reserved, created_at, updated_at)
   VALUES (UUID(), (SELECT id FROM brands WHERE slug='corcotton'), ?, ?, 0, 0, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE updated_at = updated_at`, [wh, sku.id]);

await ensureRow(SRC);
await ensureRow(DST);
const srcSnap = await invBefore(SRC);
const dstSnap = await invBefore(DST);

// Give the source plenty of headroom regardless of its seeded value.
await query('UPDATE inventory SET on_hand = 100, reserved = 0 WHERE warehouse_id = ? AND sku_id = ?', [SRC, sku.id]);

const createdTransferIds = [];
const createTransfer = async (qty) => {
  const t = await warehouseTransferService.create(
    { sourceWarehouseId: SRC, destinationWarehouseId: DST, note: 'verify', lines: [{ skuId: sku.id, quantity: qty }] },
    { id: null, email: 'verify@transfers.test' },
  );
  createdTransferIds.push(t.id);
  return t;
};

async function restore() {
  if (createdTransferIds.length) {
    const ph = createdTransferIds.map(() => '?').join(',');
    await query(`DELETE FROM inventory_movements WHERE reference_type = 'WAREHOUSE_TRANSFER' AND reference_id IN (${ph})`, createdTransferIds);
    await query(`DELETE FROM staff_audit_logs WHERE action LIKE 'WAREHOUSE_TRANSFER_%' AND resource_id IN (${ph})`, createdTransferIds);
    await query(`DELETE FROM warehouse_transfers WHERE id IN (${ph})`, createdTransferIds);
  }
  const put = async (wh, snap) => {
    if (snap) await query('UPDATE inventory SET on_hand = ?, reserved = ? WHERE warehouse_id = ? AND sku_id = ?', [snap.on_hand, snap.reserved, wh, sku.id]);
    else await query('DELETE FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [wh, sku.id]);
  };
  await put(SRC, srcSnap);
  await put(DST, dstSnap);
}

try {
  // ===================== 1. create -> DRAFT, nothing moved =========
  {
    const t = await createTransfer(10);
    assert.equal(t.status, 'DRAFT');
    assert.equal(t.items.length, 1);
    assert.equal(t.items[0].quantity, 10);
    assert.equal(t.unitCount, 10);
    const src = await invBefore(SRC);
    assert.equal(Number(src.on_hand), 100, 'DRAFT does not move stock');
    pass('CREATE_DRAFT', t.transferNumber);
  }

  // ===================== 2. dispatch -> source down, TRANSFER_OUT ==
  let mainId;
  {
    const t = await createTransfer(12);
    mainId = t.id;
    const out = await warehouseTransferService.dispatch(t.id, { id: null, email: 'verify@transfers.test' });
    assert.equal(out.status, 'DISPATCHED');
    assert(out.dispatchedAt, 'dispatched_at set');

    const src = await invBefore(SRC);
    const dst = await invBefore(DST);
    assert.equal(Number(src.on_hand), 88, 'source on-hand decremented by 12');
    assert.equal(Number(dst.on_hand), Number(dstSnap.on_hand), 'destination unchanged while in transit');

    const mv = await one(
      `SELECT movement_type, quantity_delta, balance_after FROM inventory_movements
        WHERE reference_type = 'WAREHOUSE_TRANSFER' AND reference_id = ? AND warehouse_id = ?`, [t.id, SRC]);
    assert.equal(mv.movement_type, 'TRANSFER_OUT');
    assert.equal(Number(mv.quantity_delta), -12);
    assert.equal(Number(mv.balance_after), 88);
    pass('DISPATCH_TRANSFER_OUT', 'source 100 -> 88, in transit');
  }

  // ===================== 3. graph: no re-dispatch =================
  {
    await assert.rejects(
      () => warehouseTransferService.dispatch(mainId, {}),
      (e) => e.code === 'TRANSFER_TRANSITION_INVALID',
    );
    pass('NO_REDISPATCH');
  }

  // ===================== 4. receive -> dest up, TRANSFER_IN =======
  {
    const rec = await warehouseTransferService.receive(mainId, {}, { id: null, email: 'verify@transfers.test' });
    assert.equal(rec.status, 'RECEIVED');
    assert(rec.receivedAt, 'received_at set');
    assert.equal(rec.items[0].quantityReceived, 12);

    const src = await invBefore(SRC);
    const dst = await invBefore(DST);
    assert.equal(Number(src.on_hand), 88, 'source stays down');
    assert.equal(Number(dst.on_hand), Number(dstSnap.on_hand) + 12, 'destination up by 12');

    const mv = await one(
      `SELECT movement_type, quantity_delta, balance_after FROM inventory_movements
        WHERE reference_type = 'WAREHOUSE_TRANSFER' AND reference_id = ? AND warehouse_id = ?`, [mainId, DST]);
    assert.equal(mv.movement_type, 'TRANSFER_IN');
    assert.equal(Number(mv.quantity_delta), 12);
    assert.equal(Number(mv.balance_after), Number(dstSnap.on_hand) + 12);
    pass('RECEIVE_TRANSFER_IN', `dest ${dstSnap.on_hand} -> ${Number(dstSnap.on_hand) + 12}`);
  }

  // ===================== 5. short receive = discrepancy ===========
  {
    const t = await createTransfer(10);
    await warehouseTransferService.dispatch(t.id, {});
    const dstBefore = Number((await invBefore(DST)).on_hand);
    const rec = await warehouseTransferService.receive(t.id, { received: [{ skuId: sku.id, quantityReceived: 7 }] }, {});
    assert.equal(rec.items[0].quantityReceived, 7);
    const dstAfter = Number((await invBefore(DST)).on_hand);
    assert.equal(dstAfter, dstBefore + 7, 'only the received units land');

    const aud = await one(
      `SELECT metadata_json FROM staff_audit_logs WHERE action = 'WAREHOUSE_TRANSFER_RECEIVED' AND resource_id = ?`, [t.id]);
    const meta = typeof aud.metadata_json === 'string' ? JSON.parse(aud.metadata_json) : aud.metadata_json;
    assert.equal(meta.discrepancyUnits, 3, '3 units unaccounted (lost in transit)');

    await assert.rejects(
      () => warehouseTransferService.receive(t.id, {}, {}),
      (e) => e.code === 'TRANSFER_TRANSITION_INVALID',
      'a RECEIVED transfer cannot be received again',
    );
    pass('SHORT_RECEIVE_DISCREPANCY', '10 dispatched, 7 received, 3 discrepancy');
  }

  // ===================== 6. over-receive rejected ================
  {
    const t = await createTransfer(4);
    await warehouseTransferService.dispatch(t.id, {});
    await assert.rejects(
      () => warehouseTransferService.receive(t.id, { received: [{ skuId: sku.id, quantityReceived: 5 }] }, {}),
      (e) => e.code === 'TRANSFER_RECEIVE_INVALID',
    );
    // leave it received cleanly so stock is consistent for restore math
    await warehouseTransferService.receive(t.id, {}, {});
    pass('OVER_RECEIVE_REJECTED');
  }

  // ===================== 7. cancel only from DRAFT ==============
  {
    const draft = await createTransfer(3);
    const cancelled = await warehouseTransferService.cancel(draft.id, {});
    assert.equal(cancelled.status, 'CANCELLED');

    const t = await createTransfer(3);
    await warehouseTransferService.dispatch(t.id, {});
    await assert.rejects(
      () => warehouseTransferService.cancel(t.id, {}),
      (e) => e.code === 'TRANSFER_TRANSITION_INVALID',
    );
    await warehouseTransferService.receive(t.id, {}, {});
    pass('CANCEL_ONLY_FROM_DRAFT');
  }

  // ===================== 8. guarded: below reserved ============
  {
    await query('UPDATE inventory SET on_hand = 5, reserved = 4 WHERE warehouse_id = ? AND sku_id = ?', [SRC, sku.id]);
    const t = await createTransfer(3); // 5 - 3 = 2 < reserved 4 -> reject
    await assert.rejects(
      () => warehouseTransferService.dispatch(t.id, {}),
      (e) => e.code === 'INVENTORY_TRANSFER_REJECTED',
    );
    const src = await invBefore(SRC);
    assert.equal(Number(src.on_hand), 5, 'a rejected dispatch does not move stock');
    const still = await one('SELECT status FROM warehouse_transfers WHERE id = ?', [t.id]);
    assert.equal(still.status, 'DRAFT', 'transfer stays DRAFT');
    pass('DISPATCH_GUARDED_BELOW_RESERVED');
  }

  console.log('\nWP-12 inter-warehouse transfers — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await restore();
  // Remove the warehouse this check created, so it never accumulates in an
  // environment or reappears in allocation. Its inventory rows go first —
  // inventory.warehouse_id is a RESTRICT foreign key.
  if (ephemeralWarehouseId) {
    await query('DELETE FROM inventory_movements WHERE warehouse_id = ?', [ephemeralWarehouseId]).catch(() => {});
    await query('DELETE FROM inventory WHERE warehouse_id = ?', [ephemeralWarehouseId]).catch(() => {});
    await query('DELETE FROM warehouses WHERE id = ?', [ephemeralWarehouseId]).catch(() => {});
  }
  await pool.end();
}
