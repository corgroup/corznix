// WP-01 (logistics webhook ingest spine) verification.
//
// Proves, against the local dev database, the chain that did not exist
// before this WP: a Delhivery-shaped Scan Push -> the unified webhook
// inbox -> ShipmentEventService.ingest -> shipments.delivered_at written ->
// the fulfilment -> order completion bridge -> orders.order_status =
// 'COMPLETED'. Also proves the pipeline's safety properties: idempotency
// (an identical replay is a DUPLICATE, not a second business effect), an
// out-of-order/invalid scan is IGNORED (not a thrown error), an unmapped
// status is IGNORED (never guessed), and the DELHIVERY-key webhook is
// signature-verified fail-closed while MOCK stays open for this kind of
// replay test.
//
// Isolated and self-cleaning: it borrows ONE already-seeded local order
// (must be order_status=PROCESSING with an INITIAL fulfilment still PENDING
// and a DRAFT/un-booked shipment — i.e. untouched by any other verify
// script), synthesizes a BOOKED state for its shipment exactly the way
// ShipmentBookingService's Phase-3 commit would, runs the scenario, then
// restores every row it touched and deletes only the shipment_events /
// provider_webhook_inbox rows it created. No real Delhivery call is made or
// possible: the AWB is an obvious TEST- string and providerKey MOCK/
// DELHIVERY never leaves this process.
//
//   npm run verify:logistics-webhooks
import assert from 'node:assert/strict';

process.env.DELHIVERY_WEBHOOK_TOKEN = 'wp01-verify-secret';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';

// Prove REAL_PROVIDER_CALLS = 0 — nothing in this pipeline may reach a network.
let providerCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { providerCalls += 1; return realFetch?.(...args); };

const { pool, query } = await import('../src/database/connection/pool.js');
const { webhookInboxService } = await import('../src/modules/platform/webhookInboxService.js');
const { registerLogisticsWebhooks } = await import('../src/modules/logistics/bootstrap.js');
const DOC_TOKEN_HEADER = { 'x-delhivery-webhook-token': 'wp01-verify-secret' };

const results = {};
const pass = (n, detail) => { results[n] = detail ? `PASS (${detail})` : 'PASS'; console.log(`  PASS  ${n}${detail ? ` — ${detail}` : ''}`); };
const one = async (sql, params) => (await query(sql, params))[0];

registerLogisticsWebhooks();

const AWB = `TEST-WP01-${Date.now()}`;
const EXT_ID = `TEST-EXT-${Date.now()}`;

// ---- find an untouched seeded order: PROCESSING, one PENDING INITIAL
//      fulfilment, its shipment still DRAFT/un-booked ------------------------
const candidate = await one(
  `SELECT o.id AS order_id, f.id AS fulfillment_id, s.id AS shipment_id
     FROM orders o
     JOIN fulfillments f ON f.order_id = o.id AND f.fulfillment_type = 'INITIAL'
     JOIN shipments s ON s.fulfillment_id = f.id
    WHERE o.order_status = 'PROCESSING' AND f.status = 'PENDING' AND s.booking_status <> 'BOOKED'
      AND (SELECT COUNT(*) FROM fulfillments f2 WHERE f2.order_id = o.id AND f2.fulfillment_type = 'INITIAL') = 1
    LIMIT 1`,
);
assert(candidate, 'need one local seeded order that is PROCESSING with a single PENDING INITIAL fulfilment and an un-booked shipment');
const { order_id: orderId, fulfillment_id: fulfillmentId, shipment_id: shipmentId } = candidate;

// Snapshot exactly what we are about to change, to restore it after.
const shipmentBefore = await one('SELECT * FROM shipments WHERE id=?', [shipmentId]);
const fulfillmentBefore = await one('SELECT * FROM fulfillments WHERE id=?', [fulfillmentId]);
const orderBefore = await one('SELECT * FROM orders WHERE id=?', [orderId]);

const scriptStartedAt = new Date();

