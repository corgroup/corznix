// WP-11 (standalone Fulfillment CMS) verification.
//
// Proves, against the local dev database:
//   - fulfillmentService.adminList returns fulfilments with order + warehouse
//     + item/shipment counts and a total; status / warehouseId / orderNumber
//     filters work;
//   - adminDetail returns items, shipments, events and the shipping address;
//   - the state machine is now driven by a staff path: PENDING -> PROCESSING
//     -> FULFILLED records fulfillment_events (each tagged via:'CMS') and sets
//     fulfilled_at;
//   - marking the last fulfilment of a PROCESSING order FULFILLED completes
//     the order (WP-11 x WP-01 completion bridge);
//   - an invalid edge (PENDING -> FULFILLED) is rejected.
//
// Isolated + self-cleaning: borrows one seeded PROCESSING order's PENDING
// fulfilment, then restores the order / fulfilment / events exactly.
//
//   npm run verify:fulfillment-ops
import assert from 'node:assert/strict';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { tryCompleteOrder } = await import('../src/modules/logistics/completionBridge.js');
const { orderConfirmationService } = await import('../src/modules/orderOps/service.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

// The named fixture, not "whatever orders this database happens to hold".
//
// This test drives a fulfilment to FULFILLED and completes its order. Run
// against an ambient row it mutates real commerce data, and its outcome
// depends on whichever order another script happened to leave behind — it
// only ever found a candidate at all because verify:fulfillment used to wipe
// every fulfilment table-wide and leave its own residue behind. That was a
// hidden dependency between two scripts; once those deletes were correctly
// scoped, the residue disappeared and so did this test's precondition.
//
// So it now BUILDS its precondition from the seeded fixture — confirm +
// start-processing through the real services — and tears the whole graph back
// down afterwards, returning the fixture order to exactly its seeded PLACED
// state. Nothing outside FIXTURE_SEED is ever touched.
const seedOrder = await one(
  `SELECT id, order_number FROM orders
    WHERE finalization_source = 'FIXTURE_SEED' AND order_status = 'PLACED'
      AND payment_mode = 'PREPAID'
    ORDER BY order_number LIMIT 1`);
assert(seedOrder, 'no PLACED FIXTURE_SEED order — run: npm run seed:orders --workspace=server');

await orderConfirmationService.confirm({ orderId: seedOrder.id, staffUserId: null });
await orderConfirmationService.startProcessing({ orderId: seedOrder.id, staffUserId: null });

const cand = await one(
  `SELECT o.id AS order_id, o.order_number, f.id AS fulfillment_id, f.status AS f_status
     FROM orders o
     JOIN fulfillments f ON f.order_id = o.id AND f.fulfillment_type = 'INITIAL'
    WHERE o.id = ? AND f.status = 'PENDING'
    LIMIT 1`, [seedOrder.id]);
assert(cand, `confirming ${seedOrder.order_number} did not produce a PENDING INITIAL fulfilment`);

/** Tear the built graph down and put the fixture order back to PLACED. */
async function teardownFixture() {
  const id = seedOrder.id;
  await query('DELETE pj FROM print_jobs pj JOIN documents d ON d.id = pj.document_id WHERE d.order_id = ?', [id]);
  await query('DELETE FROM credit_notes WHERE order_id = ?', [id]);
  await query('DELETE ii FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.order_id = ?', [id]);
  await query('DELETE FROM invoices WHERE order_id = ?', [id]);
  await query('DELETE FROM documents WHERE order_id = ?', [id]);
  await query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id = fe.fulfillment_id WHERE f.order_id = ?', [id]);
  await query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id WHERE f.order_id = ?', [id]);
  await query('DELETE s FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id = ?', [id]);
  await query('DELETE FROM fulfillments WHERE order_id = ?', [id]);
  await query(
    `UPDATE orders SET order_status = 'PLACED', fulfillment_status = 'UNFULFILLED',
       confirmed_at = NULL, confirmed_by_staff_id = NULL, processing_started_at = NULL,
       completed_at = NULL, allocation_fingerprint = NULL
     WHERE id = ?`, [id]);
}

const orderBefore = await one('SELECT order_status, completed_at FROM orders WHERE id=?', [cand.order_id]);
const fBefore = await one('SELECT status, ready_at, fulfilled_at, cancelled_at FROM fulfillments WHERE id=?', [cand.fulfillment_id]);
const eventIdsBefore = new Set((await query('SELECT id FROM fulfillment_events WHERE fulfillment_id=?', [cand.fulfillment_id])).map((r) => r.id));

async function restore() {
  void orderBefore; void fBefore; void eventIdsBefore;
  // The precondition was BUILT by this script, so it is torn down whole rather
  // than field-by-field: the fixture order goes back to the seeded PLACED
  // state, taking the fulfilment, shipment, invoice and paperwork with it.
  await teardownFixture();
}

try {
  // ===================== 1. adminList shape + filters =================
  {
    const all = await fulfillmentService.adminList({ limit: 200 });
    assert(all.total >= 1);
    const row = all.fulfillments.find((f) => f.id === cand.fulfillment_id);
    assert(row, 'the seeded fulfilment must be listed');
    assert.equal(row.orderNumber, cand.order_number);
    assert(row.warehouseName, 'warehouse name joined');
    assert(typeof row.itemCount === 'number' && typeof row.shipmentCount === 'number');

    const byStatus = await fulfillmentService.adminList({ status: 'PENDING', limit: 200 });
    assert(byStatus.fulfillments.every((f) => f.status === 'PENDING'));
    const byOrder = await fulfillmentService.adminList({ orderNumber: cand.order_number, limit: 50 });
    assert(byOrder.fulfillments.some((f) => f.id === cand.fulfillment_id));
    assert.equal(byOrder.fulfillments.every((f) => f.orderNumber === cand.order_number), true);
    pass('ADMIN_LIST_AND_FILTERS', `${all.total} fulfilments`);
  }

  // ===================== 2. adminDetail shape ========================
  {
    const d = await fulfillmentService.adminDetail(cand.fulfillment_id);
    assert.equal(d.id, cand.fulfillment_id);
    assert(Array.isArray(d.items) && Array.isArray(d.shipments) && Array.isArray(d.events));
    assert(d.shippingAddress && typeof d.shippingAddress === 'object');
    pass('ADMIN_DETAIL');
  }

  // ===================== 3. invalid edge rejected ====================
  {
    await assert.rejects(
      () => fulfillmentService.transitionStatus(cand.fulfillment_id, 'FULFILLED', { detail: { via: 'CMS' } }),
      (e) => e.code === 'FULFILLMENT_TRANSITION_INVALID',
    );
    const still = await one('SELECT status FROM fulfillments WHERE id=?', [cand.fulfillment_id]);
    assert.equal(still.status, 'PENDING', 'an invalid transition must not mutate status');
    pass('INVALID_EDGE_REJECTED', 'PENDING -> FULFILLED refused');
  }

  // ===================== 4. staff path drives the state machine ======
  {
    await fulfillmentService.transitionStatus(cand.fulfillment_id, 'PROCESSING', { detail: { via: 'CMS', actorStaffId: null, note: 'picked' } });
    let f = await one('SELECT status FROM fulfillments WHERE id=?', [cand.fulfillment_id]);
    assert.equal(f.status, 'PROCESSING');

    await fulfillmentService.transitionStatus(cand.fulfillment_id, 'FULFILLED', { detail: { via: 'CMS', actorStaffId: null } });
    f = await one('SELECT status, fulfilled_at FROM fulfillments WHERE id=?', [cand.fulfillment_id]);
    assert.equal(f.status, 'FULFILLED');
    assert(f.fulfilled_at, 'fulfilled_at must be set');

    const evs = await query("SELECT event_type, from_status, to_status, detail_json FROM fulfillment_events WHERE fulfillment_id=? AND id NOT IN (?)",
      [cand.fulfillment_id, eventIdsBefore.size ? [...eventIdsBefore] : ['__none__']]);
    const transitions = evs.filter((e) => e.event_type === 'STATUS_TRANSITION');
    assert(transitions.length >= 2, 'two STATUS_TRANSITION events recorded');
    // Assert THIS test's own transitions are attributed to the CMS — not that
    // no other actor may record one. A fulfilment reaching FULFILLED
    // legitimately wakes the shipment-forward-motion bridge, which records its
    // own transition tagged with its own source; demanding every event be
    // via:CMS made a real domain behaviour look like a failure.
    const byThisTest = transitions
      .map((e) => (typeof e.detail_json === 'string' ? JSON.parse(e.detail_json) : e.detail_json))
      .filter((d) => d?.via === 'CMS');
    assert(byThisTest.length >= 2,
      `both CMS transitions must be tagged via:CMS (saw ${JSON.stringify(transitions.map((e) => (typeof e.detail_json === 'string' ? JSON.parse(e.detail_json) : e.detail_json)?.via))})`);
    const toStatuses = transitions
      .filter((e) => {
        const d = typeof e.detail_json === 'string' ? JSON.parse(e.detail_json) : e.detail_json;
        return d?.via === 'CMS';
      })
      .map((e) => e.to_status);
    assert(toStatuses.includes('PROCESSING') && toStatuses.includes('FULFILLED'),
      `the CMS-tagged transitions must be the two this test made, saw ${JSON.stringify(toStatuses)}`);
    pass('STAFF_TRANSITIONS', 'PENDING -> PROCESSING -> FULFILLED, events tagged');
  }

  // ===================== 5. order completes ==========================
  {
    const r = await tryCompleteOrder(cand.order_id);
    assert.equal(r.completed, true, 'the order must complete once its only fulfilment is FULFILLED');
    const o = await one('SELECT order_status, completed_at FROM orders WHERE id=?', [cand.order_id]);
    assert.equal(o.order_status, 'COMPLETED');
    assert(o.completed_at);
    pass('ORDER_COMPLETION_BRIDGE', 'FULFILLED -> order COMPLETED');
  }

  console.log('\nWP-11 standalone Fulfillment CMS — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await restore();
  await pool.end();
}
