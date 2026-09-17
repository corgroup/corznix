// Phase 2 — automated shipment workflow.
//   PROCESSING -> package -> book (AWB) -> label -> pickup -> notify, no admin
//   click per order; resumable; blocked/failed is visible + retryable; the
//   booking idempotency key is FIXED per shipment (never a 2nd AWB).
//
// Stubbed step services; #mark/queries run against the pool with throwaway ids
// (0-row updates). Self-contained.
import assert from 'node:assert/strict';
import { pool } from '../src/database/connection/pool.js';
import { AutoFulfillmentService } from '../src/modules/shipping/autoFulfillmentService.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

// A shipment whose state advances as steps "succeed".
function fakeShipment(overrides = {}) {
  return {
    id: `auto-test-${Math.random().toString(36).slice(2, 10)}`,
    status: 'DRAFT', booking_status: 'NOT_READY', tracking_number: null, provider_code: null,
    label_status: 'NONE', label_printed_at: null, pickup_requested_at: null,
    package_snapshot_json: null, warehouse_id: 'wh-1',
    auto_fulfillment_status: 'QUEUED', auto_fulfillment_step: null, auto_fulfillment_attempts: 0,
    ...overrides,
  };
}

function buildService({ shipment, hooks = {}, automationMode = 'AUTO' }) {
  const calls = [];
  const svc = new AutoFulfillmentService({
    now: () => new Date('2026-09-10T09:00:00Z'),
    automationEnabled: true,
    automationMode,
    repository: {
      async shipment() { return { ...shipment }; },
      async orderForShipment() { return { id: 'o1', order_number: 'COR-1' }; },
      async updateShipment(_c, _id, fields) { Object.assign(shipment, fields); },
      async setAutoFulfillment(_id, patch) {
        const map = { status: 'auto_fulfillment_status', step: 'auto_fulfillment_step', error: 'auto_fulfillment_error', attempts: 'auto_fulfillment_attempts', nextAt: 'auto_fulfillment_next_at' };
        for (const [k, v] of Object.entries(patch)) if (k in map && v !== undefined) shipment[map[k]] = v;
      },
    },
    pkg: {
      async calculatedItemWeightGrams() { calls.push('CALC_WEIGHT'); return hooks.calcWeight ?? { grams: 500, complete: true }; },
    },
    booking: {
      async book({ idempotencyKey }) {
        calls.push(`BOOK:${idempotencyKey}`);
        if (hooks.bookThrow) throw hooks.bookThrow;
        shipment.booking_status = 'BOOKED'; shipment.status = 'BOOKED'; shipment.tracking_number = 'AWB123'; shipment.provider_code = 'MOCK';
        return { shipment: { awbNumber: 'AWB123' } };
      },
    },
    label: {
      async fetchLabel() { calls.push('LABEL'); if (hooks.labelThrow) throw hooks.labelThrow; shipment.label_status = 'AVAILABLE'; return { labelStatus: 'AVAILABLE' }; },
    },
    pickup: {
      async requestForWarehouse() { calls.push('PICKUP'); if (hooks.pickupThrow) throw hooks.pickupThrow; shipment.pickup_requested_at = new Date(); shipment.status = 'PICKUP_PENDING'; return { mode: 'API' }; },
    },
    notifications: { async emit(k) { calls.push(`NOTIFY:${k}`); return {}; } },
  });
  return { svc, calls, shipment };
}

process.env.SHIPMENT_AUTOMATION_ENABLED = 'true';

await acheck('full_chain_from_processing', async () => {
  const shipment = fakeShipment();
  const { svc, calls } = buildService({ shipment });
  const r = await svc.runForShipment(shipment.id, { trigger: 'MANUAL' });
  assert.equal(r.done, true, JSON.stringify(r));
  assert.deepEqual(calls, ['CALC_WEIGHT', 'BOOK:auto:' + shipment.id, 'LABEL', 'PICKUP', 'NOTIFY:WAREHOUSE_SHIPMENT_READY']);
  assert.equal(shipment.tracking_number, 'AWB123');
});

await acheck('fixed_idempotency_key', async () => {
  const shipment = fakeShipment({ booking_status: 'READY', package_snapshot_json: JSON.stringify({ packageConfirmed: true }) });
  const { svc, calls } = buildService({ shipment });
  await svc.runForShipment(shipment.id, { trigger: 'MANUAL', maxSteps: 1 });
  assert.equal(calls[0], `BOOK:auto:${shipment.id}`); // NOT a per-attempt key
});

