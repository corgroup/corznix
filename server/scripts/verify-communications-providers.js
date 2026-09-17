// WP-06 (real communication providers) verification.
//
// Proves, offline and against the local dev database:
//   - the mode switch (COMMUNICATIONS_EMAIL_PROVIDER_MODE /
//     COMMUNICATIONS_WHATSAPP_PROVIDER_MODE) actually selects the real
//     adapter, and defaults to MOCK;
//   - the real SMTP Email adapter completes a genuine nodemailer SMTP
//     protocol exchange against a tiny in-process fake SMTP server (no real
//     network, no real credentials) and classifies failures correctly;
//   - the real Infyntra WhatsApp adapter requires an approved
//     provider_template_ref (WhatsApp Business API cannot send free text
//     outside a session window), builds the Meta-Cloud-API-style template
//     request correctly, and classifies HTTP/network outcomes correctly
//     (including AMBIGUOUS on a network error, never a blind resend);
//   - `provider_template_ref` is snapshotted onto the message at enqueue
//     time and survives all the way to the provider call, through the real
//     outbox (`enqueue` -> `communication_messages` -> `dispatchDue` ->
//     `provider.send`) — not just unit-tested in isolation;
//   - neither real adapter ever reaches the network in this run
//     (REAL_PROVIDER_CALLS = 0 outside the local fake SMTP socket).
//
// Isolated and self-cleaning: everything created is tagged and deleted in a
// `finally` block, matching verify-communications.js's convention.
//
//   npm run verify:communications-providers
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { env } = await import('../src/config/index.js');
const { communicationService } = await import('../src/modules/communications/service.js');
const { communicationTemplateService } = await import('../src/modules/communications/templateService.js');
const { providerForChannel, providerByCode } = await import('../src/modules/communications/providers.js');

const results = {};
const pass = (n, detail) => { results[n] = detail ? `PASS (${detail})` : 'PASS'; console.log(`  PASS  ${n}${detail ? ` — ${detail}` : ''}`); };
const tag = randomUUID().slice(0, 8);
const created = { templates: [] };

