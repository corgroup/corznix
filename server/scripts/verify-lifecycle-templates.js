// WP-07 (lifecycle template pack) verification.
//
// Proves, against the local dev database:
//   - buildNotificationCatalog() reports every order-lifecycle policy with
//     its templateKey, channels, canonical variableSchema and starter copy;
//   - EVERY starter template in templateDefaults.js is self-consistent —
//     it creates without a validation error (every {{placeholder}} is
//     declared, the dry render succeeds) — for every policy x channel;
//   - the catalogue status transitions MISSING -> DRAFT_ONLY -> ACTIVE as a
//     template is created then activated (the exact CMS "Create draft" then
//     "Activate" flow);
//   - the payoff: once order.delivered EMAIL is ACTIVE, notificationService.
//     emit('ORDER_DELIVERED', ...) actually enqueues a message instead of a
//     TEMPLATE_NOT_AVAILABLE no-op — WP-07 closes the loop opened by WP-05.
//
// Isolated and self-cleaning. No real send.
//
//   npm run verify:lifecycle-templates
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { buildNotificationCatalog } = await import('../src/modules/notifications/catalog.js');
const { NOTIFICATION_POLICIES } = await import('../src/modules/notifications/policies.js');
const { notificationService } = await import('../src/modules/notifications/service.js');
const { communicationTemplateService } = await import('../src/modules/communications/templateService.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const tag = randomUUID().slice(0, 8);
const scriptStartedAt = new Date();
const created = { customers: [] };

// Mirror the CMS "Create draft" button: policy.variableSchema + channel.starter
function draftPayloadFor(policy, ch) {
  return {
    templateKey: policy.templateKey,
    channel: ch.channel,
    classification: policy.classification,
    subject: ch.channel === 'EMAIL' ? ch.starter.subject : undefined,
    bodyTemplate: ch.starter.bodyTemplate,
    variableSchema: policy.variableSchema,
    providerTemplateRef: ch.channel === 'WHATSAPP' && ch.starter.providerTemplateRef ? ch.starter.providerTemplateRef : undefined,
  };
}

const lifecycleKeys = Object.values(NOTIFICATION_POLICIES).map((p) => p.templateKey);
const TPL_COLS = ['id', 'brand_id', 'template_key', 'channel', 'classification', 'version', 'status', 'subject',
  'body_template', 'variable_schema', 'provider_template_ref', 'created_by_staff_id', 'created_at', 'updated_at'];
let templateSnapshot = [];

async function wipeLifecycleTemplates() {
  for (const key of new Set(lifecycleKeys)) {
    await query('DELETE FROM communication_templates WHERE template_key = ?', [key]);
  }
}

// The seed (npm run seed:comm-templates) ships ACTIVE lifecycle templates on a
// real install. Snapshot them so this isolated test leaves the DB exactly as it
// found it instead of stripping production seed data.
async function snapshotLifecycleTemplates() {
  templateSnapshot = await query(
    `SELECT ${TPL_COLS.join(', ')} FROM communication_templates WHERE template_key IN (${new Set(lifecycleKeys).size ? [...new Set(lifecycleKeys)].map(() => '?').join(',') : 'NULL'})`,
    [...new Set(lifecycleKeys)]);
}

async function restoreLifecycleTemplates() {
  await wipeLifecycleTemplates();
  for (const row of templateSnapshot) {
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
  await snapshotLifecycleTemplates();
  await wipeLifecycleTemplates();

  // ===================== 1. catalogue shape ============================
  {
    const cat = await buildNotificationCatalog();
    assert.equal(cat.length, Object.keys(NOTIFICATION_POLICIES).length);
    for (const entry of cat) {
      assert(entry.event && entry.label && entry.description && entry.templateKey);
      assert.equal(entry.classification, 'TRANSACTIONAL');
      assert(entry.variableSchema && typeof entry.variableSchema === 'object');
      assert(Array.isArray(entry.channels) && entry.channels.length >= 1);
      for (const ch of entry.channels) {
        assert(['EMAIL', 'WHATSAPP'].includes(ch.channel));
        assert.equal(ch.status, 'MISSING', `${entry.templateKey}/${ch.channel} should start MISSING`);
        assert(ch.starter && ch.starter.bodyTemplate, `${entry.templateKey}/${ch.channel} must have starter copy`);
        if (ch.channel === 'EMAIL') assert(ch.starter.subject, 'EMAIL starter needs a subject');
      }
    }
    pass('CATALOGUE_SHAPE', `${cat.length} policies, all channels MISSING with starter copy`);
  }

  // ===================== 2. EVERY starter validates ====================
  {
    let count = 0;
    const cat = await buildNotificationCatalog();
    for (const entry of cat) {
      const policy = NOTIFICATION_POLICIES[entry.event];
      for (const ch of entry.channels) {
        // eslint-disable-next-line no-await-in-loop
        const t = await communicationTemplateService.create(draftPayloadFor(policy, ch));
        assert.equal(t.status, 'DRAFT');
        assert.equal(t.templateKey, policy.templateKey);
        count += 1;
      }
    }
    pass('ALL_STARTERS_VALIDATE', `${count} default templates created with no TEMPLATE_VARIABLE_INVALID`);
  }

  // ===================== 3. MISSING -> DRAFT_ONLY ======================
  {
    const cat = await buildNotificationCatalog();
    for (const entry of cat) {
      for (const ch of entry.channels) {
        assert.equal(ch.status, 'DRAFT_ONLY', `${entry.templateKey}/${ch.channel} should be DRAFT_ONLY after create`);
        assert.equal(ch.latestVersion, 1);
        assert.equal(ch.activeVersion, null);
      }
    }
    pass('STATUS_DRAFT_ONLY_AFTER_CREATE');
  }

  // ===================== 4. activate -> ACTIVE =========================
  {
    // Activate order.delivered EMAIL (the payoff channel).
    const all = await query("SELECT id FROM communication_templates WHERE template_key='order.delivered' AND channel='EMAIL' ORDER BY version DESC LIMIT 1");
    await communicationTemplateService.setStatus({ id: all[0].id, status: 'ACTIVE' });
    const cat = await buildNotificationCatalog();
    const delivered = cat.find((e) => e.templateKey === 'order.delivered');
    const emailCh = delivered.channels.find((c) => c.channel === 'EMAIL');
    assert.equal(emailCh.status, 'ACTIVE');
    assert.equal(emailCh.activeVersion, 1);
    pass('STATUS_ACTIVE_AFTER_ACTIVATE');
  }

  // ===================== 5. payoff — emit() now enqueues ===============
  {
    const cid = randomUUID();
    created.customers.push(cid);
    await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,'T','ACTIVE',NOW(3))", [cid, `LT-${tag}`]);
    await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
      VALUES (?,?, 'EMAIL', ?, ?, 1, NOW(3), 'TEST', NOW(3), NOW(3))`, [randomUUID(), cid, `lt-${tag}@x.test`, `lt-${tag}@x.test`]);
    await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
      VALUES (?,?, 'PHONE', ?, ?, 1, NOW(3), 'TEST', NOW(3), NOW(3))`, [randomUUID(), cid, '+919876500001', '+919876500001']);

    const evId = `order_delivered:sh-${tag}`;
    const r = await notificationService.emit('ORDER_DELIVERED', { customerId: cid, shipmentId: `sh-${tag}`, orderNumber: 'COR-LT1' });
    assert.equal(r.results.EMAIL, 'ENQUEUED', 'with an ACTIVE template, ORDER_DELIVERED EMAIL must enqueue');
    // WHATSAPP has a verified contact but no ACTIVE template -> quiet skip, not an error
    assert.equal(r.results.WHATSAPP, 'TEMPLATE_NOT_AVAILABLE');

    const rows = await query('SELECT * FROM communication_messages WHERE business_event_id = ?', [evId]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].channel, 'EMAIL');
    assert.equal(rows[0].classification, 'TRANSACTIONAL');
    assert(rows[0].rendered_subject.includes('COR-LT1'));
    assert(rows[0].rendered_body.includes('COR-LT1'));
    pass('PAYOFF_EMIT_ENQUEUES', 'WP-05 emit() -> real outbox row once WP-07 template is active');
  }

  console.log('\nWP-07 lifecycle template pack — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('DELETE cme FROM communication_message_events cme JOIN communication_messages cm ON cm.id=cme.message_id WHERE cm.created_at >= ?', [scriptStartedAt]));
  await safe(() => query('DELETE FROM communication_messages WHERE created_at >= ?', [scriptStartedAt]));
  await safe(() => restoreLifecycleTemplates());
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM customer_contacts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  await pool.end();
}
