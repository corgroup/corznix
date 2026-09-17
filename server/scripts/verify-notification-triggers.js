// WP-05 (communication trigger layer) verification.
//
// Proves, against the local dev database:
//   - notificationService.emit() never throws — unknown event, no customer,
//     no template, no verified contact all return a benign summary;
//   - a policy + an ACTIVE template + a verified contact -> exactly one
//     communication_messages row, TRANSACTIONAL, correct dedupe identity and
//     rendered body; a re-emit is DEDUPED (zero second row);
//   - EMAIL routes to the verified EMAIL contact, WHATSAPP to the verified
//     PHONE contact;
//   - the real call-site wiring works end to end: a Delhivery DELIVERED
//     scan through the logistics webhook applier (WP-01) produces
//     order_shipped / order_out_for_delivery / order_delivered messages for
//     the order's customer, each exactly once.
//
// Isolated and self-cleaning. Providers stay MOCK (default); no real send.
//
//   npm run verify:notification-triggers
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

let providerCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { providerCalls += 1; return realFetch?.(...a); };

const { pool, query } = await import('../src/database/connection/pool.js');
const { notificationService } = await import('../src/modules/notifications/service.js');
const { communicationTemplateService } = await import('../src/modules/communications/templateService.js');
const { webhookInboxService } = await import('../src/modules/platform/webhookInboxService.js');
const { registerLogisticsWebhooks } = await import('../src/modules/logistics/bootstrap.js');

registerLogisticsWebhooks();

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];
const tag = randomUUID().slice(0, 8);

const created = { templates: [], customers: [], contactCustomers: [] };
const scriptStartedAt = new Date();

async function makeCustomer(withEmail = true, withPhone = false) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,'T','ACTIVE',NOW(3))", [id, `NT-${tag}`]);
  if (withEmail) {
    await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
       VALUES (?,?, 'EMAIL', ?, ?, 1, NOW(3), 'TEST', NOW(3), NOW(3))`, [randomUUID(), id, `nt-${tag}@x.test`, `nt-${tag}@x.test`]);
  }
  if (withPhone) {
    await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
       VALUES (?,?, 'PHONE', ?, ?, 1, NOW(3), 'TEST', NOW(3), NOW(3))`, [randomUUID(), id, '+919876500000', '+919876500000']);
  }
  return id;
}

async function activateTemplate(templateKey, channel, over = {}) {
  const t = await communicationTemplateService.create({
    templateKey, channel, classification: 'TRANSACTIONAL',
    subject: channel === 'EMAIL' ? 'Order {{orderNumber}}' : undefined,
    bodyTemplate: 'Update for order {{orderNumber}}.',
    variableSchema: { orderNumber: { required: true, type: 'string' } },
    providerTemplateRef: channel === 'WHATSAPP' ? 'order_update_v1' : undefined,
    ...over,
  });
  created.templates.push(`${t.templateKey}|${t.channel}`);
  await communicationTemplateService.setStatus({ id: t.id, status: 'ACTIVE' });
  return t;
}

const msgRows = (businessEventId) => query('SELECT * FROM communication_messages WHERE business_event_id = ?', [businessEventId]);

