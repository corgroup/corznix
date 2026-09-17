// The unified fulfilment workflow — one screen, one next action.
//
// The CMS renders whatever the backend says the next operator action is. That
// only works if the backend is genuinely the single authority, so this asserts
// the properties the UI depends on:
//
//   * exactly one primary action is ever offered;
//   * the sequence is Confirm -> Start preparing -> Manifest -> Ready for
//     pickup, and nothing skips a step;
//   * there is NO action after Ready for Pickup — the carrier drives from
//     there, so no "Mark in transit" button can exist;
//   * the list page and the detail page derive their action from the SAME
//     function, so a row can never disagree with the order it opens;
//   * the shipping mode is taken from the customer's checkout choice and is
//     not an input the warehouse can change;
//   * customer charge and provider cost stay separate numbers.
//
//   npm run verify:fulfilment-ux --workspace=server
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool } = await import('../src/database/connection/pool.js');
const { nextOperatorAction, operatorProgress, OPERATOR_ACTIONS } = await import('../src/modules/orderOps/operatorFlow.js');
const { WORKFLOW_BUCKETS, WORKFLOW_KEYS } = await import('../src/modules/orderOps/workflowBuckets.js');

const results = {};
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results[name] = 'PASS'; console.log(`  PASS  ${name}`); } catch (err) {
    results[name] = `FAIL: ${err.message}`; failures += 1; console.error(`  FAIL  ${name} — ${err.message}`);
  }
};

const ship = (over = {}) => ({
  id: 's1', status: 'DRAFT', bookingStatus: 'READY', labelStatus: 'NONE', pickupRequestedAt: null, ...over,
});

console.log('\nFulfilment workflow verification\n');

