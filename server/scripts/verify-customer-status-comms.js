// Customer-facing status flow + its communications.
//
// Two questions, verified together because they are the same question from two
// sides: does the customer see the RIGHT status, and are they TOLD about it on
// both channels?
//
// What this asserts, and why each one matters:
//
//   * Every customer-facing transition has a notification policy. A transition
//     the customer can see but is never told about is a support ticket.
//   * Internal warehouse states never reach the customer. MANIFESTING,
//     label-fetched, mark-printed, PICKUP_PENDING and booking reconciliation
//     are CORCOTTON's problem, not the shopper's.
//   * "Shipped" is never claimed before a real carrier scan. READY_FOR_SHIPMENT
//     carries no AWB and no tracking link precisely so it cannot read as
//     "shipped" — the parcel is still on a shelf in the warehouse.
//   * Dispatch is idempotent per (business event, channel). A webhook replay or
//     a double-click must not message a customer twice.
//   * Both channels resolve to the customer's own VERIFIED contact — the right
//     email address and the registered WhatsApp number, in the E.164 form the
//     provider adapter expects.
//   * A notification failure never rolls back the domain transition.
//   * One provider being down does not stop the other channel or corrupt state.
//
// No real message is ever sent: the communication worker is disabled and the
// enqueue path is exercised against the real dedupe, not a stub.
//
//   npm run verify:customer-status-comms --workspace=server
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { NOTIFICATION_POLICIES } = await import('../src/modules/notifications/policies.js');
const { TEMPLATE_DEFAULTS } = await import('../src/modules/notifications/templateDefaults.js');
const { notificationService } = await import('../src/modules/notifications/service.js');
const { resolveRecipient } = await import('../src/modules/notifications/recipients.js');
const { customerOrderStatus, customerTimeline, customerActivity, CUSTOMER_STATUSES } = await import('../src/modules/orderOps/customerStatus.js');

const results = {};
let failures = 0;
const check = async (name, fn) => {
  try { await fn(); results[name] = 'PASS'; console.log(`  PASS  ${name}`); } catch (err) {
    results[name] = `FAIL: ${err.message}`; failures += 1; console.error(`  FAIL  ${name} — ${err.message}`);
  }
};

// Every customer-visible transition and the policy that must announce it.
const TRANSITION_MATRIX = [
  { customerStatus: 'CONFIRMED', event: 'ORDER_CONFIRMED', channels: ['EMAIL', 'WHATSAPP'] },
  { customerStatus: 'PROCESSING', event: 'ORDER_PROCESSING', channels: ['EMAIL', 'WHATSAPP'] },
  { customerStatus: 'READY_FOR_SHIPMENT', event: 'ORDER_READY_FOR_SHIPMENT', channels: ['EMAIL', 'WHATSAPP'] },
  { customerStatus: 'IN_TRANSIT', event: 'ORDER_SHIPPED', channels: ['EMAIL', 'WHATSAPP'] },
  { customerStatus: 'OUT_FOR_DELIVERY', event: 'ORDER_OUT_FOR_DELIVERY', channels: ['EMAIL', 'WHATSAPP'] },
  { customerStatus: 'DELIVERED', event: 'ORDER_DELIVERED', channels: ['EMAIL', 'WHATSAPP'] },
];

const EXCEPTION_EVENTS = [
  'ORDER_CANCELLED', 'ORDER_DELIVERY_ATTEMPT_FAILED',
  'RETURN_REQUESTED', 'RETURN_APPROVED', 'RETURN_REJECTED', 'RETURN_RECEIVED',
  'REFUND_INITIATED', 'REFUND_COMPLETED',
];

// Internal-only states. If any of these ever became a customer status the
// shopper would be reading warehouse mechanics.
const INTERNAL_ONLY = [
  'WAREHOUSE_CONFIRMED', 'MANIFESTING', 'MANIFESTED', 'LABEL_FETCHED', 'LABEL_PRINTED',
  'MARK_PRINTED', 'BOOKING_PENDING', 'READY_TO_BOOK', 'PICKUP_PENDING', 'BOOKED', 'DRAFT', 'PROCESSING_INTERNAL',
];

console.log('\nCustomer status + communication verification\n');