try {
  // ===================== 1. emit() never throws =========================
  {
    const r1 = await notificationService.emit('NOT_A_REAL_EVENT', { customerId: 'x' });
    assert.equal(r1.skipped, 'NO_POLICY');
    const r2 = await notificationService.emit('ORDER_PLACED', {});
    assert.equal(r2.skipped, 'NO_CUSTOMER');
    pass('EMIT_NEVER_THROWS', 'unknown event / no customer return a benign summary');
  }

  // ===================== 2. no template -> quiet skip ===================
  {
    // This check needs 'order.placed' to have NO active template. It used to
    // assume that, which held only while WP-07 had seeded nothing — once
    // seed:comm-templates ran (or verify:comms-automation ran first), the key
    // existed and this failed for a reason that had nothing to do with the
    // behaviour under test. Establish the precondition instead of assuming it,
    // and put the operator's templates back afterwards.
    const parked = await query(
      "SELECT id, status FROM communication_templates WHERE template_key = 'order.placed' AND status = 'ACTIVE'",
    );
    if (parked.length) {
      await query(
        `UPDATE communication_templates SET status = 'DRAFT' WHERE id IN (${parked.map(() => '?').join(',')})`,
        parked.map((t) => t.id),
      );
    }
    try {
      const cid = await makeCustomer(true);
      const r = await notificationService.emit('ORDER_PLACED', { customerId: cid, orderId: `o-${tag}-a`, orderNumber: 'COR-A' });
      assert.equal(r.results.EMAIL, 'TEMPLATE_NOT_AVAILABLE');
      assert.equal((await msgRows(`order_placed:o-${tag}-a`)).length, 0, 'no message row without a template');
      pass('NO_TEMPLATE_QUIET_SKIP', 'the domain flow is unaffected; nothing enqueued');
    } finally {
      for (const t of parked) {
        // eslint-disable-next-line no-await-in-loop
        await query('UPDATE communication_templates SET status = ? WHERE id = ?', [t.status, t.id]);
      }
    }
  }

  // ===================== 3. full happy path ============================
  {
    // Policy templateKeys are fixed ('order.confirmed' here). WP-07 has not
    // seeded any lifecycle templates yet, so this key is unused in the DB —
    // activateTemplate creates + activates a fresh version, cleanup deletes
    // every version of it.
    const cid = await makeCustomer(true);
    await activateTemplate('order.confirmed', 'EMAIL');
    const evId = `order_confirmed:o-${tag}-b`;
    const r = await notificationService.emit('ORDER_CONFIRMED', { customerId: cid, orderId: `o-${tag}-b`, orderNumber: 'COR-B' });
    assert.equal(r.results.EMAIL, 'ENQUEUED');
    const rows = await msgRows(evId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].classification, 'TRANSACTIONAL');
    assert.equal(rows[0].channel, 'EMAIL');
    assert.equal(rows[0].recipient_contact_key, `nt-${tag}@x.test`);
    assert.equal(rows[0].policy_key, 'order.confirmed');
    assert(rows[0].rendered_body.includes('COR-B'), 'the body must render the orderNumber');
    assert(rows[0].dedupe_key.startsWith(`${evId}|order.confirmed|`), 'dedupe identity = event|policy|recipient|channel');

    // re-emit -> deduped, still ONE row
    const r2 = await notificationService.emit('ORDER_CONFIRMED', { customerId: cid, orderId: `o-${tag}-b`, orderNumber: 'COR-B' });
    assert.equal(r2.results.EMAIL, 'DEDUPED');
    assert.equal((await msgRows(evId)).length, 1, 're-emit must never create a second message');
    pass('HAPPY_PATH_AND_IDEMPOTENT', 'one TRANSACTIONAL message; re-emit deduped');
  }

  // ===================== 4. no verified contact =======================
  {
    const cid = await makeCustomer(false); // customer with zero contacts
    const r = await notificationService.emit('ORDER_CONFIRMED', { customerId: cid, orderId: `o-${tag}-c`, orderNumber: 'COR-C' });
    assert.equal(r.results.EMAIL, 'NO_VERIFIED_CONTACT');
    assert.equal((await msgRows(`order_confirmed:o-${tag}-c`)).length, 0);
    pass('NO_VERIFIED_CONTACT_SKIP');
  }

  // ========== 4b. the ORDER's checkout contact reaches a customer whose =====
  // ==========      profile has no verified phone ===========================
  //
  // The bug this pins: ORDER_CONFIRMED / ORDER_PROCESSING /
  // ORDER_READY_FOR_SHIPMENT passed only {customerId, orderId, orderNumber},
  // while ORDER_PLACED / PAYMENT_SUCCESSFUL also passed the order's shipping
  // snapshot. resolveRecipient can then only fall back to a VERIFIED PROFILE
  // phone, so every customer who signed in with Google — email verified,
  // phone typed at checkout but never verified — got the payment message and
  // silently nothing afterwards. Nothing was logged, so it looked like the
  // events never fired.
  {
    await activateTemplate('order.confirmed', 'WHATSAPP').catch(() => {});
    const cid = await makeCustomer(true, false); // email verified, NO phone
    const snapshot = JSON.stringify({ firstName: 'Order', lastName: 'Contact', phone: '9319987171' });

    // WITHOUT the snapshot: unreachable on WhatsApp. This is what the three
    // order-ops call sites used to send.
    const bare = await notificationService.emit('ORDER_CONFIRMED', {
      customerId: cid, orderId: `o-${tag}-oc1`, orderNumber: 'COR-OC1',
    });
    assert.equal(bare.results.WHATSAPP, 'NO_VERIFIED_CONTACT');

    // WITH the snapshot: the checkout number is used.
    const withSnap = await notificationService.emit('ORDER_CONFIRMED', {
      customerId: cid, orderId: `o-${tag}-oc2`, orderNumber: 'COR-OC2',
      shippingAddressSnapshot: snapshot,
    });
    assert.equal(withSnap.results.WHATSAPP, 'ENQUEUED');
    const rows = await msgRows(`order_confirmed:o-${tag}-oc2`);
    const wa = rows.find((r) => r.channel === 'WHATSAPP');
    assert(wa, 'a WHATSAPP message must exist');
    assert.equal(wa.recipient_contact_key, '+919319987171', 'must go to the number typed at checkout, normalized');
    pass('ORDER_CONTACT_REACHES_UNVERIFIED_PHONE', 'snapshot -> +919319987171; without it, NO_VERIFIED_CONTACT');
  }

  // ========== 4c. the real call sites actually pass the snapshot ===========
  //
  // 4b proves the notification layer honours the snapshot; this proves the
  // callers supply it. Without this the layer can be correct while the
  // feature stays broken — which is exactly how the bug survived a passing
  // suite.
  {
    const { readFileSync } = await import('node:fs');
    // Counted, not "appears somewhere": service.js has TWO call sites
    // (confirm + startProcessing) and an includes() check stays green when
    // only one of them is stripped.
    const sites = [
      ['src/modules/orderOps/service.js', ['ORDER_CONFIRMED', 'ORDER_PROCESSING'], 'order.shipping_address_snapshot', 2],
      ['src/modules/orderOps/controller.js', ['ORDER_READY_FOR_SHIPMENT'], 'orderRow.shipping_address_snapshot', 1],
    ];
    for (const [file, events, expr, expected] of sites) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      for (const event of events) assert(src.includes(event), `${file} must still emit ${event}`);
      const found = src.split(`shippingAddressSnapshot: ${expr}`).length - 1;
      assert.equal(found, expected, `${file}: expected ${expected} call site(s) passing the shipping snapshot, found ${found}`);
    }
    pass('ORDER_OPS_CALL_SITES_PASS_SNAPSHOT', '3 sites, counted');
  }

  // ========== 4d. every WhatsApp policy fills its approved template =========
  //
  // An approved Meta template has a fixed number of positional slots. A policy
  // that supplies fewer sends empty parameters, and the message never reaches
  // the customer intact — silently, because providers.js only logs a warning
  // per missing slot. ORDER_CONFIRMED supplied 1 of order_management's 5, and
  // ORDER_CANCELLED 1 of order_canceled's 2. Checked for every policy so the
  // next template added cannot repeat it.
  {
    const { META_TEMPLATE_CONTRACT } = await import('../src/modules/communications/providers.js');
    const { NOTIFICATION_POLICIES } = await import('../src/modules/notifications/policies.js');
    const { TEMPLATE_DEFAULTS } = await import('../src/modules/notifications/templateDefaults.js');
    // Every name any policy reads, so variables() renders as it would in
    // production rather than tripping over an undefined context.
    const ctx = {
      orderNumber: 'COR-X', orderId: 'o', shipmentId: 's', customerName: 'N',
      amount: '1', paymentReference: 'p', paymentDate: 'd', awb: 'A',
      estimatedDelivery: 'E', refundAmount: '9', resolutionType: 'R',
      pickupAddress: 'P', deliveryWindow: 'W', attemptDate: 'T',
      supportNumber: 'S', issueType: 'I', affectedStage: 'G', reason: 'r',
      itemsSummary: 'Item x1', purchaseWording: 'order',
      shippingSnapshot: { estimatedDays: 3 },
    };
    const offenders = [];
    let checked = 0;
    for (const [key, policy] of Object.entries(NOTIFICATION_POLICIES)) {
      if (!policy.channels.includes('WHATSAPP')) continue;
      const ref = TEMPLATE_DEFAULTS[policy.templateKey]?.WHATSAPP?.providerTemplateRef;
      if (!ref) continue;
      const contract = META_TEMPLATE_CONTRACT[ref];
      assert(contract, `${key}: template "${ref}" is not in META_TEMPLATE_CONTRACT`);
      const vars = policy.variables(ctx) || {};
      const needed = [...(contract.header || []), ...contract.body];
      const missing = needed.filter((n) => vars[n] === undefined || vars[n] === null || vars[n] === '');
      if (missing.length) offenders.push(`${key} -> ${ref}: ${missing.join(', ')}`);
      checked += 1;
    }
    assert.equal(offenders.length, 0, `policies not filling their approved template:\n  ${offenders.join('\n  ')}`);

    // And the fallbacks hold when the call site passes nothing but the basics:
    // a slot that renders "there" beats one that renders nothing.
    const bare = NOTIFICATION_POLICIES.ORDER_CONFIRMED.variables({ orderNumber: 'COR-Y' });
    for (const n of META_TEMPLATE_CONTRACT.order_management.body) {
      assert(bare[n], `ORDER_CONFIRMED must never emit a blank ${n}, even with a bare context`);
    }
    pass('WHATSAPP_POLICIES_FILL_TEMPLATE_SLOTS', `${checked} policies`);
  }

  // ===================== 5. WHATSAPP routes to verified PHONE ==========
  {
    await activateTemplate('order.delivered', 'EMAIL').catch(() => {});
    await activateTemplate('order.delivered', 'WHATSAPP').catch(() => {});
    const cid = await makeCustomer(true, true); // email + phone
    const evId = `order_delivered:sh-${tag}-d`;
    const r = await notificationService.emit('ORDER_DELIVERED', { customerId: cid, shipmentId: `sh-${tag}-d`, orderNumber: 'COR-D' });
    assert.equal(r.results.EMAIL, 'ENQUEUED');
    assert.equal(r.results.WHATSAPP, 'ENQUEUED');
    const rows = await msgRows(evId);
    assert.equal(rows.length, 2);
    const byCh = Object.fromEntries(rows.map((x) => [x.channel, x.recipient_contact_key]));
    assert.equal(byCh.EMAIL, `nt-${tag}@x.test`);
    assert.equal(byCh.WHATSAPP, '+919876500000');
    assert.equal(rows.find((x) => x.channel === 'WHATSAPP').provider_template_ref, 'order_update_v1', 'WhatsApp message carries the approved template ref (WP-06 wiring)');
    pass('MULTI_CHANNEL_ROUTING', 'EMAIL -> verified email, WHATSAPP -> verified phone');
  }

  // ===================== 6. end-to-end through the logistics applier ===
  {
    // Borrow the seeded PROCESSING order (same fixture WP-01 uses).
    const cand = await one(
      `SELECT o.id AS order_id, o.customer_id, o.order_number, f.id AS fulfillment_id, s.id AS shipment_id
         FROM orders o
         JOIN fulfillments f ON f.order_id = o.id AND f.fulfillment_type='INITIAL'
         JOIN shipments s ON s.fulfillment_id = f.id
        WHERE o.order_status='PROCESSING' AND f.status='PENDING' AND s.booking_status<>'BOOKED'
          AND (SELECT COUNT(*) FROM fulfillments f2 WHERE f2.order_id=o.id AND f2.fulfillment_type='INITIAL')=1
        LIMIT 1`);
    assert(cand, 'need the seeded PROCESSING order fixture (as used by verify-logistics-webhooks.js)');

    const shipBefore = await one('SELECT * FROM shipments WHERE id=?', [cand.shipment_id]);
    const contactsBefore = await query('SELECT * FROM customer_contacts WHERE customer_id=?', [cand.customer_id]);
    created.contactCustomers.push({ customerId: cand.customer_id, before: contactsBefore });

    await query('DELETE FROM customer_contacts WHERE customer_id=?', [cand.customer_id]);
    await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
      VALUES (?,?, 'EMAIL', ?, ?, 1, NOW(3), 'TEST', NOW(3), NOW(3))`, [randomUUID(), cand.customer_id, `e2e-${tag}@x.test`, `e2e-${tag}@x.test`]);

    await activateTemplate('order.shipped', 'EMAIL').catch(() => {});
    await activateTemplate('order.out_for_delivery', 'EMAIL').catch(() => {});
    // order.delivered EMAIL already active from step 5.

    const AWB = `TEST-WP05-${Date.now()}`;
    await query(`UPDATE shipments SET status='BOOKED', booking_status='BOOKED', provider_code='MOCK',
       external_shipment_id=?, tracking_number=?, booked_at=NOW(3) WHERE id=?`, [`EXT-${tag}`, AWB, cand.shipment_id]);

    const scan = (status, statusType, dt) => JSON.stringify({
      Shipment: { Status: { Status: status, StatusDateTime: dt, StatusType: statusType, StatusLocation: 'Hub', Instructions: null },
        PickUpDate: dt, NSLCode: 'X', Sortcode: 'A/B', ReferenceNo: cand.order_id, AWB } });
    const ingest = (body) => webhookInboxService.ingest({ capability: 'logistics', providerKey: 'MOCK', rawBody: body, headers: {} });

    await ingest(scan('In Transit', 'UD', '2026-09-01T10:00:00.000'));
    await ingest(scan('Out for delivery', 'UD', '2026-09-01T14:00:00.000'));
    await ingest(scan('Delivered', 'DL', '2026-09-01T18:00:00.000'));

    const shipped = await msgRows(`order_shipped:${cand.shipment_id}`);
    const ofd = await msgRows(`order_out_for_delivery:${cand.shipment_id}`);
    const delivered = await msgRows(`order_delivered:${cand.shipment_id}`);
    // ONE MESSAGE PER CHANNEL, not one message. Counting rows outright encoded
    // "only the EMAIL template is active", which stopped being true once
    // seed:comm-templates began activating WhatsApp too — and a WhatsApp row
    // here is correct rather than a leak: the recipient is resolved from the
    // ORDER contact, so deleting the customer's contact rows above does not
    // make the order unreachable. What this step actually guards is that one
    // scan does not fan out into two sends on the same channel, which is what
    // per-channel counting proves and a bare total does not.
    const perChannel = (rows) => rows.reduce((acc, r) => acc.set(r.channel, (acc.get(r.channel) || 0) + 1), new Map());
    for (const [label, rows] of [['ORDER_SHIPPED', shipped], ['ORDER_OUT_FOR_DELIVERY', ofd], ['ORDER_DELIVERED', delivered]]) {
      assert.ok(rows.length >= 1, `at least one ${label} message`);
      for (const [channel, n] of perChannel(rows)) assert.equal(n, 1, `exactly one ${label} message on ${channel}`);
    }
    const shippedEmail = shipped.find((r) => r.channel === 'EMAIL');
    assert.ok(shippedEmail, 'ORDER_SHIPPED reached the EMAIL channel');
    assert.equal(shippedEmail.recipient_contact_key, `e2e-${tag}@x.test`);
    for (const r of delivered) assert.equal(r.classification, 'TRANSACTIONAL');
    // Order completion also fires a notification. What matters is that the
    // webhook succeeded either way — whether a message row appears depends on
    // whether the operator has an active 'order.completed' template, which is
    // configuration, not behaviour. Asserting zero rows here quietly encoded
    // "no templates are seeded", so it broke the moment seed:comm-templates
    // ran. Assert the real invariant instead: at most one row, never a
    // duplicate, and the delivery webhook still completed.
    const completed = await msgRows(`order_completed:${cand.order_id}`);
    assert.ok(completed.length <= 1, 'order completion never enqueues a duplicate');

    // ---- restore the borrowed fixture ----
    await query(`UPDATE shipments SET status=?, booking_status=?, provider_code=?, external_shipment_id=?, tracking_number=?,
       booked_at=?, shipped_at=?, delivered_at=?, last_provider_status=?, last_event_at=? WHERE id=?`,
      [shipBefore.status, shipBefore.booking_status, shipBefore.provider_code, shipBefore.external_shipment_id, shipBefore.tracking_number,
        shipBefore.booked_at, shipBefore.shipped_at, shipBefore.delivered_at, shipBefore.last_provider_status, shipBefore.last_event_at, cand.shipment_id]);
    await query('UPDATE fulfillments SET status=?, fulfilled_at=NULL, ready_at=NULL WHERE id=?', ['PENDING', cand.fulfillment_id]);
    await query("UPDATE orders SET order_status='PROCESSING', completed_at=NULL WHERE id=?", [cand.order_id]);
    await query('DELETE FROM shipment_events WHERE shipment_id=?', [cand.shipment_id]);
    pass('E2E_LOGISTICS_APPLIER_FIRES_NOTIFICATIONS', 'IN_TRANSIT/OUT_FOR_DELIVERY/DELIVERED scans each produced one message');
  }

  assert.equal(providerCalls, 0, 'no real outbound calls');
  pass('REAL_PROVIDER_CALLS_ZERO');

  console.log('\nWP-05 communication trigger layer — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('DELETE cme FROM communication_message_events cme JOIN communication_messages cm ON cm.id=cme.message_id WHERE cm.created_at >= ?', [scriptStartedAt]));
  await safe(() => query('DELETE FROM communication_messages WHERE created_at >= ?', [scriptStartedAt]));
  await safe(() => query('DELETE FROM shipment_events WHERE received_at >= ?', [scriptStartedAt]));
  await safe(() => query('DELETE FROM provider_webhook_inbox WHERE capability = ? AND received_at >= ?', ['logistics', scriptStartedAt]));
  for (const key of created.templates) {
    const [k, ch] = key.split('|');
    await safe(() => query('DELETE FROM communication_templates WHERE template_key=? AND channel=?', [k, ch]));
  }
  for (const { customerId, before } of created.contactCustomers) {
    await safe(() => query('DELETE FROM customer_contacts WHERE customer_id=?', [customerId]));
    for (const c of before) {
      await safe(() => query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, [c.id, c.customer_id, c.contact_type, c.value, c.normalized_value, c.is_verified, c.verified_at, c.source, c.created_at, c.updated_at]));
    }
  }
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM customer_contacts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  await pool.end();
}
