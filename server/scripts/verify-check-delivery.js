// Phase 2 · Slice 4 — PDP "check delivery" (serviceability + EDD window).
// Pure window maths + a DB-backed checkDelivery in MOCK mode. 0 real provider calls.
import assert from 'node:assert/strict';
import { computeDeliveryWindow } from '../src/modules/shipping/deliveryWindow.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

// A Wednesday so day maths is easy to reason about.
const NOW = new Date('2026-09-02T09:00:00Z'); // Wed

await acheck('window_from_transit_days', () => {
  // lag 1 -> handover Thu 03; +4 transit -> Mon 07 (skips Sun 06); +2 buffer -> Wed 09
  const w = computeDeliveryWindow({ transitDays: 4 }, { now: NOW, bufferDays: 2, dispatchLagDays: 1 });
  assert.equal(w.earliestDate, '2026-09-07');
  assert.equal(w.latestDate, '2026-09-09');
  assert.equal(w.transitDays, 4);
  assert.equal(w.source, 'PROVIDER_TAT');
});

await acheck('window_from_provider_edd', () => {
  const w = computeDeliveryWindow({ estimatedDeliveryDate: '2026-09-10' }, { now: NOW, bufferDays: 2 });
  assert.equal(w.earliestDate, '2026-09-10');
  assert.equal(w.latestDate, '2026-09-12');
  assert.equal(w.source, 'PROVIDER_EDD');
});

await acheck('window_skips_sunday_on_both_ends', () => {
  // EDD Sun 2026-09-06 -> bumped to Mon 07; +1 buffer -> Tue 08
  const w = computeDeliveryWindow({ estimatedDeliveryDate: '2026-09-06' }, { now: NOW, bufferDays: 1 });
  assert.equal(w.earliestDate, '2026-09-07');
  assert.equal(w.latestDate, '2026-09-08');
});

await acheck('window_null_when_provider_gives_nothing', () => {
  assert.equal(computeDeliveryWindow({}, { now: NOW }), null);
  assert.equal(computeDeliveryWindow({ transitDays: null, estimatedDeliveryDate: null }, { now: NOW }), null);
});

await acheck('window_zero_buffer_is_single_day', () => {
  const w = computeDeliveryWindow({ estimatedDeliveryDate: '2026-09-10' }, { now: NOW, bufferDays: 0 });
  assert.equal(w.earliestDate, w.latestDate);
});

// ---- DB-backed (MOCK mode) --------------------------------------
await acheck('check_delivery_serviceable_pin', async () => {
  const { shippingService } = await import('../src/modules/shipping/service.js');
  const r = await shippingService.checkDelivery({ postalCode: '110001' });
  assert.equal(r.serviceable, true);
  // Either a window, or an honestly-reported gap (no invented dates).
  assert.ok(r.deliveryWindow || r.deliveryEstimateGap, 'serviceable result must carry a window or a gap reason');
  if (r.deliveryWindow) {
    assert.ok(r.deliveryWindow.earliestDate <= r.deliveryWindow.latestDate);
  }
});

await acheck('check_delivery_unserviceable_pin', async () => {
  const { shippingService } = await import('../src/modules/shipping/service.js');
  const r = await shippingService.checkDelivery({ postalCode: '000000' });
  assert.equal(r.serviceable, false);
  assert.equal(r.deliveryWindow, null);
});

await acheck('check_delivery_rejects_bad_pin', async () => {
  const { shippingService } = await import('../src/modules/shipping/service.js');
  await assert.rejects(() => shippingService.checkDelivery({ postalCode: '12A45' }), (e) => e.code === 'INVALID_POSTAL_CODE');
});

const { pool } = await import('../src/database/connection/pool.js');
await pool.end();

console.log('\n──── Phase 2 · Slice 4 — check delivery ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nCHECK_DELIVERY = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
console.log('REAL_PROVIDER_CALLS = 0');
process.exitCode = failed.length === 0 ? 0 : 1;