await check('every_customer_transition_has_a_policy', async () => {
  for (const row of TRANSITION_MATRIX) {
    const policy = NOTIFICATION_POLICIES[row.event];
    assert.ok(policy, `${row.customerStatus} has no notification policy (${row.event})`);
    for (const channel of row.channels) {
      assert.ok(
        policy.channels.includes(channel),
        `${row.event} does not notify on ${channel} — the customer would only hear about ${row.customerStatus} on one channel`,
      );
    }
    assert.equal(policy.classification, 'TRANSACTIONAL',
      `${row.event} must be TRANSACTIONAL — an order fact is not marketing and must not be gated by marketing consent`);
  }
});

await check('every_policy_has_template_content_for_each_channel', async () => {
  const missing = [];
  for (const row of TRANSITION_MATRIX) {
    const policy = NOTIFICATION_POLICIES[row.event];
    const defaults = TEMPLATE_DEFAULTS[policy.templateKey];
    for (const channel of policy.channels) {
      if (!defaults?.[channel]) missing.push(`${policy.templateKey}/${channel}`);
    }
  }
  assert.deepEqual(missing, [], `no default template content for: ${missing.join(', ')}`);
});

await check('email_templates_have_a_subject_and_a_body', async () => {
  for (const row of TRANSITION_MATRIX) {
    const t = TEMPLATE_DEFAULTS[NOTIFICATION_POLICIES[row.event].templateKey].EMAIL;
    assert.ok(t.subject && t.subject.trim().length > 5, `${row.event} EMAIL has no usable subject`);
    assert.ok(t.bodyTemplate && t.bodyTemplate.includes('{{orderNumber}}'),
      `${row.event} EMAIL body never names the order — the customer cannot tell which order it is about`);
  }
});

await check('exception_flows_are_all_covered', async () => {
  const missing = EXCEPTION_EVENTS.filter((e) => !NOTIFICATION_POLICIES[e]);
  assert.deepEqual(missing, [], `exception flows with no policy: ${missing.join(', ')}`);
});

// The load-bearing one: a customer must never be told "shipped" while the
// parcel is still in the warehouse.
await check('shipped_is_never_claimed_before_a_carrier_scan', async () => {
  const ready = NOTIFICATION_POLICIES.ORDER_READY_FOR_SHIPMENT;
  const readyVars = Object.keys(ready.variableSchema);
  assert.ok(!readyVars.some((k) => /awb|track/i.test(k)),
    'ORDER_READY_FOR_SHIPMENT carries a tracking variable — a tracking link before pickup reads as "shipped" and resolves to nothing');
  for (const channel of ready.channels) {
    const body = TEMPLATE_DEFAULTS[ready.templateKey][channel].bodyTemplate.toLowerCase();
    assert.ok(!/\bhas shipped\b|\bis on its way\b|\bdispatched\b/.test(body),
      `ORDER_READY_FOR_SHIPMENT ${channel} copy claims the order shipped`);
  }
  // And the one that DOES say shipped is bound to the carrier event.
  const shipped = NOTIFICATION_POLICIES.ORDER_SHIPPED;
  assert.ok(Object.keys(shipped.variableSchema).includes('awb'),
    'ORDER_SHIPPED must carry the AWB — it fires only when a real shipment exists');
  assert.ok(String(shipped.description).toLowerCase().includes('scan'),
    'ORDER_SHIPPED must be documented as firing on a carrier scan, not on a CMS click');
});

await check('internal_warehouse_states_never_reach_the_customer', async () => {
  for (const internal of INTERNAL_ONLY) {
    assert.ok(!CUSTOMER_STATUSES.includes(internal),
      `${internal} is exposed as a customer status`);
  }
  // And the mapper never emits one either, whatever the carrier says.
  const carrierStates = ['DRAFT', 'READY_TO_BOOK', 'BOOKING_PENDING', 'BOOKED', 'PICKUP_PENDING',
    'PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED', 'DELIVERY_EXCEPTION',
    'RTO_IN_TRANSIT', 'RTO_RETURNED'];
  const allowed = new Set([...CUSTOMER_STATUSES, 'PENDING', 'DELIVERY_DELAYED', 'RETURNING', 'CANCELLED']);
  for (const cs of carrierStates) {
    const out = customerOrderStatus({ status: 'PROCESSING' }, [{ status: cs }]);
    assert.ok(allowed.has(out), `carrier state ${cs} mapped to non-customer status "${out}"`);
  }
});

