// Warehouse pickup contact — mandatory, canonical, and enforced at the gate.
//
// A carrier pickup agent who cannot reach the warehouse is a failed pickup and
// a parcel that sits for another day. So the contact is not advisory:
//
//   * it comes from the ALLOCATED warehouse record, never the customer and
//     never a global default;
//   * it is stored canonically as +91XXXXXXXXXX, enforced by a CHECK
//     constraint so it holds regardless of which code path writes it;
//   * a warehouse cannot be enabled for fulfilment without one;
//   * READY_FOR_PICKUP is REFUSED without one, in every pickup mode — an
//     incomplete pickup request is worse than none;
//   * the provider adapter converts to the carrier's own format at the edge,
//     so canonical storage does not change what goes on the wire.
//
// Provider doubles throughout — this never calls a carrier.
//
//   npm run verify:pickup-contact --workspace=server
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { canonicalPickupPhone, isValidPickupPhone, assertPickupContact, normalizeWarehouseContactPatch } =
  await import('../src/modules/warehouses/pickupContact.js');
const { WarehousePickupService } = await import('../src/modules/shipping/pickupService.js');
const { buildManifestPayload } = await import('../src/modules/shipping/providers/delhiveryManifest.js');

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

console.log('\nWarehouse pickup contact verification\n');

await check('operator_input_is_canonicalised_not_rejected', async () => {
  // Whatever a human types for the same number must land on one stored form.
  for (const typed of ['9278092710', '09278092710', '+91 92780 92710', '91-9278092710', '+919278092710']) {
    assert.equal(canonicalPickupPhone(typed), '+919278092710', `"${typed}" did not canonicalise`);
  }
});

await check('a_non_mobile_number_is_refused_not_stored', async () => {
  // Indian mobiles start 6-9. A landline or a typo must not become a pickup
  // contact — the agent would call a dead number.
  for (const bad of ['5278092710', '1234567890', '92780927', '', null, 'not a number']) {
    assert.equal(canonicalPickupPhone(bad), '', `"${bad}" was accepted as a mobile`);
  }
  assert.throws(
    () => normalizeWarehouseContactPatch({ contactPhone: '5278092710' }),
    /WAREHOUSE_CONTACT_PHONE_INVALID|valid 10-digit/i,
    'an invalid number was silently dropped instead of refused',
  );
});

await check('the_database_itself_refuses_a_non_canonical_number', async () => {
  // Enforcement must not depend on the application layer being used.
  const id = randomUUID();
  await query(
    `INSERT INTO warehouses (id, brand_id, code, name, status, priority)
     VALUES (?, (SELECT id FROM brands ORDER BY is_default DESC LIMIT 1), ?, ?, 'DISABLED', 900)`,
    [id, `VERIFY-${id.slice(0, 8)}`, 'Verify pickup contact'],
  );
  try {
    for (const bad of ['9278092710', '+915278092710', '+9192780927101']) {
      let threw = false;
      try { await query('UPDATE warehouses SET contact_phone = ? WHERE id = ?', [bad, id]); }
      catch (err) { threw = err.code === 'ER_CHECK_CONSTRAINT_VIOLATED'; }
      assert.ok(threw, `the CHECK constraint accepted "${bad}"`);
    }
    await query('UPDATE warehouses SET contact_phone = ? WHERE id = ?', ['+919278092710', id]);
    const [row] = await query('SELECT contact_phone FROM warehouses WHERE id = ?', [id]);
    assert.equal(row.contact_phone, '+919278092710', 'a canonical number was not stored');
  } finally {
    await query('DELETE FROM warehouses WHERE id = ?', [id]);
  }
});

await check('the_gate_names_the_exact_field_that_is_missing', async () => {
  const base = { id: 'w1', name: 'Test WH', code: 'WH-T' };
  assert.throws(() => assertPickupContact({ ...base }), /WAREHOUSE_PICKUP_CONTACT_MISSING|no pickup contact/i);
  assert.throws(() => assertPickupContact({ ...base, contact_phone: '9278092710' }), /INVALID|invalid/i,
    'a non-canonical stored number should be reported as invalid, not accepted');
  assert.throws(() => assertPickupContact({ ...base, contact_phone: '+919278092710' }), /NAME_MISSING|name/i,
    'a pickup with no named contact person should be refused');
  const ok = assertPickupContact({ ...base, contact_phone: '+919278092710', contact_name: 'Desk' });
  assert.equal(ok.phone, '+919278092710');
});

