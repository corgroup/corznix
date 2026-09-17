// Phase 2 · Slice 15 — provider-side shipment edit + cancellation.
//
// Isolated (fetch + repo + transaction stubbed). NO real provider / DB call.
//   * cancel eligible only pre-handover (BOOKED / PICKUP_PENDING); PICKED_UP+
//     ⇒ CANCEL_NOT_ALLOWED
//   * provider success ⇒ shipment locally CANCELLED (inventory untouched here)
//   * timeout / ambiguous ⇒ CANCEL_UNKNOWN, shipment NOT marked cancelled,
//     reconciliation raised (brief §22)
//   * provider "not allowed" ⇒ CANCEL_NOT_ALLOWED
//   * edit: /api/p/edit; empty edit ⇒ rejected before any call
import assert from 'node:assert/strict';
import { DelhiveryShippingAdapter } from '../src/modules/shipping/providers/delhiveryAdapter.js';
import { MockShippingAdapter } from '../src/modules/shipping/providers/mockAdapter.js';
import { ShipmentProviderCancellationService } from '../src/modules/orderOps/shipmentCancellationService.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

const REAL_ENV = { SHIPPING_PROVIDER_MODE: 'REAL', DELHIVERY_API_BASE_URL: 'https://staging-express.delhivery.com', DELHIVERY_API_TOKEN: 't', SHIPPING_PROVIDER_TIMEOUT_MS: 5000 };
const d = () => new DelhiveryShippingAdapter({ runtimeEnv: REAL_ENV });
let lastCall = null;
const stubFetch = (impl) => { global.fetch = async (url, options) => { lastCall = { url: String(url), options }; return impl(); }; };
const jsonResponse = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// ---- adapter cancel ----------------------------------------------
await acheck('cancel_capability', () => { assert.equal(d().supports('cancelShipment'), true); assert.equal(d().supports('editShipment'), true); });

await acheck('cancel_success', async () => {
  stubFetch(() => jsonResponse({ success: true }));
  const r = await d().cancelShipment({ awb: '3451910000123' });
  assert.equal(r.cancelled, true);
  assert.equal(lastCall.url, 'https://staging-express.delhivery.com/api/p/edit');
  assert.deepEqual(JSON.parse(lastCall.options.body), { waybill: '3451910000123', cancellation: 'true' });
});

await acheck('cancel_not_allowed', async () => {
  stubFetch(() => jsonResponse({ success: false, rmk: 'Shipment cannot be cancelled - already Dispatched' }));
  await d().cancelShipment({ awb: '345' }).then(
    () => { throw new Error('should throw'); },
    (e) => { assert.equal(e.message, 'SHIPPING_PROVIDER_REJECTED'); assert.equal(e.notAllowed, true); },
  );
});

await acheck('cancel_timeout_is_ambiguous', async () => {
  global.fetch = async (url, options) => { await new Promise((_, rej) => options.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))); };
  await d().cancelShipment({ awb: '345' }).then(
    () => { throw new Error('should throw'); },
    (e) => { assert.equal(e.message, 'SHIPPING_PROVIDER_TIMEOUT'); assert.equal(e.ambiguous, true); },
  );
});

await acheck('edit_success', async () => {
  stubFetch(() => jsonResponse({ success: true }));
  const r = await d().editShipment({ awb: '345', weightGrams: 520, address: 'New Addr' });
  assert.equal(r.accepted, true);
  assert.deepEqual(JSON.parse(lastCall.options.body), { waybill: '345', add: 'New Addr', gm: 520 });
});

await acheck('edit_no_fields_rejected', async () => {
  global.fetch = async () => { throw new Error('should not call'); };
  await assert.rejects(() => d().editShipment({ awb: '345' }), (e) => e.message === 'SHIPPING_PROVIDER_REQUEST_INVALID');
});

// ---- service branching (stubbed repo + txn) ---------------------
const svc = ({ shipment, cancelImpl, onUnknown }) => new ShipmentProviderCancellationService({
  repository: {
    async shipment() { return shipment; },
    async updateShipment(c, id, fields) { shipment._updated = fields; },
    async insertEvent(c, e) { shipment._event = e; },
  },
  shipping: { orchestrator: { cancelShipment: cancelImpl } },
  onUnknown: onUnknown || (async () => {}),
  transaction: async (fn) => fn({ execute: async () => {} }),
});
const bookedShipment = () => ({ id: 's1', booking_status: 'BOOKED', status: 'BOOKED', tracking_number: 'AWB1', provider_code: 'DELHIVERY' });

await acheck('service_not_booked_409', async () => {
  const s = svc({ shipment: { id: 's1', booking_status: 'READY', status: 'DRAFT' }, cancelImpl: async () => ({ cancelled: true }) });
  await assert.rejects(() => s.cancel({ shipmentId: 's1' }), (e) => e.code === 'SHIPMENT_NOT_BOOKED' && e.status === 409);
});

await acheck('service_in_transit_not_allowed', async () => {
  const s = svc({ shipment: { id: 's1', booking_status: 'BOOKED', status: 'IN_TRANSIT', tracking_number: 'A' }, cancelImpl: async () => ({ cancelled: true }) });
  await assert.rejects(() => s.cancel({ shipmentId: 's1' }), (e) => e.code === 'CANCEL_NOT_ALLOWED' && e.status === 409);
});

await acheck('service_success_marks_cancelled', async () => {
  const shipment = bookedShipment();
  const s = svc({ shipment, cancelImpl: async () => ({ cancelled: true, providerRemark: 'ok' }) });
  const r = await s.cancel({ shipmentId: 's1', reason: 'customer changed mind' });
  assert.equal(r.cancelled, true);
  assert.equal(shipment._updated.status, 'CANCELLED');
  assert.equal(shipment._updated.booking_status, 'CANCELLED');
  assert.equal(shipment._event.normalizedStatus, 'CANCELLED');
  assert.equal(r.inventoryAction, 'PENDING_ORDER_DECISION');
});

await acheck('service_unknown_does_not_mark_cancelled', async () => {
  const shipment = bookedShipment();
  let raised = false;
  const s = svc({
    shipment,
    cancelImpl: async () => { throw Object.assign(new Error('SHIPPING_PROVIDER_TIMEOUT'), { ambiguous: true }); },
    onUnknown: async () => { raised = true; },
  });
  await assert.rejects(() => s.cancel({ shipmentId: 's1' }), (e) => e.code === 'CANCEL_UNKNOWN' && e.status === 409);
  assert.equal(shipment._updated, undefined, 'shipment must NOT be marked cancelled on UNKNOWN');
  assert.equal(raised, true, 'a reconciliation exception must be raised');
});

await acheck('service_provider_not_allowed', async () => {
  const s = svc({
    shipment: bookedShipment(),
    cancelImpl: async () => { throw Object.assign(new Error('SHIPPING_PROVIDER_REJECTED'), { notAllowed: true, providerReason: 'dispatched' }); },
  });
  await assert.rejects(() => s.cancel({ shipmentId: 's1' }), (e) => e.code === 'CANCEL_NOT_ALLOWED');
});

await acheck('mock_cancel_simulations', async () => {
  const m = new MockShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' }, production: false });
  assert.equal((await m.cancelShipment({ awb: 'MOCKAWB1' })).cancelled, true);
  await assert.rejects(() => m.cancelShipment({ awb: 'MOCKAWB999' }), (e) => e.notAllowed === true);
});

console.log('\n──── Phase 2 · Slice 15 — shipment edit + cancel ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSHIPMENT_CANCEL = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0 (fixture-only)');
process.exitCode = failed.length === 0 ? 0 : 1;
