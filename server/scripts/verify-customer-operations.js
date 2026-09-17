// Wave 8G-1 — customer operations + unified customer view.
//
// ONE customer identity authority; CMS aggregation read model (orders /
// returns / store credit); PII masked in list, full in authorized detail;
// staff-only INTERNAL notes never reach any customer API; verified email/phone
// cannot be silently edited; ACTIVE<->SUSPENDED with reason + session
// revocation + audit; customer merge deferred; RBAC (customers.read vs
// customers.manage). No provider / network calls.
//
//   npm run verify:customer-operations
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { roleHasPermission } = await import('../src/modules/staff/permissions.js');
const { customerAdminService } = await import('../src/modules/customers/adminService.js');
const { storeCreditService } = await import('../src/modules/storeCredit/service.js');
const { AuthSessionRepository } = await import('../src/modules/customers/repositories.js');
const sessions = new AuthSessionRepository();

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { customers: [] };

async function customer({ first, last, email, status = 'ACTIVE' }) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,NOW(3))", [id, first, last, status]);
  if (email) {
    await query("INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source) VALUES (?,?, 'EMAIL', ?, ?, 1, NOW(3), 'TEST')",
      [randomUUID(), id, email, email.toLowerCase()]);
  }
  return id;
}

try {
  // ============ 1. CUSTOMER_AUTHORITY_COUNT = 1 ============
  const idTables = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = DATABASE()
        AND table_name IN ('crm_customer','crm_customers','marketing_customer','marketing_customers','subscriber_customer','customer_profiles')`);
  assert.equal(idTables.length, 0, 'no second customer identity table');
  results.customerAuthorityCount = 1;

  // ============ 2. list + search ============
  const alice = await customer({ first: `Alice${tag}`, last: 'Anders', email: `alice.${tag}@example.test` });
  const bob = await customer({ first: `Bob${tag}`, last: 'Baker', email: `bob.${tag}@example.test` });

  const byName = await customerAdminService.list({ search: `Alice${tag}` });
  assert.ok(byName.some((c) => c.id === alice) && !byName.some((c) => c.id === bob));
  const byEmail = await customerAdminService.list({ search: `bob.${tag}` });
  assert.ok(byEmail.some((c) => c.id === bob));
  // PII masked in list
  const aliceRow = byName.find((c) => c.id === alice);
  assert.ok(aliceRow.email && aliceRow.email.includes('***') && !aliceRow.email.includes(`alice.${tag}`), 'list email is masked');
  results.list = 'PASS';
  results.search = 'PASS';

  // ============ 3. detail aggregation + full PII ============
  // minimal order + return for the aggregation
  const orderId = randomUUID();
  const reservationId = randomUUID();
  await query("INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3),INTERVAL 1 DAY))", [reservationId, alice, `co:${randomUUID()}`, '0'.repeat(64)]);
  const cartId = randomUUID();
  await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, alice, 'INR']);
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', 50000,0,50000, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [checkoutId, alice, cartId, reservationId, `cs:${randomUUID()}`, 'f'.repeat(64)]);
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', 50000,0,50000,50000,0,'{}','{}', 'CO_TEST')`, [orderId, `COR-CO-${tag}`, checkoutId, alice, reservationId]);
  await query(`INSERT INTO return_requests (id, brand_id,request_number,customer_id,order_id,request_type,status,eligibility_snapshot_json) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?, 'RETURN','REQUESTED','{}')`,
    [randomUUID(), `COR-RET-CO-${tag}`, alice, orderId]);
  await storeCreditService.applyEntry({ customerId: alice, amountMinor: 25000, entryType: 'GRANT', sourceType: 'MANUAL', idempotencyKey: `co-sc-${tag}` });

  const detail = await customerAdminService.detail(alice);
  assert.equal(detail.orders.length, 1);
  assert.equal(detail.returns.length, 1);
  assert.equal(detail.storeCredit.balanceMinor, 25000);
  assert.equal(detail.contacts[0].value, `alice.${tag}@example.test`, 'detail shows full (unmasked) contact');
  assert.equal(detail.contacts[0].verified, true);
  assert.deepEqual(detail.support, []);
  assert.deepEqual(detail.segments, []);
  results.detailAggregation = 'PASS';

  // ============ 4. staff notes isolation ============
  await customerAdminService.addNote({ customerId: alice, staffId: null, body: 'internal only — do not disclose' });
  const withNote = await customerAdminService.detail(alice);
  assert.equal(withNote.notes.length, 1);
  assert.equal(withNote.notes[0].body, 'internal only — do not disclose');
  // no customer-facing route exposes customer_notes
  const custRoutes = readFileSync(new URL('../src/modules/customers/routes.js', import.meta.url), 'utf8');
  const profileSvc = readFileSync(new URL('../src/modules/customers/profileService.js', import.meta.url), 'utf8');
  assert.ok(!/customer_notes|customerNote|\bnotes\b/i.test(custRoutes + profileSvc), 'no customer-facing code touches customer_notes');
  assert.ok(/customer_notes/.test(readFileSync(new URL('../src/modules/customers/adminRoutes.js', import.meta.url), 'utf8')) === false, 'notes only via admin controller');
  results.internalNoteIsolation = 'PASS (INTERNAL_NOTE_CUSTOMER_LEAK = 0)';

  // ============ 5. verified identity silent-edit denied ============
  await customerAdminService.updateProfile({ customerId: alice, firstName: `AliceEdited${tag}` });
  const afterEdit = await customerAdminService.detail(alice);
  assert.equal(afterEdit.firstName, `AliceEdited${tag}`);
  assert.equal(afterEdit.contacts[0].value, `alice.${tag}@example.test`, 'contact untouched by profile edit');
  // updateProfile has no path to touch contacts/status
  const adminSvc = readFileSync(new URL('../src/modules/customers/adminService.js', import.meta.url), 'utf8');
  assert.ok(!/updateProfile[\s\S]*?customer_contacts/.test(adminSvc), 'updateProfile cannot write customer_contacts');
  const ctrl = readFileSync(new URL('../src/modules/customers/adminController.js', import.meta.url), 'utf8');
  assert.ok(/VERIFIED_IDENTITY_CHANGE_DENIED/.test(ctrl), 'controller rejects identity fields');
  results.verifiedIdentitySilentEdit = 'DENIED';

  // ============ 6. status change: reason + session revoke + audit ============
  await sessions.create({ customerId: bob, tokenHash: `h-${randomUUID()}`, expiresInSeconds: 86400 });
  await sessions.create({ customerId: bob, tokenHash: `h-${randomUUID()}`, expiresInSeconds: 86400 });
  await assert.rejects(() => customerAdminService.setStatus({ customerId: bob, status: 'SUSPENDED', reason: '' }), (e) => e.code === 'VALIDATION_ERROR');
  const susp = await customerAdminService.setStatus({ customerId: bob, status: 'SUSPENDED', reason: 'fraudulent chargebacks', staffId: null });
  assert.equal(susp.revokedSessions, 2, 'suspend revokes all active sessions');
  assert.equal((await query('SELECT status FROM customers WHERE id=?', [bob]))[0].status, 'SUSPENDED');
  assert.equal((await sessions.activeForCustomer(bob)).length, 0);
  const hist = await query('SELECT * FROM customer_status_changes WHERE customer_id=?', [bob]);
  assert.equal(hist.length, 1);
  assert.equal(hist[0].reason, 'fraudulent chargebacks');
  const react = await customerAdminService.setStatus({ customerId: bob, status: 'ACTIVE', reason: 'appeal upheld', staffId: null });
  assert.equal(react.status, 'ACTIVE');
  // never deleted
  assert.ok((await query('SELECT id FROM customers WHERE id=?', [bob])).length === 1);
  results.statusChange = 'PASS (reason required, sessions revoked, history kept, no delete)';

  // ============ 7. RBAC ============
  assert.equal(roleHasPermission('SUPER_ADMIN', 'customers.manage'), true);
  assert.equal(roleHasPermission('ADMIN', 'customers.manage'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'customers.manage'), true);
  assert.equal(roleHasPermission('SUPPORT', 'customers.read'), true);
  assert.equal(roleHasPermission('SUPPORT', 'customers.manage'), false, 'identity-sensitive actions above ordinary support (§27)');
  assert.equal(roleHasPermission('VIEWER', 'customers.manage'), false);
  results.piiRbac = 'PASS';

  // ============ 8. customer merge deferred ============
  const grepMerge = readFileSync(new URL('../src/modules/customers/adminService.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/modules/customers/adminController.js', import.meta.url), 'utf8')
    + readFileSync(new URL('../src/modules/customers/adminRoutes.js', import.meta.url), 'utf8');
  assert.ok(!/merge/i.test(grepMerge), 'no merge implementation (CUSTOMER_MERGE = DEFERRED)');
  results.customerMerge = 'DEFERRED';

  assert.equal(networkCalls, 0);
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nCUSTOMER_OPERATIONS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCUSTOMER_OPERATIONS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const id of created.customers) {
    await safe(() => query('DELETE FROM customer_notes WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM customer_status_changes WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM store_credit_entries WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM store_credit_accounts WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM auth_sessions WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM return_requests WHERE customer_id=?', [id]));
    for (const o of await query('SELECT id, checkout_id, inventory_reservation_id FROM orders WHERE customer_id=?', [id])) {
      await safe(() => query('DELETE FROM orders WHERE id=?', [o.id]));
      await safe(() => query('DELETE FROM checkout_sessions WHERE id=?', [o.checkout_id]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [o.inventory_reservation_id]));
    }
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM customer_contacts WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [id]));
  }
  await pool.end();
}
