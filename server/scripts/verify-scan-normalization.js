// Phase 2 · Slice 14 — Delhivery Scan Push normalization, now grounded in the
// confirmed Dev_API.docx forward status family (not the earlier "conceptual"
// analysis). Pure — no DB, no provider call.
//
//   Manifested -> Not Picked -> In Transit -> Pending -> Dispatched -> Delivered
//   "Dispatched" = out for delivery to the customer  => OUT_FOR_DELIVERY (was IN_TRANSIT — fixed)
//   "Pending"    = at DC, not yet out for delivery    => IN_TRANSIT
//   DL Delivered != DL RTO != DL DTO — never collapsed
import assert from 'node:assert/strict';
import { mapDelhiveryStatus } from '../src/modules/logistics/statusMap.js';
import { parseDelhiveryScanPush } from '../src/modules/logistics/delhiveryScanPush.js';

const results = {};
const check = (name, fn) => {
  try { fn(); results[name] = 'PASS'; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${results[name].startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};
const map = (statusType, statusText) => mapDelhiveryStatus({ statusType, statusText });

check('forward_family', () => {
  assert.equal(map('UD', 'Manifested'), 'BOOKED');
  assert.equal(map('UD', 'Not Picked'), 'PICKUP_PENDING');
  assert.equal(map('UD', 'In Transit'), 'IN_TRANSIT');
  assert.equal(map('UD', 'Pending'), 'IN_TRANSIT');
  assert.equal(map('UD', 'Dispatched'), 'OUT_FOR_DELIVERY'); // the fix
  assert.equal(map('DL', 'Delivered'), 'DELIVERED');
});

check('dispatched_is_not_in_transit', () => {
  // regression guard for the corrected mapping
  assert.notEqual(map('UD', 'Dispatched'), 'IN_TRANSIT');
});

check('rto_family_distinct_from_delivered', () => {
  assert.equal(map('RT', 'In Transit'), 'RTO_IN_TRANSIT');
  assert.equal(map('RT', 'Pending'), 'RTO_IN_TRANSIT');
  assert.equal(map('DL', 'RTO'), 'RTO_RETURNED');
  assert.notEqual(map('DL', 'RTO'), 'DELIVERED');
});

check('reverse_family_on_forward_shipment_unmapped', () => {
  assert.equal(map('PP', 'Open'), null);
  assert.equal(map('PU', 'In Transit'), null);
});

check('cancelled', () => {
  assert.equal(map('CN', 'Canceled'), 'CANCELLED');
});

check('undelivered_attempt_maps_to_exception', () => {
  assert.equal(map('UD', 'Undelivered - Consignee unavailable'), 'DELIVERY_EXCEPTION');
});

check('parser_carries_status_type_and_nsl', () => {
  const parsed = parseDelhiveryScanPush({
    Shipment: {
      Status: { Status: 'Dispatched', StatusDateTime: '2026-09-08T10:00:00', StatusType: 'UD', StatusLocation: 'Gurugram_Hub (Haryana)', Instructions: 'Out for delivery' },
      NSLCode: 'X-DEL', Sortcode: 'DEL/xyz', ReferenceNo: 'COR-20260902-ABC', AWB: '3451910000123',
    },
  });
  assert.equal(parsed.resourceId, '3451910000123');
  assert.equal(parsed.normalizedEventType, 'OUT_FOR_DELIVERY');
  assert.equal(parsed.safeSummary.statusType, 'UD');
  assert.equal(parsed.safeSummary.nslCode, 'X-DEL');
  assert.equal(parsed.safeSummary.mappedStatus, 'OUT_FOR_DELIVERY');
  assert.ok(parsed.providerEventId); // composite idempotency key
});

check('parser_idempotency_key_stable_and_distinct', () => {
  const base = { Status: { Status: 'Delivered', StatusDateTime: '2026-09-09T12:00:00', StatusType: 'DL' }, AWB: '999', NSLCode: 'DLV' };
  const a = parseDelhiveryScanPush({ Shipment: base });
  const b = parseDelhiveryScanPush({ Shipment: base });
  const c = parseDelhiveryScanPush({ Shipment: { ...base, Status: { ...base.Status, StatusDateTime: '2026-09-09T13:00:00' } } });
  assert.equal(a.providerEventId, b.providerEventId);
  assert.notEqual(a.providerEventId, c.providerEventId);
});

console.log('\n──── Phase 2 · Slice 14 — scan normalization ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSCAN_NORMALIZATION = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
process.exitCode = failed.length === 0 ? 0 : 1;
