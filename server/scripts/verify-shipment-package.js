// Phase 2 · Slice 8 — fulfilment package confirmation (E2E spec §4/§26).
//
// Isolated (repo + transaction stubbed). NO DB / provider call.
//   * calculated item weight = SUM(effective SKU weight * qty); a SKU with no
//     weight ⇒ marked incomplete, never defaulted
//   * confirm writes the operator's ACTUAL packed weight + box; positive ints only
//   * confirming clears the package gate (NOT_READY -> READY)
//   * a booked shipment's package is locked
import assert from 'node:assert/strict';
import { ShipmentPackageService } from '../src/modules/orderOps/shipmentCancellationService.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

const svc = ({ shipment, items }) => new ShipmentPackageService({
  repository: {
    async shipment() { return shipment; },
    async packageItemsForShipment() { return items; },
    async updateShipment(c, id, fields) { shipment._updated = fields; },
  },
  transaction: async (fn) => fn({ execute: async () => {} }),
});

await acheck('calc_weight_complete', async () => {
  const s = svc({ shipment: {}, items: [
    { sku_id: 'a', quantity: 2, effective_weight_grams: 280 },
    { sku_id: 'b', quantity: 1, effective_weight_grams: 650 },
  ] });
  const r = await s.calculatedItemWeightGrams('s1');
  assert.equal(r.grams, 2 * 280 + 650);
  assert.equal(r.complete, true);
});

await acheck('calc_weight_incomplete_when_a_sku_has_no_weight', async () => {
  const s = svc({ shipment: {}, items: [
    { sku_id: 'a', quantity: 1, effective_weight_grams: 300 },
    { sku_id: 'b', quantity: 1, effective_weight_grams: null },
  ] });
  const r = await s.calculatedItemWeightGrams('s1');
  assert.equal(r.complete, false); // never silently defaulted
});

await acheck('confirm_writes_snapshot_and_readies', async () => {
  const shipment = { id: 's1', booking_status: 'NOT_READY', status: 'DRAFT' };
  const s = svc({ shipment, items: [{ sku_id: 'a', quantity: 1, effective_weight_grams: 500 }] });
  const r = await s.confirm({ shipmentId: 's1', weightGrams: 520, lengthMm: 300, widthMm: 220, heightMm: 50, staffUserId: 'st1' });
  assert.equal(r.package.weightGrams, 520);
  assert.equal(r.package.calculatedItemWeightGrams, 500);
  assert.equal(r.package.packageConfirmed, true);
  assert.equal(r.bookingStatus, 'READY');
  const written = JSON.parse(shipment._updated.package_snapshot_json);
  assert.equal(written.weightGrams, 520);
  assert.equal(shipment._updated.booking_status, 'READY');
});

await acheck('confirm_rejects_non_positive', async () => {
  const s = svc({ shipment: { id: 's1', booking_status: 'READY', status: 'DRAFT' }, items: [] });
  await assert.rejects(() => s.confirm({ shipmentId: 's1', weightGrams: 0, lengthMm: 10, widthMm: 10, heightMm: 10 }), (e) => e.status === 422);
});

await acheck('confirm_blocked_after_booking', async () => {
  const s = svc({ shipment: { id: 's1', booking_status: 'BOOKED', status: 'BOOKED' }, items: [] });
  await assert.rejects(
    () => s.confirm({ shipmentId: 's1', weightGrams: 500, lengthMm: 10, widthMm: 10, heightMm: 10 }),
    (e) => e.code === 'SHIPMENT_ALREADY_BOOKED' && e.status === 409,
  );
});

await acheck('confirm_keeps_ready_status_if_already_ready', async () => {
  const shipment = { id: 's1', booking_status: 'READY', status: 'DRAFT' };
  const s = svc({ shipment, items: [] });
  const r = await s.confirm({ shipmentId: 's1', weightGrams: 500, lengthMm: 10, widthMm: 10, heightMm: 10 });
  assert.equal(r.bookingStatus, 'READY');
  assert.equal(shipment._updated.booking_status, 'READY');
});

console.log('\n──── Phase 2 · Slice 8 — package confirmation ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSHIPMENT_PACKAGE = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
process.exitCode = failed.length === 0 ? 0 : 1;
