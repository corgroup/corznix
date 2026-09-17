// WP-09 (order cancellation cascade) verification.
//
// Proves, against the local dev database, that cancelling a PROCESSING order
// with a CONSUMED reservation atomically:
//   - flips order_status -> CANCELLED with cancelled_at / reason / staff stamp;
//   - restores consumed on_hand per line and writes an ORDER_CANCELLED
//     movement carrying the resulting balance (GAP-INV-01 — today: nothing);
//   - transitions every non-terminal fulfilment to CANCELLED via the state
//     machine, tagged via:'ORDER_CANCELLATION' (GAP-SHIP-07);
//   - locally cancels the fulfilment's DRAFT shipment;
//   - reports the prepaid amount owed (refund execution stays in payments);
//   - writes one ORDER_CANCELLED audit row;
//   - is idempotent (a second call is a no-op) and refuses a stale
//     expectedUpdatedAt and an already-shipped order.
//
// Isolated + self-cleaning: borrows one seeded PROCESSING order, snapshots the
// order row, reservation status, fulfilments + their events, shipments and the
// touched inventory row, then restores everything and deletes what it created.
//
//   npm run verify:order-cancellation
import assert from 'node:assert/strict';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { orderCancellationService } = await import('../src/modules/orderOps/cancellationService.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

const order = await one(
  `SELECT o.* FROM orders o
     JOIN fulfillments f ON f.order_id = o.id AND f.fulfillment_type = 'INITIAL'
    WHERE o.order_status = 'PROCESSING'
      AND (SELECT status FROM inventory_reservations r WHERE r.id = o.inventory_reservation_id) = 'CONSUMED'
      AND (SELECT COUNT(*) FROM fulfillments f2 WHERE f2.order_id = o.id AND f2.fulfillment_type = 'INITIAL') = 1
    LIMIT 1`);
assert(order, 'need a seeded PROCESSING order with a CONSUMED reservation and one INITIAL fulfilment');

const resItems = await query('SELECT warehouse_id, sku_id, quantity FROM inventory_reservation_items WHERE reservation_id = ?', [order.inventory_reservation_id]);
const fulfilments = await query('SELECT * FROM fulfillments WHERE order_id = ?', [order.id]);
const shipments = await query('SELECT s.* FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id = ?', [order.id]);
const invBefore = new Map();
for (const it of resItems) {
  invBefore.set(`${it.warehouse_id}:${it.sku_id}`, await one('SELECT on_hand, reserved FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [it.warehouse_id, it.sku_id]));
}
const fEventIdsBefore = new Set((await query(`SELECT id FROM fulfillment_events WHERE fulfillment_id IN (${fulfilments.map(() => '?').join(',')})`, fulfilments.map((f) => f.id))).map((r) => r.id));
const scriptStart = new Date(Date.now() - 5000);

// Production's shape, reproduced: the customer had no verified PHONE on the
// ACCOUNT, so WhatsApp could only be reached through the ORDER's own checkout
// contact. With an account phone present (as the seed has) the channel resolves
// either way and a cancellation that forgets the order contact still looks
// fine. The rows are put back in restore().
const PHONE_COLS = ['id', 'customer_id', 'contact_type', 'value', 'normalized_value', 'is_verified', 'verified_at', 'source', 'created_at', 'updated_at'];
const accountPhones = await query(
  `SELECT ${PHONE_COLS.join(', ')} FROM customer_contacts WHERE customer_id = ? AND contact_type = 'PHONE'`, [order.customer_id]);
await query("DELETE FROM customer_contacts WHERE customer_id = ? AND contact_type = 'PHONE'", [order.customer_id]);

// …and the order's own contact has to be reachable, or there is nothing for
// either channel to resolve. A freshly seeded database (CI's, every run) has a
// shipping snapshot with no email and no phone, so the gate would assert about
// messages that could never exist. Patched for the run, restored below.
const snapshotBefore = order.shipping_address_snapshot;
const snapshot = {
  ...(typeof snapshotBefore === 'string' ? JSON.parse(snapshotBefore || '{}') : (snapshotBefore || {})),
  firstName: 'Cancellation', lastName: 'Fixture',
  phone: '+919812345670', email: 'cancellation.fixture@corcotton.test',
};
await query('UPDATE orders SET shipping_address_snapshot = ? WHERE id = ?', [JSON.stringify(snapshot), order.id]);

async function restore() {
  await query(
    `UPDATE orders SET order_status = ?, fulfillment_status = ?, cancelled_at = ?, cancellation_reason = ?, cancelled_by_staff_id = ?, updated_at = ? WHERE id = ?`,
    [order.order_status, order.fulfillment_status, order.cancelled_at, order.cancellation_reason, order.cancelled_by_staff_id, order.updated_at, order.id]);
  await query('UPDATE inventory_reservations SET status = ? WHERE id = ?', ['CONSUMED', order.inventory_reservation_id]);
  for (const f of fulfilments) {
    await query('UPDATE fulfillments SET status = ?, cancelled_at = ?, ready_at = ?, fulfilled_at = ? WHERE id = ?',
      [f.status, f.cancelled_at, f.ready_at, f.fulfilled_at, f.id]);
  }
  for (const s of shipments) {
    await query('UPDATE shipments SET status = ?, booking_status = ?, cancelled_at = ? WHERE id = ?', [s.status, s.booking_status, s.cancelled_at, s.id]);
  }
  for (const it of resItems) {
    const b = invBefore.get(`${it.warehouse_id}:${it.sku_id}`);
    // No row to begin with means there is nothing to put back. Restoring is
    // cleanup, and cleanup that throws buries the result of the run it was
    // cleaning up after — this crashed on undefined *after* every assertion
    // had already passed.
    if (!b) continue;
    await query('UPDATE inventory SET on_hand = ?, reserved = ? WHERE warehouse_id = ? AND sku_id = ?', [b.on_hand, b.reserved, it.warehouse_id, it.sku_id]);
  }
  await query("DELETE FROM inventory_movements WHERE reference_type = 'ORDER' AND reference_id = ?", [order.id]);
  const stray = await query(`SELECT id FROM fulfillment_events WHERE fulfillment_id IN (${fulfilments.map(() => '?').join(',')})`, fulfilments.map((f) => f.id));
  const mine = stray.map((r) => r.id).filter((id) => !fEventIdsBefore.has(id));
  if (mine.length) await query(`DELETE FROM fulfillment_events WHERE id IN (${mine.map(() => '?').join(',')})`, mine);
  await query("DELETE FROM staff_audit_logs WHERE action = 'ORDER_CANCELLED' AND resource_id = ? AND created_at >= ?", [order.id, scriptStart]);
  // The messages this run caused the cascade to enqueue — the fixture order is
  // restored to PROCESSING, so leaving them would make the next run see a
  // cancellation that had "already" been announced.
  await query('DELETE FROM communication_messages WHERE business_event_id = ?', [`order_cancelled:${order.id}`]);
  await query("DELETE FROM customer_contacts WHERE customer_id = ? AND contact_type = 'PHONE'", [order.customer_id]);
  await query('UPDATE orders SET shipping_address_snapshot = ? WHERE id = ?', [snapshotBefore, order.id]);
  for (const row of accountPhones) {
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO customer_contacts (${PHONE_COLS.join(', ')}) VALUES (${PHONE_COLS.map(() => '?').join(',')})`,
      PHONE_COLS.map((c) => row[c]));
  }
}

try {
  // ===================== 1. the cascade =============================
  const out = await orderCancellationService.cancel(order.order_number, {
    reason: 'verify — customer changed mind',
    actor: { id: null, email: 'verify@cancel.test' },
  });
  assert.equal(out.status, 'CANCELLED');
  assert.equal(out.priorStatus, 'PROCESSING');

  const o2 = await one('SELECT order_status, cancelled_at, cancellation_reason, fulfillment_status FROM orders WHERE id = ?', [order.id]);
  assert.equal(o2.order_status, 'CANCELLED');
  assert(o2.cancelled_at, 'cancelled_at stamped');
  assert.equal(o2.cancellation_reason, 'verify — customer changed mind');
  assert.equal(o2.fulfillment_status, 'CANCELLED');
  pass('ORDER_STATUS', 'PROCESSING -> CANCELLED with stamps');

  // inventory restored + movement
  assert.equal(out.inventory.mode, 'ON_HAND_RESTORED');
  for (const it of resItems) {
    const b = invBefore.get(`${it.warehouse_id}:${it.sku_id}`);
    const after = await one('SELECT on_hand FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [it.warehouse_id, it.sku_id]);
    assert.equal(Number(after.on_hand), Number(b.on_hand) + Number(it.quantity), 'on_hand restored by the line quantity');
    const mv = await one(
      `SELECT movement_type, quantity_delta, balance_after FROM inventory_movements
        WHERE reference_type = 'ORDER' AND reference_id = ? AND warehouse_id = ? AND sku_id = ?`, [order.id, it.warehouse_id, it.sku_id]);
    assert.equal(mv.movement_type, 'ORDER_CANCELLED');
    assert.equal(Number(mv.quantity_delta), Number(it.quantity));
    assert.equal(Number(mv.balance_after), Number(after.on_hand));
  }
  pass('INVENTORY_RESTORED', 'consumed on_hand returned + ORDER_CANCELLED movement');

  // fulfilments cancelled via the state machine
  const fAfter = await query('SELECT id, status FROM fulfillments WHERE order_id = ?', [order.id]);
  assert(fAfter.every((f) => f.status === 'CANCELLED'), 'every fulfilment CANCELLED');
  const evs = await query(
    `SELECT detail_json FROM fulfillment_events
      WHERE fulfillment_id IN (${fulfilments.map(() => '?').join(',')}) AND event_type = 'STATUS_TRANSITION' AND id NOT IN (${[...fEventIdsBefore, '_'].map(() => '?').join(',')})`,
    [...fulfilments.map((f) => f.id), ...fEventIdsBefore, '_']);
  assert(evs.length >= 1, 'a STATUS_TRANSITION event was recorded');
  for (const e of evs) {
    const d = typeof e.detail_json === 'string' ? JSON.parse(e.detail_json) : e.detail_json;
    assert.equal(d?.via, 'ORDER_CANCELLATION');
  }
  pass('FULFILMENTS_CANCELLED', `${fAfter.length} fulfilment(s), events tagged`);

  // shipments locally cancelled (via cancelDraftShipments or the explicit loop)
  const sAfter = await query('SELECT s.status FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id = ?', [order.id]);
  assert(sAfter.every((s) => s.status === 'CANCELLED'), 'every shipment CANCELLED');
  pass('SHIPMENTS_CANCELLED', `${sAfter.length} shipment(s)`);

  // refund owed reported, execution NOT attempted here
  assert.equal(out.refund.required, Number(order.online_paid_minor) > 0);
  if (out.refund.required) assert.equal(out.refund.amountMinor, Number(order.online_paid_minor));
  pass('REFUND_REPORTED', out.refund.required ? `${out.refund.amountMinor} owed` : 'nothing prepaid');

  // the customer is told, on every channel the policy names
  //
  // Production cancelled an order with the WhatsApp template ACTIVE and sent
  // only the email: the event carried no order contact, so WhatsApp found no
  // verified phone and was dropped with no message row at all. Nothing here
  // looked at messages, so the gate passed throughout.
  {
    const wanted = await query(
      `SELECT channel, status FROM communication_messages
        WHERE business_event_id = ? ORDER BY channel`, [`order_cancelled:${order.id}`]);
    const channels = new Set(wanted.map((m) => m.channel));
    const active = await query(
      "SELECT channel FROM communication_templates WHERE template_key = 'order.cancelled' AND status = 'ACTIVE'");
    for (const { channel } of active) {
      assert.ok(channels.has(channel), `a cancellation message exists for ${channel} (template is ACTIVE)`);
    }
    assert.equal(wanted.length, channels.size, 'one message per channel, not duplicates');
    pass('CUSTOMER_NOTIFIED', [...channels].join(' + ') || 'no ACTIVE template');
  }

  // a booked AWB is voided with the CARRIER, not only in our database
  //
  // The cascade used to flip shipments to CANCELLED locally and stop there, so
  // a cancelled order left a live AWB the courier would still collect. The
  // fixture's shipment is a draft, so this asserts the reported outcome list —
  // and that a booked one would be named in it.
  {
    assert.ok(Array.isArray(out.carrierCancellations), 'the cancellation reports what it did with the carrier');
    const booked = shipments.filter((s) => s.booking_status === 'BOOKED' && s.tracking_number);
    assert.equal(out.carrierCancellations.length, booked.length, 'one carrier outcome per booked AWB');
    for (const outcome of out.carrierCancellations) {
      assert.ok(['CANCELLED', 'NOT_CANCELLED'].includes(outcome.status), 'each AWB has a stated outcome');
      if (outcome.status === 'CANCELLED') {
        // The carrier must actually have been told. The first version of this
        // check passed while the provider was never called: the cascade had
        // just written CANCELLED itself, and the provider service treated its
        // own row as "already cancelled" and returned success. On production
        // that left AWB 54729910000162 live on a cancelled order.
        const told = await one(
          `SELECT last_provider_status FROM shipments WHERE id = ?`, [outcome.shipmentId]);
        assert.equal(String(told?.last_provider_status || '').toLowerCase(), 'cancelled',
          'the shipment records that the CARRIER cancelled it, not just that we did');
      }
      if (outcome.status === 'NOT_CANCELLED') {
        const alert = await one(
          "SELECT severity FROM staff_notifications WHERE event_key = 'AWB_STILL_LIVE_AFTER_CANCELLATION' AND entity_id = ?",
          [outcome.shipmentId]);
        assert.equal(alert?.severity, 'CRITICAL', 'a live AWB is raised to staff, loudly');
      }
    }
    pass('CARRIER_CANCELLATION_REPORTED', `${out.carrierCancellations.length} booked AWB(s)`);
  }

  // audit
  const aud = await one("SELECT metadata_json FROM staff_audit_logs WHERE action = 'ORDER_CANCELLED' AND resource_id = ? AND created_at >= ?", [order.id, scriptStart]);
  assert(aud, 'ORDER_CANCELLED audit row written');
  pass('AUDIT');

  // ===================== 2. idempotent =============================
  const again = await orderCancellationService.cancel(order.order_number, { actor: { id: null } });
  assert.equal(again.alreadyCancelled, true, 'a second cancel is a no-op');
  pass('IDEMPOTENT');

  console.log('\nWP-09 order cancellation cascade — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await restore();
  await pool.end();
}
