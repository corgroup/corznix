// Abandoned-cart recovery campaigns — verification.
//
// Proves, against the real DB + the real communications outbox:
//   CAMPAIGN_VALIDATION   — a channel can't be enabled without an ACTIVE
//                           MARKETING template for it; a bad coupon is rejected.
//   DETECTS_AND_ENQUEUES  — a stale cart with items, a verified + consented
//                           customer, and an ACTIVE campaign -> one reminder
//                           enqueued as a MARKETING outbox row, one
//                           abandoned_cart_sends episode row.
//   NEVER_AFTER_PURCHASE  — an order placed at/after the cart's last activity
//                           makes the cart ineligible (0 reminders).
//   SEND_ONCE_PER_EPISODE — a second scan does nothing; touching the cart
//                           (new updated_at) permits exactly one more.
//   PER_CUSTOMER_COOLDOWN — a second campaign won't remind the same customer
//                           within cooldown_hours.
//   RESPECTS_CONSENT      — no marketing consent -> no episode burned, no
//                           enqueue (stays a candidate for later).
//   PAUSED_NOOP           — a PAUSED campaign is never scanned.
//
// Isolated + self-cleaning. No real send (COMMUNICATION_WORKER_ENABLED=false).
//
//   npm run verify:abandoned-cart
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.COMMUNICATION_WORKER_ENABLED = 'false';
process.env.ABANDONED_CART_WORKER_ENABLED = 'false';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { marketingCampaignService } = await import('../src/modules/marketingCampaigns/service.js');
const [corcotton] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");

// Abandoned-cart campaigns are ordinary campaigns with the cart.abandoned
// trigger (docs/MESSAGING.md): created, activated and paused through the one
// campaign API the CMS uses.
async function createCartCampaign({ name, delayMinutes = 60, maxAgeHours = 168, cooldownHours = 168, minCartValueMinor = 0, couponCode = null, templateKey, activate = true }) {
  const c = await marketingCampaignService.create(corcotton.id, {
    name, campaignType: 'ABANDONED_CART',
    channels: templateKey ? [{ channel: 'EMAIL', templateKey }] : [],
    trigger: { key: 'cart.abandoned', config: { delayMinutes, maxAgeHours, cooldownHours, minCartValueMinor, couponCode } },
  }, null);
  if (activate) await marketingCampaignService.activate(c.id, corcotton.id);
  return c;
}
const pauseCampaign = (id) => marketingCampaignService.pause(id, corcotton.id);
const { abandonedCartService } = await import('../src/modules/abandonedCart/service.js');
const { abandonedCartRepository } = await import('../src/modules/abandonedCart/repository.js');
const { communicationTemplateService } = await import('../src/modules/communications/templateService.js');
const { consentService } = await import('../src/modules/consent/service.js');
const {
  ABANDONED_CART_TEMPLATE_DEFAULTS, ABANDONED_CART_VARIABLE_SCHEMA,
} = await import('../src/modules/abandonedCart/templates.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const tag = randomUUID().slice(0, 8);
const startedAt = new Date();
const EMAIL = `acart-${tag}@x.test`;
const KEY = `marketing.abandoned_cart_v_${tag}`;

const created = { campaigns: [], customers: [], carts: [], orders: [], reservations: [] };
// Every scan below is limited to this gate's own customers: with default-ON
// marketing a database's real customers are reachable, and a verify run must
// never remind them.

async function makeCustomerWithCart({ consented = true, subtotalItems = 2 } = {}) {
  const cid = randomUUID();
  created.customers.push(cid);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,'T','ACTIVE',NOW(3))", [cid, `AC-${tag}`]);
  const email = `acart-${tag}-${created.customers.length}@x.test`;
  await query(`INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source,created_at,updated_at)
    VALUES (?,?, 'EMAIL', ?, ?, 1, NOW(3), 'TEST', NOW(3), NOW(3))`, [randomUUID(), cid, email, email]);
  if (consented) {
    await consentService.record({ contactKey: email, channel: 'EMAIL', purpose: 'MARKETING', action: 'GRANTED', source: 'STAFF_RECORDED', customerId: cid });
  }
  // a cart with N distinct active SKUs
  const skus = await query(
    `SELECT s.id FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE' LIMIT ?`, [subtotalItems]);
  assert(skus.length >= 1, 'need an ACTIVE sku fixture from the seed');
  const cartId = randomUUID();
  created.carts.push(cartId);
  await query("INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,'INR')", [cartId, cid]);
  for (const s of skus) {
    // eslint-disable-next-line no-await-in-loop
    await query('INSERT INTO cart_items (id,cart_id,sku_id,quantity) VALUES (?,?,?,1)', [randomUUID(), cartId, s.id]);
  }
  return { cid, email, cartId };
}

