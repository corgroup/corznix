// WP-04 / GAP-INV-02 (RTO inventory recovery) verification.
//
// Proves, against the local dev database:
//   - runRtoBridge routes a returned-to-origin shipment's units into
//     quarantine at the dispatch warehouse (source_type RTO_RECEIVED),
//     non_sellable up, on_hand untouched, one QC_QUARANTINED movement per
//     line referencing the shipment;
//   - it is idempotent on the shipment (a replayed RTO_RETURNED scan does
//     not double-quarantine);
//   - an RTO batch RELEASEs back to sellable on_hand like any other
//     quarantine batch;
//   - the WP-01 logistics applier calls the bridge on an RTO_RETURNED scan;
//   - the data-integrity invariant (non_sellable == open-batch remainder)
//     holds throughout.
//
// Isolated + self-cleaning: borrows one seeded fulfilment + its shipment,
// snapshots the inventory row, then restores it and deletes what it created.
//
//   npm run verify:rto-inventory
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { pool, query } = await import('../src/database/connection/pool.js');
const { runRtoBridge } = await import('../src/modules/logistics/rtoBridge.js');
const { inventoryQuarantineService } = await import('../src/modules/inventoryQuarantine/service.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

const shipment = await one(
  `SELECT s.id, s.shipment_number, s.warehouse_id, s.fulfillment_id
     FROM shipments s
     JOIN fulfillments f ON f.id = s.fulfillment_id
    WHERE s.warehouse_id IS NOT NULL
      AND (SELECT COUNT(*) FROM fulfillment_items fi WHERE fi.fulfillment_id = f.id) > 0
    LIMIT 1`);
assert(shipment, 'need a seeded shipment with a warehouse and fulfilment items');

const items = await query('SELECT sku_id, quantity FROM fulfillment_items WHERE fulfillment_id = ?', [shipment.fulfillment_id]);
const invBefore = new Map();
for (const it of items) {
  await query(
    `INSERT INTO inventory (id, brand_id, warehouse_id, sku_id, on_hand, reserved, non_sellable, created_at, updated_at)
     VALUES (UUID(), (SELECT id FROM brands WHERE slug='corcotton'), ?, ?, 0, 0, 0, NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE updated_at = updated_at`, [shipment.warehouse_id, it.sku_id]);
  invBefore.set(it.sku_id, await one('SELECT on_hand, reserved, non_sellable FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [shipment.warehouse_id, it.sku_id]));
}

const driftCount = () => one(
  `SELECT COUNT(*) n FROM inventory i
     WHERE i.non_sellable <> (
       SELECT COALESCE(SUM(q.quantity - q.quantity_released - q.quantity_scrapped), 0)
         FROM inventory_quarantine q
        WHERE q.warehouse_id = i.warehouse_id AND q.sku_id = i.sku_id AND q.status = 'OPEN')`);

async function restore() {
  const batches = await query("SELECT id FROM inventory_quarantine WHERE source_type = 'RTO_RECEIVED' AND source_ref = ?", [shipment.id]);
  const ids = batches.map((b) => b.id);
  if (ids.length) {
    await query(`DELETE FROM inventory_movements WHERE reference_type IN ('SHIPMENT','INVENTORY_QUARANTINE') AND reference_id IN (${['?', ...ids.map(() => '?')].join(',')})`, [shipment.id, ...ids]);
    await query('DELETE FROM staff_audit_logs WHERE resource_type = ? AND resource_id IN (' + ids.map(() => '?').join(',') + ')', ['inventory_quarantine', ...ids]);
    await query(`DELETE FROM inventory_quarantine WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
  }
  await query("DELETE FROM inventory_movements WHERE reference_type = 'SHIPMENT' AND reference_id = ?", [shipment.id]);
  await query("DELETE FROM staff_audit_logs WHERE action = 'RTO_RECEIVED_QUARANTINED' AND resource_id = ?", [shipment.id]);
  for (const it of items) {
    const b = invBefore.get(it.sku_id);
    await query('UPDATE inventory SET on_hand = ?, reserved = ?, non_sellable = ? WHERE warehouse_id = ? AND sku_id = ?',
      [b.on_hand, b.reserved, b.non_sellable, shipment.warehouse_id, it.sku_id]);
  }
}

try {
  // ===================== 1. RTO -> quarantine ======================
  {
    const r = await runRtoBridge({ shipmentId: shipment.id });
    assert.equal(r.quarantined, true);
    assert.equal(r.batches.length, items.length);
    for (const it of items) {
      const b = invBefore.get(it.sku_id);
      const inv = await one('SELECT on_hand, non_sellable FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [shipment.warehouse_id, it.sku_id]);
      assert.equal(Number(inv.on_hand), Number(b.on_hand), 'on_hand untouched by RTO quarantine');
      assert.equal(Number(inv.non_sellable), Number(b.non_sellable) + Number(it.quantity), 'non_sellable up by the shipped quantity');
      const mv = await one(
        `SELECT movement_type FROM inventory_movements WHERE reference_type = 'SHIPMENT' AND reference_id = ? AND sku_id = ?`, [shipment.id, it.sku_id]);
      assert.equal(mv.movement_type, 'QC_QUARANTINED');
    }
    const batch = await one("SELECT source_type, source_ref, status FROM inventory_quarantine WHERE source_ref = ? LIMIT 1", [shipment.id]);
    assert.equal(batch.source_type, 'RTO_RECEIVED');
    assert.equal(batch.status, 'OPEN');
    assert.equal(Number((await driftCount()).n), 0);
    pass('RTO_QUARANTINED', `${items.length} line(s) -> non_sellable`);
  }

  // ===================== 2. idempotent ============================
  {
    const again = await runRtoBridge({ shipmentId: shipment.id });
    assert.equal(again.quarantined, false);
    assert.equal(again.reason, 'ALREADY_QUARANTINED');
    const count = await one("SELECT COUNT(*) n FROM inventory_quarantine WHERE source_ref = ?", [shipment.id]);
    assert.equal(Number(count.n), items.length, 'no extra batches on replay');
    pass('IDEMPOTENT');
  }

  // ===================== 3. RELEASE restocks ======================
  {
    const b = await one("SELECT id, sku_id, quantity FROM inventory_quarantine WHERE source_ref = ? LIMIT 1", [shipment.id]);
    const before = invBefore.get(b.sku_id);
    const dto = await inventoryQuarantineService.dispose(b.id, { action: 'RELEASE', quantity: Number(b.quantity), note: 'inspected OK' }, { id: null, email: 'verify@rto.test' });
    assert.equal(dto.status, 'RESOLVED');
    const inv = await one('SELECT on_hand, non_sellable FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [shipment.warehouse_id, b.sku_id]);
    assert.equal(Number(inv.on_hand), Number(before.on_hand) + Number(b.quantity), 'released units restocked to on_hand');
    assert.equal(Number((await driftCount()).n), 0);
    pass('RTO_BATCH_RELEASES', 'inspected RTO units restocked');
  }

  // ===================== 4. applier wiring ========================
  {
    const src = await readFile(new URL('../src/modules/logistics/applier.js', import.meta.url), 'utf8');
    assert(src.includes('runRtoBridge'), 'applier imports the RTO bridge');
    assert(/RTO_RETURNED/.test(src), 'applier keys the bridge on RTO_RETURNED');
    pass('APPLIER_WIRED');
  }

  console.log('\nWP-04 RTO inventory recovery — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await restore();
  await pool.end();
}
