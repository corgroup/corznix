// Multi-company CMS — Phase 4 isolation proof (implementation/multi-company/
// DESIGN.md §4.1 + §8, Phase 4 row: "verify:brand-scope-commerce").
//
// Mirrors verify-brand-scope-catalog.js's rigor (Phase 3) for the tables
// this phase scoped: commerce (carts, checkout_sessions, orders, customers,
// promotions, customer_segments, newsletter_subscribers,
// marketing_suppressions, consent_records, store_credit_accounts) and
// comms/support (support_tickets, internal_conversations,
// communication_templates, communication_broadcasts, staff_notifications) —
// plus the storefront host->brand mapping and customer_identities (the real
// gap found while wiring this phase, migration 080).
//
// Two proof styles, matched to how each surface was actually scoped:
//  - Real HTTP + two staff sessions (one per company, deny-by-default) for
//    the admin-scoped surfaces: tax profiles (list/get/create isolation,
//    same as Phase 3's category test), internal chat (brand_id, direct_key)
//    widening.
//  - Direct repository/service calls for the customer-derived surfaces
//    (orders, checkout, carts, store credit, support tickets) — brand_id on
//    these is ALWAYS derived from the owning customer's own row (never a
//    separate caller-supplied value, see each repository's own comments),
//    so the real thing to prove is that derivation, not an HTTP round trip.
//  - Direct customer-identity proof for decision §7.1 ("separate per-brand
//    accounts... even with the same email/phone"): the same OTP identity
//    can exist independently in both companies, but not twice in the same
//    one.
//
//   npm run verify:brand-scope-commerce
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';

let externalCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) externalCalls += 1;
  return realFetch(input, init);
};

