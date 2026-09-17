// Warehouse-manager confirmation (fulfilment specification §7).
//
// The point of this step is that a named person at the allocated warehouse
// undertook to fulfil the order. So the assertions are about what is
// *recorded*, not merely that a status changed.
//
// It also guards the constraint that made this a new state rather than a reuse
// of an existing one. Three separate things are called some form of "ready"
// and must keep meaning what they mean:
//
//   fulfillments.readiness_status  BOOKING readiness — derived from carrier
//                                  metadata, never set by a person
//   fulfillments.status = READY    an operational staff state, with ready_at
//   WAREHOUSE_CONFIRMED            a human at the warehouse accepted the work
//
// Confirming must therefore move the third without disturbing the first two.
//
// Self-restoring: puts the fixture fulfilment back exactly as it found it.
//
//   npm run verify:warehouse-confirmation --workspace=server
import assert from 'node:assert/strict';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { nextOperatorStatus, OPERATOR_FLOW } = await import('../src/modules/fulfillment/transitions.js');

const results = {};
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results[name] = 'PASS'; console.log(`  PASS  ${name}`); } catch (err) {
    results[name] = `FAIL: ${err.message}`; failures += 1; console.error(`  FAIL  ${name} — ${err.message}`);
  }
};

const COLS = 'status, readiness_status, block_reason, ready_at, warehouse_confirmed_at, warehouse_confirmed_by_staff_id, warehouse_confirmation_note';
const readRow = (id) => query(`SELECT ${COLS} FROM fulfillments WHERE id = ?`, [id]).then((r) => r[0]);

let fulfillmentId = null;
let before = null;

