// Phase 2 · Slice 13 — Delhivery track PULL + reconciliation.
//
// Isolated fixture test. global.fetch stubbed for the adapter; the
// reconciliation service runs with injected repository / orchestrator / applier
// / transaction / db stubs — NO real DB, NO real provider call.
//
//   * response shape not in Dev_API.docx ⇒ parser mirrors the DOCUMENTED Scan
//     Push payload and FAILS LOUD on an unreadable body — never fabricates
//   * an empty envelope is a valid "no shipment" answer (needed for
//     BOOKING_UNKNOWN resolution), not an error
//   * a pulled scan and a pushed scan produce the IDENTICAL idempotency key
//   * a failed pull NEVER mutates shipment state
//   * BOOKING_UNKNOWN: carrier has it ⇒ adopt AWB (BOOKED); carrier doesn't ⇒ FAILED
import assert from 'node:assert/strict';
import { DelhiveryShippingAdapter } from '../src/modules/shipping/providers/delhiveryAdapter.js';
import { MockShippingAdapter } from '../src/modules/shipping/providers/mockAdapter.js';
import { parseTrackResponse } from '../src/modules/shipping/providers/delhiveryTrack.js';
import { parseDelhiveryScanPush, scanPushIdempotencyKey } from '../src/modules/logistics/delhiveryScanPush.js';
import { TrackReconciliationService } from '../src/modules/logistics/trackReconciliation.js';

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

// The documented Scan Push payload shape, as a track record.
const trackBody = (over = {}) => ({
  ShipmentData: [{
    Shipment: {
      AWB: over.awb ?? '3451910000123',
      ReferenceNo: over.ref ?? 'COR-20260908-ABC',
      Status: {
        Status: over.status ?? 'In Transit',
        StatusType: over.type ?? 'UD',
        StatusDateTime: over.at ?? '2026-09-09T08:30:00',
        StatusLocation: over.loc ?? 'Gurugram_Hub (Haryana)',
        Instructions: over.ins ?? '',
      },
      NSLCode: over.nsl ?? 'X-UCI',
    },
  }],
});

// ---- pure parser --------------------------------------------------
await acheck('parse_scan_push_shaped_envelope', () => {
  const [s] = parseTrackResponse(trackBody());
  assert.equal(s.awb, '3451910000123');
  assert.equal(s.orderReference, 'COR-20260908-ABC');
  assert.equal(s.current.statusText, 'In Transit');
  assert.equal(s.current.statusType, 'UD');
  assert.equal(s.current.nslCode, 'X-UCI');
});

await acheck('parse_empty_envelope_is_not_an_error', () => {
  assert.deepEqual(parseTrackResponse({ ShipmentData: [] }), []);
  assert.deepEqual(parseTrackResponse([]), []);
});

await acheck('parse_unreadable_body_fails_loud', () => {
  assert.throws(() => parseTrackResponse({ foo: 'bar', totally: 'unknown' }), (e) => e.message === 'SHIPPING_PROVIDER_RESPONSE_INVALID');
  assert.throws(() => parseTrackResponse('garbage'), (e) => e.message === 'SHIPPING_PROVIDER_RESPONSE_INVALID');
});

await acheck('parse_bare_array_and_packages_envelope', () => {
  const bare = parseTrackResponse([{ Shipment: { AWB: '999', Status: { Status: 'Delivered', StatusType: 'DL', StatusDateTime: '2026-09-10T10:00:00' } } }]);
  assert.equal(bare[0].awb, '999');
  const pkgs = parseTrackResponse({ packages: [{ waybill: '888', status: { status: 'Pending', status_type: 'UD', status_date_time: '2026-09-10T09:00:00' } }] });
  assert.equal(pkgs[0].awb, '888');
});

// ---- adapter -----------------------------------------------------
await acheck('track_capability_declared', () => {
  assert.equal(dAdapter().supports('trackShipment'), true);
});

await acheck('track_by_waybill_query', async () => {
  stubFetch(() => jsonResponse(trackBody()));
  const r = await dAdapter().trackShipment({ awb: '3451910000123', providerCode: 'DELHIVERY' });
  assert.equal(lastCall.url.pathname, '/api/v1/packages/json/');
  assert.equal(lastCall.url.searchParams.get('waybill'), '3451910000123');
  assert.equal(r.providerCode, 'DELHIVERY');
  assert.equal(r.shipments[0].awb, '3451910000123');
  assert.equal(r.shipments[0].currentStatus.statusText, 'In Transit');
});

await acheck('track_by_ref_ids_query', async () => {
  stubFetch(() => jsonResponse(trackBody()));
  await dAdapter().trackShipment({ orderReference: 'COR-20260908-ABC', providerCode: 'DELHIVERY' });
  assert.equal(lastCall.url.searchParams.get('ref_ids'), 'COR-20260908-ABC');
  assert.equal(lastCall.url.searchParams.get('waybill'), null);
});