async function restore() {
  // shipment_events for this shipment started at zero (confirmed before this
  // WP shipped, `shipment_events` was empty repo-wide) — every row for this
  // shipment id is one this run created.
  await query('DELETE FROM shipment_events WHERE shipment_id = ?', [shipmentId]);
  await query('DELETE FROM shipment_provider_documents WHERE shipment_id = ? OR awb = ?', [shipmentId, AWB]);
  // provider_webhook_inbox already has unrelated rows (payments testing) and
  // a REJECTED insert never returns its id — sweep by capability + time
  // window instead of tracking individual ids.
  await query("DELETE FROM provider_webhook_inbox WHERE capability LIKE 'logistics%' AND received_at >= ?", [scriptStartedAt]);
  await query(
    `UPDATE shipments SET status=?, booking_status=?, provider_code=?, external_shipment_id=?, tracking_number=?,
            tracking_url=?, booked_at=?, shipped_at=?, delivered_at=?, cancelled_at=?, last_provider_status=?, last_event_at=?
      WHERE id=?`,
    [shipmentBefore.status, shipmentBefore.booking_status, shipmentBefore.provider_code, shipmentBefore.external_shipment_id,
      shipmentBefore.tracking_number, shipmentBefore.tracking_url, shipmentBefore.booked_at, shipmentBefore.shipped_at,
      shipmentBefore.delivered_at, shipmentBefore.cancelled_at, shipmentBefore.last_provider_status, shipmentBefore.last_event_at,
      shipmentId],
  );
  await query('UPDATE fulfillments SET status=?, ready_at=?, fulfilled_at=?, cancelled_at=? WHERE id=?',
    [fulfillmentBefore.status, fulfillmentBefore.ready_at, fulfillmentBefore.fulfilled_at, fulfillmentBefore.cancelled_at, fulfillmentId]);
  await query('UPDATE orders SET order_status=?, completed_at=? WHERE id=?',
    [orderBefore.order_status, orderBefore.completed_at, orderId]);
}

async function inboxRow(id) { return one('SELECT * FROM provider_webhook_inbox WHERE id=?', [id]); }

const scan = ({ status, statusType, dt, location = 'Test Hub (Test City)', instructions = null, nsl = 'X-TEST' }) => JSON.stringify({
  Shipment: {
    Status: { Status: status, StatusDateTime: dt, StatusType: statusType, StatusLocation: location, Instructions: instructions },
    PickUpDate: dt, NSLCode: nsl, Sortcode: 'TST/TST', ReferenceNo: orderId, AWB: AWB,
  },
});

async function ingest(providerKey, body, headers = {}) {
  return webhookInboxService.ingest({ capability: 'logistics', providerKey, rawBody: body, headers });
}