const ageCart = (cartId, minutesAgo) =>
  query('UPDATE carts SET updated_at = DATE_SUB(NOW(3), INTERVAL ? MINUTE) WHERE id = ?', [minutesAgo, cartId]);

const sendsFor = (campaignId) => query('SELECT * FROM abandoned_cart_sends WHERE campaign_id = ?', [campaignId]);
const outboxFor = (cartId) => query("SELECT * FROM communication_messages WHERE business_event_id LIKE ? AND classification='MARKETING'", [`abandoned_cart:%:${cartId}:%`]);

try {
  // ---- template + campaign scaffold --------------------------------
  const emailTpl = await communicationTemplateService.create({
    templateKey: KEY, channel: 'EMAIL', classification: 'MARKETING',
    subject: ABANDONED_CART_TEMPLATE_DEFAULTS.EMAIL.subject,
    bodyTemplate: ABANDONED_CART_TEMPLATE_DEFAULTS.EMAIL.bodyTemplate,
    variableSchema: ABANDONED_CART_VARIABLE_SCHEMA,
  });
  await communicationTemplateService.setStatus({ id: emailTpl.id, status: 'ACTIVE' });

  // ===================== 1. CAMPAIGN_VALIDATION =====================
  {
    const dead = await createCartCampaign({ name: `V dead ${tag}`, templateKey: 'no.such.template', activate: false });
    created.campaigns.push(dead.id);
    await assert.rejects(marketingCampaignService.activate(dead.id, corcotton.id),
      (e) => e.code === 'CAMPAIGN_NOT_READY' && e.details?.blockers?.some((b) => b.code === 'TEMPLATE_NOT_ACTIVE'),
      'activating with a missing template must be refused');

    await assert.rejects(createCartCampaign({ name: `V coupon ${tag}`, templateKey: KEY, couponCode: `GHOST${tag}`, activate: false }),
      (e) => e.code === 'COUPON_NOT_FOUND', 'a non-existent coupon must be refused');

    const bare = await createCartCampaign({ name: `V bare ${tag}`, activate: false });
    created.campaigns.push(bare.id);
    await assert.rejects(marketingCampaignService.activate(bare.id, corcotton.id),
      (e) => e.code === 'CAMPAIGN_NOT_READY' && e.details?.blockers?.some((b) => b.code === 'NO_CHANNEL'),
      'activating a campaign with no channel must be refused');
    pass('CAMPAIGN_VALIDATION', 'dead channel / bad coupon / channel-less ACTIVE all rejected');
  }

  // ===================== 2. DETECTS_AND_ENQUEUES ====================
  const campaign = await createCartCampaign({ name: `Recover ${tag}`, templateKey: KEY });
  created.campaigns.push(campaign.id);

  const a = await makeCustomerWithCart();
  await ageCart(a.cartId, 120); // 2h old, delay is 60m -> eligible

  {
    const summary = await abandonedCartService.runOnce({ customerIds: created.customers });
    assert.equal(summary.byCampaign[campaign.id].reminded, 1, 'one cart reminded');
    const sends = await sendsFor(campaign.id);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].cart_id, a.cartId);
    assert.equal(sends[0].channels_enqueued, 'EMAIL');
    const outbox = await outboxFor(a.cartId);
    assert.equal(outbox.length, 1, 'one MARKETING outbox row');
    assert.equal(outbox[0].classification, 'MARKETING');
    assert(outbox[0].rendered_body.includes('Return to your cart'), 'template rendered');
    pass('DETECTS_AND_ENQUEUES', '1 reminder -> 1 episode row + 1 MARKETING outbox row');
  }

  // ===================== 3. NEVER_AFTER_PURCHASE ====================
  {
    const b = await makeCustomerWithCart();
    await ageCart(b.cartId, 120); // abandoned 2h ago
    const [{ activity_at: activityAt }] = await query('SELECT updated_at AS activity_at FROM carts WHERE id = ?', [b.cartId]);

    // ...then they placed an order AFTER touching the cart.
    const rid = randomUUID();
    created.reservations.push(rid);
    await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
       VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [rid, b.cid, `acart:${randomUUID()}`, '0'.repeat(64)]);
    const oid = randomUUID();
    created.orders.push(oid);
    await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
        subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source,placed_at)
       VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,NULL,?,?, 'PAID','PREPAID','INR', 100,0,100,100,0,'{}','{}','ACART_TEST', DATE_ADD(?, INTERVAL 5 MINUTE))`,
      [oid, `COR-ACART-${tag}`, b.cid, rid, activityAt]);

    const summary = await abandonedCartService.runOnce({ customerIds: created.customers });
    const remindedCarts = (await sendsFor(campaign.id)).map((s) => s.cart_id);
    assert(!remindedCarts.includes(b.cartId), 'a cart with a later order is never reminded');
    assert.equal(summary.byCampaign[campaign.id].reminded, 0, 'nothing new reminded this pass');
    pass('NEVER_AFTER_PURCHASE', 'order placed >= cart activity -> cart ineligible');
  }

  // ===================== 4. PER_CUSTOMER_COOLDOWN ===================
  {
    const c2 = await createCartCampaign({ name: `Recover2 ${tag}`, templateKey: KEY });
    created.campaigns.push(c2.id);
    // customer a was reminded in check 2 -> still inside the 168h cooldown, even
    // for a different campaign, even if the cart changed.
    await ageCart(a.cartId, 90);
    const summary = await abandonedCartService.runOnce({ customerIds: created.customers });
    assert.equal((summary.byCampaign[c2.id]?.reminded) || 0, 0, 'a second campaign respects the per-customer cooldown');
    assert.equal((summary.byCampaign[campaign.id]?.reminded) || 0, 0, 'the original campaign also respects the cooldown');
    assert.equal((await sendsFor(c2.id)).length, 0);
    pass('PER_CUSTOMER_COOLDOWN', 'same customer not re-reminded within cooldown_hours (any campaign)');
  }

  // ===================== 5. SEND_ONCE_PER_EPISODE ===================
  {
    // Isolate this check to the original campaign.
    for (const other of created.campaigns.filter((id) => id !== campaign.id)) {
      // eslint-disable-next-line no-await-in-loop
      await pauseCampaign(other).catch((e) => { if (e.code !== 'CAMPAIGN_NOT_PAUSABLE') throw e; });
    }
    const before = (await sendsFor(campaign.id)).filter((s) => s.cart_id === a.cartId).length;
    // Age the earlier reminder past the cooldown so only the episode key is left
    // as the guard.
    await query('UPDATE abandoned_cart_sends SET created_at = DATE_SUB(NOW(3), INTERVAL 400 HOUR) WHERE customer_id = ?', [a.cid]);

    // Same cart, unchanged since its last recorded episode -> still nothing.
    const [{ act }] = await query('SELECT updated_at AS act FROM carts WHERE id = ?', [a.cartId]);
    await query('UPDATE abandoned_cart_sends SET cart_activity_at = ? WHERE campaign_id = ? AND cart_id = ?', [act, campaign.id, a.cartId]);
    await abandonedCartService.runOnce({ customerIds: created.customers });
    assert.equal((await sendsFor(campaign.id)).filter((s) => s.cart_id === a.cartId).length, before,
      'a re-scan of an unchanged cart (past cooldown) still sends nothing — episode dedupe');

    // Customer edits the cart -> new episode -> exactly one more.
    await ageCart(a.cartId, 75);
    await abandonedCartService.runOnce({ customerIds: created.customers });
    assert.equal((await sendsFor(campaign.id)).filter((s) => s.cart_id === a.cartId).length, before + 1,
      'a changed cart permits exactly one more reminder');
    pass('SEND_ONCE_PER_EPISODE', 'unchanged cart = 0 even past cooldown; cart edited = +1');
  }

  // ===================== 6. RESPECTS_CONSENT ========================
  {
    const d = await makeCustomerWithCart({ consented: false });
    await ageCart(d.cartId, 120);
    await abandonedCartService.runOnce({ customerIds: created.customers });
    const sends = (await sendsFor(campaign.id)).filter((s) => s.cart_id === d.cartId);
    assert.equal(sends.length, 0, 'no episode burned for a customer without marketing consent');
    assert.equal((await outboxFor(d.cartId)).length, 0, 'nothing enqueued without consent');

    // now they consent -> reminded on the next pass
    await consentService.record({ contactKey: d.email, channel: 'EMAIL', purpose: 'MARKETING', action: 'GRANTED', source: 'DOUBLE_OPT_IN', customerId: d.cid });
    await abandonedCartService.runOnce({ customerIds: created.customers });
    assert.equal((await sendsFor(campaign.id)).filter((s) => s.cart_id === d.cartId).length, 1, 'reminded once consent is granted');
    pass('RESPECTS_CONSENT', 'no consent -> candidate preserved; consent -> reminded');
  }

  // ===================== 7. PAUSED_NOOP =============================
  {
    await pauseCampaign(campaign.id);
    const e = await makeCustomerWithCart();
    await ageCart(e.cartId, 200);
    const summary = await abandonedCartService.runOnce({ customerIds: created.customers });
    assert(!summary.byCampaign[campaign.id], 'a PAUSED campaign is not scanned');
    assert.equal((await sendsFor(campaign.id)).filter((s) => s.cart_id === e.cartId).length, 0);
    pass('PAUSED_NOOP', 'PAUSED campaign never scans');
  }

  // ===================== 8. TEST_REMINDER ===========================
  // One named customer's reminder, now, on a PAUSED campaign — the only way to
  // verify recovery on production without messaging everyone with a cart.
  {
    const t = await makeCustomerWithCart();
    const r = await abandonedCartService.sendTestReminder(campaign.id, { contact: t.email.toUpperCase() });
    const email = r.results.find((x) => x.channel === 'EMAIL');
    assert.equal(email?.outcome, 'QUEUED', `consented customer's test reminder is queued, got ${JSON.stringify(r.results)}`);
    assert.ok(r.product, 'the test names the product from THIS customer\'s cart');
    const testRows = await query('SELECT id FROM communication_messages WHERE business_event_id LIKE ?', [`abandoned_cart_test:${campaign.id}:${t.cartId}:%`]);
    assert.equal(testRows.length, 1, 'exactly one test message enqueued');
    assert.equal((await sendsFor(campaign.id)).filter((s) => s.cart_id === t.cartId).length, 0,
      'a test must NOT use up the cart\'s real reminder episode');
    const [{ n: tokens }] = await query('SELECT COUNT(*) AS n FROM cart_recovery_tokens WHERE customer_id = ?', [t.cid]);
    assert.ok(Number(tokens) >= 1, 'a real recovery token was issued for this customer');

    const quiet = await makeCustomerWithCart({ consented: false });
    const q = await abandonedCartService.sendTestReminder(campaign.id, { contact: quiet.email });
    assert.equal(q.results.find((x) => x.channel === 'EMAIL')?.outcome, 'SUPPRESSED', 'no consent -> suppressed, reported');

    await assert.rejects(() => abandonedCartService.sendTestReminder(campaign.id, { contact: `nobody-${tag}@x.test` }),
      (e) => e.code === 'CUSTOMER_NOT_FOUND');
    const empty = await makeCustomerWithCart();
    await query('DELETE FROM cart_items WHERE cart_id = ?', [empty.cartId]);
    await assert.rejects(() => abandonedCartService.sendTestReminder(campaign.id, { contact: empty.email }),
      (e) => e.code === 'CART_EMPTY');
    pass('TEST_REMINDER', 'one customer only; consent enforced; episode untouched; real token issued');
  }

  // ---- stats sanity ----
  {
    const stats = await abandonedCartRepository.campaignStats(campaign.id);
    assert(stats.reminders >= 3, 'stats report the reminders sent');
    pass('STATS', `reminders=${stats.reminders} customers=${stats.customers} converted=${stats.converted}`);

    // The Cart Recovery page's per-customer log is the real sends + messages:
    // one row per reminder episode, every channel's own message attached.
    const log = await abandonedCartService.reminderLog({ campaignIds: [campaign.id], page: 1, pageSize: 200 });
    const sends = await sendsFor(campaign.id);
    assert.equal(log.total, sends.length, `one log row per real reminder (${log.total} vs ${sends.length})`);
    const first = log.reminders.find((r) => r.customerId === a.cid);
    assert.ok(first, 'the reminded customer appears in the log');
    assert.ok(first.email && first.email.includes('acart-'), `the customer's email is shown: ${first.email}`);
    assert.ok(first.channels.length >= 1 && first.channels.every((c) => ['EMAIL', 'WHATSAPP'].includes(c.channel)), 'each channel is listed on its own');
    const [msg] = await query("SELECT status, recipient_contact_key FROM communication_messages WHERE business_event_id = ? AND channel = 'EMAIL'", [sends.find((x) => x.customer_id === a.cid).business_event_id]);
    const emailRow = first.channels.find((c) => c.channel === 'EMAIL');
    assert.equal(emailRow.status, msg.status, 'the channel status is the engine message status, not a label');
    assert.equal(emailRow.to, msg.recipient_contact_key, 'and names the address it went to');
    assert.equal(first.recoveredOrder, null, 'no order -> not recovered');
    assert.ok(!log.reminders.some((r) => r.reminderType !== 'Abandoned cart reminder'), 'test reminders are not listed as reminders');
    pass('REMINDER_LOG_IS_REAL_PER_CUSTOMER_PER_CHANNEL', `${log.total} reminders`);
  }

  console.log('\nAbandoned-cart campaigns — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const oid of created.orders) await safe(() => query('DELETE FROM orders WHERE id = ?', [oid]));
  for (const rid of created.reservations) await safe(() => query('DELETE FROM inventory_reservations WHERE id = ?', [rid]));
  await safe(() => query('DELETE cme FROM communication_message_events cme JOIN communication_messages cm ON cm.id=cme.message_id WHERE cm.created_at >= ?', [startedAt]));
  await safe(() => query('DELETE FROM communication_messages WHERE created_at >= ?', [startedAt]));
  for (const id of created.campaigns) await safe(() => query('DELETE FROM marketing_campaigns WHERE id = ?', [id]));
  await safe(() => query('DELETE FROM communication_templates WHERE template_key = ?', [KEY]));
  for (const cartId of created.carts) await safe(() => query('DELETE FROM carts WHERE id = ?', [cartId]));
  await safe(() => query("DELETE FROM consent_state WHERE contact_key LIKE ?", [`%acart-${tag}%`]));
  await safe(() => query("DELETE FROM consent_records WHERE contact_key LIKE ?", [`%acart-${tag}%`]));
  await safe(() => query("DELETE FROM marketing_suppressions WHERE contact_key LIKE ?", [`%acart-${tag}%`]));
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM customer_contacts WHERE customer_id = ?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id = ?', [cid]));
  }
  await pool.end();
}