await acheck('track_more_than_50_waybills_rejected_before_call', async () => {
  global.fetch = async () => { throw new Error('fetch should not run'); };
  await assert.rejects(
    () => dAdapter().trackShipment({ awbNumbers: Array.from({ length: 51 }, (_, i) => `A${i}`) }),
    (e) => e.message === 'SHIPPING_PROVIDER_REQUEST_INVALID',
  );
});

await acheck('track_no_identifier_rejected', async () => {
  await assert.rejects(() => dAdapter().trackShipment({}), (e) => e.message === 'SHIPPING_PROVIDER_REQUEST_INVALID');
});

await acheck('track_auth_failure_mapped', async () => {
  stubFetch(() => jsonResponse({ message: 'Invalid token' }, 401));
  await assert.rejects(() => dAdapter().trackShipment({ awb: '1' }), (e) => e.message === 'SHIPPING_PROVIDER_AUTH_FAILED');
});

await acheck('track_unreadable_response_fails_loud', async () => {
  stubFetch(() => jsonResponse({ weird: true }));
  await assert.rejects(() => dAdapter().trackShipment({ awb: '1' }), (e) => e.message === 'SHIPPING_PROVIDER_RESPONSE_INVALID');
});

// ---- idempotency key parity (push vs pull) ----------------------
await acheck('pulled_scan_key_equals_pushed_scan_key', () => {
  const raw = {
    Shipment: {
      Status: { Status: 'Dispatched', StatusDateTime: '2026-09-11T06:00:00', StatusType: 'UD', StatusLocation: 'X', Instructions: 'OFD' },
      NSLCode: 'X-DEL', AWB: '3451910000123',
    },
  };
  const pushed = parseDelhiveryScanPush(raw).providerEventId;
  const pulled = scanPushIdempotencyKey({
    awb: '3451910000123', statusType: 'UD', statusText: 'Dispatched',
    statusDateTime: '2026-09-11T06:00:00', nslCode: 'X-DEL',
  });
  assert.equal(pulled, pushed);
  assert.ok(pulled);
});

// ---- reconciliation service (no DB) ----------------------------
const fakeShipment = (over = {}) => ({
  id: 'shp-1', status: 'BOOKED', booking_status: 'BOOKED', provider_code: 'DELHIVERY',
  tracking_number: 'AWB1', booked_at: new Date('2026-09-08T00:00:00Z'), ...over,
});
const svc = ({ shipment, track, applier, order, attemptRow, capture = {} }) => {
  let current = shipment;
  return new TrackReconciliationService({
    repository: {
      async shipment() { return current; },
      async orderForShipment() { return order ?? null; },
      async updateShipment(_c, _id, patch) { capture.patch = { ...(capture.patch || {}), ...patch }; current = { ...current, ...patch }; },
      async insertEvent(_c, e) { capture.events = [...(capture.events || []), e]; },
    },
    orchestrator: {
      async trackShipment(req) {
        capture.trackReq = req;
        if (track instanceof Error) throw track;
        return typeof track === 'function' ? track(req) : track;
      },
    },
    applier: applier || (async (event) => { capture.applied = [...(capture.applied || []), event]; return 'APPLIED'; }),
    transaction: async (fn) => fn({ execute: async (sql, params) => { capture.sql = [...(capture.sql || []), { sql, params }]; } }),
    db: async () => (attemptRow ? [attemptRow] : []),
    now: () => new Date('2026-09-12T00:00:00Z'),
  });
};

await acheck('reconcile_booked_applies_current_status', async () => {
  const capture = {};
  const r = await svc({
    shipment: fakeShipment(),
    track: { providerCode: 'DELHIVERY', shipments: [{ awb: 'AWB1', orderReference: 'COR-1', currentStatus: { statusText: 'In Transit', statusType: 'UD', statusDateTime: '2026-09-11T10:00:00' }, history: [] }] },
    capture,
  }).reconcileShipment('shp-1');
  assert.equal(r.outcome, 'RECONCILED');
  assert.equal(r.applied, 1);
  const ev = capture.applied[0];
  assert.equal(ev.capability, 'logistics');
  assert.equal(ev.providerKey, 'DELHIVERY');
  assert.equal(ev.summary.mappedStatus, 'IN_TRANSIT');
  assert.equal(ev.summary.source, 'TRACK_PULL');
  assert.ok(ev.providerEventId);
});

await acheck('reconcile_replays_history_in_order', async () => {
  const capture = {};
  await svc({
    shipment: fakeShipment(),
    track: { providerCode: 'DELHIVERY', shipments: [{
      awb: 'AWB1',
      currentStatus: { statusText: 'Dispatched', statusType: 'UD', statusDateTime: '2026-09-11T18:00:00' },
      history: [
        { statusText: 'In Transit', statusType: 'UD', statusDateTime: '2026-09-11T06:00:00' },
        { statusText: 'Pending', statusType: 'UD', statusDateTime: '2026-09-11T12:00:00' },
      ],
    }] },
    capture,
  }).reconcileShipment('shp-1');
  const order = capture.applied.map((e) => e.summary.statusText);
  assert.deepEqual(order, ['In Transit', 'Pending', 'Dispatched']);
});