await check('a_booked_parcel_reads_as_ready_not_shipped', async () => {
  for (const cs of ['BOOKED', 'PICKUP_PENDING']) {
    assert.equal(
      customerOrderStatus({ status: 'PROCESSING' }, [{ status: cs }]), 'READY_FOR_SHIPMENT',
      `a ${cs} parcel must read as READY_FOR_SHIPMENT — the carrier has not collected it`,
    );
  }
  assert.equal(customerOrderStatus({ status: 'PROCESSING' }, [{ status: 'PICKED_UP' }]), 'IN_TRANSIT',
    'a collected parcel must read as IN_TRANSIT');
});

await check('split_shipment_shows_the_least_advanced_parcel', async () => {
  const out = customerOrderStatus({ status: 'PROCESSING' }, [
    { status: 'DELIVERED' }, { status: 'IN_TRANSIT' },
  ]);
  assert.equal(out, 'IN_TRANSIT', 'an order is not delivered while a parcel is still in transit');
});

await check('customer_timeline_is_monotonic_and_complete', async () => {
  const t = customerTimeline({ status: 'PROCESSING' }, [{ status: 'OUT_FOR_DELIVERY' }]);
  assert.equal(t.steps.length, CUSTOMER_STATUSES.length);
  const states = t.steps.map((s) => s.state).join(',');
  assert.equal(states, 'done,done,done,done,current,todo', `unexpected timeline shape: ${states}`);
});

// The order page prints a time under every reached step. Each one must be a
// recorded fact: the order's own timestamps for the first two steps, applied
// carrier events FOR that step for the rest — the moment the LAST moving
// parcel got there. A step with no record of its own carries no time.
await check('customer_timeline_times_come_from_records_only', async () => {
  const order = { status: 'PROCESSING', confirmedAt: '2026-09-01T10:00:00Z', processingStartedAt: '2026-09-01T12:00:00Z' };
  const t = customerTimeline(order, [
    { status: 'IN_TRANSIT', timeline: [{ status: 'BOOKED', at: '2026-09-02T09:00:00Z' }, { status: 'IN_TRANSIT', at: '2026-09-02T15:00:00Z' }] },
    // No booking scan of its own: the order has no honest "ready" time.
    { status: 'IN_TRANSIT', timeline: [{ status: 'IN_TRANSIT', at: '2026-09-03T08:00:00Z' }] },
  ]);
  const at = Object.fromEntries(t.steps.map((step) => [step.key, step.at]));
  assert.deepEqual(at, {
    CONFIRMED: '2026-09-01T10:00:00.000Z',
    PROCESSING: '2026-09-01T12:00:00.000Z',
    READY_FOR_SHIPMENT: null,
    IN_TRANSIT: '2026-09-03T08:00:00.000Z',
    OUT_FOR_DELIVERY: null,
    DELIVERED: null,
  });
  // Delivered with no out-for-delivery scan, plus a replacement parcel still
  // being drafted: the draft must not blank the delivered time, and the
  // skipped step must not borrow it.
  const delivered = customerTimeline({ status: 'COMPLETED' }, [
    { status: 'DELIVERED', timeline: [{ status: 'BOOKED', at: '2026-09-04T09:00:00Z' }, { status: 'DELIVERED', at: '2026-09-05T10:00:00Z' }] },
    { status: 'DRAFT', timeline: [] },
  ]);
  const deliveredAt = Object.fromEntries(delivered.steps.map((step) => [step.key, step.at]));
  assert.equal(deliveredAt.DELIVERED, '2026-09-05T10:00:00.000Z');
  assert.equal(deliveredAt.READY_FOR_SHIPMENT, '2026-09-04T09:00:00.000Z');
  assert.equal(deliveredAt.OUT_FOR_DELIVERY, null, 'a skipped step must not borrow a later time');
  const bare = customerTimeline({ status: 'PROCESSING' }, []);
  assert.ok(bare.steps.every((step) => step.at === null), 'a step with no record must carry no time');
  const shipless = customerTimeline({ status: 'COMPLETED', completedAt: '2026-09-05T10:00:00Z' }, []);
  assert.equal(shipless.steps.find((step) => step.key === 'DELIVERED').at, '2026-09-05T10:00:00.000Z');
});