// ---- a minimal, offline, fake SMTP server (RFC-shaped, not a real MTA) ----
async function startFakeSmtp() {
  const received = [];
  let mode = 'CMD';
  let dataBuf = '';
  const server = createServer((socket) => {
    socket.write('220 fake-smtp.local ready\r\n');
    let buf = '';
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (mode === 'DATA') {
        dataBuf += buf; buf = '';
        if (dataBuf.includes('\r\n.\r\n')) {
          received.push(dataBuf); dataBuf = ''; mode = 'CMD';
          socket.write('250 2.0.0 OK: queued as fake-1\r\n');
        }
        return;
      }
      let idx;
      // eslint-disable-next-line no-cond-assign
      while ((idx = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const cmd = line.split(' ')[0].toUpperCase();
        if (cmd === 'EHLO' || cmd === 'HELO') socket.write('250-fake-smtp.local\r\n250 8BITMIME\r\n');
        else if (cmd === 'RCPT' && /bounce-me/i.test(line)) socket.write('550 5.1.1 No such mailbox\r\n');
        else if (cmd === 'MAIL' || cmd === 'RCPT') socket.write('250 2.1.0 OK\r\n');
        else if (cmd === 'DATA') { mode = 'DATA'; socket.write('354 End with <CRLF>.<CRLF>\r\n'); }
        else if (cmd === 'QUIT') { socket.write('221 2.0.0 Bye\r\n'); socket.end(); }
        else if (cmd) socket.write('250 2.0.0 OK\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, received, stop: () => new Promise((r) => server.close(r)) };
}

// The default fetch is a counting passthrough — any call that reaches it is a
// REAL outbound call and must stay at 0. Each network test installs its own
// stub that replaces this entirely (and never touches realFetch).
const realFetch = globalThis.fetch;
let realNetworkCalls = 0;
globalThis.fetch = (...a) => { realNetworkCalls += 1; return realFetch?.(...a); };
function stubFetch(handler) {
  globalThis.fetch = async (url, opts) => handler(url, opts);
}

let fakeSmtp;

// Phase 2 — per-purpose SMTP vars (SMTP_*_OTP / _ORDER / _SUPPORT) take
// precedence over the plain SMTP_* this test manipulates. Null them for the
// run so the test's fake-SMTP redirect via env.SMTP_HOST works; restore after.
const PER_PURPOSE_SMTP = ['HOST', 'USER', 'PASSWORD', 'FROM'].flatMap((f) =>
  ['OTP', 'ORDER', 'SUPPORT'].map((p) => `SMTP_${f}_${p}`));
const smtpSnapshot = Object.fromEntries(PER_PURPOSE_SMTP.map((k) => [k, env[k]]));
for (const k of PER_PURPOSE_SMTP) env[k] = undefined;

try {
  fakeSmtp = await startFakeSmtp();

  // ================= 1. Mode switch defaults to MOCK ======================
  assert.equal(providerForChannel('EMAIL').code, 'MOCK_EMAIL');
  assert.equal(providerForChannel('WHATSAPP').code, 'MOCK_WHATSAPP');
  pass('DEFAULT_MODE_IS_MOCK');

  // ================= 2. Real Email adapter — not configured ===============
  {
    const original = { host: env.SMTP_HOST, from: env.SMTP_FROM, emailFrom: env.EMAIL_FROM };
    env.SMTP_HOST = undefined; env.SMTP_FROM = undefined; env.EMAIL_FROM = undefined;
    const r = await providerByCode('SMTP_EMAIL').send({ to: 'x@test.dev', subject: 'S', body: 'B' });
    assert.equal(r.outcome, 'FAILED'); assert.equal(r.error, 'PROVIDER_NOT_CONFIGURED'); assert.equal(r.retryable, false);
    env.SMTP_HOST = original.host; env.SMTP_FROM = original.from; env.EMAIL_FROM = original.emailFrom;
    pass('SMTP_NOT_CONFIGURED_GUARD');
  }

  // ---- configure for the rest of the Email tests --------------------------
  env.SMTP_HOST = '127.0.0.1';
  env.SMTP_PORT = fakeSmtp.port;
  env.SMTP_SECURE = false;
  env.SMTP_FROM = 'noreply@corcotton.test';

  // ================= 3. Mode switch actually selects the real adapter =====
  env.COMMUNICATIONS_EMAIL_PROVIDER_MODE = 'REAL';
  assert.equal(providerForChannel('EMAIL').code, 'SMTP_EMAIL');
  env.COMMUNICATIONS_EMAIL_PROVIDER_MODE = 'MOCK';
  assert.equal(providerForChannel('EMAIL').code, 'MOCK_EMAIL');
  pass('EMAIL_MODE_SWITCH_SELECTS_REAL_ADAPTER');

  // ================= 4. Real Email — genuine SMTP send, via the adapter ===
  {
    const r = await providerByCode('SMTP_EMAIL').send({ to: 'customer@corcotton.test', subject: 'Order update', body: 'Your order shipped.' });
    assert.equal(r.outcome, 'ACCEPTED');
    assert(r.providerMessageId, 'a real nodemailer send must return a message id');
    assert.equal(fakeSmtp.received.length, 1);
    assert(fakeSmtp.received[0].includes('Your order shipped.'), 'the actual SMTP DATA payload must carry the rendered body');
    pass('SMTP_REAL_SEND_ACCEPTED', 'genuine nodemailer <-> fake-SMTP protocol exchange completed');
  }

  // ================= 5. Real Email — a hard SMTP rejection is FAILED ======
  //   (a permanent 550 mailbox rejection -> not retryable. The cached-
  //    transporter design, shared with the OTP adapter, means a
  //    connection-level failure can't be exercised in the same process as a
  //    success; a server-side 5xx proves the catch + classification without
  //    busting the transporter cache.)
  {
    const r = await providerByCode('SMTP_EMAIL').send({ to: 'bounce-me@corcotton.test', subject: 'S', body: 'B' });
    assert.equal(r.outcome, 'FAILED');
    assert.equal(r.retryable, false, 'a permanent 550 rejection is not retryable');
    pass('SMTP_HARD_REJECTION_FAILED');
  }

  // ================= 6. Real Email adapter has no delivery webhook (honest)
  assert.equal(providerByCode('SMTP_EMAIL').normalizeWebhook({ status: 'DELIVERED' }), null);
  pass('SMTP_NO_DELIVERY_WEBHOOK', 'documented limitation, not a fabricated contract');

  // ================= 7. Real WhatsApp — not configured ====================
  {
    const original = { base: env.INFYNTRA_API_BASE_URL, key: env.INFYNTRA_API_KEY, phone: env.INFYNTRA_PHONE_ID };
    env.INFYNTRA_API_BASE_URL = undefined; env.INFYNTRA_API_KEY = undefined; env.INFYNTRA_PHONE_ID = undefined;
    const r = await providerByCode('INFYNTRA_WHATSAPP').send({ to: '+919876543210', providerTemplateRef: 'x', variables: {} });
    assert.equal(r.error, 'PROVIDER_NOT_CONFIGURED');
    env.INFYNTRA_API_BASE_URL = original.base; env.INFYNTRA_API_KEY = original.key; env.INFYNTRA_PHONE_ID = original.phone;
    pass('INFYNTRA_NOT_CONFIGURED_GUARD');
  }

  // ---- configure for the rest of the WhatsApp tests ------------------------
  env.INFYNTRA_API_BASE_URL = 'https://fake-infyntra.test';
  env.INFYNTRA_API_KEY = 'fake-key';
  env.INFYNTRA_PHONE_ID = '000000000000000';
  env.PROVIDER_PHONE_FORMAT = '91_PLUS_10_DIGITS';

  // ================= 8. Mode switch actually selects the real adapter =====
  env.COMMUNICATIONS_WHATSAPP_PROVIDER_MODE = 'REAL';
  assert.equal(providerForChannel('WHATSAPP').code, 'INFYNTRA_WHATSAPP');
  env.COMMUNICATIONS_WHATSAPP_PROVIDER_MODE = 'MOCK';
  assert.equal(providerForChannel('WHATSAPP').code, 'MOCK_WHATSAPP');
  pass('WHATSAPP_MODE_SWITCH_SELECTS_REAL_ADAPTER');

  // ================= 9. No provider_template_ref -> hard requirement ======
  {
    const r = await providerByCode('INFYNTRA_WHATSAPP').send({ to: '+919876543210', variables: { name: 'A' } });
    assert.equal(r.outcome, 'FAILED'); assert.equal(r.error, 'PROVIDER_TEMPLATE_REQUIRED'); assert.equal(r.retryable, false);
    pass('WHATSAPP_TEMPLATE_REQUIRED', 'free-form WhatsApp text is never sent through this adapter');
  }

  // ================= 10. Invalid recipient format ==========================
  {
    const r = await providerByCode('INFYNTRA_WHATSAPP').send({ to: '9876543210', providerTemplateRef: 'order_update_v1', variables: {} });
    assert.equal(r.error, 'RECIPIENT_INVALID');
    pass('WHATSAPP_RECIPIENT_INVALID', 'rejects a non-E.164 recipient rather than guessing');
  }

  // ================= 11. Successful template send — request shape proof ===
  {
    let captured = null;
    stubFetch(async (url, opts) => {
      captured = { url: String(url), body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.TEST123' }] }) };
    });
    const r = await providerByCode('INFYNTRA_WHATSAPP').send({
      to: '+919876543210', providerTemplateRef: 'order_update_v1', variables: { orderNumber: 'COR-1', status: 'Shipped' },
    });
    assert.equal(r.outcome, 'ACCEPTED');
    assert.equal(r.providerMessageId, 'wamid.TEST123');
    assert(captured.url.includes('000000000000000/send_messages'));
    assert.equal(captured.body.to, '919876543210', 'PROVIDER_PHONE_FORMAT=91_PLUS_10_DIGITS must be honoured');
    assert.equal(captured.body.type, 'template');
    assert.equal(captured.body.template.name, 'order_update_v1');
    assert.deepEqual(captured.body.template.components[0].parameters, [{ type: 'text', text: 'COR-1' }, { type: 'text', text: 'Shipped' }]);
    pass('WHATSAPP_REAL_SEND_ACCEPTED', 'Meta-Cloud-API-shaped template request, variables positional in declared order');
  }

  // ================= 12. HTTP rejection classified by status ==============
  {
    stubFetch(async () => ({ ok: false, status: 404, json: async () => ({ error: 'template not found' }) }));
    const r404 = await providerByCode('INFYNTRA_WHATSAPP').send({ to: '+919876543210', providerTemplateRef: 'missing', variables: {} });
    assert.equal(r404.outcome, 'FAILED'); assert.equal(r404.retryable, false, '404 (bad template ref) is a config problem, not transient');

    stubFetch(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    const r500 = await providerByCode('INFYNTRA_WHATSAPP').send({ to: '+919876543210', providerTemplateRef: 'x', variables: {} });
    assert.equal(r500.retryable, true, '5xx must be retryable');
    pass('WHATSAPP_HTTP_STATUS_CLASSIFICATION');
  }

  // ================= 13. Network error -> AMBIGUOUS, never a blind retry ===
  {
    stubFetch(async () => { throw new Error('ECONNRESET'); });
    const r = await providerByCode('INFYNTRA_WHATSAPP').send({ to: '+919876543210', providerTemplateRef: 'x', variables: {} });
    assert.equal(r.outcome, 'AMBIGUOUS');
    pass('WHATSAPP_NETWORK_ERROR_AMBIGUOUS', 'parked at UNKNOWN by the engine, not blindly resent (a duplicate WhatsApp is customer-visible)');
  }

  // ================= 14. Invalid provider response ==========================
  {
    stubFetch(async () => ({ ok: true, json: async () => ({}) }));
    const r = await providerByCode('INFYNTRA_WHATSAPP').send({ to: '+919876543210', providerTemplateRef: 'x', variables: {} });
    assert.equal(r.error, 'PROVIDER_RESPONSE_INVALID');
    pass('WHATSAPP_INVALID_RESPONSE_GUARD');
  }

  // ================= 15. No delivery webhook (honest) =======================
  assert.equal(providerByCode('INFYNTRA_WHATSAPP').normalizeWebhook({ status: 'DELIVERED' }), null);
  pass('WHATSAPP_NO_DELIVERY_WEBHOOK', 'no Infyntra delivery-status contract is documented/available — not fabricated');

  // ============================================================================
  // 16. FULL ENGINE PROOF — provider_template_ref survives enqueue -> outbox ->
  //     dispatch -> real provider.send(), through the actual DB, not a mock.
  // ============================================================================
  {
    const templateKey = `wp06.whatsapp.${tag}`;
    const t = await communicationTemplateService.create({
      templateKey, channel: 'WHATSAPP', classification: 'TRANSACTIONAL',
      bodyTemplate: 'Hi {{name}}, your order {{orderNumber}} is on the way.',
      variableSchema: { name: { required: true, type: 'string' }, orderNumber: { required: true, type: 'string' } },
      providerTemplateRef: 'order_update_v1',
    });
    created.templates.push(`${t.templateKey}|${t.channel}`);
    await communicationTemplateService.setStatus({ id: t.id, status: 'ACTIVE' });

    const enq = await communicationService.enqueue({
      businessEventId: `wp06-test:${tag}`, policyKey: 'test.wp06', classification: 'TRANSACTIONAL',
      channel: 'WHATSAPP', templateKey, recipient: { contactKey: '+919876543210' },
      variables: { name: 'Priya', orderNumber: 'COR-999' },
    });
    const stored = await query('SELECT provider_template_ref, rendered_body FROM communication_messages WHERE id=?', [enq.id]);
    assert.equal(stored[0].provider_template_ref, 'order_update_v1', 'the template ref must be snapshotted at enqueue time');
    pass('E2E_PROVIDER_TEMPLATE_REF_SNAPSHOTTED');

    let captured = null;
    stubFetch(async (url, opts) => {
      captured = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ messages: [{ id: 'wamid.E2E999' }] }) };
    });
    env.COMMUNICATIONS_WHATSAPP_PROVIDER_MODE = 'REAL';
    const summary = await communicationService.dispatchDue({ limit: 10 });
    env.COMMUNICATIONS_WHATSAPP_PROVIDER_MODE = 'MOCK';
    // dispatchDue drains the SHARED outbox, so the batch legitimately picks up
    // anything another verify script left QUEUED. This test's contract is that
    // ITS message went out through the real adapter — asserted precisely below
    // on enq.id — not that the queue happened to hold exactly one row.
    assert.ok(summary.sent >= 1, "expected at least this message to be sent");
    assert.equal(captured.template.name, 'order_update_v1');
    const after = await query('SELECT status, provider_code, provider_message_id FROM communication_messages WHERE id=?', [enq.id]);
    assert.equal(after[0].status, 'SENT');
    assert.equal(after[0].provider_code, 'INFYNTRA_WHATSAPP');
    assert.equal(after[0].provider_message_id, 'wamid.E2E999');
    pass('E2E_DISPATCH_THROUGH_REAL_PROVIDER', 'enqueue -> outbox -> dispatchDue -> real Infyntra adapter -> SENT, end to end');
  }

  // ================= 17. Same end-to-end proof for real Email =============
  {
    const templateKey = `wp06.email.${tag}`;
    const t = await communicationTemplateService.create({
      templateKey, channel: 'EMAIL', classification: 'TRANSACTIONAL', subject: 'Your order {{orderNumber}}',
      bodyTemplate: 'Hi {{name}}, your order {{orderNumber}} shipped.',
      variableSchema: { name: { required: true, type: 'string' }, orderNumber: { required: true, type: 'string' } },
    });
    created.templates.push(`${t.templateKey}|${t.channel}`);
    await communicationTemplateService.setStatus({ id: t.id, status: 'ACTIVE' });

    const enq = await communicationService.enqueue({
      businessEventId: `wp06-email-test:${tag}`, policyKey: 'test.wp06', classification: 'TRANSACTIONAL',
      channel: 'EMAIL', templateKey, recipient: { contactKey: 'customer@corcotton.test' },
      variables: { name: 'Priya', orderNumber: 'COR-999' },
    });

    const beforeCount = fakeSmtp.received.length;
    env.COMMUNICATIONS_EMAIL_PROVIDER_MODE = 'REAL';
    const summary = await communicationService.dispatchDue({ limit: 10 });
    env.COMMUNICATIONS_EMAIL_PROVIDER_MODE = 'MOCK';
    assert.equal(summary.sent, 1);
    assert.equal(fakeSmtp.received.length, beforeCount + 1, 'a real SMTP DATA transaction must have occurred');
    assert(fakeSmtp.received[fakeSmtp.received.length - 1].includes('COR-999'));
    const after = await query('SELECT status, provider_code FROM communication_messages WHERE id=?', [enq.id]);
    assert.equal(after[0].status, 'SENT');
    assert.equal(after[0].provider_code, 'SMTP_EMAIL');
    pass('E2E_EMAIL_DISPATCH_THROUGH_REAL_SMTP', 'enqueue -> outbox -> dispatchDue -> real SMTP adapter -> fake server -> SENT');
  }

  // ================= 18. Zero real outbound network calls ==================
  assert.equal(realNetworkCalls, 0, 'REAL_PROVIDER_CALLS (anything reaching the real fetch) must be 0');
  pass('REAL_PROVIDER_CALLS_ZERO');

  console.log('\nWP-06 real communication providers — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(smtpSnapshot)) env[k] = v;
  if (fakeSmtp) await fakeSmtp.stop();
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('DELETE cme FROM communication_message_events cme JOIN communication_messages cm ON cm.id=cme.message_id WHERE cm.business_event_id LIKE ?', [`%${tag}%`]));
  await safe(() => query('DELETE FROM communication_messages WHERE business_event_id LIKE ?', [`%${tag}%`]));
  for (const key of created.templates) {
    const [k, ch] = key.split('|');
    await safe(() => query('DELETE FROM communication_templates WHERE template_key=? AND channel=?', [k, ch]));
  }
  await pool.end();
}
