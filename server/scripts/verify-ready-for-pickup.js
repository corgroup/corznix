// READY_FOR_PICKUP — the carrier-pickup trigger.
//
// The operator marks ONE parcel ready, but a carrier pickup is warehouse-level:
// Delhivery's PUR Creation covers every package waiting at a location and only
// one request per warehouse per day may be open. `requestForWarehouse` refuses
// with PICKUP_ALREADY_OPEN once that day's request exists — correct for "raise
// the day's pickup", wrong for "this parcel is ready", because a parcel packed
// after the request could never be attached to anything.
//
// So the case that matters most here is the second parcel of the day.
//
// Provider doubles throughout: this asserts the decision rules and the
// persistence, and must never actually call a carrier.
//
// Self-restoring: the fixture shipment is put back exactly as found.
//
//   npm run verify:ready-for-pickup --workspace=server
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { WarehousePickupService } = await import('../src/modules/shipping/pickupService.js');

const results = {};
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results[name] = 'PASS'; console.log(`  PASS  ${name}`); } catch (err) {
    results[name] = `FAIL: ${err.message}`; failures += 1; console.error(`  FAIL  ${name} — ${err.message}`);
  }
};

const TODAY = (() => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();

let providerCalls = 0;
const svcFor = (pickupMode) => new WarehousePickupService({
  providerLocations: {
    async activeIdentifier() {
      return { provider_location_identifier: 'CORCOTTON-TEST-LOC', pickup_mode: pickupMode };
    },
  },
  shipping: {
    orchestrator: {
      async requestPickup() {
        providerCalls += 1;
        return { accepted: true, pickupId: `PUR-${randomUUID().slice(0, 8)}`, scheduledFor: TODAY };
      },
    },
  },
});

const SHIPMENT_COLS = 'status, booking_status, tracking_number, tracking_url, label_status, pickup_request_id, pickup_requested_at, provider_code, external_shipment_id, booked_at';
const readShipment = (id) => query(`SELECT ${SHIPMENT_COLS} FROM shipments WHERE id = ?`, [id]).then((r) => r[0]);

let shipmentId = null;
let before = null;
const createdPickupRequests = [];

try {
  const [row] = await query(
    `SELECT s.id FROM shipments s
       JOIN fulfillments f ON f.id = s.fulfillment_id
       JOIN orders o ON o.id = f.order_id
      WHERE o.finalization_source = 'FIXTURE_SEED'
      ORDER BY s.created_at LIMIT 1`);
  if (!row) throw new Error('no fixture shipment — run: npm run seed:orders --workspace=server');
  shipmentId = row.id;
  before = await readShipment(shipmentId);

  const setState = (patch) => {
    const cols = Object.keys(patch);
    return query(
      `UPDATE shipments SET ${cols.map((c) => `${c}=?`).join(',')} WHERE id = ?`,
      [...cols.map((c) => patch[c]), shipmentId]);
  };
  // chk_shipment_booked_complete: a BOOKED shipment MUST carry provider_code,
  // external_shipment_id, tracking_number and booked_at. chk_shipment_unbooked_clean
  // requires the mirror image when NOT_READY/READY. Only legal states below.
  const bookedFields = {
    booking_status: 'BOOKED', provider_code: 'DELHIVERY',
    external_shipment_id: 'TESTSHIP0001', tracking_number: 'TESTAWB0001',
    booked_at: new Date(),
  };
  const unbookedFields = {
    booking_status: 'NOT_READY', provider_code: null, external_shipment_id: null,
    tracking_number: null, tracking_url: null, booked_at: null,
  };

  // ---- preconditions are refused one at a time ---------------------------
  await check('unbooked_shipment_is_refused', async () => {
    await setState({ status: 'DRAFT', label_status: 'NONE', pickup_request_id: null, pickup_requested_at: null, ...unbookedFields });
    await assert.rejects(
      () => svcFor('API').readyForPickup({ shipmentId, pickupDate: TODAY }),
      (e) => e.code === 'SHIPMENT_NOT_BOOKED');
  });

  // The service checks for a missing AWB defensively, but that state cannot
  // actually be reached: the database refuses to store a BOOKED shipment
  // without one. Asserting the constraint is the stronger test — it is what
  // makes a fabricated AWB impossible rather than merely discouraged.
  await check('database_forbids_a_booked_shipment_without_an_awb', async () => {
    await assert.rejects(
      () => setState({ ...bookedFields, tracking_number: null }),
      (e) => /chk_shipment_booked_complete/.test(e.message),
      'chk_shipment_booked_complete must reject a booked shipment with no AWB');
  });

  await check('missing_label_is_refused', async () => {
    await setState({ status: 'BOOKED', label_status: 'PENDING', pickup_request_id: null, pickup_requested_at: null, ...bookedFields });
    await assert.rejects(
      () => svcFor('API').readyForPickup({ shipmentId, pickupDate: TODAY }),
      (e) => e.code === 'SHIPMENT_LABEL_UNAVAILABLE');
  });

  const ready = { status: 'BOOKED', label_status: 'AVAILABLE', pickup_request_id: null, pickup_requested_at: null, ...bookedFields };

  // ---- the two modes that must NOT call the provider ---------------------
  await check('auto_pickup_mode_never_calls_the_provider', async () => {
    await setState(ready);
    const callsBefore = providerCalls;
    const out = await svcFor('AUTO').readyForPickup({ shipmentId, pickupDate: TODAY });
    assert.equal(out.mode, 'AUTO');
    assert.equal(providerCalls, callsBefore, 'an auto-pickup account must never be sent a request');
    const after = await readShipment(shipmentId);
    assert.equal(after.status, 'PICKUP_PENDING', 'the parcel is still awaiting collection');
    assert.equal(after.pickup_request_id, null, 'no pickup request is invented for one nobody made');
  });

  await check('manual_panel_mode_never_calls_the_provider', async () => {
    await setState(ready);
    const callsBefore = providerCalls;
    const out = await svcFor('MANUAL_PANEL').readyForPickup({ shipmentId, pickupDate: TODAY });
    assert.equal(out.mode, 'MANUAL_PANEL');
    assert.ok(/panel/i.test(out.message), 'the operator is told where to raise it');
    assert.equal(providerCalls, callsBefore);
  });

  // ---- API mode: first parcel raises the day's request -------------------
  await check('first_parcel_raises_the_days_pickup_request', async () => {
    await query(
      "DELETE FROM warehouse_pickup_requests WHERE pickup_date = ? AND provider_code = 'DELHIVERY'", [TODAY]);
    await setState(ready);
    const callsBefore = providerCalls;
    const out = await svcFor('API').readyForPickup({ shipmentId, pickupDate: TODAY });
    assert.equal(out.mode, 'API');
    assert.equal(providerCalls, callsBefore + 1, 'the provider pickup API is actually called');
    assert.ok(out.pickupRequestId, 'a pickup request is persisted');
    createdPickupRequests.push(out.pickupRequestId);

    const after = await readShipment(shipmentId);
    assert.equal(after.pickup_request_id, out.pickupRequestId, 'the parcel is attached to it');
    assert.ok(after.pickup_requested_at, 'the request time is recorded');
    assert.equal(after.status, 'PICKUP_PENDING',
      'PICKUP_PENDING, not PICKED_UP — a request is not a collection');
  });

  // ---- the case the old code could not handle ----------------------------
  await check('second_parcel_joins_the_open_request_without_a_second_call', async () => {
    const [open] = await query(
      "SELECT id FROM warehouse_pickup_requests WHERE pickup_date = ? AND status IN ('REQUESTED','ACCEPTED') LIMIT 1",
      [TODAY]);
    assert.ok(open, 'the day\'s request from the previous case is still open');

    // A second parcel finished after that request was raised.
    await setState({ ...ready, pickup_request_id: null, pickup_requested_at: null });
    const callsBefore = providerCalls;
    const out = await svcFor('API').readyForPickup({ shipmentId, pickupDate: TODAY });

    assert.equal(out.joinedExisting, true, 'it joins rather than raising a second request');
    assert.equal(out.pickupRequestId, open.id);
    assert.equal(providerCalls, callsBefore, 'one provider call per warehouse per day, not per parcel');

    const after = await readShipment(shipmentId);
    assert.equal(after.pickup_request_id, open.id, 'the parcel is attached to the open request');
    assert.equal(after.status, 'PICKUP_PENDING');
  });

  // ---- a double-click is not a second pickup -----------------------------
  await check('marking_ready_twice_is_idempotent', async () => {
    const callsBefore = providerCalls;
    const out = await svcFor('API').readyForPickup({ shipmentId, pickupDate: TODAY });
    assert.equal(out.alreadyReady, true);
    assert.equal(providerCalls, callsBefore, 'no further provider call');
  });

  await check('pickup_date_is_required_and_validated', async () => {
    await assert.rejects(
      () => svcFor('API').readyForPickup({ shipmentId, pickupDate: '06-09-2026' }),
      (e) => e.code === 'VALIDATION_ERROR',
      'the provider contract requires YYYY-MM-DD, so a malformed date is refused before any call');
  });

  console.log(`\n${JSON.stringify(results, null, 2)}`);
  console.log(`\nproviderPickupCallsMade = ${providerCalls}`);
  console.log(`READY_FOR_PICKUP = ${failures ? 'FAIL' : 'PASS'}`);
} finally {
  if (shipmentId && before) {
    // Every mutated column, restored together. Restoring a subset trips
    // chk_shipment_unbooked_clean (a NOT_READY shipment must have no provider
    // identity), the UPDATE fails, and the fixture is left BOOKED — which is
    // exactly what happened before this was fixed.
    await query(
      `UPDATE shipments SET status=?, booking_status=?, tracking_number=?, tracking_url=?,
         label_status=?, pickup_request_id=NULL, pickup_requested_at=?, provider_code=?,
         external_shipment_id=?, booked_at=? WHERE id=?`,
      [before.status, before.booking_status, before.tracking_number, before.tracking_url,
        before.label_status, before.pickup_requested_at, before.provider_code,
        before.external_shipment_id, before.booked_at, shipmentId],
    ).catch((e) => {
      // A failed restore corrupts data every later run depends on. Never
      // swallow it — a silent catch is how this went unnoticed.
      console.error(`
  RESTORE FAILED — the fixture shipment is left modified: ${e.message}`);
      failures += 1;
    });
    const after = await readShipment(shipmentId);
    for (const col of SHIPMENT_COLS.split(', ')) {
      if (col === 'pickup_request_id') continue;
      const a = after[col] instanceof Date ? after[col].getTime() : after[col];
      const b = before[col] instanceof Date ? before[col].getTime() : before[col];
      if (a !== b) {
        console.error(`  RESTORE INCOMPLETE — ${col}: ${JSON.stringify(b)} -> ${JSON.stringify(a)}`);
        failures += 1;
      }
    }
  }
  await query("DELETE FROM warehouse_pickup_requests WHERE provider_location_identifier IS NULL AND pickup_date = ?", [TODAY])
    .catch(async () => {
      for (const id of createdPickupRequests) {
        await query('DELETE FROM warehouse_pickup_requests WHERE id = ?', [id]).catch(() => {});
      }
    });
  await pool.end();
}

if (failures) process.exit(1);