try {
  // ---- synthesize the BOOKED state a MOCK-mode booking would leave (the
  //      current default SHIPPING_PROVIDER_MODE) --------------------------
  await query(
    `UPDATE shipments SET status='BOOKED', booking_status='BOOKED', provider_code='MOCK',
            external_shipment_id=?, tracking_number=?, booked_at=NOW(3) WHERE id=?`,
    [EXT_ID, AWB, shipmentId],
  );
  pass('SETUP_SHIPMENT_BOOKED', `awb=${AWB}`);

  // ---- 1. Manifested (UD) — confirms an already-known state; stored, not applied
  {
    const r = await ingest('MOCK', scan({ status: 'Manifested', statusType: 'UD', dt: '2026-09-01T09:00:00.000', instructions: 'Manifest uploaded' }));
    assert.equal(r.businessEffect, false, 'Manifested must not itself move the shipment (already BOOKED)');
    const row = await one('SELECT status FROM shipments WHERE id=?', [shipmentId]);
    assert.equal(row.status, 'BOOKED');
    pass('MANIFESTED_NO_OP', 'shipment stays BOOKED, event recorded');
  }

  // ---- 2. In Transit (UD) — BOOKED -> IN_TRANSIT, first forward motion ---
  {
    const r = await ingest('MOCK', scan({ status: 'In Transit', statusType: 'UD', dt: '2026-09-01T12:00:00.000' }));
    assert.equal(r.businessEffect, true);
    const row = await one('SELECT status FROM shipments WHERE id=?', [shipmentId]);
    assert.equal(row.status, 'IN_TRANSIT');
    const f = await one('SELECT status FROM fulfillments WHERE id=?', [fulfillmentId]);
    assert.equal(f.status, 'PROCESSING', 'first forward-motion scan must bump the fulfilment off PENDING');
    pass('IN_TRANSIT_APPLIED', 'shipment IN_TRANSIT, fulfilment PROCESSING');
  }

  // ---- 3. An invalid transition (CN while IN_TRANSIT) is IGNORED, not thrown
  {
    const r = await ingest('MOCK', scan({ status: 'Cancelled', statusType: 'CN', dt: '2026-09-01T12:05:00.000' }));
    assert.equal(r.status, 'IGNORED');
    const row = await one('SELECT status FROM shipments WHERE id=?', [shipmentId]);
    assert.equal(row.status, 'IN_TRANSIT', 'an invalid transition must not mutate the shipment');
    pass('INVALID_TRANSITION_IGNORED', 'CN while IN_TRANSIT recorded as IGNORED, no state change');
  }

  // ---- 4. An unmapped status (ambiguous UD text) is IGNORED, never guessed
  {
    const r = await ingest('MOCK', scan({ status: 'Undelivered - reason pending review', statusType: 'UD', dt: '2026-09-01T12:10:00.000' }));
    assert.equal(r.status, 'IGNORED');
    const row = await one('SELECT status FROM shipments WHERE id=?', [shipmentId]);
    assert.equal(row.status, 'IN_TRANSIT');
    pass('UNMAPPED_STATUS_IGNORED', 'ambiguous UD text not guessed at');
  }

  // ---- 5. Out for Delivery (UD) — IN_TRANSIT -> OUT_FOR_DELIVERY ----------
  {
    const r = await ingest('MOCK', scan({ status: 'Out for delivery', statusType: 'UD', dt: '2026-09-01T15:00:00.000' }));
    assert.equal(r.businessEffect, true);
    const row = await one('SELECT status FROM shipments WHERE id=?', [shipmentId]);
    assert.equal(row.status, 'OUT_FOR_DELIVERY');
    pass('OUT_FOR_DELIVERY_APPLIED');
  }

  // ---- 6. Delivered (DL) — the keystone assertion ------------------------
  const deliveredAt = '2026-09-01T18:30:00.000';
  {
    const r = await ingest('MOCK', scan({ status: 'Delivered', statusType: 'DL', dt: deliveredAt }));
    assert.equal(r.status, 'APPLIED');
    const shipmentRow = await one('SELECT status, delivered_at FROM shipments WHERE id=?', [shipmentId]);
    assert.equal(shipmentRow.status, 'DELIVERED');
    assert(shipmentRow.delivered_at, 'shipments.delivered_at must be written — GAP-DELIV-01');
    const fulfillmentRow = await one('SELECT status, fulfilled_at FROM fulfillments WHERE id=?', [fulfillmentId]);
    assert.equal(fulfillmentRow.status, 'FULFILLED', 'the fulfilment must advance to FULFILLED');
    assert(fulfillmentRow.fulfilled_at);
    const orderRow = await one('SELECT order_status, completed_at FROM orders WHERE id=?', [orderId]);
    assert.equal(orderRow.order_status, 'COMPLETED', 'the order must complete once every INITIAL fulfilment is FULFILLED');
    assert(orderRow.completed_at);
    pass('DELIVERED_COMPLETES_ORDER', 'shipment DELIVERED -> fulfilment FULFILLED -> order COMPLETED');
  }

  // ---- 7. RTO must never collapse into forward DELIVERED (regression guard,
  //         proven on the mapper directly since this shipment is now terminal)
  {
    const { mapDelhiveryStatus } = await import('../src/modules/logistics/statusMap.js');
    assert.equal(mapDelhiveryStatus({ statusType: 'DL', statusText: 'RTO Delivered to origin' }), 'RTO_RETURNED');
    assert.equal(mapDelhiveryStatus({ statusType: 'DL', statusText: 'Delivered' }), 'DELIVERED');
    assert.equal(mapDelhiveryStatus({ statusType: 'RT', statusText: 'RTO In Transit' }), 'RTO_IN_TRANSIT');
    pass('DL_RTO_NEVER_COLLAPSES', 'DL+RTO text != forward DELIVERED');
  }

  // ---- 7b. A missing intermediate scan must not strand a delivered parcel.
  //
  // Every ladder above walks IN_TRANSIT -> OUT_FOR_DELIVERY -> DELIVERED, which
  // is precisely why this went unnoticed: DELIVERED used to be reachable ONLY
  // from OUT_FOR_DELIVERY. Delhivery does not guarantee every stage is emitted
  // (Dev_API.docx "Package Lifecycle") and a Dispatched push can simply be
  // lost, and when that happened the DELIVERED scan was refused as an invalid
  // transition and dropped as IGNORED with no error code — the shipment sat at
  // IN_TRANSIT forever, the order never completed, no delivery notification
  // went out, COD was never reconciled and the return window never opened.
  // Asserted on the classifier directly: the shipment above is terminal.
  {
    const { classifyTransition } = await import('../src/modules/shipping/shipmentLifecycle.js');
    for (const from of ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERY_EXCEPTION']) {
      assert.equal(classifyTransition(from, 'DELIVERED'), 'apply',
        `a carrier DELIVERED scan must be honoured from ${from} — an unemitted or lost intermediate scan must never strand a delivered parcel`);
    }
    // But only where the parcel is demonstrably in the network. A shipment that
    // was never collected cannot have been delivered: that is not a missing
    // scan, it is what a recycled or mismatched AWB looks like, and honouring
    // it would complete an order that never shipped.
    assert.equal(classifyTransition('BOOKED', 'DELIVERED'), 'invalid');
    assert.equal(classifyTransition('PICKUP_PENDING', 'DELIVERED'), 'invalid');
    // A parcel coming back to us is not delivered to the customer.
    assert.equal(classifyTransition('RTO_IN_TRANSIT', 'DELIVERED'), 'invalid');
    // Terminal stays terminal. `stale` rather than `invalid` is deliberate: the
    // scan is still written to shipment_events with applied=false, so a late
    // DELIVERED against a cancelled parcel is visible without being obeyed.
    // What matters is only that it never applies.
    for (const terminal of ['DELIVERED', 'RTO_RETURNED', 'CANCELLED', 'FAILED', 'LOST']) {
      assert.notEqual(classifyTransition(terminal, 'DELIVERED'), 'apply',
        `a DELIVERED scan must not mutate a shipment already ${terminal}`);
    }
    pass('DELIVERED_SURVIVES_MISSING_SCANS', 'DELIVERED reachable from every forward state, never from RTO/terminal');
  }

  // ---- 8. Idempotency — an exact replay of the DELIVERED scan is a DUPLICATE
  {
    const r = await ingest('MOCK', scan({ status: 'Delivered', statusType: 'DL', dt: deliveredAt }));
    assert.equal(r.status, 'DUPLICATE');
    assert.equal(r.businessEffect, false);
    const rows = await query("SELECT COUNT(*) n FROM shipment_events WHERE shipment_id=? AND normalized_status='DELIVERED'", [shipmentId]);
    assert.equal(Number(rows[0].n), 1, 'a replay must never create a second DELIVERED event');
    pass('IDEMPOTENT_REPLAY', 'identical webhook redelivery = DUPLICATE, zero extra business effect');
  }

  // ---- 9. DELHIVERY providerKey — fail-closed without a valid token -------
  {
    const r = await ingest('DELHIVERY', scan({ status: 'In Transit', statusType: 'UD', dt: '2026-09-01T19:00:00.000' }), {});
    assert.equal(r.status, 'REJECTED');
    assert.equal(r.businessEffect, false);
    pass('DELHIVERY_WEBHOOK_REJECTED_NO_TOKEN', 'unsigned/unconfigured request rejected before any parsing');
  }
  {
    const r = await ingest('DELHIVERY', scan({ status: 'In Transit', statusType: 'UD', dt: '2026-09-01T19:00:00.000' }), { 'x-delhivery-webhook-token': 'wrong-token' });
    assert.equal(r.status, 'REJECTED');
    pass('DELHIVERY_WEBHOOK_REJECTED_WRONG_TOKEN');
  }
  {
    // Correct token: the signature check must accept it and proceed past
    // verification. This AWB was booked under providerCode MOCK in the setup
    // step above, so the DELHIVERY-keyed applier legitimately finds no
    // matching DELHIVERY shipment and IGNOREs — the point of this assertion
    // is `verification_status`, not the applier's downstream decision.
    const r = await ingest('DELHIVERY', scan({ status: 'Manifested', statusType: 'UD', dt: '2026-09-01T19:05:00.000' }), { 'x-delhivery-webhook-token': 'wp01-verify-secret' });
    assert.notEqual(r.status, 'REJECTED');
    const row = await inboxRow(r.id);
    assert.equal(row.verification_status, 'VERIFIED');
    pass('DELHIVERY_WEBHOOK_ACCEPTED_VALID_TOKEN');
  }

  // ---- 11. Document Push (Slice 17) — a separate endpoint, its own applier;
  //          a URL push links a shipment_provider_documents row by AWB --------
  {
    await query("UPDATE shipments SET provider_code='DELHIVERY' WHERE id=?", [shipmentId]); // this AWB, as Delhivery
    const orderNumber = (await one('SELECT order_number FROM orders WHERE id=?', [orderId])).order_number;
    const r = await webhookInboxService.ingest({
      capability: 'logistics-epod', providerKey: 'DELHIVERY',
      rawBody: JSON.stringify({ waybill: AWB, EPOD: 'https://cdn.delhivery.test/epod/sample.png', orderID: orderNumber }),
      headers: DOC_TOKEN_HEADER,
    });
    assert.equal(r.status, 'APPLIED', 'a new carrier document is a business effect');
    const doc = await one('SELECT * FROM shipment_provider_documents WHERE shipment_id=? AND doc_type=? LIMIT 1', [shipmentId, 'EPOD']);
    assert(doc, 'a shipment_provider_documents row must be created');
    assert.equal(doc.image_status, 'LINKED_URL');
    assert.equal(doc.image_url, 'https://cdn.delhivery.test/epod/sample.png');
    assert.equal(doc.link_status, 'LINKED');
    // idempotent: an identical re-push is one row
    const r2 = await webhookInboxService.ingest({
      capability: 'logistics-epod', providerKey: 'DELHIVERY',
      rawBody: JSON.stringify({ waybill: AWB, EPOD: 'https://cdn.delhivery.test/epod/sample.png', orderID: orderNumber }),
      headers: DOC_TOKEN_HEADER,
    });
    assert.equal(r2.status, 'DUPLICATE');
    const n = await query('SELECT COUNT(*) n FROM shipment_provider_documents WHERE shipment_id=? AND doc_type=?', [shipmentId, 'EPOD']);
    assert.equal(Number(n[0].n), 1, 'a re-push must not create a second document row');
    await query("UPDATE shipments SET provider_code='MOCK' WHERE id=?", [shipmentId]);
    pass('DOCUMENT_PUSH_LINKS_DOCUMENT', 'EPOD push -> shipment_provider_documents LINKED_URL, idempotent');
  }

  // ---- 10. No outbound network call anywhere in this pipeline -------------
  assert.equal(providerCalls, 0, 'REAL_PROVIDER_CALLS must be 0');
  results.realProviderCalls = 0;
  pass('REAL_PROVIDER_CALLS_ZERO');

  console.log('\nWP-01 logistics webhook ingest spine — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await restore();
  globalThis.fetch = realFetch;
  await pool.end();
}
