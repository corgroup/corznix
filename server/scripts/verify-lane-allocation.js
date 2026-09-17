// Per-lane warehouse allocation policy.
//
// Encodes the specification's own worked example, which the previous
// destination-only serviceability check could not express:
//
//   Warehouse A — closest, but does NOT have the stock
//   Warehouse B — farther, has the complete stock, and CAN reach the customer
//   Warehouse C — has the stock, but the customer's PIN is NOT serviceable
//                 from that origin
//   => B must be selected.
//
// Serviceability used to be one destination-only question answered for every
// warehouse at once, so C was indistinguishable from B and could be chosen.
//
// Pure policy test: the real WarehouseAllocationService is driven with
// injected repository / inventory / shipping doubles, so it asserts the
// decision rules rather than the contents of a database. No DB, no network.
//
//   npm run verify:lane-allocation --workspace=server
import assert from 'node:assert/strict';

const { WarehouseAllocationService, ALLOCATION_STATUS } =
  await import('../src/modules/warehouses/allocationService.js');

const results = {};
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results[name] = 'PASS'; console.log(`  PASS  ${name}`); } catch (err) {
    results[name] = `FAIL: ${err.message}`; failures += 1; console.error(`  FAIL  ${name} — ${err.message}`);
  }
};

const SKU = 'sku-tee-m';
const DEST = '110001';

// Warehouses, nearest first by PIN prefix against DEST.
const WAREHOUSES = [
  { id: 'wh-a', code: 'A', name: 'Warehouse A', priority: 1, postal_code: '110002' }, // closest
  { id: 'wh-b', code: 'B', name: 'Warehouse B', priority: 2, postal_code: '221001' }, // farther
  { id: 'wh-c', code: 'C', name: 'Warehouse C', priority: 3, postal_code: '560001' }, // farthest
];

/** @param {Record<string, number>} stockByWarehouse units of SKU per warehouse */
const inventoryDouble = (stockByWarehouse) => ({
  inventory: {
    async findForSkuIds() {
      return Object.entries(stockByWarehouse).map(([warehouse_id, on_hand]) => ({
        warehouse_id, sku_id: SKU, on_hand, reserved: 0,
      }));
    },
  },
});

/** @param {Record<string, {serviceable: boolean|null, transitDays?: number|null}>} lanes */
const shippingDouble = (lanes, { destinationServiceable = true } = {}) => ({
  async laneServiceability({ origins }) {
    return new Map(origins.map((o) => [o.warehouseId, {
      serviceable: lanes[o.warehouseId]?.serviceable ?? null,
      transitDays: lanes[o.warehouseId]?.transitDays ?? null,
      reason: 'TEST',
    }]));
  },
  async quote() { return { serviceable: destinationServiceable }; },
});

const build = ({ stock, lanes, destinationServiceable = true }) => new WarehouseAllocationService({
  repository: { async activeOrderedByPriority() { return WAREHOUSES; } },
  inventory: inventoryDouble(stock),
  shipping: shippingDouble(lanes, { destinationServiceable }),
});

// ---- 1. the specification's worked example ------------------------------
await check('spec_example_picks_B_not_the_nearest_and_not_the_unserviceable', async () => {
  const svc = build({
    stock: { 'wh-a': 0, 'wh-b': 5, 'wh-c': 5 },
    lanes: {
      'wh-a': { serviceable: true, transitDays: 1 },
      'wh-b': { serviceable: true, transitDays: 3 },
      'wh-c': { serviceable: false },          // stock, but cannot reach the customer
    },
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 2 }] });
  assert.equal(out.status, ALLOCATION_STATUS.ALLOCATED);
  assert.equal(out.allocations.length, 1, 'one warehouse should cover the order');
  assert.equal(out.allocations[0].warehouseId, 'wh-b',
    `expected Warehouse B, got ${out.allocations[0].warehouseId}`);
  assert.equal(out.serviceabilityBasis, 'PER_LANE');
});

// The regression this guards: C is only excluded because the lane says so.
await check('unserviceable_lane_is_the_only_reason_C_is_excluded', async () => {
  const svc = build({
    stock: { 'wh-a': 0, 'wh-b': 0, 'wh-c': 5 },
    lanes: { 'wh-a': { serviceable: true }, 'wh-b': { serviceable: true }, 'wh-c': { serviceable: false } },
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 2 }] });
  assert.equal(out.status, ALLOCATION_STATUS.UNALLOCATABLE,
    'the only warehouse with stock cannot reach the customer, so nothing is allocatable');
  assert.equal(out.allocations.length, 0);
});

// ---- 1b. distance is never a rejection criterion ------------------------
// "Never convert a warehouse-level failure into an order-level failure until
// every eligible warehouse has been evaluated." The nearest warehouse being
// empty says nothing about the order; only the exhaustion of ALL of them does.
await check('farthest_warehouse_alone_having_stock_still_accepts_the_order', async () => {
  const svc = build({
    // Only the LAST-ranked warehouse can fulfil it.
    stock: { 'wh-a': 0, 'wh-b': 0, 'wh-c': 10 },
    lanes: {
      'wh-a': { serviceable: true, transitDays: 1 },
      'wh-b': { serviceable: true, transitDays: 2 },
      'wh-c': { serviceable: true, transitDays: 9 }, // reachable, just slow
    },
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 3 }] });
  assert.equal(out.status, ALLOCATION_STATUS.ALLOCATED,
    'an empty nearest warehouse must not fail the order while a farther one can fulfil it');
  assert.equal(out.allocations[0].warehouseId, 'wh-c');
  assert.equal(out.unmet.length, 0);
});