await check('the_operator_sequence_is_exactly_the_specified_one', async () => {
  const steps = [
    [{ status: 'PLACED' }, [], 'CONFIRM_ORDER'],
    [{ status: 'CONFIRMED' }, [], 'START_PREPARING'],
    [{ status: 'PROCESSING' }, [ship()], 'MANIFEST_SHIPMENT'],
    [{ status: 'PROCESSING' }, [ship({ status: 'BOOKED', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE' })], 'READY_FOR_PICKUP'],
  ];
  for (const [order, shipments, expected] of steps) {
    const out = nextOperatorAction({ order, shipments });
    assert.equal(out.action, expected, `${order.status} offered ${out.action}, expected ${expected}`);
    assert.ok(out.label, `${expected} has no button label`);
  }
});

await check('there_is_never_more_than_one_next_action', async () => {
  // The return type enforces it structurally — one action, not a list. A
  // regression to an array of equally-weighted buttons would fail here.
  const out = nextOperatorAction({ order: { status: 'PROCESSING' }, shipments: [ship()] });
  assert.equal(typeof out.action, 'string');
  assert.ok(!Array.isArray(out.action), 'the next action became a list');
  assert.ok(!('actions' in out), 'a second action channel appeared alongside the primary one');
});

await check('nothing_is_offered_after_ready_for_pickup', async () => {
  // The carrier drives from here. A "Mark in transit" button would let a
  // warehouse assert a fact only a scan can establish.
  const after = [
    ship({ status: 'PICKUP_PENDING', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE', pickupRequestedAt: 'x' }),
    ship({ status: 'PICKED_UP', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE', pickupRequestedAt: 'x' }),
    ship({ status: 'IN_TRANSIT', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE', pickupRequestedAt: 'x' }),
    ship({ status: 'OUT_FOR_DELIVERY', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE', pickupRequestedAt: 'x' }),
    ship({ status: 'DELIVERED', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE', pickupRequestedAt: 'x' }),
  ];
  for (const s of after) {
    const out = nextOperatorAction({ order: { status: 'PROCESSING' }, shipments: [s] });
    assert.equal(out.action, null, `${s.status} still offers "${out.action}" to the warehouse`);
    assert.ok(out.stage, `${s.status} has no stage label to show instead`);
  }
});

await check('a_step_can_never_be_skipped', async () => {
  // Manifest is not offered until the order is actually being prepared.
  const notProcessing = nextOperatorAction({ order: { status: 'CONFIRMED' }, shipments: [ship()] });
  assert.equal(notProcessing.action, 'START_PREPARING', 'manifest was offered before preparing began');
  // Ready for pickup is not offered while the label is missing.
  const noLabel = nextOperatorAction({
    order: { status: 'PROCESSING' },
    shipments: [ship({ status: 'BOOKED', bookingStatus: 'BOOKED', labelStatus: 'PENDING' })],
  });
  assert.equal(noLabel.action, null, 'pickup was offered before the label existed');
  assert.equal(noLabel.waitingOn, 'LABEL', 'the operator is not told what is being waited on');
});

await check('a_waiting_state_explains_itself_in_business_language', async () => {
  const waits = [
    [[ship({ bookingStatus: 'UNKNOWN' })], 'RECONCILE'],
    [[ship({ status: 'BOOKED', bookingStatus: 'BOOKED', labelStatus: 'FAILED' })], 'LABEL'],
    [[], 'SHIPMENT'],
  ];
  for (const [shipments, expected] of waits) {
    const out = nextOperatorAction({ order: { status: 'PROCESSING' }, shipments });
    assert.equal(out.waitingOn, expected, `expected to be waiting on ${expected}, got ${out.waitingOn}`);
    assert.ok(out.hint && out.hint.length > 20, 'the wait has no explanation');
    assert.ok(!/[A-Z_]{6,}/.test(out.hint), `the hint leaks a raw enum: "${out.hint}"`);
  }
});

await check('an_unknown_booking_never_offers_a_second_manifest', async () => {
  // Re-manifesting a booking whose outcome is unknown could create a second
  // real shipment at the carrier.
  const out = nextOperatorAction({
    order: { status: 'PROCESSING' },
    shipments: [ship({ bookingStatus: 'UNKNOWN' })],
  });
  assert.equal(out.action, null, 'a manifest was offered on top of an ambiguous booking');
});

await check('owner_delivery_is_never_offered_a_carrier_action', async () => {
  const out = nextOperatorAction({ order: { status: 'PROCESSING' }, shipments: [ship()], isOwnerDelivery: true });
  assert.equal(out.action, null, 'a carrier action was offered on a store-delivered order');
  assert.match(out.stage, /owner/i);
});

await check('the_progress_rail_only_moves_forward', async () => {
  const seq = [
    [{ status: 'CONFIRMED' }, []],
    [{ status: 'PROCESSING' }, [ship()]],
    [{ status: 'PROCESSING' }, [ship({ status: 'BOOKED', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE' })]],
    [{ status: 'PROCESSING' }, [ship({ status: 'PICKUP_PENDING', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE', pickupRequestedAt: 'x' })]],
    [{ status: 'PROCESSING' }, [ship({ status: 'IN_TRANSIT', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE', pickupRequestedAt: 'x' })]],
    [{ status: 'COMPLETED' }, [ship({ status: 'DELIVERED', bookingStatus: 'BOOKED', labelStatus: 'AVAILABLE', pickupRequestedAt: 'x' })]],
  ];
  let last = -1;
  for (const [order, shipments] of seq) {
    const p = operatorProgress({ order, shipments });
    assert.ok(p.currentIndex >= last, `progress went backwards at ${order.status}/${shipments[0]?.status}`);
    last = p.currentIndex;
  }
  assert.equal(last, 5, 'a delivered order does not reach the end of the rail');
});

await check('the_cms_carries_no_transition_graph_of_its_own', async () => {
  // The whole point of backend-driven rendering. A hard-coded next-step map in
  // the CMS is what drifted last time.
  const files = [
    '../../apps/cms/src/features/fulfillment/FulfillmentWorkspace.jsx',
    '../../apps/cms/src/pages/OrdersPage.jsx',
  ];
  for (const rel of files) {
    const src = fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
    for (const forbidden of ['CONFIRM_PACKAGE', 'FETCH_LABEL', 'MARK_PRINTED', 'RUN_AUTOMATION']) {
      assert.ok(!src.includes(forbidden), `${rel} references the retired step ${forbidden}`);
    }
    // It may NAME actions for labels/icons, but must not decide the order.
    assert.ok(!/nextActions\s*\.\s*includes/.test(src),
      `${rel} decides the next step from a client-side list instead of the backend's nextOperatorAction`);
  }
});

await check('the_list_and_detail_pages_share_one_authority', async () => {
  const controller = fs.readFileSync(new URL('../src/modules/orderOps/controller.js', import.meta.url), 'utf8');
  // Both listRowDto and getOrder must call the same function.
  const calls = controller.match(/nextOperatorAction\(\{/g) || [];
  assert.ok(calls.length >= 2,
    'the list rows do not use nextOperatorAction — a row could disagree with the order it opens');
});

await check('the_shipping_mode_is_not_an_operator_input', async () => {
  const validation = fs.readFileSync(new URL('../src/modules/orderOps/validation.js', import.meta.url), 'utf8');
  const manifest = validation.slice(validation.indexOf('export const manifestBody'), validation.indexOf('export const pickupBody'));
  for (const forbidden of ['serviceLevel', 'shippingMode', 'shippingMethod']) {
    assert.ok(!manifest.includes(forbidden),
      `the manifest accepts ${forbidden} — the warehouse could ship a service the customer did not buy`);
  }
  // And the booking payload reads it from the persisted order snapshot.
  const service = fs.readFileSync(new URL('../src/modules/orderOps/service.js', import.meta.url), 'utf8');
  assert.match(service, /serviceLevel:\s*shippingSnap\.serviceLevel/,
    'the carrier booking does not take its service level from the order snapshot');
});

await check('customer_charge_and_provider_cost_stay_separate', async () => {
  const ordersRepo = fs.readFileSync(new URL('../src/modules/orders/repository.js', import.meta.url), 'utf8');
  for (const field of ['customerShippingChargeMinor', 'actualLogisticsCostMinor']) {
    assert.ok(ordersRepo.includes(field), `orders do not persist ${field}`);
  }
  const controller = fs.readFileSync(new URL('../src/modules/orderOps/controller.js', import.meta.url), 'utf8');
  assert.ok(controller.includes('customerShippingChargeMinor') && controller.includes('actualLogisticsCostMinor'),
    'the CMS is not shown both numbers, so free shipping would look free to CORCOTTON too');
});

await check('every_workflow_bucket_has_a_predicate_and_a_label', async () => {
  for (const key of WORKFLOW_KEYS) {
    const b = WORKFLOW_BUCKETS[key];
    assert.ok(b.label, `${key} has no label`);
    if (key !== 'ALL') {
      assert.ok(b.where && b.where.trim(), `${key} has no predicate — its tab would show everything`);
      assert.ok(!/\?/.test(b.where), `${key} interpolates a parameter — buckets must be fixed predicates`);
    }
  }
});

await check('every_bucket_agrees_with_the_stage_its_rows_show', async () => {
  // A tab that lists an order whose row says something else is worse than no
  // tab. This is a LIVE check against the real database, because the failure
  // mode is data-shaped: an order in one state still carrying a shipment row
  // from another. Found in the browser, so it is asserted from now on.
  const { orderOpsRepository } = await import('../src/modules/orderOps/repository.js');
  const EXPECTED_STAGES = {
    PREPARING: ['Preparing'],
    READY_TO_SHIP: ['Ready to ship'],
    READY_FOR_PICKUP: ['Ready for pickup'],
    IN_TRANSIT: ['In transit'],
    OUT_FOR_DELIVERY: ['Out for delivery'],
    DELIVERED: ['Delivered'],
    CANCELLED: ['Cancelled'],
  };
  const mismatches = [];
  for (const [bucket, stages] of Object.entries(EXPECTED_STAGES)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await orderOpsRepository.listOrders({ workflow: bucket, limit: 100 });
    for (const r of rows) {
      const live = Number(r.shipment_live_count || 0);
      const booked = Number(r.shipment_booked_count || 0);
      const lbl = Number(r.shipment_label_ready_count || 0);
      const pick = Number(r.shipment_pickup_count || 0);
      const tr = Number(r.shipment_transit_count || 0);
      const ofd = Number(r.shipment_ofd_count || 0);
      const dl = Number(r.shipment_delivered_count || 0);
      const shipments = [];
      for (let i = 0; i < live; i += 1) {
        const st = i < dl ? 'DELIVERED' : i < dl + ofd ? 'OUT_FOR_DELIVERY'
          : i < dl + ofd + tr ? 'IN_TRANSIT' : i < pick ? 'PICKUP_PENDING'
            : i < booked ? 'BOOKED' : 'DRAFT';
        shipments.push({
          status: st, bookingStatus: i < booked ? 'BOOKED' : 'READY',
          labelStatus: i < lbl ? 'AVAILABLE' : 'NONE', pickupRequestedAt: i < pick ? true : null,
        });
      }
      const { stage } = nextOperatorAction({ order: { status: r.order_status }, shipments });
      if (!stages.includes(stage)) mismatches.push(`${bucket} lists ${r.order_number} but its row shows "${stage}"`);
    }
  }
  assert.deepEqual(mismatches, [], mismatches.join('; '));
});

await check('every_offered_action_has_operator_facing_copy', async () => {
  for (const [key, def] of Object.entries(OPERATOR_ACTIONS)) {
    assert.ok(def.label && !/_/.test(def.label), `${key} has no human label`);
    assert.ok(def.hint && def.hint.length > 20, `${key} has no explanation`);
    assert.ok(def.stage, `${key} has no stage name`);
  }
});

console.log(`\n${failures ? 'FAILURES' : 'ALL PASS'} — ${Object.keys(results).length} checks, ${failures} failed\n`);
await pool.end();
process.exit(failures ? 1 : 0);
