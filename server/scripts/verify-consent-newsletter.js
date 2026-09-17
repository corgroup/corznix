// Wave 8G-2 — consent + newsletter / subscribers.
//
// Channel + purpose aware append-only consent ledger with a monotonic seq
// (deterministic latest-wins under a grant/revoke race); anonymous newsletter
// subscribers (no customer account); dedupe; unsubscribe -> consent REVOKE +
// marketing suppression; resubscribe; subscriber<->customer linking; auth OTP
// never coupled to marketing consent. No provider / network calls.
//
//   npm run verify:consent-newsletter
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { consentService } = await import('../src/modules/consent/service.js');
const { newsletterService } = await import('../src/modules/newsletter/service.js');
const { customerPreferencesService } = await import('../src/modules/customers/preferencesService.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { customers: [], emails: [], phones: [] };
const email = (name) => { const e = `${name}.${tag}@example.test`; created.emails.push(e.toLowerCase()); return e; };

async function customer({ email: em }) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), 'C','T','ACTIVE',NOW(3))", [id]);
  if (em) await query("INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source) VALUES (?,?, 'EMAIL', ?, ?, 1, NOW(3), 'TEST')", [randomUUID(), id, em, em.toLowerCase()]);
  return id;
}

try {
  // ============ 1. channel + purpose separation ============
  const k1 = email('sep');
  const cid = await customer({ email: k1 });
  await consentService.record({ contactKey: k1, channel: 'EMAIL', purpose: 'MARKETING', action: 'GRANTED', source: 'ACCOUNT_SETTINGS', customerId: cid });
  assert.equal((await consentService.effective({ contactKey: k1, channel: 'EMAIL', purpose: 'MARKETING' })).granted, true);
  assert.equal((await consentService.effective({ contactKey: k1, channel: 'EMAIL', purpose: 'NEWSLETTER' })).granted, false, 'purpose separation');
  assert.equal((await consentService.effective({ contactKey: '919812345678', channel: 'WHATSAPP', purpose: 'MARKETING' })).granted, false, 'channel separation');
  const hist1 = await consentService.history({ contactKey: k1.toLowerCase() });
  assert.equal(hist1.length, 1);
  results.consentLedger = 'PASS';
  results.channelAware = 'PASS';
  results.purposeAware = 'PASS';

  // ============ 2. deterministic latest-wins ============
  await consentService.record({ contactKey: k1, channel: 'EMAIL', purpose: 'MARKETING', action: 'REVOKED', source: 'ACCOUNT_SETTINGS', customerId: cid });
  assert.equal((await consentService.effective({ contactKey: k1, channel: 'EMAIL', purpose: 'MARKETING' })).granted, false);
  await consentService.record({ contactKey: k1, channel: 'EMAIL', purpose: 'MARKETING', action: 'GRANTED', source: 'ACCOUNT_SETTINGS', customerId: cid });
  assert.equal((await consentService.effective({ contactKey: k1, channel: 'EMAIL', purpose: 'MARKETING' })).granted, true);
  const seqs = (await consentService.history({ contactKey: k1.toLowerCase() })).map((r) => Number(r.seq));
  assert.ok(seqs[0] > seqs[seqs.length - 1], 'seq is monotonic');
  results.latestWins = 'PASS';

  // ============ 3. grant/revoke race — no contradiction ============
  for (let i = 0; i < 5; i += 1) {
    const rk = email(`race${i}`);
    await Promise.all([
      consentService.record({ contactKey: rk, channel: 'EMAIL', purpose: 'MARKETING', action: 'GRANTED', source: 'ACCOUNT_SETTINGS' }),
      consentService.record({ contactKey: rk, channel: 'EMAIL', purpose: 'MARKETING', action: 'REVOKED', source: 'UNSUBSCRIBE_LINK' }),
    ]);
    const state = (await query('SELECT * FROM consent_state WHERE contact_key=? AND channel=? AND purpose=?', [rk.toLowerCase(), 'EMAIL', 'MARKETING']))[0];
    const recs = await query('SELECT seq, action FROM consent_records WHERE contact_key=? ORDER BY seq DESC', [rk.toLowerCase()]);
    assert.equal(recs.length, 2, 'both events recorded');
    assert.equal(state.effective_action, recs[0].action, 'effective state matches the highest-seq event');
    assert.equal(Number(state.source_seq), Number(recs[0].seq));
  }
  results.grantRevokeRace = 'PASS (deterministic, no contradiction)';

  // ============ 4. AUTH_CONSENT_COUPLING = 0 ============
  const authService = readFileSync(new URL('../src/modules/auth/service.js', import.meta.url), 'utf8');
  const otpProviders = readFileSync(new URL('../src/modules/auth/otpProviders.js', import.meta.url), 'utf8');
  assert.ok(!/consent|suppress|marketing|newsletter/i.test(authService + otpProviders), 'auth OTP path has no consent/marketing coupling');
  results.authConsentCoupling = 0;

  // ============ 5-6. newsletter subscribe + dedupe ============
  const ne = email('news');
  const s1 = await newsletterService.subscribe({ email: ne, source: 'FOOTER_NEWSLETTER' });
  assert.equal(s1.status, 'SUBSCRIBED');
  assert.equal((await consentService.effective({ contactKey: ne, channel: 'EMAIL', purpose: 'NEWSLETTER' })).granted, true);
  const s2 = await newsletterService.subscribe({ email: ` ${ne.toUpperCase()} `, source: 'CHECKOUT' });
  assert.equal(s2.id, s1.id, 'case/whitespace-insensitive dedupe');
  const race = await Promise.allSettled(Array.from({ length: 4 }, () => newsletterService.subscribe({ email: email('conc'), source: 'FOOTER_NEWSLETTER' })));
  void race;
  const concRows = await query("SELECT COUNT(*) c FROM newsletter_subscribers WHERE normalized_email LIKE ?", [`conc.${tag}%`]);
  // Grouped by the table's ACTUAL uniqueness rule (channel + contact), not by
  // normalized_email. A WhatsApp row has no email, and MySQL groups every NULL
  // together — so on the old assertion any two WhatsApp subscribers looked
  // like duplicates of one another. Same NULL-grouping trap as the orders
  // duplicate check, which had the same fix.
  const dupCheck = await query(
    'SELECT channel, normalized_contact, COUNT(*) c FROM newsletter_subscribers GROUP BY channel, normalized_contact HAVING c > 1');
  assert.equal(dupCheck.length, 0, 'DUPLICATE_NEWSLETTER_SUBSCRIBERS = 0');
  void concRows;
  results.newsletter = 'PASS';
  results.duplicateSubscribers = 0;

  // ============ 6b. WhatsApp is a first-class subscription channel ========
  // The table was email-only until migration 102 (normalized_email NOT NULL,
  // unique on brand+email), so a WhatsApp opt-in could not be recorded at all
  // even though the consent ledger has always modelled the channel.
  {
    const phone = `+9198765${String(Date.now()).slice(-5)}`;
    created.phones.push(phone);
    const w1 = await newsletterService.subscribe({ phone, channel: 'WHATSAPP', source: 'PROMOTION_FORM' });
    assert.equal(w1.status, 'SUBSCRIBED');
    assert.equal(w1.channel, 'WHATSAPP');
    assert.equal(w1.contact, phone, 'the contact is the normalised number');
    assert.equal(w1.email, null, 'a WhatsApp row carries no email');

    // The ledger must say WHATSAPP, not mislabel it EMAIL.
    assert.equal((await consentService.effective({ contactKey: phone, channel: 'WHATSAPP', purpose: 'NEWSLETTER' })).granted, true);
    assert.equal((await consentService.effective({ contactKey: phone, channel: 'EMAIL', purpose: 'NEWSLETTER' })).granted, false,
      'granting WhatsApp must not imply email consent');

    // Idempotent on its own channel, and unformatted input normalises to it.
    const w2 = await newsletterService.subscribe({ phone: phone.replace('+91', ''), channel: 'WHATSAPP', source: 'PROMOTION_FORM' });
    assert.equal(w2.id, w1.id, 'a repeat WhatsApp signup dedupes onto the same row');

    // The same person may hold BOTH channels — the unique key is per channel.
    const dual = email('dual');
    const e1 = await newsletterService.subscribe({ email: dual, source: 'PROMOTION_FORM' });
    const p2 = `+9199999${String(Date.now()).slice(-5)}`;
    created.phones.push(p2);
    const e2 = await newsletterService.subscribe({ phone: p2, channel: 'WHATSAPP', source: 'PROMOTION_FORM' });
    assert.notEqual(e1.id, e2.id, 'email and WhatsApp subscriptions are separate rows');

    // A WhatsApp request without a number is refused rather than stored blank.
    await assert.rejects(
      () => newsletterService.subscribe({ channel: 'WHATSAPP', source: 'PROMOTION_FORM' }),
      (err) => err.code === 'VALIDATION_ERROR');

    // The CMS list renders this as "Since"; it was missing from the DTO, so
    // every row showed "Invalid Date".
    assert.ok(w1.createdAt, 'the DTO must expose createdAt for the CMS list');

    // The CMS opens a subscriber from this list. detail() used to key its
    // consent history off normalized_email, which is NULL for a WhatsApp row —
    // so the one channel that most needs an auditable opt-in showed none.
    const wDetail = await newsletterService.detail(w1.id);
    assert.ok(wDetail.consentHistory.length > 0, 'a WhatsApp subscriber must have a visible consent history');
    assert.equal(wDetail.consentHistory[0].channel, 'WHATSAPP');

    results.whatsappChannel = 'PASS (subscribes, dedupes per channel, ledger says WHATSAPP)';
  }

  // ============ 7-9. unsubscribe -> suppression -> resubscribe ============
  const un = await newsletterService.unsubscribe({ email: ne, source: 'UNSUBSCRIBE_LINK' });
  assert.equal(un.status, 'UNSUBSCRIBED');
  assert.equal((await consentService.effective({ contactKey: ne, channel: 'EMAIL', purpose: 'NEWSLETTER' })).granted, false);
  const supp = await query("SELECT * FROM marketing_suppressions WHERE contact_key=? AND released_at IS NULL", [ne.toLowerCase()]);
  assert.equal(supp.length, 1);
  assert.equal(supp[0].reason, 'CONSENT_REVOKED');
  assert.equal((await consentService.isMarketable({ contactKey: ne, channel: 'EMAIL', purpose: 'NEWSLETTER' })).marketable, false);
  // history preserved
  assert.ok((await consentService.history({ contactKey: ne.toLowerCase() })).some((r) => r.action === 'GRANTED'), 'GRANT history kept after unsubscribe');
  results.unsubscribe = 'PASS';

  const re = await newsletterService.subscribe({ email: ne, source: 'ACCOUNT_SETTINGS' });
  assert.equal(re.status, 'SUBSCRIBED');
  assert.equal((await consentService.isMarketable({ contactKey: ne, channel: 'EMAIL', purpose: 'NEWSLETTER' })).marketable, true, 'resubscribe releases the consent-revoked suppression');
  // staff hard-bounce suppression still blocks
  await consentService.suppress({ contactKey: ne, channel: 'EMAIL', reason: 'HARD_BOUNCE', staffId: null });
  assert.equal((await consentService.isMarketable({ contactKey: ne, channel: 'EMAIL', purpose: 'NEWSLETTER' })).marketable, false);
  await consentService.releaseSuppression({ contactKey: ne, channel: 'EMAIL', reason: 'HARD_BOUNCE' });
  assert.equal((await consentService.isMarketable({ contactKey: ne, channel: 'EMAIL', purpose: 'NEWSLETTER' })).marketable, true);
  results.suppression = 'PASS';

  // ============ 10. subscriber <-> customer linking ============
  const linkEmail = email('link');
  await newsletterService.subscribe({ email: linkEmail, source: 'FOOTER_NEWSLETTER' }); // anonymous
  const beforeCount = Number((await query('SELECT COUNT(*) c FROM customers'))[0].c);
  const linkedCustomer = await customer({ email: linkEmail });
  await newsletterService.linkVerifiedCustomerEmail(linkedCustomer, linkEmail.toLowerCase());
  const linkedRow = await query('SELECT customer_id FROM newsletter_subscribers WHERE normalized_email=?', [linkEmail.toLowerCase()]);
  assert.equal(linkedRow[0].customer_id, linkedCustomer, 'anonymous subscriber linked to verified customer');
  assert.equal(Number((await query('SELECT COUNT(*) c FROM customers'))[0].c), beforeCount + 1, 'linking created no extra customer beyond the one we made');
  results.subscriberCustomerLinking = 'PASS';

  // ============ 11. double opt-in policy ============
  results.doubleOptInPolicy = await newsletterService.doubleOptInPolicy();
  assert.equal(results.doubleOptInPolicy, 'SINGLE_OPT_IN');

  // ============ 12. account preferences ============
  const prefCustomer = await customer({ email: email('pref') });
  const prefEmail = (await query("SELECT normalized_value FROM customer_contacts WHERE customer_id=?", [prefCustomer]))[0].normalized_value;
  await customerPreferencesService.set({ customerId: prefCustomer, channel: 'EMAIL', purpose: 'MARKETING', granted: true });
  const prefs = await customerPreferencesService.get(prefCustomer);
  assert.ok(prefs.channels.some((c) => c.channel === 'EMAIL' && c.purpose === 'MARKETING' && c.granted));
  await customerPreferencesService.set({ customerId: prefCustomer, channel: 'EMAIL', purpose: 'MARKETING', granted: false });
  assert.equal((await consentService.effective({ contactKey: prefEmail, channel: 'EMAIL', purpose: 'MARKETING' })).granted, false);
  results.accountPreferences = 'PASS';

  // ============ 13. checkout newsletter checkbox ============
  // The checkbox on the checkout page used to send purpose MARKETING, which
  // takes the plain-consent branch: it recorded a consent row and NO
  // newsletter_subscribers row, so a customer who ticked it never appeared on
  // the Subscribers list and could not be mailed. It also stamped every
  // consent ACCOUNT_SETTINGS, so a checkout opt-in was indistinguishable from
  // one made on the account page.
  const coCustomer = await customer({ email: email('checkout') });
  const coEmail = (await query('SELECT normalized_value FROM customer_contacts WHERE customer_id=?', [coCustomer]))[0].normalized_value;
  const CHECKBOX = { channel: 'EMAIL', purpose: 'NEWSLETTER', source: 'CHECKOUT' };

  await customerPreferencesService.set({ customerId: coCustomer, ...CHECKBOX, granted: true });
  const coRows = await query('SELECT channel, source, status, customer_id FROM newsletter_subscribers WHERE normalized_contact=?', [coEmail]);
  assert.equal(coRows.length, 1, 'ticking the checkout box must create exactly one subscriber');
  assert.equal(coRows[0].channel, 'EMAIL');
  assert.equal(coRows[0].source, 'CHECKOUT', 'the row must say the subscription came from checkout');
  assert.equal(coRows[0].customer_id, coCustomer, 'and be linked to the customer who ticked it');
  const coConsent = await consentService.history({ contactKey: coEmail });
  assert.equal(coConsent[0].channel, 'EMAIL');
  assert.equal(coConsent[0].purpose, 'NEWSLETTER');
  assert.equal(coConsent[0].action, 'GRANTED');
  assert.equal(coConsent[0].source, 'CHECKOUT', 'the ledger must carry the checkout source too');
  const coLedger = await query('SELECT subscriber_id FROM consent_records WHERE contact_key=? ORDER BY seq DESC LIMIT 1', [coEmail]);
  assert.ok(coLedger[0].subscriber_id, 'the consent record points at the subscriber row');
  // The CMS list is what marketing reads — the row has to reach it, dated.
  const coListed = (await newsletterService.list({})).find((r) => r.contact === coEmail);
  assert.ok(coListed && coListed.source === 'CHECKOUT' && coListed.createdAt, 'checkout subscriber is listed with source and date');

  // Re-submitting the same checkout (or a second order) must not duplicate.
  await customerPreferencesService.set({ customerId: coCustomer, ...CHECKBOX, granted: true });
  assert.equal((await query('SELECT id FROM newsletter_subscribers WHERE normalized_contact=?', [coEmail])).length, 1, 'no duplicate subscriber');

  // Unticking withdraws consent through the same subscriber row.
  await customerPreferencesService.set({ customerId: coCustomer, ...CHECKBOX, granted: false });
  assert.equal((await query('SELECT status FROM newsletter_subscribers WHERE normalized_contact=?', [coEmail]))[0].status, 'UNSUBSCRIBED');
  assert.equal((await consentService.isMarketable({ contactKey: coEmail, channel: 'EMAIL', purpose: 'NEWSLETTER' })).marketable, false);

  // Unticking a box that was never ticked is not an error, and the refusal is
  // still recorded — there is simply no subscription to end.
  const neverCustomer = await customer({ email: email('never') });
  const neverEmail = (await query('SELECT normalized_value FROM customer_contacts WHERE customer_id=?', [neverCustomer]))[0].normalized_value;
  await customerPreferencesService.set({ customerId: neverCustomer, ...CHECKBOX, granted: false });
  assert.equal((await query('SELECT id FROM newsletter_subscribers WHERE normalized_contact=?', [neverEmail])).length, 0);
  assert.equal((await consentService.history({ contactKey: neverEmail }))[0].action, 'REVOKED');

  // A caller cannot invent a source the ledger's CHECK constraint would reject.
  await assert.rejects(
    () => customerPreferencesService.set({ customerId: neverCustomer, channel: 'EMAIL', purpose: 'NEWSLETTER', granted: true, source: 'ELSEWHERE' }),
    (err) => err.code === 'VALIDATION_ERROR');
  results.checkoutNewsletterCheckbox = 'PASS (subscriber created, source CHECKOUT, deduped, revocable)';

  assert.equal(networkCalls, 0);
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nCONSENT_NEWSLETTER_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONSENT_NEWSLETTER_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query(`DELETE FROM consent_records WHERE contact_key LIKE ?`, [`%${tag}%`]));
  await safe(() => query(`DELETE FROM consent_state WHERE contact_key LIKE ?`, [`%${tag}%`]));
  await safe(() => query(`DELETE FROM marketing_suppressions WHERE contact_key LIKE ?`, [`%${tag}%`]));
  await safe(() => query(`DELETE FROM newsletter_subscribers WHERE normalized_contact LIKE ?`, [`%${tag}%`]));
  // The WhatsApp rows are keyed by phone number, which cannot carry the tag, so
  // the LIKE sweep above never matched them: every run left two subscribers and
  // their consent rows behind. They are removed by the exact numbers used.
  for (const phone of created.phones) {
    await safe(() => query('DELETE FROM consent_records WHERE contact_key=?', [phone]));
    await safe(() => query('DELETE FROM consent_state WHERE contact_key=?', [phone]));
    await safe(() => query('DELETE FROM marketing_suppressions WHERE contact_key=?', [phone]));
    await safe(() => query('DELETE FROM newsletter_subscribers WHERE normalized_contact=?', [phone]));
  }
  for (const id of created.customers) {
    await safe(() => query('DELETE FROM customer_contacts WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [id]));
  }
  await pool.end();
}