await acheck('missing_weight_blocks', async () => {
  const shipment = fakeShipment();
  const { svc } = buildService({ shipment, hooks: { calcWeight: { grams: null, complete: false } } });
  const r = await svc.runForShipment(shipment.id, { trigger: 'MANUAL' });
  assert.equal(r.blocked, true);
  assert.equal(r.step, 'PACKAGE');
  assert.equal(shipment.auto_fulfillment_status, 'BLOCKED');
});

await acheck('booking_unknown_blocks_no_retry', async () => {
  const shipment = fakeShipment({ booking_status: 'READY', package_snapshot_json: JSON.stringify({ packageConfirmed: true }) });
  const err = Object.assign(new Error('reconcile'), { code: 'BOOKING_RECONCILIATION_REQUIRED' });
  const { svc, calls } = buildService({ shipment, hooks: { bookThrow: err } });
  const r = await svc.runForShipment(shipment.id, { trigger: 'MANUAL' });
  assert.equal(r.blocked, true);
  assert.equal(shipment.auto_fulfillment_status, 'BLOCKED');
  assert.equal(calls.filter((c) => c.startsWith('BOOK')).length, 1); // exactly one attempt
});

await acheck('transient_label_error_requeues_with_backoff', async () => {
  const shipment = fakeShipment({ booking_status: 'BOOKED', status: 'BOOKED', tracking_number: 'AWB1', provider_code: 'MOCK' });
  const err = Object.assign(new Error('provider down'), { code: 'LABEL_FETCH_FAILED' });
  const { svc } = buildService({ shipment, hooks: { labelThrow: err } });
  const r = await svc.runForShipment(shipment.id, { trigger: 'MANUAL' });
  assert.ok(!r.blocked && !r.failed);
  assert.equal(shipment.auto_fulfillment_status, 'QUEUED');
  assert.equal(shipment.auto_fulfillment_attempts, 1);
  assert.ok(shipment.auto_fulfillment_next_at instanceof Date); // backoff scheduled
});

await acheck('pickup_not_ready_requeues_for_worker', async () => {
  const shipment = fakeShipment({ booking_status: 'BOOKED', status: 'BOOKED', tracking_number: 'AWB1', label_status: 'AVAILABLE' });
  const err = Object.assign(new Error('nothing ready'), { code: 'NO_SHIPMENTS_READY_FOR_PICKUP' });
  const { svc } = buildService({ shipment, hooks: { pickupThrow: err } });
  const r = await svc.runForShipment(shipment.id, { trigger: 'MANUAL' });
  assert.ok(!r.blocked && !r.failed); // transient, not a hard stop
  assert.equal(shipment.auto_fulfillment_status, 'QUEUED'); // worker retries PICKUP later
});

await acheck('pickup_auto_mode_advances_to_notify', async () => {
  const shipment = fakeShipment({ booking_status: 'BOOKED', status: 'BOOKED', tracking_number: 'AWB1', label_status: 'AVAILABLE' });
  const { svc, calls } = buildService({ shipment });
  // pickup stub returns { mode: 'API' } and stamps pickup_requested_at — but
  // simulate AUTO mode: override the stub
  svc.pickup = { async requestForWarehouse() { calls.push('PICKUP'); return { mode: 'AUTO' }; } };
  const r = await svc.runForShipment(shipment.id, { trigger: 'MANUAL' });
  assert.equal(r.done, true);
  assert.ok(calls.includes('NOTIFY:WAREHOUSE_SHIPMENT_READY'));
});

await acheck('terminal_shipment_is_noop', async () => {
  const shipment = fakeShipment({ status: 'DELIVERED', booking_status: 'BOOKED' });
  const { svc, calls } = buildService({ shipment });
  const r = await svc.runForShipment(shipment.id, { trigger: 'MANUAL' });
  assert.equal(r.done, true);
  assert.deepEqual(calls, []);
});

await acheck('manual_runs_even_when_automation_disabled', async () => {
  const shipment = fakeShipment({ status: 'DELIVERED', booking_status: 'BOOKED' });
  const { svc } = buildService({ shipment, automationMode: 'MANUAL' });
  const auto = await svc.runForShipment(shipment.id, { trigger: 'WORKER' });
  assert.equal(auto.skipped, 'AUTOMATION_DISABLED');
  const manual = await svc.runForShipment(shipment.id, { trigger: 'MANUAL' });
  assert.equal(manual.done, true);
});

console.log('\n──── Phase 2 — automated shipment workflow ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nAUTO_FULFILLMENT = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
await pool.end();
process.exitCode = failed.length === 0 ? 0 : 1;