await check('order_is_rejected_only_when_no_warehouse_qualifies', async () => {
  // Each warehouse fails for a different reason, so none is eligible.
  const svc = build({
    stock: { 'wh-a': 0, 'wh-b': 0, 'wh-c': 10 },
    lanes: {
      'wh-a': { serviceable: true },            // reachable, no stock
      'wh-b': { serviceable: true },            // reachable, no stock
      'wh-c': { serviceable: false },           // stock, unreachable
    },
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 1 }] });
  assert.equal(out.status, ALLOCATION_STATUS.UNALLOCATABLE,
    'rejection is correct ONLY because every warehouse failed inventory or serviceability');
});

// ---- 2. TAT beats proximity (the ranking rule the spec asks for) ---------
await check('faster_lane_wins_over_nearer_warehouse', async () => {
  const svc = build({
    stock: { 'wh-a': 5, 'wh-b': 5, 'wh-c': 5 },
    lanes: {
      'wh-a': { serviceable: true, transitDays: 6 }, // nearest by PIN, slowest lane
      'wh-b': { serviceable: true, transitDays: 2 }, // farther, fastest lane
      'wh-c': { serviceable: true, transitDays: 4 },
    },
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 1 }] });
  assert.equal(out.allocations[0].warehouseId, 'wh-b', 'fastest transit time should win, not the nearest PIN');
  assert.equal(out.selectionReason, 'TAT');
  assert.deepEqual(out.laneTransitDays, { 'wh-a': 6, 'wh-b': 2, 'wh-c': 4 });
});

// Without transit times, ranking must still fall back to proximity.
await check('without_tat_falls_back_to_pin_proximity', async () => {
  const svc = build({
    stock: { 'wh-a': 5, 'wh-b': 5, 'wh-c': 5 },
    lanes: { 'wh-a': { serviceable: true }, 'wh-b': { serviceable: true }, 'wh-c': { serviceable: true } },
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 1 }] });
  assert.equal(out.allocations[0].warehouseId, 'wh-a', 'nearest PIN prefix wins when no TAT is available');
  assert.equal(out.selectionReason, 'PIN_PROXIMITY');
});

// ---- 3. a carrier that cannot answer must not refuse every order --------
await check('all_lanes_inconclusive_falls_back_to_destination_check', async () => {
  const svc = build({
    stock: { 'wh-a': 5, 'wh-b': 5, 'wh-c': 5 },
    lanes: {}, // every lane null => nothing known
    destinationServiceable: true,
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 1 }] });
  assert.equal(out.serviceabilityBasis, 'DESTINATION_ONLY', 'must degrade to the older coarse check');
  assert.equal(out.status, ALLOCATION_STATUS.ALLOCATED, 'a provider that cannot answer must not refuse the order');
});

await check('destination_unserviceable_still_refuses', async () => {
  const svc = build({
    stock: { 'wh-a': 5, 'wh-b': 5, 'wh-c': 5 },
    lanes: {},
    destinationServiceable: false,
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 1 }] });
  assert.equal(out.status, ALLOCATION_STATUS.UNALLOCATABLE, 'fail-closed on a genuinely unserviceable destination');
});

// One bad lane must not discard the warehouses that DID answer.
await check('one_failed_lane_does_not_discard_the_others', async () => {
  const svc = build({
    stock: { 'wh-a': 0, 'wh-b': 5, 'wh-c': 5 },
    lanes: {
      'wh-a': { serviceable: true },
      'wh-b': { serviceable: true, transitDays: 3 },
      'wh-c': { serviceable: null }, // timed out — unknown, not "no"
    },
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 2 }] });
  assert.equal(out.status, ALLOCATION_STATUS.ALLOCATED);
  assert.equal(out.serviceabilityBasis, 'PER_LANE');
  assert.equal(out.allocations[0].warehouseId, 'wh-b');
});

// ---- 4. splitting still respects lane eligibility ------------------------
await check('split_never_uses_an_unserviceable_warehouse', async () => {
  const svc = build({
    stock: { 'wh-a': 1, 'wh-b': 1, 'wh-c': 50 },
    lanes: {
      'wh-a': { serviceable: true, transitDays: 2 },
      'wh-b': { serviceable: true, transitDays: 3 },
      'wh-c': { serviceable: false }, // plenty of stock, unreachable
    },
  });
  const out = await svc.allocate({ destinationPostalCode: DEST, items: [{ skuId: SKU, quantity: 5 }] });
  const used = out.allocations.map((a) => a.warehouseId);
  assert.ok(!used.includes('wh-c'), 'an unserviceable warehouse must never appear in a split');
  assert.equal(out.status, ALLOCATION_STATUS.PARTIALLY_UNAVAILABLE, 'only 2 of 5 units are reachable');
  assert.equal(out.unmet[0].quantity, 3);
});

console.log(`\n${JSON.stringify(results, null, 2)}`);
console.log(`\nLANE_ALLOCATION = ${failures ? 'FAIL' : 'PASS'}`);
if (failures) process.exit(1);
