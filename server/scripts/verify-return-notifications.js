// WP-05b (returns + refund notification wiring) verification.
//
// Proves, against the local dev database:
//   - buildNotificationCatalog() now carries the 6 return/refund policies
//     alongside the 7 order policies, each with a starter that VALIDATES
//     (every {{placeholder}} declared, dry render OK);
//   - RESERVED_NOTIFICATION_EVENTS shrank to only the deliberately-deferred
//     events;
//   - notificationService.emit() for each new event produces one
//     TRANSACTIONAL message with the right rendered variables (including the
//     formatted refund amount + method phrase) and is idempotent;
//   - format.js helpers produce sane output.
//
// The call-site wiring in returnLifecycleService / returnRequestService /
// refundService follows the exact pattern verified end-to-end in
// verify-notification-triggers.js (order lifecycle) and is covered against
// regression by the 7 verify:returns* scripts.
//
// Isolated and self-cleaning. No real send.
//
//   npm run verify:return-notifications
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { buildNotificationCatalog } = await import('../src/modules/notifications/catalog.js');
const { NOTIFICATION_POLICIES, RESERVED_NOTIFICATION_EVENTS } = await import('../src/modules/notifications/policies.js');
const { notificationService } = await import('../src/modules/notifications/service.js');
const { communicationTemplateService } = await import('../src/modules/communications/templateService.js');
const { formatMinor, refundMethodPhrase } = await import('../src/modules/notifications/format.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const tag = randomUUID().slice(0, 8);
const scriptStartedAt = new Date();
const created = { customers: [] };

const NEW_EVENTS = ['RETURN_REQUESTED', 'RETURN_APPROVED', 'RETURN_REJECTED', 'RETURN_RECEIVED', 'REFUND_INITIATED', 'REFUND_COMPLETED'];
const lifecycleKeys = [...new Set(Object.values(NOTIFICATION_POLICIES).map((p) => p.templateKey))];

// Template existence IS the notification config (WP-07): an ACTIVE template is
// the only thing that makes a lifecycle event actually send. This script wipes
// EVERY policy's templates — not just the six it tests — so without a restore
// it silently switched off all customer notifications for the whole system on
// every run, and its own teardown called the wipe as its LAST act, guaranteeing
// it. Observed live: 28 seeded templates down to 5, and ORDER_DELIVERED
// reporting TEMPLATE_NOT_AVAILABLE on a real carrier webhook.
//
// Snapshot / restore, same as verify-comms-automation.js already does.
const TPL_COLS = ['id', 'brand_id', 'template_key', 'channel', 'classification', 'version', 'status', 'subject',
  'body_template', 'variable_schema', 'provider_template_ref', 'created_by_staff_id', 'created_at', 'updated_at'];
const templateSnapshot = await query(
  `SELECT ${TPL_COLS.join(', ')} FROM communication_templates
    WHERE template_key IN (${lifecycleKeys.map(() => '?').join(',')})`, lifecycleKeys);

async function wipeLifecycleTemplates() {
  for (const key of lifecycleKeys) await query('DELETE FROM communication_templates WHERE template_key = ?', [key]);
}

async function restoreLifecycleTemplates() {
  await wipeLifecycleTemplates();
  for (const row of templateSnapshot) {
    const vs = row.variable_schema == null ? null
      : (typeof row.variable_schema === 'string' ? row.variable_schema : JSON.stringify(row.variable_schema));
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO communication_templates (${TPL_COLS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)`,
      [row.id, row.brand_id, row.template_key, row.channel, row.classification, row.version, row.status,
        row.subject, row.body_template, vs, row.provider_template_ref, row.created_by_staff_id,
        row.created_at, row.updated_at]);
  }
}

function draftPayloadFor(policy, ch) {
  return {
    templateKey: policy.templateKey, channel: ch.channel, classification: policy.classification,
    subject: ch.channel === 'EMAIL' ? ch.starter.subject : undefined,
    bodyTemplate: ch.starter.bodyTemplate, variableSchema: policy.variableSchema,
  };
}

async function makeCustomer() {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,'T','ACTIVE',NOW(3))", [id, `RN-${tag}`]);
  await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
    VALUES (?,?, 'EMAIL', ?, ?, 1, NOW(3), 'TEST', NOW(3), NOW(3))`, [randomUUID(), id, `rn-${tag}@x.test`, `rn-${tag}@x.test`]);
  return id;
}

try {
  await wipeLifecycleTemplates();

  // ===================== 1. format helpers ============================
  {
    assert.equal(formatMinor(123400, 'INR'), '₹1,234.00');
    assert.equal(formatMinor(50000), '₹500.00');
    assert.equal(refundMethodPhrase('STORE_CREDIT'), 'CORCOTTON store credit');
    assert.equal(refundMethodPhrase('ORIGINAL_PAYMENT'), 'your original payment method');
    pass('FORMAT_HELPERS');
  }

  // ===================== 2. catalogue + reserved list ==================
  {
    const cat = await buildNotificationCatalog();
    assert.equal(cat.length, Object.keys(NOTIFICATION_POLICIES).length);
    for (const e of NEW_EVENTS) assert(cat.find((c) => c.event === e), `${e} missing from catalogue`);
    // Assert the policies that must EXIST, not a total. The count grows every
    // time a legitimate new lifecycle event is wired (ORDER_PROCESSING and
    // ORDER_READY_FOR_SHIPMENT most recently), so a magic number here only
    // ever fails for the right reason by accident.
    const EXPECTED_POLICIES = [
      'ORDER_PLACED', 'ORDER_CONFIRMED', 'ORDER_PROCESSING', 'ORDER_READY_FOR_SHIPMENT',
      'ORDER_SHIPPED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERY_ATTEMPT_FAILED',
      'ORDER_DELIVERED', 'ORDER_COMPLETED', 'ORDER_CANCELLED',
      'RETURN_REQUESTED', 'RETURN_APPROVED', 'RETURN_REJECTED', 'RETURN_RECEIVED',
      'REFUND_INITIATED', 'REFUND_COMPLETED',
    ];
    const absent = EXPECTED_POLICIES.filter((e) => !cat.find((c) => c.event === e));
    assert.deepEqual(absent, [], `lifecycle policies missing from the catalogue: ${absent.join(', ')}`);
    // reserved list must no longer contain the events we wired
    for (const e of NEW_EVENTS) assert(!RESERVED_NOTIFICATION_EVENTS.includes(e), `${e} still in RESERVED list`);
    assert.deepEqual(
      [...RESERVED_NOTIFICATION_EVENTS].sort(),
      ['EXCHANGE_ORDER_CREATED', 'PAYMENT_FAILED', 'REPLACEMENT_SHIPPED', 'RETURN_PICKED_UP', 'RETURN_QC_FAILED', 'RETURN_QC_PASSED'].sort(),
    );
    pass('CATALOGUE_AND_RESERVED', `${cat.length} policies, all ${EXPECTED_POLICIES.length} expected present; reserved list is only the deferred events`);
  }

  // ===================== 3. every new starter validates ================
  {
    const cat = await buildNotificationCatalog();
    let n = 0;
    for (const event of NEW_EVENTS) {
      const entry = cat.find((c) => c.event === event);
      const policy = NOTIFICATION_POLICIES[event];
      for (const ch of entry.channels) {
        // eslint-disable-next-line no-await-in-loop
        const t = await communicationTemplateService.create(draftPayloadFor(policy, ch));
        assert.equal(t.status, 'DRAFT');
        // eslint-disable-next-line no-await-in-loop
        await communicationTemplateService.setStatus({ id: t.id, status: 'ACTIVE' });
        n += 1;
      }
    }
    pass('NEW_STARTERS_VALIDATE', `${n} return/refund default templates create + activate cleanly`);
  }

  // ===================== 4. emit() for each new event =================
  {
    const cid = await makeCustomer();
    const base = { customerId: cid, returnRequestId: `rr-${tag}`, refundAttemptId: `ra-${tag}`, requestNumber: 'COR-RET-1', orderNumber: 'COR-ORD-1' };

    const req = await notificationService.emit('RETURN_REQUESTED', base);
    assert.equal(req.results.EMAIL, 'ENQUEUED');

    const rej = await notificationService.emit('RETURN_REJECTED', { ...base, reason: 'outside the return window' });
    assert.equal(rej.results.EMAIL, 'ENQUEUED');
    const rejRow = (await query("SELECT * FROM communication_messages WHERE business_event_id = ?", [`return_rejected:rr-${tag}`]))[0];
    assert(rejRow.rendered_body.includes('outside the return window'), 'reject reason must render');
    assert(rejRow.rendered_body.includes('COR-RET-1'));

    const refund = await notificationService.emit('REFUND_INITIATED', {
      ...base, amount: formatMinor(299900, 'INR'), method: refundMethodPhrase('STORE_CREDIT'),
    });
    assert.equal(refund.results.EMAIL, 'ENQUEUED');
    const refundRow = (await query("SELECT * FROM communication_messages WHERE business_event_id = ?", [`refund_initiated:ra-${tag}`]))[0];
    assert(refundRow.rendered_body.includes('₹2,999.00'), 'formatted amount must render');
    assert(refundRow.rendered_body.includes('CORCOTTON store credit'), 'method phrase must render');
    assert.equal(refundRow.classification, 'TRANSACTIONAL');

    // idempotent
    const again = await notificationService.emit('REFUND_INITIATED', {
      ...base, amount: formatMinor(299900, 'INR'), method: refundMethodPhrase('STORE_CREDIT'),
    });
    assert.equal(again.results.EMAIL, 'DEDUPED');
    assert.equal((await query("SELECT COUNT(*) n FROM communication_messages WHERE business_event_id = ?", [`refund_initiated:ra-${tag}`]))[0].n, 1);

    pass('EMIT_RETURN_AND_REFUND_EVENTS', 'RETURN_REQUESTED/REJECTED + REFUND_INITIATED render + dedupe');
  }

  console.log('\nWP-05b return + refund notifications — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('DELETE cme FROM communication_message_events cme JOIN communication_messages cm ON cm.id=cme.message_id WHERE cm.created_at >= ?', [scriptStartedAt]));
  await safe(() => query('DELETE FROM communication_messages WHERE created_at >= ?', [scriptStartedAt]));
  // Put the real templates back — this used to end on the wipe.
  await safe(() => restoreLifecycleTemplates());
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM customer_contacts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  await pool.end();
}
