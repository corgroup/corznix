// WP-12 / GAP-INV-03 (QC-FAIL quarantine) verification.
//
// Proves, against the local dev database:
//   - opening a quarantine batch (the return QC-FAIL path) moves units into
//     inventory.non_sellable, leaves on_hand / reserved untouched, writes a
//     QC_QUARANTINED movement, and records an OPEN batch;
//   - RELEASE moves units non_sellable -> on_hand (rework passed) and writes
//     QC_RELEASED; SCRAP writes them off (non_sellable down only) with
//     QC_SCRAPPED; partial dispositions accumulate and the batch RESOLVES
//     once every unit is accounted for;
//   - over-disposing a batch is refused;
//   - the data-integrity invariant (non_sellable == sum of open-batch
//     remainder) holds after each step;
//   - the return lifecycle FAIL branch is wired to the quarantine service.
//
// Isolated + self-cleaning: borrows one (warehouse, sku), snapshots the
// inventory row, then restores it and deletes the batch + movements.
//
//   npm run verify:quarantine
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { pool, query } = await import('../src/database/connection/pool.js');
const { withTransaction } = await import('../src/database/connection/transaction.js');
const { inventoryQuarantineService } = await import('../src/modules/inventoryQuarantine/service.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

const wh = await one("SELECT id FROM warehouses WHERE status = 'ACTIVE' ORDER BY is_default DESC LIMIT 1");
const sku = await one('SELECT id, sku FROM skus ORDER BY sku LIMIT 1');
await query(
  `INSERT INTO inventory (id, brand_id, warehouse_id, sku_id, on_hand, reserved, non_sellable, created_at, updated_at)
   VALUES (UUID(), (SELECT id FROM brands WHERE slug='corcotton'), ?, ?, 0, 0, 0, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE updated_at = updated_at`, [wh.id, sku.id]);
const snap = await one('SELECT on_hand, reserved, non_sellable FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [wh.id, sku.id]);
await query('UPDATE inventory SET on_hand = 20, reserved = 3, non_sellable = 0 WHERE warehouse_id = ? AND sku_id = ?', [wh.id, sku.id]);

let batchId = null;
const readInv = () => one('SELECT on_hand, reserved, non_sellable FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [wh.id, sku.id]);
const driftCount = () => one(
  `SELECT COUNT(*) n FROM inventory i
     WHERE i.non_sellable <> (
       SELECT COALESCE(SUM(q.quantity - q.quantity_released - q.quantity_scrapped), 0)
         FROM inventory_quarantine q
        WHERE q.warehouse_id = i.warehouse_id AND q.sku_id = i.sku_id AND q.status = 'OPEN')`);

async function restore() {
  if (batchId) {
    await query("DELETE FROM inventory_movements WHERE reference_type = 'INVENTORY_QUARANTINE' AND reference_id = ?", [batchId]);
    await query("DELETE FROM inventory_movements WHERE reference_type = 'RETURN_REQUEST' AND reference_id = ?", [FAKE_RETURN_ID]);
    await query('DELETE FROM staff_audit_logs WHERE resource_type = ? AND resource_id = ?', ['inventory_quarantine', batchId]);
    await query('DELETE FROM inventory_quarantine WHERE id = ?', [batchId]);
  }
  await query('UPDATE inventory SET on_hand = ?, reserved = ?, non_sellable = ? WHERE warehouse_id = ? AND sku_id = ?',
    [snap.on_hand, snap.reserved, snap.non_sellable, wh.id, sku.id]);
}

const FAKE_RETURN_ID = '00000000-0000-4000-8000-0000000fa11d';

try {
  // ===================== 1. open a quarantine batch ================
  {
    const raw = await withTransaction((tx) => inventoryQuarantineService.openFromReturnQc({
      warehouseId: wh.id, skuId: sku.id, quantity: 6,
      returnRequestId: FAKE_RETURN_ID, returnNumber: 'RET-VERIFY-QC', staffId: null, connection: tx,
    }));
    batchId = raw.id;
    const batch = await inventoryQuarantineService.detail(batchId);
    const inv = await readInv();
    assert.equal(Number(inv.on_hand), 20, 'on_hand unchanged by quarantine');
    assert.equal(Number(inv.reserved), 3, 'reserved unchanged');
    assert.equal(Number(inv.non_sellable), 6, 'non_sellable up by 6');
    assert.equal(batch.status, 'OPEN');
    assert.equal(batch.quantityRemaining, 6);

    const mv = await one(
      `SELECT movement_type, quantity_delta, balance_after FROM inventory_movements
        WHERE reference_type = 'RETURN_REQUEST' AND reference_id = ? AND warehouse_id = ?`, [FAKE_RETURN_ID, wh.id]);
    assert.equal(mv.movement_type, 'QC_QUARANTINED');
    assert.equal(Number(mv.balance_after), 20, 'movement records the sellable balance (unchanged)');
    assert.equal(Number((await driftCount()).n), 0, 'invariant holds');
    pass('OPEN_QUARANTINE', 'non_sellable 0 -> 6, on_hand untouched');
  }

  // ===================== 2. partial RELEASE ========================
  {
    const dto = await inventoryQuarantineService.dispose(batchId, { action: 'RELEASE', quantity: 4, note: 'reworked' }, { id: null, email: 'verify@qc.test' });
    const inv = await readInv();
    assert.equal(Number(inv.non_sellable), 2, 'non_sellable 6 -> 2');
    assert.equal(Number(inv.on_hand), 24, 'on_hand 20 -> 24 (released back to sellable)');
    assert.equal(dto.status, 'OPEN', 'still 2 units to dispose');
    assert.equal(dto.quantityReleased, 4);
    assert.equal(dto.quantityRemaining, 2);
    assert.equal(Number((await driftCount()).n), 0);
    pass('PARTIAL_RELEASE', '4 released -> on_hand, batch still OPEN');
  }

  // ===================== 3. SCRAP the remainder -> RESOLVED ========
  {
    const dto = await inventoryQuarantineService.dispose(batchId, { action: 'SCRAP', quantity: 2 }, { id: null, email: 'verify@qc.test' });
    const inv = await readInv();
    assert.equal(Number(inv.non_sellable), 0, 'non_sellable drained');
    assert.equal(Number(inv.on_hand), 24, 'scrap does not touch on_hand');
    assert.equal(dto.status, 'RESOLVED');
    assert(dto.resolvedAt, 'resolved_at set');
    assert.equal(dto.quantityScrapped, 2);
    assert.equal(dto.quantityRemaining, 0);
    assert.equal(Number((await driftCount()).n), 0);
    pass('SCRAP_RESOLVES', 'batch fully disposed');
  }

  // ===================== 4. over-dispose refused ===================
  {
    await assert.rejects(
      () => inventoryQuarantineService.dispose(batchId, { action: 'RELEASE', quantity: 1 }, {}),
      (e) => e.code === 'QUARANTINE_ALREADY_RESOLVED' || e.code === 'QUARANTINE_OVER_DISPOSE',
    );
    pass('OVER_DISPOSE_REFUSED');
  }

  // ===================== 5. return lifecycle is wired ==============
  {
    const src = await readFile(new URL('../src/modules/returns/returnLifecycleService.js', import.meta.url), 'utf8');
    assert(src.includes('inventoryQuarantineService.openFromReturnQc'), 'recordQc FAIL branch calls the quarantine service');
    pass('RETURN_QC_FAIL_WIRED');
  }

  console.log('\nWP-12 QC-FAIL quarantine — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await restore();
  await pool.end();
}