await acheck('reconcile_terminal_shipment_skipped_no_applier', async () => {
  const capture = {};
  const r = await svc({ shipment: fakeShipment({ status: 'DELIVERED' }), track: { shipments: [] }, capture }).reconcileShipment('shp-1');
  assert.equal(r.outcome, 'SKIPPED');
  assert.equal(r.reason, 'TERMINAL');
  assert.equal(capture.trackReq, undefined); // never even pulled
});

await acheck('reconcile_no_awb_skipped', async () => {
  const r = await svc({ shipment: fakeShipment({ tracking_number: null }), track: { shipments: [] } }).reconcileShipment('shp-1');
  assert.equal(r.outcome, 'SKIPPED');
  assert.equal(r.reason, 'NO_AWB');
});

await acheck('failed_pull_never_mutates', async () => {
  const capture = {};
  const r = await svc({ shipment: fakeShipment(), track: new Error('SHIPPING_PROVIDER_AUTH_FAILED'), capture }).reconcileShipment('shp-1');
  assert.equal(r.outcome, 'PROVIDER_ERROR');
  assert.equal(r.status, 'BOOKED');
  assert.equal(capture.applied, undefined);
  assert.equal(capture.patch, undefined);
});

await acheck('unknown_booking_carrier_has_it_adopts_awb', async () => {
  const capture = {};
  const r = await svc({
    shipment: fakeShipment({ booking_status: 'UNKNOWN', tracking_number: null, status: 'BOOKING_PENDING', booked_at: null }),
    order: { order_number: 'COR-20260908-ABC' },
    track: { providerCode: 'DELHIVERY', shipments: [{ awb: 'DL777', orderReference: 'COR-20260908-ABC', currentStatus: { statusText: 'Manifested', statusType: 'UD', statusDateTime: '2026-09-09T00:00:00' }, history: [] }] },
    capture,
  }).reconcileBookingUnknown('shp-1');
  assert.equal(r.outcome, 'BOOKED');
  assert.equal(r.awb, 'DL777');
  assert.equal(capture.patch.booking_status, 'BOOKED');
  assert.equal(capture.patch.tracking_number, 'DL777');
  assert.equal(capture.patch.status, 'BOOKED');
  assert.ok(capture.patch.external_shipment_id);
  // attempt row promoted + a RECONCILE booked event written
  assert.ok(capture.sql.some((q) => /SUCCEEDED/.test(q.sql)));
  assert.ok((capture.events || []).some((e) => e.source === 'RECONCILE'));
});

await acheck('unknown_booking_carrier_lacks_it_marks_failed', async () => {
  const capture = {};
  const r = await svc({
    shipment: fakeShipment({ booking_status: 'UNKNOWN', tracking_number: null, status: 'BOOKING_PENDING' }),
    order: { order_number: 'COR-NOPE' },
    track: { providerCode: 'DELHIVERY', shipments: [] },
    capture,
  }).reconcileBookingUnknown('shp-1');
  assert.equal(r.outcome, 'NOT_BOOKED');
  assert.equal(capture.patch.booking_status, 'FAILED');
  assert.ok(capture.sql.some((q) => /RECONCILED_NOT_AT_CARRIER/.test(q.sql)));
});

await acheck('unknown_booking_pull_failure_stays_unknown', async () => {
  const capture = {};
  const r = await svc({
    shipment: fakeShipment({ booking_status: 'UNKNOWN', tracking_number: null }),
    order: { order_number: 'COR-1' },
    track: new Error('SHIPPING_PROVIDER_UNAVAILABLE'),
    capture,
  }).reconcileBookingUnknown('shp-1');
  assert.equal(r.outcome, 'STILL_UNKNOWN');
  assert.equal(capture.patch, undefined);
});

await acheck('reconcile_dispatches_unknown_to_booking_resolver', async () => {
  // reconcileShipment on an UNKNOWN shipment routes to reconcileBookingUnknown
  const capture = {};
  const r = await svc({
    shipment: fakeShipment({ booking_status: 'UNKNOWN', tracking_number: null }),
    order: { order_number: 'COR-1' },
    track: { shipments: [] },
    capture,
  }).reconcileShipment('shp-1');
  assert.equal(r.outcome, 'NOT_BOOKED');
});

// ---- mock adapter parity --------------------------------------
await acheck('mock_adapter_track_is_deterministic', async () => {
  const m = new MockShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' }, production: false });
  const r = await m.trackShipment({ awb: 'MOCKAWB1', simulate: { statusText: 'Delivered', statusType: 'DL', statusDateTime: '2026-09-12T10:00:00' } });
  assert.equal(r.shipments[0].awb, 'MOCKAWB1');
  assert.equal(r.shipments[0].currentStatus.statusText, 'Delivered');
  const empty = await m.trackShipment({ orderReference: 'X', simulateEmpty: true });
  assert.deepEqual(empty.shipments, []);
});

console.log('\n──── Phase 2 · Slice 13 — track pull + reconciliation ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nTRACK_RECONCILIATION = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0 (fixture-only)');
process.exitCode = failed.length === 0 ? 0 : 1;