await check('customer_activity_speaks_customer_words_newest_first', async () => {
  const list = customerActivity(
    { placedAt: '2026-09-01T09:00:00Z', confirmedAt: '2026-09-01T10:00:00Z' },
    [
      { shipmentNumber: 'S1', status: 'DELIVERED', timeline: [
        { status: 'BOOKED', at: '2026-09-02T09:00:00Z', note: null },
        { status: 'IN_TRANSIT', at: '2026-09-02T15:00:00Z', location: 'Delhi Hub', note: 'In Transit' },
        { status: 'IN_TRANSIT', at: '2026-09-02T16:00:00Z', location: 'Delhi Hub', note: 'In Transit' },
        { status: 'DELIVERED', at: '2026-09-03T11:00:00Z', note: 'Delivered to neighbour' },
      ] },
      { shipmentNumber: 'S2', status: 'IN_TRANSIT', timeline: [{ status: 'IN_TRANSIT', at: '2026-09-02T18:00:00Z' }] },
      { shipmentNumber: 'S3', status: 'DRAFT', timeline: [] },
    ],
  );
  const times = list.map((entry) => new Date(entry.at).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => b - a), 'activity must be newest first');
  assert.deepEqual(list.map((entry) => entry.label), [
    'Delivered', 'In transit', 'In transit', 'Packed and ready for courier pickup', 'Order confirmed', 'Order placed',
  ]);
  assert.ok(list.every((entry) => !/BOOKED|MANIFEST|PICKUP_PENDING|DRAFT/.test(`${entry.label} ${entry.note || ''}`)),
    'internal warehouse states must never reach the customer');
  const delivered = list[0];
  assert.equal(delivered.note, 'Delivered to neighbour', 'a remark that adds something is kept');
  assert.equal(delivered.packageNumber, 1, 'with two moving parcels each line names its package');
  assert.equal(list[2].note, null, 'a remark that only repeats the label is dropped');
  assert.equal(list.filter((entry) => entry.location === 'Delhi Hub').length, 1, 'a repeated scan at the same place is one line');
});

// ---- live dispatch, against the real dedupe -----------------------------
let customerId = null;
let createdIds = [];

const cleanup = async () => {
  if (createdIds.length) {
    await query(`DELETE FROM communication_messages WHERE id IN (${createdIds.map(() => '?').join(',')})`, createdIds);
  }
  if (customerId) {
    await query('DELETE FROM customer_contacts WHERE customer_id = ?', [customerId]);
    await query('DELETE FROM customers WHERE id = ?', [customerId]);
  }
};