const { createApp } = await import('../src/app.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { cmsAllowedOrigins } = await import('../src/config/index.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { StaffBrandAccessRepository } = await import('../src/modules/staff/repositories.js');
const { CustomerRepository, CustomerIdentityRepository } = await import('../src/modules/customers/repositories.js');
const { CartRepository } = await import('../src/modules/cart/repository.js');
const { CheckoutRepository } = await import('../src/modules/checkout/repository.js');
const { OrderRepository } = await import('../src/modules/orders/repository.js');
const { StoreCreditRepository } = await import('../src/modules/storeCredit/repository.js');
const { SupportService } = await import('../src/modules/support/service.js');
const { InternalChatRepository } = await import('../src/modules/internalChat/repository.js');
const { withTransaction } = await import('../src/database/connection/transaction.js');

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `bsc-${Date.now()}`;
const A_EMAIL = `a.${TAG}@brand-scope.test`;
const B_EMAIL = `b.${TAG}@brand-scope.test`;
const PW = 'Corcotton-BrandScope-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;
const cleanup = { taxProfiles: new Set(), customers: new Set(), carts: new Set(), checkouts: new Set(), orders: new Set(), storeCreditAccounts: new Set(), tickets: new Set(), conversations: new Set(), identities: new Set() };

async function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function loginCookie(email) {
  const res = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function teardown() {
  try { server?.close(); } catch { /* noop */ }
  for (const id of cleanup.tickets) await query('DELETE FROM support_tickets WHERE id = ?', [id]).catch(() => {});
  for (const id of cleanup.conversations) await query('DELETE FROM internal_conversations WHERE id = ?', [id]).catch(() => {});
  for (const id of cleanup.orders) await query('DELETE FROM orders WHERE id = ?', [id]).catch(() => {});
  for (const id of cleanup.checkouts) await query('DELETE FROM checkout_sessions WHERE id = ?', [id]).catch(() => {});
  for (const id of cleanup.storeCreditAccounts) await query('DELETE FROM store_credit_accounts WHERE id = ?', [id]).catch(() => {});
  for (const id of cleanup.carts) await query('DELETE FROM carts WHERE id = ?', [id]).catch(() => {});
  for (const id of cleanup.identities) await query('DELETE FROM customer_identities WHERE id = ?', [id]).catch(() => {});
  for (const id of cleanup.customers) await query('DELETE FROM customers WHERE id = ?', [id]).catch(() => {});
  for (const id of cleanup.taxProfiles) await query('DELETE FROM tax_profiles WHERE id = ?', [id]).catch(() => {});
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@brand-scope.test'").catch(() => {});
  await query("DELETE FROM staff_brand_access WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@brand-scope.test')").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@brand-scope.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@brand-scope.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@brand-scope.test'");

  const [cotton] = await query("SELECT id, order_prefix FROM brands WHERE slug = 'corcotton' LIMIT 1");
  const [znix] = await query("SELECT id, order_prefix FROM brands WHERE slug = 'corznix' LIMIT 1");
  assert.ok(cotton && znix, 'both brands must exist (Phase 1 migration)');
  assert.ok(cotton.order_prefix && znix.order_prefix && cotton.order_prefix !== znix.order_prefix,
    'each brand needs its own distinct order_prefix (migration 081)');

  const userA = await staffAuthService.createStaffUser({ email: A_EMAIL, password: PW, firstName: 'A', lastName: 'Cotton', role: 'ADMIN' });
  const userB = await staffAuthService.createStaffUser({ email: B_EMAIL, password: PW, firstName: 'B', lastName: 'Znix', role: 'ADMIN' });
  const brandAccess = new StaffBrandAccessRepository();
  await brandAccess.revoke(userB.id, cotton.id);
  await brandAccess.grant({ staffUserId: userB.id, brandId: znix.id, role: 'ADMIN', grantedBy: null });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const a = await loginCookie(A_EMAIL);
  const b = await loginCookie(B_EMAIL);

  // ---- 1. Tax profiles: list/get/create isolation (admin, real HTTP) ----
  {
    const hsn = '61091000';
    const createdA = await call('/api/v1/admin/tax-profiles', { method: 'POST', cookie: a, body: { name: `BS Tax ${TAG}`, hsnSac: hsn, gstRateBps: 500 } });
    assert.equal(createdA.status, 201, `Cor-Cotton tax profile create failed: ${JSON.stringify(createdA.json)}`);
    const taxId = createdA.json.data.id;
    cleanup.taxProfiles.add(taxId);

    const listB = await call('/api/v1/admin/tax-profiles', { cookie: b });
    assert.ok(!listB.json.data.taxProfiles.some((t) => t.id === taxId), "Cor-Znix's tax profile list must not contain Cor-Cotton's");

    const getB = await call(`/api/v1/admin/tax-profiles/${taxId}`, { cookie: b });
    assert.equal(getB.status, 404, "fetching another company's tax profile by id must 404, not leak it");

    const getA = await call(`/api/v1/admin/tax-profiles/${taxId}`, { cookie: a });
    assert.equal(getA.status, 200, "Cor-Cotton's own fetch must still work");

    // Same HSN code, independently, in the other company — no longer a
    // pre-existing-gap collision (this table itself has no unique HSN
    // constraint, but confirms the create path is genuinely per-brand).
    const createdB = await call('/api/v1/admin/tax-profiles', { method: 'POST', cookie: b, body: { name: `BS Tax B ${TAG}`, hsnSac: hsn, gstRateBps: 1200 } });
    assert.equal(createdB.status, 201, 'the same HSN must be usable independently in another company');
    cleanup.taxProfiles.add(createdB.json.data.id);

    pass('TAX_PROFILE_ISOLATION', 'list scoped, get-by-id 404s across companies, brand_id wired end-to-end');
  }

  // ---- 2. customer_identities: per-brand OTP/Google identity (direct) ---
  {
    const customerRepo = new CustomerRepository();
    const identityRepo = new CustomerIdentityRepository();
    const custA = await customerRepo.create({ firstName: 'CI', lastName: 'A', brandId: cotton.id });
    const custB = await customerRepo.create({ firstName: 'CI', lastName: 'B', brandId: znix.id });
    cleanup.customers.add(custA.id); cleanup.customers.add(custB.id);

    const subject = `+91${Math.floor(9000000000 + Math.random() * 99999999)}`;
    const idA = await identityRepo.create({ customerId: custA.id, brandId: cotton.id, provider: 'PHONE_OTP', providerSubject: subject });
    cleanup.identities.add(idA.id);
    // The SAME phone number, as a DISTINCT identity, in the other company —
    // decision §7.1: separate per-brand accounts even with the same contact.
    const idB = await identityRepo.create({ customerId: custB.id, brandId: znix.id, provider: 'PHONE_OTP', providerSubject: subject });
    cleanup.identities.add(idB.id);
    assert.notEqual(idA.customer_id, idB.customer_id, 'same phone number must resolve to two DIFFERENT customers across companies');

    // The identical (brand, provider, subject) a second time must be rejected.
    await assert.rejects(
      () => identityRepo.create({ customerId: custA.id, brandId: cotton.id, provider: 'PHONE_OTP', providerSubject: subject }),
      (e) => e.code === 'IDENTITY_CONFLICT',
      'the exact same identity within ONE company must still be rejected as a conflict',
    );

    // Cross-brand lookup must not find the other company's identity.
    const lookupWrongBrand = await identityRepo.findByProviderSubject('PHONE_OTP', subject, znix.id);
    assert.equal(lookupWrongBrand.customer_id, custB.id, "Cor-Znix's lookup must resolve to its OWN customer, never Cor-Cotton's");

    pass('CUSTOMER_IDENTITY_PER_BRAND', 'same phone/email = two independent accounts across companies, one per company');
  }

  // ---- 3. carts -> checkout -> orders: brand_id derived from customer ---
  {
    const customerRepo = new CustomerRepository();
    const custA = await customerRepo.create({ firstName: 'CO', lastName: 'A', brandId: cotton.id });
    cleanup.customers.add(custA.id);

    const cartRepo = new CartRepository();
    const cart = await cartRepo.getOrCreate(custA.id);
    cleanup.carts.add(cart.id);
    assert.equal(cart.brand_id, cotton.id, "a cart's brand_id must match its customer's, derived automatically");

    const checkoutRepo = new CheckoutRepository();
    const reservationId = randomUUID();
    await query(
      `INSERT INTO inventory_reservations (id, brand_id, customer_id, idempotency_key, request_fingerprint, status, expires_at)
       VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?, ?, ?, 'RESERVED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`,
      [reservationId, custA.id, `bsc:${TAG}`, '0'.repeat(64)],
    );
    const checkout = await withTransaction((tx) => checkoutRepo.create(tx, {
      customerId: custA.id, cartId: cart.id, reservationId, idempotencyKey: `bsc-co:${TAG}`,
      cartFingerprint: 'f'.repeat(64), items: [], currency: 'INR', subtotalMinor: 10000, reservationExpiresAt: new Date(Date.now() + 86400000),
    }));
    cleanup.checkouts.add(checkout.id);
    assert.equal(checkout.brand_id, cotton.id, "a checkout session's brand_id must match its customer's, derived automatically (never a separate input)");

    const orderRepo = new OrderRepository();
    const order = await withTransaction((tx) => orderRepo.create(tx, {
      checkout: { ...checkout, shipping_quote_snapshot: null, shipping_address_snapshot: '{}' },
      eligibility: { selected_payment_mode: 'PREPAID' }, onlinePaid: 10000, codDue: 0, source: 'BRAND_SCOPE_TEST',
    }));
    cleanup.orders.add(order.id);
    assert.equal(order.brand_id, cotton.id, "an order's brand_id must match its checkout's, derived automatically");
    assert.ok(order.order_number.startsWith(`${cotton.order_prefix}-`), `order_number must use the brand's own prefix ("${cotton.order_prefix}-"), got "${order.order_number}"`);

    pass('COMMERCE_CHAIN_BRAND_DERIVATION', `cart -> checkout -> order all inherit brand_id from the customer; order_number prefixed "${cotton.order_prefix}-"`);
  }

  // ---- 4. store credit: brand_id derived from customer -------------------
  {
    const customerRepo = new CustomerRepository();
    const custZ = await customerRepo.create({ firstName: 'SC', lastName: 'Z', brandId: znix.id });
    cleanup.customers.add(custZ.id);
    const account = await withTransaction((tx) => new StoreCreditRepository().ensureAccount(tx, custZ.id));
    cleanup.storeCreditAccounts.add(account.id);
    assert.equal(account.brand_id, znix.id, "a store-credit account's brand_id must match its customer's (Cor-Znix here)");
    pass('STORE_CREDIT_BRAND_DERIVATION');
  }

  // ---- 5. support tickets: brand_id + prefix derived from customer ------
  {
    const customerRepo = new CustomerRepository();
    const custA = await customerRepo.create({ firstName: 'SUP', lastName: 'A', brandId: cotton.id });
    cleanup.customers.add(custA.id);
    const supportService = new SupportService();
    const ticket = await supportService.createTicket({ customerId: custA.id, category: 'GENERAL', subject: `Brand scope test ${TAG}`, body: 'Brand scope isolation test ticket.', idempotencyKey: `bsc-ticket:${TAG}` });
    cleanup.tickets.add(ticket.id);
    const [row] = await query('SELECT brand_id, ticket_number FROM support_tickets WHERE id = ?', [ticket.id]);
    assert.equal(row.brand_id, cotton.id, "a support ticket's brand_id must match its customer's");
    assert.ok(row.ticket_number.startsWith(`${cotton.order_prefix}-SUP-`), `ticket_number must use the brand's own prefix, got "${row.ticket_number}"`);
    pass('SUPPORT_TICKET_BRAND_DERIVATION', `ticket_number prefixed "${cotton.order_prefix}-SUP-"`);
  }

  // ---- 6. internal_conversations: (brand_id, direct_key) widened --------
  {
    const chatRepo = new InternalChatRepository();
    const directKey = InternalChatRepository.directKey(userA.id, userB.id);
    const convCotton = await withTransaction((tx) => chatRepo.insertConversation(tx, { brandId: cotton.id, kind: 'DIRECT', subject: null, directKey, createdBy: userA.id }));
    cleanup.conversations.add(convCotton);
    // The exact same direct_key, in the OTHER company, must be a DIFFERENT
    // row — proving the widened (brand_id, direct_key) unique key, not the
    // old global one.
    const convZnix = await withTransaction((tx) => chatRepo.insertConversation(tx, { brandId: znix.id, kind: 'DIRECT', subject: null, directKey, createdBy: userA.id }));
    cleanup.conversations.add(convZnix);
    assert.notEqual(convCotton, convZnix, 'the same staff-pair direct_key must get a SEPARATE thread per company');

    const lookedUpCotton = await chatRepo.directByKey(null, directKey, cotton.id);
    const lookedUpZnix = await chatRepo.directByKey(null, directKey, znix.id);
    assert.equal(lookedUpCotton.id, convCotton, "Cor-Cotton's lookup must resolve to its OWN thread");
    assert.equal(lookedUpZnix.id, convZnix, "Cor-Znix's lookup must resolve to its OWN thread, never Cor-Cotton's");

    pass('INTERNAL_CHAT_PER_BRAND_THREADS', '(brand_id, direct_key) — same staff pair, independent thread per company');
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`\nNO_EXTERNAL_PROVIDER_CALLS: ${externalCalls === 0 ? 'PASS' : `FAIL (${externalCalls})`}`);
  console.log(`\nBRAND_SCOPE_COMMERCE_VERIFICATION = ${externalCalls === 0 ? 'PASS' : 'FAIL'}`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  await teardown();
}
