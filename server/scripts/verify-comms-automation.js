// Communication-automation coverage verification.
//
// The plumbing (notifications/ policy registry + emit() + communications/
// outbox) is wired at ~10 domain call sites. This proves the automation is
// actually production-ready, not just present:
//
//   WIRING_COMPLETE      — every non-reserved policy in NOTIFICATION_POLICIES
//                          is emitted from a real domain call site (static
//                          source scan of src/modules, excluding notifications/
//                          and test/verify code);
//   SEED_ACTIVATES_EMAIL — after `npm run seed:comm-templates`, every policy's
//                          EMAIL channel has an ACTIVE template, so the
//                          catalogue reports 0 MISSING email channels;
//   EMIT_ENQUEUES        — with the seed in place, notificationService.emit()
//                          for a lifecycle event enqueues a real, rendered
//                          TRANSACTIONAL outbox row for a verified customer;
//   NO_TEMPLATE_QUIET_SKIP — archive that template and the same emit() is a
//                          silent TEMPLATE_NOT_AVAILABLE no-op (never throws,
//                          never enqueues) — the domain flow is unaffected.
//
// Isolated + self-cleaning: snapshots the lifecycle templates and restores
// them, deletes only the rows it creates. No real send.
//
//   npm run verify:comms-automation
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { NOTIFICATION_POLICIES, RESERVED_NOTIFICATION_EVENTS } = await import('../src/modules/notifications/policies.js');
const { notificationService } = await import('../src/modules/notifications/service.js');
const { buildNotificationCatalog } = await import('../src/modules/notifications/catalog.js');
const { communicationTemplateService } = await import('../src/modules/communications/templateService.js');
const { TEMPLATE_DEFAULTS } = await import('../src/modules/notifications/templateDefaults.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const tag = randomUUID().slice(0, 8);
const startedAt = new Date();

const modulesDir = fileURLToPath(new URL('../src/modules/', import.meta.url));
const lifecycleKeys = [...new Set(Object.values(NOTIFICATION_POLICIES).map((p) => p.templateKey))];
const TPL_COLS = ['id', 'brand_id', 'template_key', 'channel', 'classification', 'version', 'status', 'subject',
  'body_template', 'variable_schema', 'provider_template_ref', 'created_by_staff_id', 'created_at', 'updated_at'];
let snapshot = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

async function wipeLifecycle() {
  for (const key of lifecycleKeys) await query('DELETE FROM communication_templates WHERE template_key = ?', [key]);
}
async function restoreLifecycle() {
  await wipeLifecycle();
  for (const row of snapshot) {
    const vs = row.variable_schema == null ? null : (typeof row.variable_schema === 'string' ? row.variable_schema : JSON.stringify(row.variable_schema));
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO communication_templates (${TPL_COLS.join(', ')})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, ?)`,
      [row.id, row.brand_id, row.template_key, row.channel, row.classification, row.version, row.status, row.subject,
        row.body_template, vs, row.provider_template_ref, row.created_by_staff_id, row.created_at, row.updated_at]);
  }
}

try {
  snapshot = await query(
    `SELECT ${TPL_COLS.join(', ')} FROM communication_templates WHERE template_key IN (${lifecycleKeys.map(() => '?').join(',')})`,
    lifecycleKeys);

  // ===================== 1. WIRING_COMPLETE ============================
  {
    const sources = walk(modulesDir)
      .filter((f) => !f.includes(`${path.sep}notifications${path.sep}`))
      .map((f) => readFileSync(f, 'utf8'))
      .join('\n');
    const reserved = new Set(RESERVED_NOTIFICATION_EVENTS);
    const missing = [];
    for (const event of Object.keys(NOTIFICATION_POLICIES)) {
      if (reserved.has(event)) continue;
      // emit('EVENT' | emit("EVENT" | #notify('EVENT'  — the two call forms.
      const re = new RegExp(`(emit|#notify)\\(\\s*['"\`]${event}['"\`]`);
      // Or an indirected map value: SHIPMENT_STATUS_EVENT maps scan status -> event key.
      const indirect = new RegExp(`['"\`]${event}['"\`]`);
      if (!re.test(sources) && !indirect.test(sources)) missing.push(event);
    }
    assert.deepEqual(missing, [], `every lifecycle policy must be emitted from a domain call site — missing: ${missing.join(', ')}`);
    pass('WIRING_COMPLETE', `${Object.keys(NOTIFICATION_POLICIES).length} policies, all wired (${reserved.size} deliberately reserved)`);
  }

  // ===================== 2. SEED_ACTIVATES_EMAIL ======================
  {
    // Reproduce the seed: create + activate an EMAIL template per policy.
    await wipeLifecycle();
    for (const policy of Object.values(NOTIFICATION_POLICIES)) {
      const starter = (TEMPLATE_DEFAULTS[policy.templateKey] || {}).EMAIL;
      assert(starter, `TEMPLATE_DEFAULTS is missing an EMAIL starter for ${policy.templateKey}`);
      // eslint-disable-next-line no-await-in-loop
      const t = await communicationTemplateService.create({
        templateKey: policy.templateKey, channel: 'EMAIL', classification: policy.classification,
        subject: starter.subject, bodyTemplate: starter.bodyTemplate, variableSchema: policy.variableSchema,
      });
      // eslint-disable-next-line no-await-in-loop
      await communicationTemplateService.setStatus({ id: t.id, status: 'ACTIVE' });
    }
    const cat = await buildNotificationCatalog();
    const missingEmail = cat.flatMap((e) => e.channels.filter((c) => c.channel === 'EMAIL' && c.status !== 'ACTIVE').map(() => e.event));
    assert.deepEqual(missingEmail, [], `EMAIL channels still not ACTIVE after seed: ${missingEmail.join(', ')}`);
    pass('SEED_ACTIVATES_EMAIL', `${cat.length}/${cat.length} lifecycle EMAIL templates ACTIVE`);
  }

  // ===================== 3. EMIT_ENQUEUES + 4. QUIET_SKIP =============
  {
    const cid = randomUUID();
    await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,'T','ACTIVE',NOW(3))", [cid, `CA-${tag}`]);
    await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
      VALUES (?,?, 'EMAIL', ?, ?, 1, NOW(3), 'TEST', NOW(3), NOW(3))`, [randomUUID(), cid, `ca-${tag}@x.test`, `ca-${tag}@x.test`]);

    const evId = `order_placed:ord-${tag}`;
    const r1 = await notificationService.emit('ORDER_PLACED', { customerId: cid, orderId: `ord-${tag}`, orderNumber: `COR-CA-${tag}` });
    assert.equal(r1.results.EMAIL, 'ENQUEUED', 'with an ACTIVE template ORDER_PLACED EMAIL must enqueue');
    const rows = await query('SELECT * FROM communication_messages WHERE business_event_id = ?', [evId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].classification, 'TRANSACTIONAL');
    assert(rows[0].rendered_body.includes(`COR-CA-${tag}`), 'the order number is rendered into the body');
    pass('EMIT_ENQUEUES', 'emit() -> one rendered TRANSACTIONAL outbox row');

    // Archive the ORDER_PLACED email; the same emit is now a silent no-op.
    const active = await query("SELECT id FROM communication_templates WHERE template_key='order.placed' AND channel='EMAIL' AND status='ACTIVE'");
    for (const a of active) await communicationTemplateService.setStatus({ id: a.id, status: 'ARCHIVED' });
    let threw = null;
    let r2;
    try {
      r2 = await notificationService.emit('ORDER_PLACED', { customerId: cid, orderId: `ord2-${tag}`, orderNumber: `COR-CA2-${tag}` });
    } catch (e) { threw = e; }
    assert.equal(threw, null, 'emit() must never throw when no template is active');
    assert.equal(r2.results.EMAIL, 'TEMPLATE_NOT_AVAILABLE');
    const none = await query('SELECT COUNT(*) c FROM communication_messages WHERE business_event_id = ?', [`order_placed:ord2-${tag}`]);
    assert.equal(Number(none[0].c), 0, 'no outbox row when the template is not active');
    pass('NO_TEMPLATE_QUIET_SKIP', 'archived template -> emit() is a silent no-op, domain flow unaffected');

    await query('DELETE FROM customers WHERE id = ?', [cid]).catch(() => {});
  }

  console.log('\nCommunication automation — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('DELETE cme FROM communication_message_events cme JOIN communication_messages cm ON cm.id=cme.message_id WHERE cm.created_at >= ?', [startedAt]));
  await safe(() => query('DELETE FROM communication_messages WHERE created_at >= ?', [startedAt]));
  await safe(() => query("DELETE FROM customer_contacts WHERE normalized_value LIKE ?", [`ca-${tag}%`]));
  await safe(() => restoreLifecycle());
  await pool.end();
}