try {
  const [row] = await query(
    `SELECT f.id FROM fulfillments f
       JOIN orders o ON o.id = f.order_id
      WHERE o.finalization_source = 'FIXTURE_SEED' AND f.status = 'PENDING'
      ORDER BY f.created_at LIMIT 1`);
  if (!row) throw new Error('no PENDING fixture fulfilment — run: npm run seed:orders --workspace=server');
  fulfillmentId = row.id;
  before = await readRow(fulfillmentId);

  const [staff] = await query("SELECT id FROM staff_users WHERE status = 'ACTIVE' ORDER BY created_at LIMIT 1");
  if (!staff) throw new Error('no active staff user to act as the warehouse manager');

  // ---- the operator sequence is declared by the domain --------------------
  await check('operator_sequence_is_confirm_then_process', async () => {
    assert.deepEqual(OPERATOR_FLOW, ['PENDING', 'WAREHOUSE_CONFIRMED', 'PROCESSING', 'FULFILLED']);
    assert.equal(nextOperatorStatus('PENDING'), 'WAREHOUSE_CONFIRMED');
    assert.equal(nextOperatorStatus('WAREHOUSE_CONFIRMED'), 'PROCESSING');
    assert.equal(nextOperatorStatus('PROCESSING'), 'FULFILLED');
    assert.equal(nextOperatorStatus('FULFILLED'), null, 'nothing follows the terminal state');
    assert.equal(nextOperatorStatus('CANCELLED'), null, 'a cancelled fulfilment offers no next action');
  });

  // ---- a confirmation with nobody attached is worthless -------------------
  await check('confirmation_without_an_actor_is_refused', async () => {
    await assert.rejects(
      () => fulfillmentService.confirmByWarehouse(fulfillmentId, { actorStaffId: null }),
      (e) => e.code === 'WAREHOUSE_CONFIRMATION_ACTOR_REQUIRED');
    const after = await readRow(fulfillmentId);
    assert.equal(after.status, 'PENDING', 'a refused confirmation must not move the status');
    assert.equal(after.warehouse_confirmed_at, null);
  });

  // ---- the confirmation itself -------------------------------------------
  await check('confirmation_records_actor_timestamp_and_note', async () => {
    const dto = await fulfillmentService.confirmByWarehouse(fulfillmentId, {
      actorStaffId: staff.id, note: 'Stock checked on the shelf.',
    });
    assert.equal(dto.status, 'WAREHOUSE_CONFIRMED');

    const after = await readRow(fulfillmentId);
    assert.equal(after.status, 'WAREHOUSE_CONFIRMED');
    assert.equal(after.warehouse_confirmed_by_staff_id, staff.id, 'the confirming staff member is recorded');
    assert.ok(after.warehouse_confirmed_at instanceof Date, 'a confirmation timestamp is recorded');
    assert.equal(after.warehouse_confirmation_note, 'Stock checked on the shelf.');

    // Exposed on the read model, so the CMS does not have to dig it out.
    assert.ok(dto.warehouseConfirmation, 'the read model exposes the confirmation');
    assert.equal(dto.warehouseConfirmation.byStaffId, staff.id);
    assert.equal(dto.nextOperatorStatus, 'PROCESSING', 'the next action is the one the flow declares');
  });

  // ---- the constraint that made this a new state -------------------------
  await check('booking_readiness_is_untouched_by_confirmation', async () => {
    const after = await readRow(fulfillmentId);
    assert.equal(after.readiness_status, before.readiness_status,
      'confirming must not change BOOKING readiness — it is derived from carrier metadata');
    assert.equal(after.block_reason, before.block_reason);
  });

  await check('operational_ready_state_is_untouched_by_confirmation', async () => {
    const after = await readRow(fulfillmentId);
    assert.equal(String(after.ready_at), String(before.ready_at),
      'confirming must not stamp ready_at — that belongs to the separate operational READY state');
  });

  // ---- an event is recorded for the audit trail --------------------------
  await check('transition_is_recorded_as_an_event', async () => {
    const [ev] = await query(
      `SELECT from_status, to_status, detail_json FROM fulfillment_events
        WHERE fulfillment_id = ? AND to_status = 'WAREHOUSE_CONFIRMED'
        ORDER BY created_at DESC LIMIT 1`, [fulfillmentId]);
    assert.ok(ev, 'a STATUS_TRANSITION event exists for the confirmation');
    assert.equal(ev.from_status, 'PENDING');
    const detail = typeof ev.detail_json === 'string' ? JSON.parse(ev.detail_json) : ev.detail_json;
    assert.equal(detail.actorStaffId, staff.id, 'the event carries the actor too');
  });

  // ---- confirming twice is not a second confirmation ----------------------
  // A double-click must not re-stamp the confirmation with whoever clicked
  // last, which would erase the person who actually accepted the order (§20).
  await check('re_confirming_is_idempotent_and_keeps_the_original_confirmer', async () => {
    const first = await readRow(fulfillmentId);
    const [other] = await query(
      "SELECT id FROM staff_users WHERE status = 'ACTIVE' AND id <> ? ORDER BY created_at LIMIT 1", [staff.id]);
    const dto = await fulfillmentService.confirmByWarehouse(fulfillmentId, {
      actorStaffId: other?.id || staff.id, note: 'second click',
    });
    assert.equal(dto.status, 'WAREHOUSE_CONFIRMED');
    const after = await readRow(fulfillmentId);
    assert.equal(String(after.warehouse_confirmed_at), String(first.warehouse_confirmed_at),
      'the original confirmation timestamp is kept');
    assert.equal(after.warehouse_confirmed_by_staff_id, first.warehouse_confirmed_by_staff_id,
      'the original confirming staff member is kept');
    assert.equal(after.warehouse_confirmation_note, first.warehouse_confirmation_note,
      'the original note is kept');
    const events = await query(
      "SELECT COUNT(*) n FROM fulfillment_events WHERE fulfillment_id = ? AND to_status = 'WAREHOUSE_CONFIRMED'",
      [fulfillmentId]);
    assert.equal(Number(events[0].n), 1, 'a second click records no second event');
  });

  // ---- the confirmed order can proceed -----------------------------------
  await check('confirmed_fulfilment_can_start_processing', async () => {
    const dto = await fulfillmentService.transitionStatus(fulfillmentId, 'PROCESSING', {
      detail: { via: 'TEST' },
    });
    assert.equal(dto.status, 'PROCESSING');
    const after = await readRow(fulfillmentId);
    assert.ok(after.warehouse_confirmed_at, 'the confirmation record survives the next transition');
  });

  console.log(`\n${JSON.stringify(results, null, 2)}`);
  console.log(`\nWAREHOUSE_CONFIRMATION = ${failures ? 'FAIL' : 'PASS'}`);
} finally {
  // Put the fixture fulfilment back exactly as found.
  if (fulfillmentId && before) {
    await query(
      `UPDATE fulfillments
          SET status = ?, ready_at = ?, warehouse_confirmed_at = NULL,
              warehouse_confirmed_by_staff_id = NULL, warehouse_confirmation_note = NULL
        WHERE id = ?`,
      [before.status, before.ready_at, fulfillmentId]).catch((e) => console.error('  restore:', e.message));
    await query(
      "DELETE FROM fulfillment_events WHERE fulfillment_id = ? AND to_status IN ('WAREHOUSE_CONFIRMED', 'PROCESSING')",
      [fulfillmentId]).catch(() => {});
  }
  await pool.end();
}

if (failures) process.exit(1);
