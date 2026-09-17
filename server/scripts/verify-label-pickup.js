// Phase 2 · Slices 11 + 12 — shipping label + carrier pickup (PUR).
//
// Isolated fixture test. global.fetch stubbed — NO real provider call.
//   * label: pdf=true ⇒ provider S3 URL; non-URL response ⇒ fail loud
//   * MOCK label ⇒ RENDERED sentinel (local PDF), not a fake provider URL
//   * pickup is warehouse-level; PICKUP_REQUESTED != PICKED_UP
//   * pickup mode AUTO / MANUAL_PANEL ⇒ no API call
//   * bad pickup date / count ⇒ rejected before any call; timeout ⇒ ambiguous
import assert from 'node:assert/strict';
import { DelhiveryShippingAdapter } from '../src/modules/shipping/providers/delhiveryAdapter.js';
import { MockShippingAdapter } from '../src/modules/shipping/providers/mockAdapter.js';
import { WarehousePickupService } from '../src/modules/shipping/pickupService.js';
import { query, pool } from '../src/database/connection/pool.js';

// Tomorrow, computed at run time. These dates used to be the literal
// '2026-09-08', which passed until that day ended and then failed every run
// after it — the service correctly refuses a pickup in the past. A test that
// hardcodes a date is a scheduled failure.
const TOMORROW = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

const REAL_ENV = {
  SHIPPING_PROVIDER_MODE: 'REAL',
  DELHIVERY_API_BASE_URL: 'https://staging-express.delhivery.com',
  DELHIVERY_API_TOKEN: 'test-token',
  SHIPPING_PROVIDER_TIMEOUT_MS: 5000,
};
const dAdapter = () => new DelhiveryShippingAdapter({ runtimeEnv: REAL_ENV });
let lastCall = null;
const stubFetch = (impl) => { global.fetch = async (url, options) => { lastCall = { url: new URL(url), options }; return impl(); }; };
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ---- label ---------------------------------------------------------
await acheck('label_capability', () => { assert.equal(dAdapter().supports('getLabel'), true); });

await acheck('label_success_url', async () => {
  stubFetch(() => jsonResponse({ packages: [{ pdf_download_link: 'https://s3.amazonaws.com/delhivery/label-123.pdf' }] }));
  const r = await dAdapter().getLabel({ awb: '3451910000123', size: '4R' });
  assert.equal(r.format, 'PDF');
  assert.equal(r.url, 'https://s3.amazonaws.com/delhivery/label-123.pdf');
  assert.equal(lastCall.url.pathname, '/api/p/packing_slip');
  assert.equal(lastCall.url.searchParams.get('wbns'), '3451910000123');
  assert.equal(lastCall.url.searchParams.get('pdf'), 'true');
  assert.equal(lastCall.url.searchParams.get('pdf_size'), '4R');
});

await acheck('label_non_url_response_fails_loud', async () => {
  stubFetch(() => jsonResponse({ packages: [{ status: 'processing' }] }));
  await assert.rejects(() => dAdapter().getLabel({ awb: '345' }), (e) => e.message === 'SHIPPING_PROVIDER_RESPONSE_INVALID');
});

await acheck('label_no_awb_rejected', async () => {
  await assert.rejects(() => dAdapter().getLabel({}), (e) => e.message === 'SHIPPING_PROVIDER_REQUEST_INVALID');
});

await acheck('mock_label_is_rendered_sentinel', async () => {
  const m = new MockShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' }, production: false });
  const r = await m.getLabel({ awb: 'MOCKAWB1' });
  assert.equal(r.format, 'RENDERED');
  assert.equal(r.url, null);
});

// ---- pickup adapter -----------------------------------------------
await acheck('pickup_capability', () => { assert.equal(dAdapter().supports('requestPickup'), true); });

await acheck('pickup_success', async () => {
  stubFetch(() => jsonResponse({ pickup_id: 'PUR12345' }));
  const r = await dAdapter().requestPickup({ pickupLocationName: 'CORCOTTON ND 01', pickupDate: TOMORROW, pickupTime: '14:00:00', expectedPackageCount: 3 });
  assert.equal(r.accepted, true);
  assert.equal(r.pickupId, 'PUR12345');
  assert.equal(lastCall.url.pathname, '/fm/request/new/');
  assert.equal(lastCall.options.method, 'POST');
  assert.deepEqual(JSON.parse(lastCall.options.body), {
    pickup_time: '14:00:00', pickup_date: TOMORROW, pickup_location: 'CORCOTTON ND 01', expected_package_count: 3,
  });
});

await acheck('pickup_bad_date_rejected_before_call', async () => {
  global.fetch = async () => { throw new Error('fetch should not run'); };
  await assert.rejects(
    () => dAdapter().requestPickup({ pickupLocationName: 'X', pickupDate: '08-09-2026', expectedPackageCount: 1 }),
    (e) => e.message === 'SHIPPING_PROVIDER_REQUEST_INVALID',
  );
});

await acheck('pickup_timeout_is_ambiguous', async () => {
  global.fetch = async (url, options) => {
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  };
  await dAdapter().requestPickup({ pickupLocationName: 'X', pickupDate: TOMORROW, expectedPackageCount: 1 }).then(
    () => { throw new Error('should have thrown'); },
    (e) => { assert.equal(e.message, 'SHIPPING_PROVIDER_TIMEOUT'); assert.equal(e.ambiguous, true); },
  );
});

