// Offer / New Collection campaigns end to end, against the real database.
//
// What this exists to stop reaching customers:
//   * a contact being messaged because they were in an uploaded file, without
//     marketing consent;
//   * the same person receiving the campaign twice because they appear in the
//     customer table, the newsletter list AND a CSV;
//   * an unconfirmed upload silently becoming audience;
//   * a WhatsApp send on a template Meta has not approved;
//   * a campaign that fires its whole audience at the provider in one burst.
//
// Uses the real MarketingCampaignService, the real ConsentService and the real
// communications outbox (messages are ENQUEUED, not dispatched — no provider is
// contacted). Everything it creates is removed again.
//
//   npm run verify:marketing-campaign
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { marketingCampaignService } = await import('../src/modules/marketingCampaigns/service.js');
const { consentService } = await import('../src/modules/consent/service.js');
const { campaignEventPrefix } = await import('../src/modules/marketingCampaigns/repository.js');
const { META_TEMPLATE_CONTRACT } = await import('../src/modules/communications/providers.js');
const { startMarketingCampaignWorker } = await import('../src/modules/marketingCampaigns/worker.js');
const { catalogService } = await import('../src/modules/catalog/service.js');
const { storefrontBaseUrl } = await import('../src/config/index.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

const tag = randomUUID().slice(0, 8);
const CONSENTED_EMAIL = `verify.optin.${tag}@example.com`;
const SILENT_EMAIL = `verify.noconsent.${tag}@example.com`;
// Holds a NEWSLETTER grant only — never MARKETING. Declared here because
// cleanup() removes its consent rows and runs even when the body throws.
const NEWSLETTER_EMAIL = `verify.news.${tag}@example.com`;
const TEMPLATE_KEY = 'marketing.offer_campaign';
// Channel configurations for the one campaign under test (docs/MESSAGING.md:
// a campaign names the template each channel sends).
const EMAIL_ONLY = [{ channel: 'EMAIL', templateKey: TEMPLATE_KEY }];
const EMAIL_AND_WHATSAPP = (providerTemplateRef = null) => [
  { channel: 'EMAIL', templateKey: TEMPLATE_KEY },
  { channel: 'WHATSAPP', templateKey: TEMPLATE_KEY, providerTemplateRef },
];

const brand = await one("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
assert(brand, 'the corcotton brand must exist — run npm run seed');

const createdTemplateIds = [];
let campaignId = null;
let listId = null;
let knownCustomerListId = null;
let stopWorker = () => {};
let secondCampaignId = null;
let duplicateCampaignId = null;

async function cleanup() {
  if (campaignId) {
    await query('DELETE FROM communication_messages WHERE business_event_id LIKE ?', [`${campaignEventPrefix(campaignId)}%`]).catch(() => {});
    await query('DELETE FROM marketing_campaigns WHERE id = ?', [campaignId]).catch(() => {});
  }
  if (duplicateCampaignId) await query('DELETE FROM marketing_campaigns WHERE id = ?', [duplicateCampaignId]).catch(() => {});
  if (secondCampaignId) {
    await query('DELETE FROM communication_messages WHERE business_event_id LIKE ?', [`${campaignEventPrefix(secondCampaignId)}%`]).catch(() => {});
    await query('DELETE FROM marketing_campaigns WHERE id = ?', [secondCampaignId]).catch(() => {});
  }
  if (listId) await query('DELETE FROM marketing_audience_lists WHERE id = ?', [listId]).catch(() => {});
  if (knownCustomerListId) await query('DELETE FROM marketing_audience_lists WHERE id = ?', [knownCustomerListId]).catch(() => {});
  for (const id of createdTemplateIds) {
    await query('DELETE FROM communication_templates WHERE id = ?', [id]).catch(() => {});
  }
  // Consent is an append-only ledger; the two verify contacts are removed so
  // the gate leaves no trace that verify:reporting would later count.
  await query('DELETE FROM consent_records WHERE contact_key IN (?, ?, ?)', [CONSENTED_EMAIL, SILENT_EMAIL, NEWSLETTER_EMAIL]).catch(() => {});
}

/**
 * The CI seed has no marketing templates, so the gate builds the ones it needs
 * and removes them again — the same way the other gates handle shipping
 * profiles and tax mappings.
 */
async function ensureTemplate(channel, providerRef) {
  const existing = await one(
    `SELECT id FROM communication_templates WHERE brand_id = ? AND template_key = ? AND channel = ? AND status = 'ACTIVE' LIMIT 1`,
    [brand.id, TEMPLATE_KEY, channel]);
  if (existing) return existing.id;
  const id = randomUUID();
  // Next version, not 1: seed:marketing-templates may already own version 1 of
  // this key/channel (the offer template is seeded DRAFT while Meta reviews
  // it), and (brand, key, channel, version) is unique.
  const [{ v }] = await query(
    'SELECT COALESCE(MAX(version), 0) AS v FROM communication_templates WHERE brand_id = ? AND template_key = ? AND channel = ?',
    [brand.id, TEMPLATE_KEY, channel]);
  await query(
    `INSERT INTO communication_templates
       (id, brand_id, template_key, channel, classification, version, status, subject, body_template, variable_schema, provider_template_ref)
     VALUES (?,?,?,?,'MARKETING',?,'ACTIVE',?,?,CAST(? AS JSON),?)`,
    [id, brand.id, TEMPLATE_KEY, channel, Number(v) + 1,
      channel === 'EMAIL' ? '{{offerName}}' : null,
      channel === 'EMAIL'
        ? '<p>Hi {{customerName}},</p><p>{{offerName}} — {{offerDetails}}</p>'
        : 'Hi {{customerName}}, {{offerName}}: {{offerDetails}}',
      JSON.stringify({
        customerName: { required: true, type: 'string' },
        offerName: { required: true, type: 'string' },
        offerDetails: { type: 'string' },
        ctaLabel: { type: 'string' }, ctaUrl: { type: 'string' }, imageUrl: { type: 'string' },
      }),
      providerRef]);
  createdTemplateIds.push(id);
  return id;
}

try {
  await ensureTemplate('EMAIL', null);

  // ---- 1. upload: a file with every kind of bad row --------------------
  const csv = [
    'Name,Phone,Email',
    `Optin,,${CONSENTED_EMAIL}`,
    `Silent,,${SILENT_EMAIL}`,
    `DupeOfOptin,,${CONSENTED_EMAIL.toUpperCase()}`,   // duplicate, different case
    'BadPhone,12345,',                                  // invalid phone, no email
    'NoContact,,',                                      // nothing at all
    `Spaced, +91 93199 87171 ,spaced.${tag}@example.com`,
  ].join('\n');

  const preview = await marketingCampaignService.uploadList(brand.id, {
    buffer: Buffer.from(`\uFEFF${csv}`, 'utf8'), filename: 'verify-list.csv',
    name: `verify ${tag}`, staffId: null,
  });
  listId = preview.listId;
  assert.equal(preview.counts.total, 6, `6 data rows, got ${preview.counts.total}`);
  assert.equal(preview.counts.valid, 3, `3 valid, got ${preview.counts.valid}`);
  assert.equal(preview.counts.duplicate, 1, 'the repeated email is a duplicate regardless of case');
  // Two rows carry nothing usable: the malformed phone with no email, and the
  // wholly empty contact.
  assert.equal(preview.counts.invalid, 2, `2 invalid, got ${preview.counts.invalid}`);
  assert.equal(preview.counts.invalidPhone, 1, 'the malformed phone is counted');
  assert.equal(preview.confirmed, false, 'a fresh upload is NOT confirmed');
  assert.ok(preview.samples.INVALID[0]?.invalid_reason, 'every bad row says why');
  pass('UPLOAD_VALIDATES_AND_REPORTS_EVERY_BUCKET',
    `valid=${preview.counts.valid} invalid=${preview.counts.invalid} dup=${preview.counts.duplicate}`);

  // ---- 1b. a known customer listed twice is counted once ---------------
  // Production showed "existing customers 2, new contacts -1" for a file with
  // one valid row and its duplicate. Uses a real customer's verified contact,
  // in a list that is never attached to a campaign and is removed again.
  const known = await one(
    `SELECT cc.normalized_value AS email FROM customer_contacts cc
       JOIN customers c ON c.id = cc.customer_id
      WHERE cc.contact_type = 'EMAIL' AND c.brand_id = ? LIMIT 1`, [brand.id]);
  if (known) {
    const knownPreview = await marketingCampaignService.uploadList(brand.id, {
      buffer: Buffer.from(['Name,Phone,Email', `Known,,${known.email}`, `KnownAgain,,${known.email.toUpperCase()}`,
        `Stranger,,stranger.${tag}@example.com`].join('\n'), 'utf8'),
      filename: 'verify-known.csv', name: `verify known ${tag}`, staffId: null,
    });
    knownCustomerListId = knownPreview.listId;
    assert.equal(knownPreview.counts.valid, 2, `2 valid, got ${knownPreview.counts.valid}`);
    assert.equal(knownPreview.counts.duplicate, 1, 'the repeated customer is a duplicate');
    assert.equal(knownPreview.counts.existingCustomers, 1,
      `the duplicate must not count the customer twice, got ${knownPreview.counts.existingCustomers}`);
    assert.equal(knownPreview.counts.newExternalContacts, 1, `one new contact, got ${knownPreview.counts.newExternalContacts}`);
    await marketingCampaignService.discardList(knownCustomerListId, brand.id);
    knownCustomerListId = null;
    pass('EXISTING_CUSTOMERS_COUNT_VALID_ROWS_ONLY', 'existing=1 new=1 with a duplicate of the customer');
  } else {
    // A fresh CI database may have no customer with an email contact.
    // Say so rather than pass silently.
    console.log('  NOTE  no customer email contact in this database');
    results.EXISTING_CUSTOMERS_COUNT_VALID_ROWS_ONLY = 'SKIPPED (no customer email contact to match)';
  }
  assert.ok(preview.counts.newExternalContacts >= 0, 'new contacts is never negative');

  // ---- 2. an unconfirmed upload is not audience ------------------------
  campaignId = (await marketingCampaignService.create(brand.id, {
    name: `Verify offer ${tag}`, campaignType: 'SALE_OFFER', offerName: 'Verify Offer',
    offerDetails: 'Flat 20% off', channels: EMAIL_ONLY, trigger: { key: 'send_now' },
    audienceSources: [{ type: 'LIST', listId }], batchSize: 2,
  }, null)).id;

  let audience = await marketingCampaignService.audiencePreview(campaignId, brand.id);
  assert.equal(audience.total, 0, 'an unconfirmed list contributes nobody');
  pass('UNCONFIRMED_UPLOAD_IS_NOT_AUDIENCE');

  await marketingCampaignService.confirmList(listId, brand.id);

  // ---- 3. consent decides, not the file --------------------------------
  await consentService.record({
    contactKey: CONSENTED_EMAIL, channel: 'EMAIL', purpose: 'MARKETING',
    action: 'GRANTED', source: 'CMS_IMPORT',
  });

  audience = await marketingCampaignService.audiencePreview(campaignId, brand.id);
  assert.equal(audience.total, 3, `3 email contacts resolved, got ${audience.total}`);
  assert.equal(audience.emailEligible, 1, `only the opted-in contact is eligible, got ${audience.emailEligible}`);
  assert.equal(audience.suppressed, 2, 'the other two are suppressed with a reason');
  assert.ok(Object.keys(audience.suppressedReasons).length, 'suppression reasons are reported');
  // The per-person breakdown the CMS shows before a send.
  assert.ok(audience.people, 'preview carries a per-person breakdown');
  assert.equal(audience.people.finalSendable, audience.people.emailEligible + audience.people.whatsappEligible - audience.people.bothEligible,
    'final sendable people = email + WhatsApp - both');
  assert.ok(audience.people.disabled >= 2, 'the contacts without consent are counted as suppressed people');
  assert.equal(audience.people.registeredCustomers, null, 'a list-only audience has no registered-customer total');
  pass('ONLY_CONSENTED_CONTACTS_ARE_ELIGIBLE',
    `eligible=${audience.emailEligible} suppressed=${audience.suppressed}`);

  // ---- 3b. a NEWSLETTER subscriber is reachable ------------------------
  // The storefront's newsletter signup grants the NEWSLETTER purpose, not
  // MARKETING. Judging a subscriber audience against MARKETING suppressed
  // every one of them as NO_CONSENT — found on production, where a New
  // Collection campaign resolved 3 subscribers and could send to none.
  await consentService.record({
    contactKey: NEWSLETTER_EMAIL, channel: 'EMAIL', purpose: 'NEWSLETTER',
    action: 'GRANTED', source: 'FOOTER_NEWSLETTER',
  });
  {
    const [{ marketable: asMarketing }, { marketable: asNewsletter }] = await Promise.all([
      consentService.isMarketable({ contactKey: NEWSLETTER_EMAIL, channel: 'EMAIL', purpose: 'MARKETING' }),
      consentService.isMarketable({ contactKey: NEWSLETTER_EMAIL, channel: 'EMAIL', purpose: 'NEWSLETTER' }),
    ]);
    assert.equal(asMarketing, false, 'a newsletter grant is not a MARKETING grant');
    assert.equal(asNewsletter, true, 'the newsletter grant is held');
    // The service must judge a subscriber-sourced recipient on NEWSLETTER, so
    // this contact is sendable even though MARKETING says no.
    const sendable = await marketingCampaignService.sendTest(campaignId, brand.id, { email: NEWSLETTER_EMAIL });
    const email = sendable.results.find((r) => r.channel === 'EMAIL');
    assert.ok(email?.queued, `a newsletter subscriber must be reachable, got ${JSON.stringify(email)}`);
    assert.equal(email.purpose, 'NEWSLETTER', 'and reached under the permission they actually gave');
    pass('NEWSLETTER_SUBSCRIBER_IS_REACHABLE', 'granted NEWSLETTER, not MARKETING');

    // An offer with no landing page of its own still links somewhere real:
    // production sent "Shop Now" with an empty href.
    const [msg] = await query(
      `SELECT rendered_body FROM communication_messages
        WHERE business_event_id LIKE ? AND recipient_contact_key = ? ORDER BY created_at DESC LIMIT 1`,
      [`${campaignEventPrefix(campaignId)}test:%`, NEWSLETTER_EMAIL]);
    assert.ok(msg, 'the test message was enqueued');
    assert.ok(!/href=""/.test(msg.rendered_body), `no empty link in the message: ${msg.rendered_body}`);
    assert.ok(msg.rendered_body.includes(`href="${storefrontBaseUrl}`), 'the CTA falls back to the storefront');
    pass('OFFER_CTA_NEVER_LINKS_NOWHERE');
  }

  // ---- 3c. a test phone is normalised, a malformed one refused ----------
  // Production: "9319987171" was handed to WhatsApp as typed and rejected as
  // RECIPIENT_INVALID. No consent is held for this number, so nothing is sent;
  // the refusal message names the key the service actually used.
  {
    await marketingCampaignService.update(campaignId, brand.id, { channels: EMAIL_AND_WHATSAPP() });
    const r = await marketingCampaignService.sendTest(campaignId, brand.id, { phone: '60000 00001' });
    const wa = r.results.find((x) => x.channel === 'WHATSAPP');
    assert.ok(wa && !wa.queued && wa.error === 'NO_CONSENT', `expected NO_CONSENT, got ${JSON.stringify(wa)}`);
    assert.ok(wa.message.startsWith('+916000000001 '), `the phone was normalised to E.164: ${wa.message}`);
    await assert.rejects(
      () => marketingCampaignService.sendTest(campaignId, brand.id, { phone: '12345' }),
      (err) => err.code === 'VALIDATION_ERROR',
      'a malformed test phone is refused, not sent');
    await marketingCampaignService.update(campaignId, brand.id, { channels: EMAIL_ONLY });
    pass('TEST_PHONE_IS_NORMALISED');
  }

  // ---- 3d. a New Collection campaign resolves its real collection -------
  // The resolver used to join a table that does not exist and swallow the
  // error, so every New Collection message had no image and an empty link.
  {
    const missing = (await marketingCampaignService.create(brand.id, {
      name: `Verify collection ${tag}`, campaignType: 'NEW_COLLECTION', collectionSlug: `verify-missing-${tag}`,
      channels: [{ channel: 'EMAIL', templateKey: 'marketing.new_collection' }], trigger: { key: 'send_now' },
    })).id;
    try {
      const r = await marketingCampaignService.readiness(missing, brand.id);
      assert.ok(r.blockers.some((b) => b.code === 'COLLECTION_NOT_FOUND'), `unknown collection blocks: ${JSON.stringify(r.blockers)}`);
      const live = (await catalogService.listCollections())[0];
      if (live) {
        await marketingCampaignService.update(missing, brand.id, { collectionSlug: live.slug });
        const ok = await marketingCampaignService.readiness(missing, brand.id);
        assert.ok(!ok.blockers.some((b) => b.code === 'COLLECTION_NOT_FOUND'), `a live collection resolves: ${JSON.stringify(ok.blockers)}`);
        const imageBlocked = ok.blockers.some((b) => b.code === 'COLLECTION_IMAGE_MISSING');
        assert.equal(imageBlocked, !live.thumbnailUrl, 'blocked for a missing picture exactly when the collection has none');
        pass('NEW_COLLECTION_RESOLVES_THE_REAL_COLLECTION', `${live.slug} image=${Boolean(live.thumbnailUrl)}`);
      } else {
        results.NEW_COLLECTION_RESOLVES_THE_REAL_COLLECTION = 'PARTIAL (no active collection; unknown-slug block verified)';
      }
    } finally {
      await query('DELETE FROM marketing_campaigns WHERE id = ?', [missing]);
    }
  }

  // ---- 4. WhatsApp cannot launch on an unapproved Meta template --------
  await marketingCampaignService.update(campaignId, brand.id, { channels: EMAIL_AND_WHATSAPP() });
  const waTemplateId = await ensureTemplate('WHATSAPP', `not_approved_${tag}`);
  const blocked = await marketingCampaignService.readiness(campaignId, brand.id);
  assert.equal(blocked.ready, false, 'an unapproved WhatsApp template blocks the campaign');
  assert.ok(blocked.blockers.some((b) => b.code === 'META_TEMPLATE_NOT_APPROVED'),
    `expected META_TEMPLATE_NOT_APPROVED, got ${JSON.stringify(blocked.blockers)}`);
  await assert.rejects(
    () => marketingCampaignService.activate(campaignId, brand.id),
    (err) => err.code === 'CAMPAIGN_NOT_READY',
    'launching on an unapproved template must be refused',
  );
  pass('UNAPPROVED_META_TEMPLATE_BLOCKS_LAUNCH');

  // ---- 4b. a template SUBMITTED to Meta but still in review is not approved
  // Declaring a variable contract for a template is not the same as Meta
  // having approved it. A contract entry marked pendingApproval must block the
  // launch exactly like an unknown name does — otherwise "submitted" quietly
  // becomes "approved" the moment someone adds the mapping.
  const pending = Object.entries(META_TEMPLATE_CONTRACT).find(([, c]) => c.pendingApproval);
  if (pending) {
    await marketingCampaignService.update(campaignId, brand.id, { channels: EMAIL_AND_WHATSAPP(pending[0]) });
    const r = await marketingCampaignService.readiness(campaignId, brand.id);
    assert.equal(r.ready, false, 'a template awaiting Meta approval cannot be launched on');
    assert.ok(r.blockers.some((b) => b.code === 'META_TEMPLATE_PENDING_APPROVAL'),
      `expected META_TEMPLATE_PENDING_APPROVAL, got ${JSON.stringify(r.blockers)}`);
    await marketingCampaignService.update(campaignId, brand.id, { channels: EMAIL_AND_WHATSAPP() });
    pass('PENDING_META_APPROVAL_IS_NOT_TREATED_AS_APPROVED', pending[0]);
  } else {
    // Every declared template is approved at Meta — nothing to assert, and
    // saying so beats a silent skip.
    console.log('  NOTE  no template is currently marked pendingApproval');
    results.PENDING_META_APPROVAL_IS_NOT_TREATED_AS_APPROVED = 'SKIPPED (no pending template declared)';
  }

  // ---- 4c. a DRAFT row held back for Meta says "awaiting approval" ------
  // With no ACTIVE WhatsApp row at all, readiness used to say "No ACTIVE
  // template", which invites an admin to activate a row Meta has not approved.
  // Only on a row this gate created; an existing ACTIVE row is never touched.
  if (pending && createdTemplateIds.includes(waTemplateId)) {
    const waRow = waTemplateId;
    await query("UPDATE communication_templates SET status = 'DRAFT', provider_template_ref = ? WHERE id = ?", [pending[0], waRow]);
    await marketingCampaignService.update(campaignId, brand.id, { channels: EMAIL_AND_WHATSAPP() });
    const draft = await marketingCampaignService.readiness(campaignId, brand.id);
    const waBlockers = draft.blockers.filter((b) => b.channel === 'WHATSAPP');
    assert.equal(draft.ready, false, 'still blocked');
    assert.ok(waBlockers.some((b) => b.code === 'META_TEMPLATE_PENDING_APPROVAL'),
      `expected META_TEMPLATE_PENDING_APPROVAL, got ${JSON.stringify(waBlockers)}`);
    assert.ok(!waBlockers.some((b) => b.code === 'TEMPLATE_NOT_ACTIVE'), 'no "activate it" message for a template Meta is reviewing');
    pass('DRAFT_PENDING_TEMPLATE_SAYS_AWAITING_META', pending[0]);
  } else {
    results.DRAFT_PENDING_TEMPLATE_SAYS_AWAITING_META = 'SKIPPED (no pending template declared, or an ACTIVE WhatsApp row already exists)';
  }

  // Back to email-only, which is ready.
  await marketingCampaignService.update(campaignId, brand.id, { channels: EMAIL_ONLY });
  const ready = await marketingCampaignService.readiness(campaignId, brand.id);
  assert.equal(ready.ready, true, `expected ready, blockers: ${JSON.stringify(ready.blockers)}`);

  // ---- 5. the snapshot deduplicates across sources ---------------------
  // The same list twice, plus registered users: the UNIQUE key must collapse
  // every repeat into one row per (channel, contact).
  await marketingCampaignService.update(campaignId, brand.id, {
    // The same list twice. Deliberately NOT a subscriber source: that would
    // pull this database's real newsletter subscribers into a verify run and
    // enqueue messages to them. Dedupe is what is under test, and one list
    // named twice exercises it exactly.
    audienceSources: [
      { type: 'LIST', listId },
      { type: 'LIST', listId },
    ],
  });
  // Scheduled: activation only schedules it. The time is then moved into the
  // past (as if the hour had arrived), so the queue pass below proves a
  // scheduled campaign is started by the worker, not by a person.
  await marketingCampaignService.update(campaignId, brand.id, {
    trigger: { key: 'scheduled', scheduledAt: new Date(Date.now() + 3600_000).toISOString() },
  });
  const launched = await marketingCampaignService.activate(campaignId, brand.id);
  assert.equal(launched.status, 'SCHEDULED');
  const [{ n: beforeTime }] = await query('SELECT COUNT(*) AS n FROM marketing_campaign_recipients WHERE campaign_id = ?', [campaignId]);
  assert.equal(Number(beforeTime), 0, 'nothing is snapshotted before the scheduled time');
  await query('UPDATE marketing_campaigns SET scheduled_at = DATE_SUB(NOW(3), INTERVAL 1 SECOND) WHERE id = ?', [campaignId]);

  // ---- 6. batching: one pass sends at most batch_size ------------------
  const firstPass = await marketingCampaignService.runDue({});
  assert.equal(firstPass.started, 1, 'the due scheduled campaign was started by the queue pass');
  const touched = firstPass.queued + firstPass.suppressed + firstPass.failed;
  assert.ok(touched <= 2, `batch_size 2 must cap one pass, ${touched} were processed`);
  const [{ n: snapshotSize }] = await query('SELECT COUNT(*) AS n FROM marketing_campaign_recipients WHERE campaign_id = ?', [campaignId]);
  assert.ok(Number(snapshotSize) >= 3, 'there is more than one batch of work');
  const snapshotRows = await query(
    'SELECT channel, contact_key, COUNT(*) AS n FROM marketing_campaign_recipients WHERE campaign_id = ? GROUP BY channel, contact_key HAVING n > 1',
    [campaignId]);
  assert.equal(snapshotRows.length, 0, 'no contact appears twice in the snapshot');
  pass('SNAPSHOT_DEDUPLICATES_ACROSS_SOURCES', `snapshot=${snapshotSize}`);
  pass('BATCH_SIZE_CAPS_EACH_PASS', `${touched} processed with batchSize=2`);
  const started = await one('SELECT status FROM marketing_campaigns WHERE id = ?', [campaignId]);
  assert.equal(started.status, 'ACTIVE', `a due scheduled campaign is live once started, got ${started.status}`);
  pass('DUE_SCHEDULED_CAMPAIGN_STARTS');

  // ---- 6b. the same campaign cannot run twice for the same trigger -------
  {
    const { marketingCampaignRepository } = await import('../src/modules/marketingCampaigns/repository.js');
    const [run] = await query('SELECT trigger_key FROM campaign_runs WHERE campaign_id = ?', [campaignId]);
    const again = await marketingCampaignRepository.createRun(campaignId, run.trigger_key);
    assert.equal(again.created, false, 'a second run for the same trigger key is refused by the database');
    const [{ n: runs }] = await query('SELECT COUNT(*) AS n FROM campaign_runs WHERE campaign_id = ?', [campaignId]);
    assert.equal(Number(runs), 1, 'exactly one run');
    await assert.rejects(() => marketingCampaignService.activate(campaignId, brand.id),
      (err) => err.code === 'CAMPAIGN_NOT_DRAFT', 'an active campaign cannot be activated again');
    await assert.rejects(() => marketingCampaignService.update(campaignId, brand.id, { name: 'changed' }),
      (err) => err.code === 'CAMPAIGN_NOT_EDITABLE', 'an active campaign cannot be edited without pausing');
    pass('ONE_RUN_PER_TRIGGER_AND_NO_LIVE_EDITS');
  }

  // ---- 7. pause stops the queue, resume restarts it --------------------
  await marketingCampaignService.pause(campaignId, brand.id);
  const whilePaused = await marketingCampaignService.runDue({});
  assert.equal(whilePaused.campaigns, 0, 'a paused campaign is not picked up');
  await marketingCampaignService.resume(campaignId, brand.id);
  pass('PAUSE_STOPS_AND_RESUME_RESTARTS_THE_QUEUE');

  // ---- 8. the background worker drains it, nobody presses anything -----
  // Production had no worker: a launched campaign sat PENDING forever. The
  // real worker runs here on a short interval and this loop only watches.
  stopWorker = startMarketingCampaignWorker({ intervalMs: 250 });
  const drainDeadline = Date.now() + 20_000;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const c = await one('SELECT status FROM marketing_campaigns WHERE id = ?', [campaignId]);
    if (c.status === 'COMPLETED') break;
    assert.ok(Date.now() < drainDeadline, `the worker did not finish the campaign within 20 s (status ${c.status})`);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 250); });
  }
  stopWorker();
  pass('WORKER_DRAINS_CAMPAIGN_WITHOUT_MANUAL_ACTION');
  const states = await query(
    'SELECT state, COUNT(*) AS n FROM marketing_campaign_recipients WHERE campaign_id = ? GROUP BY state', [campaignId]);
  const byState = Object.fromEntries(states.map((s) => [s.state, Number(s.n)]));
  assert.equal(byState.PENDING || 0, 0, 'the queue drained');
  assert.equal(byState.QUEUED || 0, 1, `exactly the one consented contact was queued, got ${byState.QUEUED || 0}`);
  assert.ok((byState.SUPPRESSED || 0) >= 2, 'the contacts without consent were suppressed, not sent');

  // Test sends share the campaign's event prefix, so exclude them: this
  // asserts what the LAUNCH enqueued, not what a tester asked for by hand.
  const messages = await query(
    `SELECT recipient_contact_key, classification, channel FROM communication_messages
      WHERE business_event_id LIKE ? AND business_event_id NOT LIKE ?`,
    [`${campaignEventPrefix(campaignId)}%`, `${campaignEventPrefix(campaignId)}test:%`]);
  assert.equal(messages.length, 1, `one message enqueued, got ${messages.length}`);
  assert.equal(messages[0].recipient_contact_key, CONSENTED_EMAIL, 'and it is for the consented address');
  assert.equal(messages[0].classification, 'MARKETING');
  pass('ONLY_THE_CONSENTED_CONTACT_WAS_ENQUEUED', messages[0].recipient_contact_key);

  // ---- 9. the campaign finished, and the report adds up ----------------
  const finished = await marketingCampaignService.get(campaignId, brand.id);
  assert.equal(finished.status, 'COMPLETED', `expected COMPLETED, got ${finished.status}`);
  assert.equal(finished.runs.length, 1, 'the report lists the run');
  assert.equal(finished.runs[0].status, 'COMPLETED', 'and the run completed');
  assert.ok(finished.report.snapshot.EMAIL, 'the report breaks down by channel');
  assert.ok(finished.report.reasons.length, 'the report says why contacts were suppressed');
  assert.ok(finished.report.delivery.length, 'the report includes engine-side delivery rows');
  pass('CAMPAIGN_COMPLETES_AND_REPORTS');

  // ---- 9a. the audience list is the real recipients and messages ----------
  {
    const list = await marketingCampaignService.recipients(campaignId, brand.id, { page: 1, pageSize: 200 });
    const [{ n: snapshotRows }] = await query('SELECT COUNT(*) AS n FROM marketing_campaign_recipients WHERE campaign_id = ?', [campaignId]);
    assert.equal(list.total, Number(snapshotRows), 'one row per recipient per channel');
    const sent = list.recipients.find((r) => r.to === CONSENTED_EMAIL);
    assert.equal(sent.state, 'QUEUED', 'the consented contact was queued');
    // The source names the list in full (it was silently truncated at 40 chars).
    assert.equal(sent.source, `LIST:${listId}`, `the recipient's source is stored in full: ${sent.source}`);
    const [msg] = await query('SELECT status FROM communication_messages WHERE business_event_id = ?', [`${campaignEventPrefix(campaignId)}${sent.id}`]);
    assert.equal(sent.messageStatus, msg.status, 'its delivery status is the real engine message status');
    const silent = list.recipients.find((r) => r.to === SILENT_EMAIL);
    assert.equal(silent.state, 'SUPPRESSED', 'a contact without consent is listed as not sent');
    assert.ok(silent.stateReason, 'with the reason');
    assert.equal(silent.messageStatus, null, 'and no message exists for it');
    const emailOnly = await marketingCampaignService.recipients(campaignId, brand.id, { channel: 'WHATSAPP' });
    assert.ok(emailOnly.recipients.every((r) => r.channel === 'WHATSAPP'), 'the channel filter applies');
    pass('RECIPIENT_LIST_IS_REAL_PER_CHANNEL', `${list.total} rows`);
  }

  // ---- 9b. a completed campaign is reused by duplicating it --------------
  // A recurring launch: copy last time's campaign, change only the image and
  // link, activate. The original stays a record of what it sent.
  {
    const copy = await marketingCampaignService.duplicate(campaignId, brand.id, null);
    duplicateCampaignId = copy.id;
    assert.equal(copy.status, 'DRAFT', 'the copy is a draft');
    assert.equal(copy.trigger.key, 'send_now', 'a one-off schedule is not copied');
    assert.deepEqual(copy.channels.map((c) => [c.channel, c.templateKey]), finished.channels.map((c) => [c.channel, c.templateKey]), 'channels and templates are copied');
    assert.deepEqual(copy.audience_sources, finished.audience_sources, 'the audience is copied');
    const edited = await marketingCampaignService.update(copy.id, brand.id, { imageUrl: 'https://www.corcotton.in/new.jpg', ctaUrl: 'https://www.corcotton.in/collections/new' });
    assert.equal(edited.image_url, 'https://www.corcotton.in/new.jpg', 'the copy is editable');
    const original = await marketingCampaignService.get(campaignId, brand.id);
    assert.equal(original.status, 'COMPLETED', 'the original is untouched');
    assert.equal(original.image_url, finished.image_url, 'and keeps its own content');
    assert.equal((await marketingCampaignService.readiness(copy.id, brand.id)).ready, true, 'the copy can be activated');
    pass('COMPLETED_CAMPAIGN_IS_REUSED_BY_DUPLICATING');
  }

  // ---- 10. frequency cap: no second campaign within the window -----------
  // Production 2026-09-17: two campaigns 8 minutes apart; Meta accepted the
  // owner's second WhatsApp and never delivered it. The consented contact above
  // was just messaged, so a second campaign to the same list holds them back.
  {
    const { marketingCampaignRepository } = await import('../src/modules/marketingCampaigns/repository.js');
    assert.equal(await marketingCampaignRepository.recentlyMarketed(CONSENTED_EMAIL, 'EMAIL', 24), true, 'the campaign message counts');
    assert.equal(await marketingCampaignRepository.recentlyMarketed(NEWSLETTER_EMAIL, 'EMAIL', 24), false, 'a test send does not count');
    secondCampaignId = (await marketingCampaignService.create(brand.id, {
      name: `Verify second ${tag}`, campaignType: 'SALE_OFFER', offerName: 'Second', offerDetails: 'x',
      channels: EMAIL_ONLY, trigger: { key: 'send_now' }, audienceSources: [{ type: 'LIST', listId }],
    })).id;
    const second = await marketingCampaignService.audiencePreview(secondCampaignId, brand.id);
    assert.equal(second.people.frequencyCapped, 1, `the recently messaged person is held back in preview, got ${JSON.stringify(second.people)}`);
    assert.equal(second.suppressedReasons.FREQUENCY_CAP, 1, 'and the reason is named');
    await marketingCampaignService.activate(secondCampaignId, brand.id);
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const c = await one('SELECT status FROM marketing_campaigns WHERE id = ?', [secondCampaignId]);
      if (c.status === 'COMPLETED') break;
      // eslint-disable-next-line no-await-in-loop
      await marketingCampaignService.runDue({});
    }
    const capped = await one('SELECT state, reason FROM marketing_campaign_recipients WHERE campaign_id = ? AND contact_key = ?', [secondCampaignId, CONSENTED_EMAIL]);
    assert.equal(capped.state, 'SUPPRESSED');
    assert.equal(capped.reason, 'FREQUENCY_CAP');
    const [{ n }] = await query('SELECT COUNT(*) AS n FROM communication_messages WHERE business_event_id LIKE ?', [`${campaignEventPrefix(secondCampaignId)}%`]);
    assert.equal(Number(n), 0, 'nothing was enqueued for the capped person');
    pass('FREQUENCY_CAP_HOLDS_BACK_A_SECOND_CAMPAIGN');
  }

  console.log('\nMarketing campaign — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nMARKETING_CAMPAIGN_VERIFICATION = FAIL');
  console.error(error?.code ? `${error.code}: ${error.message}` : error);
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  stopWorker();
  await cleanup();
  await pool.end();
}