// ---- the operational gate ------------------------------------------------
let providerCalls = 0;
const serviceFor = (pickupMode) => new WarehousePickupService({
  providerLocations: {
    async activeIdentifier() { return { provider_location_identifier: 'CORCOTTON-TEST', pickup_mode: pickupMode }; },
  },
  shipping: {
    orchestrator: {
      async requestPickup(req) {
        providerCalls += 1;
        return { accepted: true, pickupId: `PUR-${randomUUID().slice(0, 6)}`, scheduledFor: TODAY, echoed: req };
      },
    },
  },
});

// A warehouse + shipment we own completely, so nothing shared is touched.
const whId = randomUUID();
const shipmentId = randomUUID();
let fixtureBuilt = false;

try {
  const [brand] = await query('SELECT id FROM brands ORDER BY is_default DESC LIMIT 1');
  await query(
    `INSERT INTO warehouses (id, brand_id, code, name, address_line1, city, state, postal_code, country, status, priority)
     VALUES (?, ?, ?, ?, '1 Test Road', 'Ghazipur', 'Uttar Pradesh', '233222', 'IN', 'DISABLED', 901)`,
    [whId, brand.id, `VERIFY-GATE-${whId.slice(0, 6)}`, 'Verify gate warehouse'],
  );
  // A shipment row that satisfies every OTHER precondition, so the only thing
  // that can fail is the contact.
  const [anyFul] = await query('SELECT id, order_id FROM fulfillments LIMIT 1');
  assert.ok(anyFul, 'no fulfilment exists to hang a fixture shipment on — run seed:orders first');
  await query(
  // chk_shipment_booked_complete refuses a BOOKED row without a complete
  // provider identity — external id, AWB and booked_at together. Even a
  // test fixture cannot invent a half-booked shipment, which is precisely
  // why a fabricated AWB is impossible rather than merely discouraged.
    `INSERT INTO shipments (id, brand_id, fulfillment_id, warehouse_id, shipment_number, status, booking_status,
                            provider_code, external_shipment_id, tracking_number, booked_at,
                            label_status, cod_collection_minor, sequence)
     VALUES (?, ?, ?, ?, ?, 'BOOKED', 'BOOKED', 'DELHIVERY', ?, ?, NOW(3), 'AVAILABLE', 0,
             (SELECT COALESCE(MAX(x.sequence), 0) + 1 FROM (SELECT sequence FROM shipments WHERE fulfillment_id = ?) x))`,
    [shipmentId, brand.id, anyFul.id, whId, `SHP-VERIFY-${shipmentId.slice(0, 6)}`,
      `EXT-${shipmentId.slice(0, 8)}`, `AWBVERIFY${shipmentId.slice(0, 6)}`, anyFul.id],
  );
  fixtureBuilt = true;

  await check('ready_for_pickup_is_refused_without_a_contact', async () => {
    const before = providerCalls;
    await assert.rejects(
      () => serviceFor('API').readyForPickup({ shipmentId, pickupDate: TODAY }),
      (err) => /WAREHOUSE_PICKUP_CONTACT/.test(err.code || ''),
      'a parcel was declared ready from a warehouse nobody can call',
    );
    assert.equal(providerCalls, before, 'the provider was called despite the missing contact');
    const [row] = await query('SELECT status, pickup_request_id FROM shipments WHERE id = ?', [shipmentId]);
    assert.equal(row.status, 'BOOKED', 'the shipment moved despite the refusal');
    assert.equal(row.pickup_request_id, null, 'a pickup request row was created despite the refusal');
  });

  await check('the_gate_applies_in_auto_and_manual_modes_too', async () => {
    // AUTO and MANUAL_PANEL make no API call — but a human still turns up at
    // this address expecting someone to answer.
    for (const mode of ['AUTO', 'MANUAL_PANEL']) {
      await assert.rejects(
        () => serviceFor(mode).readyForPickup({ shipmentId, pickupDate: TODAY }),
        (err) => /WAREHOUSE_PICKUP_CONTACT/.test(err.code || ''),
        `${mode} skipped the contact gate`,
      );
    }
  });

  await check('a_complete_contact_lets_the_pickup_through', async () => {
    await query(
      'UPDATE warehouses SET contact_name = ?, contact_phone = ? WHERE id = ?',
      ['Pickup Desk', '+919278092710', whId],
    );
    const before = providerCalls;
    const out = await serviceFor('API').readyForPickup({ shipmentId, pickupDate: TODAY });
    assert.equal(out.mode, 'API');
    assert.equal(providerCalls, before + 1, 'the provider was not called');
    const [row] = await query('SELECT status, pickup_request_id FROM shipments WHERE id = ?', [shipmentId]);
    assert.equal(row.status, 'PICKUP_PENDING', 'the shipment did not move to PICKUP_PENDING');
    assert.ok(row.pickup_request_id, 'no pickup request was recorded');
  });

  await check('the_pickup_request_carries_the_allocated_warehouses_own_contact', async () => {
    // Not the customer's number, not a default — the warehouse the parcel is
    // actually leaving from.
    // Clear the previous check's request entirely — a CLOSED one still holds
    // the day (see PICKUP_DAY_ALREADY_USED), which is correct behaviour but
    // would make this check assert the wrong thing.
    await query('UPDATE shipments SET pickup_request_id = NULL, status = ? WHERE id = ?', ['BOOKED', shipmentId]);
    await query('DELETE FROM warehouse_pickup_requests WHERE warehouse_id = ?', [whId]);
    let seen = null;
    const svc = new WarehousePickupService({
      providerLocations: { async activeIdentifier() { return { provider_location_identifier: 'X', pickup_mode: 'API' }; } },
      shipping: {
        orchestrator: {
          async requestPickup(req) { seen = req; return { accepted: true, pickupId: 'PUR-X', scheduledFor: TODAY }; },
        },
      },
    });
    await svc.readyForPickup({ shipmentId, pickupDate: TODAY });
    assert.equal(seen.pickupContactPhone, '+919278092710', 'the warehouse contact did not reach the pickup request');
    assert.equal(seen.pickupContactName, 'Pickup Desk');
    assert.equal(seen.pickupPostalCode, '233222', 'the warehouse PIN did not reach the pickup request');
    assert.equal(seen.pickupDate, TODAY);
  });
  await check('a_settled_pickup_day_is_reported_accurately', async () => {
    // A parcel packed AFTER the day's pickup was already collected must not be
    // told the request is "already open" — it is closed. The carrier's one
    // pickup per location per day stands, but the operator needs to be told
    // that, and which date to use instead.
    await query('UPDATE shipments SET pickup_request_id = NULL, status = ? WHERE id = ?', ['BOOKED', shipmentId]);
    await query("UPDATE warehouse_pickup_requests SET status = 'CLOSED' WHERE warehouse_id = ?", [whId]);
    await assert.rejects(
      () => serviceFor('API').requestForWarehouse({ warehouseId: whId, pickupDate: TODAY }),
      (err) => {
        assert.notEqual(err.code, 'PICKUP_ALREADY_OPEN', 'a CLOSED request was reported as still open');
        assert.equal(err.code, 'PICKUP_DAY_ALREADY_USED', `unexpected code ${err.code}`);
        assert.ok(err.details?.nextAvailableDate, 'the operator was not told which date to use instead');
        return true;
      },
    );
  });
} finally {
  if (fixtureBuilt) {
    await query('UPDATE shipments SET pickup_request_id = NULL WHERE id = ?', [shipmentId]);
    await query('DELETE FROM warehouse_pickup_requests WHERE warehouse_id = ?', [whId]);
    await query('DELETE FROM shipments WHERE id = ?', [shipmentId]);
  }
  await query('DELETE FROM warehouses WHERE id = ?', [whId]);
}

await check('the_adapter_converts_to_the_carriers_own_format', async () => {
  // Canonical storage must not change what has always gone on the wire.
  const { dataObject } = buildManifestPayload({
    orderReference: 'COR-TEST', pickupLocationName: 'LOC',
    origin: { name: 'WH', address: '1 Test Road', city: 'Ghazipur', state: 'UP', postalCode: '233222', phone: '+919278092710' },
    destination: { name: 'A', phone: '+919000000001', address: '2 Road', postalCode: '221001', city: 'Varanasi', state: 'UP' },
    package: { weightGrams: 500 },
    payment: { mode: 'PREPAID', codCollectionMinor: 0, orderValueMinor: 100000 },
  });
  const shipment = dataObject.shipments[0];
  assert.equal(shipment.return_phone, '9278092710',
    'the carrier received a +91-prefixed number — that is a change to a working integration');
  assert.equal(shipment.phone, '9000000001', 'the destination phone was not converted at the edge');
});

console.log(`\n${failures ? 'FAILURES' : 'ALL PASS'} — ${Object.keys(results).length} checks, ${failures} failed\n`);
await pool.end();
process.exit(failures ? 1 : 0);