// ---- pickup service mode branching (no DB) -----------------------
const svcWithMode = (pickup_mode) => new WarehousePickupService({
  providerLocations: { async activeIdentifier() { return { provider_location_identifier: 'CORCOTTON ND 01', pickup_mode }; } },
  shipping: { orchestrator: { async requestPickup() { throw new Error('should not call provider'); } } },
});

// A real warehouse: the pickup path now reads its contact, so a synthetic id
// would fail for the wrong reason.
const [pickupWarehouse] = await query(
  "SELECT id FROM warehouses WHERE status = 'ACTIVE' AND contact_phone IS NOT NULL AND contact_name IS NOT NULL LIMIT 1");
assert.ok(pickupWarehouse, 'no warehouse has a pickup contact — run migration 089');

await acheck('pickup_mode_auto_no_call', async () => {
  const r = await svcWithMode('AUTO').requestForWarehouse({ warehouseId: pickupWarehouse.id, pickupDate: TOMORROW });
  assert.equal(r.mode, 'AUTO');
});
await acheck('pickup_mode_manual_no_call', async () => {
  const r = await svcWithMode('MANUAL_PANEL').requestForWarehouse({ warehouseId: pickupWarehouse.id, pickupDate: TOMORROW });
  assert.equal(r.mode, 'MANUAL_PANEL');
});
await acheck('pickup_unregistered_warehouse_409', async () => {
  const svc = new WarehousePickupService({ providerLocations: { async activeIdentifier() { return null; } } });
  await assert.rejects(
    () => svc.requestForWarehouse({ warehouseId: 'w1', pickupDate: TOMORROW }),
    (e) => e.code === 'WAREHOUSE_NOT_REGISTERED_WITH_PROVIDER' && e.status === 409,
  );
});

// ---- ShipmentLabelService wiring — the class of bug the tests above cannot
// see, because they stub the adapter directly and never exercise the layer
// that calls it. Found live: `this.shipping.getLabel(...)` called a method
// that does not exist on ShippingService (only `.orchestrator.getLabel`
// does) — every real fetch threw "not a function", was swallowed by the
// catch block, and reported as a generic LABEL_FETCH_FAILED with no real
// reason, for every provider, always. A stub with getLabel ONLY under
// `.orchestrator` reproduces exactly that shape: it fails the same way the
// real ShippingService would if the call site regresses.
{
  const { ShipmentLabelService } = await import('../src/modules/orderOps/service.js');

  // Any fixture shipment does — this only proves the COLUMN accepts a real
  // length, independent of the row's booking state, and is restored after.
  const [fixtureShipment] = await query(
    `SELECT s.id FROM shipments s
       JOIN fulfillments f ON f.id = s.fulfillment_id
       JOIN orders o ON o.id = f.order_id
      WHERE o.finalization_source = 'FIXTURE_SEED' LIMIT 1`);

  await acheck('label_service_calls_orchestrator_not_shippingservice', async () => {
    const orchestratorOnly = {
      // Deliberately no top-level getLabel — matches the real ShippingService
      // shape. If the call site ever regresses to this.shipping.getLabel(),
      // this throws "orchestratorOnly.getLabel is not a function" and the
      // test fails loud, instead of silently reporting LABEL_FETCH_FAILED.
      orchestrator: { async getLabel() { return { url: 'https://example.test/label.pdf', format: 'PDF', size: '4R' }; } },
    };
    const svc = new ShipmentLabelService({ shipping: orchestratorOnly });
    // A repository double is enough here — the point is proving WHICH method
    // on `shipping` gets called, not exercising persistence (that's covered
    // by the long-URL check below, against the real repository).
    svc.repository = {
      async shipment() { return { id: 'x', booking_status: 'BOOKED', tracking_number: 'AWB1', provider_code: 'DELHIVERY' }; },
      async updateShipment() {},
    };
    const result = await svc.fetchLabel({ shipmentId: 'x' });
    assert.equal(result.labelStatus, 'AVAILABLE');
    assert.equal(result.url, 'https://example.test/label.pdf');
  });

  // The other half of the same live bug: even with the wiring fixed, a real
  // Delhivery pre-signed S3 URL (AWS security token and all) is comfortably
  // over 500 characters. Proven against the REAL fixture row + REAL
  // repository, not a mock, because a schema constraint only fails for real.
  await acheck('label_url_column_holds_a_real_length_url', async () => {
    assert.ok(fixtureShipment, 'no fixture shipment — run seed:orders');
    const longUrl = `https://example.test/packing-slip/x.pdf?${'X-Amz-Security-Token=' + 'a'.repeat(1700)}`;
    assert.ok(longUrl.length > 1700, 'test URL is not actually long');
    const before = await query('SELECT label_url, label_status FROM shipments WHERE id = ?', [fixtureShipment.id]);
    try {
      await query('UPDATE shipments SET label_url = ?, label_status = ? WHERE id = ?', [longUrl, 'AVAILABLE', fixtureShipment.id]);
      const [row] = await query('SELECT label_url FROM shipments WHERE id = ?', [fixtureShipment.id]);
      assert.equal(row.label_url, longUrl, 'the stored URL was truncated — label_url is too narrow again');
    } finally {
      await query('UPDATE shipments SET label_url = ?, label_status = ? WHERE id = ?',
        [before[0].label_url, before[0].label_status, fixtureShipment.id]);
    }
  });
}

console.log('\n──── Phase 2 · Slices 11 + 12 — label + pickup ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nLABEL_PICKUP = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0 (fixture-only)');
await pool.end();
process.exitCode = failed.length === 0 ? 0 : 1;
