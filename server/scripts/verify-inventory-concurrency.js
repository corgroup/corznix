// Inventory concurrency proof — genuine last-unit races across SEPARATE
// database connections, plus deterministic multi-key lock ordering.
//
// The single balance-of-record is `inventory (warehouse_id, sku_id)`; reserve
// / consume take `SELECT ... FOR UPDATE` on the unique-index row in a stable
// (warehouse_id, sku_id) order, and every write is guarded so `reserved`
// can never exceed `on_hand`. This script proves that under real contention:
//
//   successful reservations = 1
//   oversell                = 0
//   negative availability   = 0
//
//   npm run verify:inventory:concurrency
import assert from 'node:assert/strict';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { inventoryService } = await import('../src/modules/inventory/service.js');

// External-call tripwire.
let providerCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { providerCalls += 1; return realFetch?.(...args); };

const results = {};
const createdReservations = [];

const WH = (await query('SELECT id FROM warehouses WHERE is_default = 1 LIMIT 1'))[0]?.id;
assert.ok(WH, 'a default warehouse is required');

const skus = await query(
  `SELECT s.id FROM skus s
     JOIN inventory i ON i.sku_id = s.id AND i.warehouse_id = ?
    WHERE s.status = 'ACTIVE' ORDER BY s.id LIMIT 2`, [WH],
);
assert.equal(skus.length, 2, 'two SKUs with inventory at the default warehouse are required');
const [X, Y] = skus.map((r) => r.id);

const original = await query(
  'SELECT sku_id, on_hand, reserved FROM inventory WHERE warehouse_id = ? AND sku_id IN (?, ?)', [WH, X, Y],
);

const setStock = (skuId, onHand, reserved = 0) =>
  query('UPDATE inventory SET on_hand = ?, reserved = ?, updated_at = NOW(3) WHERE warehouse_id = ? AND sku_id = ?', [onHand, reserved, WH, skuId]);
