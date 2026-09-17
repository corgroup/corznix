// verify:consent-default — default-ON marketing for registered customers
// (owner decision, 2026-09-17), and the one rule that makes it acceptable:
// an OFF the customer chose is never switched back on by the system.
//
// Proves against the real database, the real login envelope and the real
// messaging engine (providers forced to MOCK — nothing leaves this machine):
//   1. a customer's verified email and WhatsApp start with MARKETING granted;
//      an unverified contact is not granted;
//   2. turning WhatsApp OFF, then signing in again, leaves WhatsApp OFF and
//      Email ON — channels are independent;
//   3. the baseline job is idempotent and never overrides a decision;
//   4. a marketing message to the OFF channel is SUPPRESSED at send time, while
//      a transactional message to the same address is still sent;
//   5. PENDING_PROFILE customers count as registered in campaign audiences.
process.env.COMMUNICATIONS_EMAIL_PROVIDER_MODE = 'MOCK';
process.env.COMMUNICATIONS_WHATSAPP_PROVIDER_MODE = 'MOCK';

const assert = (await import('node:assert/strict')).default;
const { randomUUID } = await import('node:crypto');
const { pool, query } = await import('../src/database/connection/pool.js');
const { consentService } = await import('../src/modules/consent/service.js');
const { customerPreferencesService } = await import('../src/modules/customers/preferencesService.js');
const { CustomerRepository, CustomerContactRepository } = await import('../src/modules/customers/repositories.js');
const { applyDefaultMarketingAfterSignIn } = await import('../src/modules/consent/loginDefaults.js');
const { communicationService } = await import('../src/modules/communications/service.js');
const { communicationTemplateService } = await import('../src/modules/communications/templateService.js');
const { marketingCampaignRepository } = await import('../src/modules/marketingCampaigns/repository.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const tag = randomUUID().slice(0, 8);
const email = `verify.default.${tag}@example.com`;
const phone = `+9160${String(Date.now()).slice(-8)}`;
const unverifiedEmail = `verify.default.unv.${tag}@example.com`;
const created = { customers: [], templates: [] };

const [brand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
const customers = new CustomerRepository();
const contacts = new CustomerContactRepository();
const marketable = async (key, channel) => (await consentService.isMarketable({ contactKey: key, channel, purpose: 'MARKETING' })).marketable;

try {
  const customer = await customers.create({ firstName: 'Verify', lastName: 'Default', brandId: brand.id });
  created.customers.push(customer.id);
  await contacts.upsert({ customerId: customer.id, contactType: 'EMAIL', value: email, normalizedValue: email, source: 'EMAIL_ONBOARDING', verified: true });
  await contacts.upsert({ customerId: customer.id, contactType: 'PHONE', value: phone, normalizedValue: phone, source: 'WHATSAPP_ONBOARDING', verified: true });
  const other = await customers.create({ firstName: 'Verify', lastName: 'Unverified', brandId: brand.id });
  created.customers.push(other.id);
  await contacts.upsert({ customerId: other.id, contactType: 'EMAIL', value: unverifiedEmail, normalizedValue: unverifiedEmail, source: 'PROFILE', verified: false });

  // 1 — the sign-in hook applies the default (its HTTP wiring is proven by
  // verify:customer-auth and by the static check below).
  const fresh = await customers.findById(customer.id);
  await applyDefaultMarketingAfterSignIn(customer.id);
  assert.equal(await marketable(email, 'EMAIL'), true, 'verified email starts ON');
  assert.equal(await marketable(phone, 'WHATSAPP'), true, 'verified WhatsApp starts ON');
  await applyDefaultMarketingAfterSignIn(other.id);
  assert.equal(await marketable(unverifiedEmail, 'EMAIL'), false, 'an unverified contact is never defaulted on');
  const prefs = await customerPreferencesService.get(customer.id);
  const shown = Object.fromEntries(prefs.channels.filter((c) => c.purpose === 'MARKETING').map((c) => [c.channel, c.granted]));
  assert.deepEqual(shown, { EMAIL: true, WHATSAPP: true }, 'the Preferences page shows the stored ON state');
  const { readFileSync } = await import('node:fs');
  const authController = readFileSync(new URL('../src/modules/auth/controller.js', import.meta.url), 'utf8');
  assert.equal(authController.split('applyDefaultMarketingAfterSignIn(').length - 1, 4, 'OTP, both Google paths and identity link apply the default');
  const authServiceSrc = readFileSync(new URL('../src/modules/auth/service.js', import.meta.url), 'utf8');
  assert.ok(!/consent|marketing/i.test(authServiceSrc), 'auth/service.js stays free of consent logic');
  pass('NEW_CUSTOMER_DEFAULTS_ON_FOR_VERIFIED_CONTACTS');

  // 2 — OFF survives the next login; channels are independent.
  await customerPreferencesService.set({ customerId: customer.id, channel: 'WHATSAPP', purpose: 'MARKETING', granted: false });
  await applyDefaultMarketingAfterSignIn(customer.id);
  await applyDefaultMarketingAfterSignIn(customer.id);
  assert.equal(await marketable(phone, 'WHATSAPP'), false, 'WhatsApp stays OFF after later logins');
  assert.equal(await marketable(email, 'EMAIL'), true, 'Email stays ON');
  pass('EXPLICIT_OFF_SURVIVES_LOGIN', 'WhatsApp OFF, Email ON after two more logins');

  // 3 — baseline never overrides, and is idempotent.
  assert.deepEqual(await consentService.applyDefaultMarketing(customer.id, 'DEFAULT_ON_BASELINE'), [], 'baseline changes nothing for a decided customer');
  assert.equal(await marketable(phone, 'WHATSAPP'), false, 'still OFF after the baseline job');
  // Turning it back ON is the customer's own action, and works.
  await customerPreferencesService.set({ customerId: customer.id, channel: 'WHATSAPP', purpose: 'MARKETING', granted: true });
  assert.equal(await marketable(phone, 'WHATSAPP'), true, 'the customer can turn it back on');
  await customerPreferencesService.set({ customerId: customer.id, channel: 'WHATSAPP', purpose: 'MARKETING', granted: false });
  pass('BASELINE_IS_IDEMPOTENT_AND_NEVER_OVERRIDES');

  // 4 — enforcement at send time, and transactional is untouched.
  const txKey = `verify.default.tx.${tag}`;
  const mkKey = `verify.default.mk.${tag}`;
  for (const [key, classification] of [[txKey, 'TRANSACTIONAL'], [mkKey, 'MARKETING']]) {
    // eslint-disable-next-line no-await-in-loop
    const t = await communicationTemplateService.create({
      templateKey: key, channel: 'WHATSAPP', classification,
      bodyTemplate: 'Hi {{name}}', variableSchema: { name: { required: true, type: 'string' } },
      providerTemplateRef: `verify_${tag}`,
    });
    created.templates.push(key);
    // eslint-disable-next-line no-await-in-loop
    await communicationTemplateService.setStatus({ id: t.id, status: 'ACTIVE' });
  }
  const mk = await communicationService.enqueue({
    businessEventId: `verify-default:${tag}:mk`, policyKey: 'verify.default', classification: 'MARKETING', purpose: 'MARKETING',
    channel: 'WHATSAPP', templateKey: mkKey, recipient: { customerId: customer.id, contactKey: phone }, variables: { name: 'V' },
  });
  const tx = await communicationService.enqueue({
    businessEventId: `verify-default:${tag}:tx`, policyKey: 'verify.default', classification: 'TRANSACTIONAL',
    channel: 'WHATSAPP', templateKey: txKey, recipient: { customerId: customer.id, contactKey: phone }, variables: { name: 'V' },
  });
  for (let i = 0; i < 5; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const [{ n }] = await query("SELECT COUNT(*) AS n FROM communication_messages WHERE id IN (?, ?) AND status IN ('QUEUED','SENDING')", [mk.id, tx.id]);
    if (!Number(n)) break;
    // eslint-disable-next-line no-await-in-loop
    await communicationService.dispatchDue({ limit: 50 });
  }
  const statuses = Object.fromEntries((await query('SELECT id, status FROM communication_messages WHERE id IN (?, ?)', [mk.id, tx.id])).map((r) => [r.id, r.status]));
  assert.equal(statuses[mk.id], 'SUPPRESSED', `marketing to the OFF channel is suppressed at send, got ${statuses[mk.id]}`);
  assert.ok(['SENT', 'DELIVERED'].includes(statuses[tx.id]), `a transactional message to the same number is still sent, got ${statuses[tx.id]}`);
  pass('OFF_BLOCKS_MARKETING_NOT_TRANSACTIONAL');

  // 5 — a customer who never finished their profile is still registered.
  assert.equal(fresh.status, 'PENDING_PROFILE', 'fixture is PENDING_PROFILE');
  const audience = await marketingCampaignRepository.registeredUsers(brand.id, 'ALL');
  assert.ok(audience.some((r) => r.customer_id === customer.id), 'PENDING_PROFILE customers are in the registered audience');
  pass('PENDING_PROFILE_IS_REGISTERED_AUDIENCE');

  console.log('\nConsent default — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nCONSENT_DEFAULT_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  const keys = [email, phone, unverifiedEmail];
  const report = (what) => (e) => console.error(`cleanup ${what}:`, e.message);
  await query("DELETE FROM communication_messages WHERE business_event_id LIKE ?", [`verify-default:${tag}:%`]).catch(report('messages'));
  for (const k of created.templates) {
    // eslint-disable-next-line no-await-in-loop
    await query('DELETE FROM communication_templates WHERE template_key = ?', [k]).catch(report('templates'));
  }
  await query('DELETE FROM marketing_suppressions WHERE contact_key IN (?, ?, ?)', keys).catch(report('suppressions'));
  await query('DELETE FROM consent_state WHERE contact_key IN (?, ?, ?)', keys).catch(report('consent_state'));
  await query('DELETE FROM consent_records WHERE contact_key IN (?, ?, ?)', keys).catch(report('consent_records'));
  if (created.customers.length) {
    const ph = created.customers.map(() => '?').join(',');
    await query(`DELETE FROM audit_logs WHERE customer_id IN (${ph})`, created.customers).catch(report('audit_logs'));
    await query(`DELETE FROM customers WHERE id IN (${ph})`, created.customers).catch(report('customers'));
  }
  await pool.end();
}