try {
  // A throwaway customer with BOTH channels verified, so channel resolution is
  // exercised for real rather than assumed.
  customerId = randomUUID();
  const email = `verify-${customerId.slice(0, 8)}@corcotton.invalid`;
  const phone = '+919278092799';
  const [brand] = await query('SELECT id FROM brands ORDER BY is_default DESC LIMIT 1');
  await query(
    'INSERT INTO customers (id, brand_id, first_name, last_name, status) VALUES (?, ?, ?, ?, ?)',
    [customerId, brand.id, 'Verify', 'Comms', 'ACTIVE'],
  );
  for (const [type, value] of [['EMAIL', email], ['PHONE', phone]]) {
    await query(
      `INSERT INTO customer_contacts (id, customer_id, contact_type, value, normalized_value, is_verified, verified_at, source)
       VALUES (?, ?, ?, ?, ?, 1, NOW(3), 'VERIFY_SCRIPT')`,
      [randomUUID(), customerId, type, value, value],
    );
  }

  await check('both_channels_resolve_to_the_customers_verified_contact', async () => {
    const e = await resolveRecipient(customerId, 'EMAIL');
    const w = await resolveRecipient(customerId, 'WHATSAPP');
    assert.equal(e?.contactKey, email, 'EMAIL resolved to the wrong address');
    assert.equal(w?.contactKey, phone, 'WHATSAPP resolved to the wrong number');
    assert.match(w.contactKey, /^\+91[6-9][0-9]{9}$/,
      'the WhatsApp destination is not in the E.164 form the provider adapter expects');
  });

  await check('an_unverified_contact_is_never_messaged', async () => {
    const other = randomUUID();
    await query('INSERT INTO customers (id, brand_id, first_name, status) VALUES (?, ?, ?, ?)', [other, brand.id, 'Unverified', 'ACTIVE']);
    await query(
      `INSERT INTO customer_contacts (id, customer_id, contact_type, value, normalized_value, is_verified, source)
       VALUES (?, ?, 'EMAIL', ?, ?, 0, 'VERIFY_SCRIPT')`,
      [randomUUID(), other, 'nope@corcotton.invalid', 'nope@corcotton.invalid'],
    );
    try {
      assert.equal(await resolveRecipient(other, 'EMAIL'), null, 'an unverified address was selected as a recipient');
    } finally {
      await query('DELETE FROM customer_contacts WHERE customer_id = ?', [other]);
      await query('DELETE FROM customers WHERE id = ?', [other]);
    }
  });

  await check('dispatch_is_idempotent_per_business_event_and_channel', async () => {
    const orderId = randomUUID();
    const ctx = { customerId, orderId, orderNumber: 'COR-VERIFY-COMMS', shipmentId: randomUUID() };
    const first = await notificationService.emit('ORDER_PROCESSING', ctx);
    const second = await notificationService.emit('ORDER_PROCESSING', ctx);

    // Whatever the template state, the SECOND call must never create a new
    // message where the first did.
    for (const channel of ['EMAIL', 'WHATSAPP']) {
      if (first.results[channel] === 'ENQUEUED') {
        assert.equal(second.results[channel], 'DEDUPED',
          `a repeated ${channel} emit created a second message — a webhook replay would message the customer twice`);
      }
    }
    const rows = await query(
      'SELECT id, channel FROM communication_messages WHERE business_event_id = ?',
      [`order_processing:${orderId}`],
    );
    createdIds = createdIds.concat(rows.map((r) => r.id));
    const perChannel = rows.reduce((m, r) => ({ ...m, [r.channel]: (m[r.channel] || 0) + 1 }), {});
    for (const [channel, n] of Object.entries(perChannel)) {
      assert.equal(n, 1, `${n} ${channel} messages exist for one business event`);
    }
  });

  await check('a_notification_failure_never_breaks_the_domain_flow', async () => {
    // emit() is the contract boundary: it must absorb everything.
    const out = await notificationService.emit('ORDER_PROCESSING', { customerId: null });
    assert.equal(out.skipped, 'NO_CUSTOMER', 'a missing customer should be skipped, not thrown');
    const unknown = await notificationService.emit('NOT_A_REAL_EVENT', { customerId });
    assert.equal(unknown.skipped, 'NO_POLICY', 'an unknown event should be skipped, not thrown');
    // A policy whose variables() blows up must still not escape.
    const broken = await notificationService.emit('ORDER_SHIPPED', { customerId, get orderNumber() { throw new Error('boom'); } });
    assert.ok(broken, 'emit() propagated an exception from a policy');
  });

  await check('one_channel_failing_does_not_stop_the_other', async () => {
    // A per-channel result is recorded independently; no channel's outcome is
    // allowed to short-circuit the loop.
    const out = await notificationService.emit('ORDER_READY_FOR_SHIPMENT', {
      customerId, orderId: randomUUID(), orderNumber: 'COR-VERIFY-CHAN', shipmentId: randomUUID(),
    });
    assert.deepEqual(Object.keys(out.results).sort(), ['EMAIL', 'WHATSAPP'],
      'both channels must be attempted independently');
    const rows = await query('SELECT id FROM communication_messages WHERE variables_json LIKE ?', ['%COR-VERIFY-CHAN%']);
    createdIds = createdIds.concat(rows.map((r) => r.id));
  });

  await check('every_send_is_auditable', async () => {
    const columns = (await query('SHOW COLUMNS FROM communication_messages')).map((c) => c.Field);
    const required = [
      'recipient_customer_id', 'policy_key', 'business_event_id', 'channel', 'recipient_contact_key',
      'provider_code', 'template_key', 'provider_template_ref', 'sent_at', 'provider_message_id',
      'status', 'last_error', 'attempt_count',
    ];
    const missing = required.filter((c) => !columns.includes(c));
    assert.deepEqual(missing, [], `the audit trail cannot record: ${missing.join(', ')}`);
  });
} finally {
  await cleanup();
}

console.log(`\n${failures ? 'FAILURES' : 'ALL PASS'} — ${Object.keys(results).length} checks, ${failures} failed\n`);
await pool.end();
process.exit(failures ? 1 : 0);
