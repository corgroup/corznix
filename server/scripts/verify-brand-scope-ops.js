// Multi-company CMS — Phase 5 isolation proof (implementation/multi-company/
// DESIGN.md §4.1 + §8, Phase 5 row: "verify:brand-scope-ops").
//
// Mirrors Phase 3's verify-brand-scope-catalog.js and Phase 4's
// verify-brand-scope-commerce.js for the surfaces THIS phase scoped:
// operations (warehouses + everything hanging off warehouse_id: inventory,
// fulfillments, shipments, print stations/printers) and documents (invoices,
// credit notes, document_counters) — plus the company-scoped permissions
// mechanism (role + permission_overrides_json) that went live this phase,
// and the company_profiles legal-identity fix (the real "COR-Znix invoices
// would have used Cor-Cotton's own GSTIN" bug found and fixed this phase).
//
// Cor-Znix has no products/warehouses/orders of its own yet (that's Phase
// 7's onboarding) — order/ticket_number cross-brand prefixing was already
// proven end-to-end in Phase 4's verify-brand-scope-commerce.js. What THIS
// script proves instead, for the surfaces that genuinely are usable today
// without a live Cor-Znix commerce chain:
//  - Warehouse isolation: real HTTP + two staff sessions, one per company
//    (same deny-by-default style as Phase 3/4) — list/get-by-id/create,
//    cross-brand 404, (brand_id, code) independence.
//  - Company-scoped permissions: ONE staff member, granted BOTH companies,
//    with a permission override applied to only ONE of the two grants —
//    proves resolveEffectivePermissions() actually changes what the SAME
//    person can do depending on which company their session is switched
//    to, not just that two different logins see different things.
//  - company_profiles legal identity: Cor-Cotton's profile carries its real
//    GSTIN; Cor-Znix's is genuinely its own (currently blank) row, not a
//    read of Cor-Cotton's.
//  - document_counters + invoice/credit-note number prefix: each brand's
//    sequence is independent (Cor-Znix starts at 1 even after Cor-Cotton's
//    counter has advanced) and uses that brand's own order_prefix, proven
//    by calling the real nextNumber() generator directly with a disposable
//    counter name.
//
//   npm run verify:brand-scope-ops
import assert from 'node:assert/strict';

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
const { companyService } = await import('../src/modules/company/service.js');
const { documentRepository } = await import('../src/modules/documents/repository.js');
const { withTransaction } = await import('../src/database/connection/transaction.js');

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `bso-${Date.now()}`;
const A_EMAIL = `a.${TAG}@brand-scope.test`; // Cor-Cotton only
const B_EMAIL = `b.${TAG}@brand-scope.test`; // Cor-Znix only
const C_EMAIL = `c.${TAG}@brand-scope.test`; // both companies, override on Znix only
const PW = 'Corcotton-BrandScope-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;
const cleanup = { warehouses: new Set() };

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
  for (const id of cleanup.warehouses) await query('DELETE FROM warehouses WHERE id = ?', [id]).catch(() => {});
  await query("DELETE FROM document_counters WHERE name = 'BSO_TEST'").catch(() => {});
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

  // ---- 1. warehouses: create/list/get-by-id isolation, code independence ----
  {
    const codeSuffix = TAG.slice(-8);
    const createdA = await call('/api/v1/admin/warehouses', { method: 'POST', cookie: a, body: { code: `WH-BSO-${codeSuffix}`, name: `BSO Cotton FC ${TAG}` } });
    assert.equal(createdA.status, 201, `Cor-Cotton warehouse create failed: ${JSON.stringify(createdA.json)}`);
    const whId = createdA.json.data.id;
    cleanup.warehouses.add(whId);
    // warehouseDto() doesn't surface brand_id in the HTTP response (a
    // session is already scoped to one company) — check the actual row.
    const [whRow] = await query('SELECT brand_id FROM warehouses WHERE id = ?', [whId]);
    assert.equal(whRow.brand_id, cotton.id, "the created warehouse's brand_id must be the actor's own company, from req.brandId — never client-supplied");

    const listB = await call('/api/v1/admin/warehouses', { cookie: b });
    assert.ok(!listB.json.data.warehouses?.some((w) => w.id === whId) && !listB.json.data.some?.((w) => w.id === whId), "Cor-Znix's warehouse list must not contain Cor-Cotton's warehouse");

    const getB = await call(`/api/v1/admin/warehouses/${whId}`, { cookie: b });
    assert.equal(getB.status, 404, "fetching another company's warehouse by id must 404, not 403 — never leak existence (DESIGN.md §5.3)");

    const getA = await call(`/api/v1/admin/warehouses/${whId}`, { cookie: a });
    assert.equal(getA.status, 200, "Cor-Cotton's own fetch must still work");

    // The SAME warehouse code, in the OTHER company, must succeed — proves
    // uk_warehouses_brand_code is (brand_id, code) now, not global.
    const createdB = await call('/api/v1/admin/warehouses', { method: 'POST', cookie: b, body: { code: `WH-BSO-${codeSuffix}`, name: `BSO Znix FC ${TAG}` } });
    assert.equal(createdB.status, 201, 'the same warehouse code must be usable independently in another company (brand_id, code) uniqueness');
    cleanup.warehouses.add(createdB.json.data.id);

    pass('WAREHOUSE_ISOLATION', 'list scoped, get-by-id 404s across companies, (brand_id, code) independent, brand_id server-derived');
  }

  // ---- 2. company-scoped permissions: ONE staff member, two companies, --
  // ----    an override on only one grant actually changes behaviour -----
  {
    // OPERATIONS carries no warehouse.* permission at all (see
    // staff/permissions.js) — a clean negative baseline in both companies
    // before any override.
    const userC = await staffAuthService.createStaffUser({ email: C_EMAIL, password: PW, firstName: 'C', lastName: 'Both', role: 'OPERATIONS' });
    // Cor-Cotton grant: left at plain OPERATIONS (no override) — the negative case.
    // Cor-Znix grant: OPERATIONS + an override that GRANTS warehouse.read/manage.
    await brandAccess.grant({
      staffUserId: userC.id, brandId: znix.id, role: 'OPERATIONS', grantedBy: null,
      permissionOverrides: { grant: ['warehouse.read', 'warehouse.manage'] },
    });

    const c = await loginCookie(C_EMAIL);

    // Session defaults to the `is_default` brand (Cor-Cotton) on first login.
    const meC = (await call('/api/v1/admin/me', { cookie: c })).json.data;
    assert.equal(meC.accessibleBrands.length, 2, 'userC must be able to see both companies');
    assert.equal(meC.currentBrand.slug, 'corcotton', 'a fresh session defaults to the is_default company');

    const deniedInCotton = await call('/api/v1/admin/warehouses', { cookie: c });
    assert.equal(deniedInCotton.status, 403, 'OPERATIONS has no warehouse.read in Cor-Cotton (no override there) — must be denied');

    const switched = await call('/api/v1/admin/session/brand', { method: 'PUT', cookie: c, body: { brandId: znix.id } });
    assert.equal(switched.status, 200, `switching to Cor-Znix failed: ${JSON.stringify(switched.json)}`);

    const allowedInZnix = await call('/api/v1/admin/warehouses', { cookie: c });
    assert.equal(allowedInZnix.status, 200, "the SAME staff member, SAME session, now in Cor-Znix, must be allowed — the override on Cor-Znix's own grant took effect");

    const switchBack = await call('/api/v1/admin/session/brand', { method: 'PUT', cookie: c, body: { brandId: cotton.id } });
    assert.equal(switchBack.status, 200);
    const deniedAgain = await call('/api/v1/admin/warehouses', { cookie: c });
    assert.equal(deniedAgain.status, 403, 'switching back to Cor-Cotton must re-deny — the override is per-grant, not cached globally for the session');

    pass('COMPANY_SCOPED_PERMISSIONS', 'resolveEffectivePermissions(role, overrides) genuinely differs per company for the SAME staff member');
  }

  // ---- 3. company_profiles: separate legal identity per company --------
  {
    const cottonProfile = await companyService.getProfile(cotton.id);
    const znixProfile = await companyService.getProfile(znix.id);
    assert.ok(cottonProfile, "Cor-Cotton's company_profiles row must exist");
    assert.equal(cottonProfile.gstin, '09AAVFC6069N1ZF', "Cor-Cotton's own GSTIN must come back — the real legal-identity value, not a stale singleton");
    assert.ok(znixProfile, "Cor-Znix's company_profiles row must exist independently");
    assert.notEqual(znixProfile.gstin, cottonProfile.gstin, "Cor-Znix must NEVER read Cor-Cotton's GSTIN — the exact bug this phase fixed (company_profile singular vs company_profiles plural)");
    pass('COMPANY_PROFILE_PER_BRAND', `Cor-Cotton GSTIN=${cottonProfile.gstin}, Cor-Znix GSTIN=${znixProfile.gstin ?? '(blank, no legal filing yet)'}`);
  }

  // ---- 4. document_counters + number prefix: independent per company ---
  {
    await withTransaction(async (tx) => {
      const n1 = await documentRepository.nextNumber(tx, cotton.id, 'BSO_TEST', 'BSOTEST');
      const n2 = await documentRepository.nextNumber(tx, cotton.id, 'BSO_TEST', 'BSOTEST');
      const nz = await documentRepository.nextNumber(tx, znix.id, 'BSO_TEST', 'BSOTEST');

      assert.ok(n1.startsWith(`${cotton.order_prefix}-BSOTEST-`), `Cor-Cotton's number must use its own prefix, got "${n1}"`);
      assert.ok(n1.endsWith('-000001') && n2.endsWith('-000002'), `Cor-Cotton's counter must advance 1, 2, ... got "${n1}" then "${n2}"`);
      assert.ok(nz.startsWith(`${znix.order_prefix}-BSOTEST-`), `Cor-Znix's number must use ITS OWN prefix ("${znix.order_prefix}-"), never Cor-Cotton's, got "${nz}"`);
      assert.ok(nz.endsWith('-000001'), `Cor-Znix's counter must start at 1 independently, even though Cor-Cotton's is already at 2 — got "${nz}"`);
    });
    pass('DOCUMENT_COUNTER_INDEPENDENCE', `document_counters keyed (brand_id, name) — Cor-Cotton "${cotton.order_prefix}-BSOTEST-...", Cor-Znix "${znix.order_prefix}-BSOTEST-..." advance independently`);
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`\nNO_EXTERNAL_PROVIDER_CALLS: ${externalCalls === 0 ? 'PASS' : `FAIL (${externalCalls})`}`);
  console.log(`\nBRAND_SCOPE_OPS_VERIFICATION = ${externalCalls === 0 ? 'PASS' : 'FAIL'}`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  await teardown();
}