const stockOf = async (skuId) => {
  const [row] = await query('SELECT on_hand, reserved FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [WH, skuId]);
  return { onHand: Number(row.on_hand), reserved: Number(row.reserved), available: Number(row.on_hand) - Number(row.reserved) };
};
const reserveOne = (skuId, key, items = [{ warehouseId: WH, skuId, quantity: 1 }]) =>
  inventoryService.reserve(items, { idempotencyKey: `concurrency-verify:${key}` })
    .then((r) => { createdReservations.push(r.id); return r; });

try {
  // ---------------------------------------------------------------------
  // 1. Two buyers, one unit — via the real service, on separate connections
  // ---------------------------------------------------------------------
  await setStock(X, 1, 0);
  const race = await Promise.allSettled([
    reserveOne(X, `lastunit:A:${Date.now()}`),
    reserveOne(X, `lastunit:B:${Date.now()}`),
  ]);
  const won = race.filter((r) => r.status === 'fulfilled');
  const lost = race.filter((r) => r.status === 'rejected');
  assert.equal(won.length, 1, 'exactly one reservation succeeds');
  assert.equal(lost.length, 1, 'exactly one reservation fails');
  assert.ok(['OUT_OF_STOCK', 'INSUFFICIENT_STOCK'].includes(lost[0].reason.code), `safe failure code, got ${lost[0].reason.code}`);
  const afterRace = await stockOf(X);
  assert.equal(afterRace.onHand, 1, 'on_hand untouched by a reservation');
  assert.equal(afterRace.reserved, 1, 'exactly one unit reserved');
  assert.equal(afterRace.available, 0, 'no negative availability');
  results.lastUnitRace = 'PASS (1 success, 1 safe failure, oversell 0)';

  for (const id of createdReservations.splice(0)) await inventoryService.releaseReservation(id);

  // ---------------------------------------------------------------------
  // 2. Low-level interleaving — prove FOR UPDATE serialises the two txns
  // ---------------------------------------------------------------------
  await setStock(X, 1, 0);
  const a = await pool.getConnection();
  const b = await pool.getConnection();
  try {
    await a.beginTransaction();
    await b.beginTransaction();

    // A takes the row lock.
    await a.execute('SELECT on_hand, reserved FROM inventory WHERE warehouse_id = ? AND sku_id = ? FOR UPDATE', [WH, X]);

    // B tries to take the same lock — it must block.
    let bUnblocked = false;
    const bLock = b.execute('SELECT on_hand, reserved FROM inventory WHERE warehouse_id = ? AND sku_id = ? FOR UPDATE', [WH, X])
      .then((r) => { bUnblocked = true; return r; });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(bUnblocked, false, 'B is blocked while A holds the row lock');

    // A reserves the unit and commits.
    const [aWrite] = await a.execute(
      'UPDATE inventory SET reserved = reserved + 1 WHERE warehouse_id = ? AND sku_id = ? AND reserved + 1 BETWEEN 0 AND on_hand', [WH, X],
    );
    assert.equal(aWrite.affectedRows, 1, 'A reserves the last unit');
    await a.commit();

    // B now proceeds, sees reserved = 1, and its guarded write is refused.
    const [[bRow]] = await bLock;
    assert.equal(bUnblocked, true, 'B unblocks once A commits');
    assert.equal(Number(bRow.reserved), 1, 'B sees the committed reservation');
    const [bWrite] = await b.execute(
      'UPDATE inventory SET reserved = reserved + 1 WHERE warehouse_id = ? AND sku_id = ? AND reserved + 1 BETWEEN 0 AND on_hand', [WH, X],
    );
    assert.equal(bWrite.affectedRows, 0, 'B cannot oversell — guard refuses the second unit');
    await b.rollback();
  } finally {
    a.release();
    b.release();
  }
  const afterInterleave = await stockOf(X);
  assert.equal(afterInterleave.reserved, 1, 'still exactly one unit reserved');
  assert.equal(afterInterleave.available, 0, 'no oversell');
  results.forUpdateInterleaving = 'PASS (blocked read, guarded write, oversell 0)';

  // ---------------------------------------------------------------------
  // 3. Deterministic multi-key lock order — no preventable deadlock
  // ---------------------------------------------------------------------
  await setStock(X, 5, 0);
  await setStock(Y, 5, 0);
  const multi = await Promise.allSettled([
    reserveOne(null, `multi:A:${Date.now()}`, [{ warehouseId: WH, skuId: X, quantity: 1 }, { warehouseId: WH, skuId: Y, quantity: 1 }]),
    // opposite input order — the repository sorts to (warehouse_id, sku_id) regardless
    reserveOne(null, `multi:B:${Date.now()}`, [{ warehouseId: WH, skuId: Y, quantity: 1 }, { warehouseId: WH, skuId: X, quantity: 1 }]),
  ]);
  assert.equal(multi.filter((r) => r.status === 'rejected').length, 0, `no deadlock/failure: ${multi.map((r) => r.reason?.code).join(',')}`);
  assert.equal((await stockOf(X)).reserved, 2, 'both multi-item reservations applied to X');
  assert.equal((await stockOf(Y)).reserved, 2, 'both multi-item reservations applied to Y');
  results.deterministicLockOrder = 'PASS (opposite input order, zero deadlocks)';

  // ===== 4. one un-expirable reservation must not block the expiry queue =====
  //
  // `expiredIds` returns the batch oldest-first and the loop had no per-row
  // isolation, so a single reservation that could not be released was
  // permanently FIRST in the queue and its throw aborted the whole batch —
  // every 30 seconds, forever. Nothing behind it ever expired, the stock those
  // reservations held stayed reserved and unsellable, and every abandoned
  // checkout piled up behind the same row. Observed live: 2 expirable rows in,
  // 0 expired, both still waiting.
  //
  // A refusal is legitimate — `changeReserved` will not drive `reserved`
  // negative — so the poison row is built here the only way it occurs in
  // reality: an inventory row that has drifted below what the reservation holds.
  {
    const { expireReservationBatch } = await import('../src/modules/inventory/expiryWorker.js');

    // This section deliberately drives `reserved` below what open reservations
    // hold. Anything still open from the sections above would then be
    // unreleasable, and the teardown swallows release failures — so those rows
    // would leak as RESERVED forever and drift the inventory of a long-lived
    // database. Retire them here, before the stock is distorted.
    while (createdReservations.length) {
      await inventoryService.releaseReservation(createdReservations.pop()).catch(() => {});
    }
    await setStock(X, 10, 0);
    await setStock(Y, 10, 0);

    const poison = await reserveOne(X, `poison-${Date.now()}`);
    const healthy = await reserveOne(Y, `healthy-${Date.now()}`);
    // Both expire immediately, poison first.
    await query('UPDATE inventory_reservations SET expires_at = DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE id = ?', [poison.id]);
    await query('UPDATE inventory_reservations SET expires_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?', [healthy.id]);
    // Drift X's reserved to 0 so releasing the poison row would go negative.
    await query('UPDATE inventory SET reserved = 0 WHERE warehouse_id = ? AND sku_id = ?', [WH, X]);

    const outcome = await expireReservationBatch();
    assert.equal(outcome.failed >= 1, true, 'the un-expirable reservation must be reported, not swallowed');

    const [healthyRow] = await query('SELECT status FROM inventory_reservations WHERE id = ?', [healthy.id]);
    assert.equal(healthyRow.status, 'EXPIRED',
      'a reservation behind an un-expirable one MUST still expire — one poison row must never stall the queue');
    const [poisonRow] = await query('SELECT status FROM inventory_reservations WHERE id = ?', [poison.id]);
    assert.equal(poisonRow.status, 'RESERVED', 'the refusal itself must stand — inventory is never driven negative');

    // The poison row cannot be released through the service by construction —
    // that is the whole point — so retire it directly rather than leaving a
    // permanently stuck RESERVED row behind for the next run to trip over.
    await query("UPDATE inventory_reservations SET status = 'RELEASED' WHERE id = ?", [poison.id]);
    createdReservations.length = 0; // both rows are terminal; nothing for teardown to release
    results.expiryQueueIsolation = 'PASS (one un-expirable reservation cannot stall the batch)';
  }

  assert.equal(providerCalls, 0, 'no outbound provider calls');
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nINVENTORY_CONCURRENCY_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nINVENTORY_CONCURRENCY_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  for (const id of createdReservations) {
    await inventoryService.releaseReservation(id).catch(() => {});
  }
  for (const row of original) {
    await query('UPDATE inventory SET on_hand = ?, reserved = ?, updated_at = NOW(3) WHERE warehouse_id = ? AND sku_id = ?',
      [Number(row.on_hand), Number(row.reserved), WH, row.sku_id]);
  }
  await pool.end();
}
