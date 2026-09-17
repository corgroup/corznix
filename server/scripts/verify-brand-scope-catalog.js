// Multi-company CMS — Phase 3 isolation proof (implementation/multi-company/
// DESIGN.md §4.1 + §8, Phase 3 row: "verify:brand-scope-catalog").
//
// Everything else in this session's regression suite proves Phase 3 didn't
// BREAK anything. This script proves the actual point of Phase 3: two
// staff members scoped to different companies genuinely cannot see, list,
// fetch-by-id, or slug/code-collide with each other's catalog or content —
// across products, categories, SKU master codes, and the content engine
// (content_documents is the scope anchor every content_pages/nav_items/
// campaigns/etc. row inherits through document_id).
//
// Real HTTP listener + two real staff sessions, one per company (Cor-Cotton,
// Cor-Znix), each explicitly staff_brand_access-granted to exactly one
// brand — deny-by-default, nothing inferred. All synthetic rows removed in
// finally; real catalog/content data untouched.
//
//   npm run verify:brand-scope-catalog
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

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `bs-${Date.now()}`;
const A_EMAIL = `a.${TAG}@brand-scope.test`; // Cor-Cotton
const B_EMAIL = `b.${TAG}@brand-scope.test`; // Cor-Znix
const PW = 'Corcotton-BrandScope-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;
const cleanupIds = { categories: new Set(), products: new Set(), fitCodes: new Set() };

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

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  for (const pid of cleanupIds.products) await query('DELETE FROM products WHERE id = ?', [pid]).catch(() => {});
  for (const cid of cleanupIds.categories) await query('DELETE FROM categories WHERE id = ?', [cid]).catch(() => {});
  for (const fid of cleanupIds.fitCodes) await query('DELETE FROM catalog_fit_codes WHERE id = ?', [fid]).catch(() => {});
  await query("DELETE FROM content_nav_items WHERE item_key LIKE ?", [`nav_item_${TAG}%`.replace(/-/g, '_')]).catch(() => {});
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@brand-scope.test'").catch(() => {});
  await query("DELETE FROM staff_brand_access WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@brand-scope.test')").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@brand-scope.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@brand-scope.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@brand-scope.test'");

  const [cotton] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  const [znix] = await query("SELECT id FROM brands WHERE slug = 'corznix' LIMIT 1");
  assert.ok(cotton && znix, 'both brands must exist (Phase 1 migration)');

  // staffA: CATALOG_MANAGER, Cor-Cotton only (createStaffUser's default-brand
  // auto-grant already gives exactly this — nothing extra to do).
  const userA = await staffAuthService.createStaffUser({ email: A_EMAIL, password: PW, firstName: 'A', lastName: 'Cotton', role: 'CATALOG_MANAGER' });
  // staffB: CATALOG_MANAGER, Cor-Znix only — revoke the auto-granted
  // Cor-Cotton default and grant Cor-Znix explicitly instead, so their
  // session resolves to exactly one company with nothing inferred.
  const userB = await staffAuthService.createStaffUser({ email: B_EMAIL, password: PW, firstName: 'B', lastName: 'Znix', role: 'CATALOG_MANAGER' });
  const brandAccess = new StaffBrandAccessRepository();
  await brandAccess.revoke(userB.id, cotton.id);
  await brandAccess.grant({ staffUserId: userB.id, brandId: znix.id, role: 'CATALOG_MANAGER', grantedBy: null });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const a = await loginCookie(A_EMAIL);
  const b = await loginCookie(B_EMAIL);

  // ---- 0. /me resolves each to exactly their own company --------------
  {
    const meA = (await call('/api/v1/admin/me', { cookie: a })).json.data;
    const meB = (await call('/api/v1/admin/me', { cookie: b })).json.data;
    assert.equal(meA.accessibleBrands.length, 1);
    assert.equal(meA.accessibleBrands[0].slug, 'corcotton');
    assert.equal(meB.accessibleBrands.length, 1);
    assert.equal(meB.accessibleBrands[0].slug, 'corznix');
    pass('SESSION_RESOLVES_OWN_COMPANY_ONLY');
  }

  // ---- 1. categories: create/list/get-by-id isolation ------------------
  {
    const name = `Isolation Root ${TAG}`;
    const created = await call('/api/v1/admin/catalog/categories', { method: 'POST', cookie: a, body: { name } });
    assert.equal(created.status, 201);
    const catId = created.json.data.id;
    cleanupIds.categories.add(catId);

    const listB = await call('/api/v1/admin/catalog/categories', { cookie: b });
    assert.ok(!listB.json.data.categories.some((c) => c.id === catId), "Cor-Znix's category list must not contain Cor-Cotton's category");

    const getB = await call(`/api/v1/admin/catalog/categories/${catId}`, { cookie: b });
    assert.equal(getB.status, 404, "fetching another company's category by id must 404, not leak it");

    const listA = await call('/api/v1/admin/catalog/categories', { cookie: a });
    assert.ok(listA.json.data.categories.some((c) => c.id === catId), "Cor-Cotton's own list must still show it");

    // same name/slug in the OTHER company must succeed — slug uniqueness is
    // (brand_id, slug) now, not global.
    const createdB = await call('/api/v1/admin/catalog/categories', { method: 'POST', cookie: b, body: { name } });
    assert.equal(createdB.status, 201, 'the same category name must be creatable independently in another company');
    cleanupIds.categories.add(createdB.json.data.id);
    assert.notEqual(createdB.json.data.slug, undefined);

    pass('CATEGORY_ISOLATION', 'list scoped, get-by-id 404s across companies, slugs independent per company');
  }

  // ---- 2. products: create/list/get-by-id isolation --------------------
  {
    const name = `Isolation Product ${TAG}`;
    const created = await call('/api/v1/admin/products', { method: 'POST', cookie: a, body: { name, productType: 'tshirts' } });
    assert.equal(created.status, 201);
    const pid = created.json.data.id;
    cleanupIds.products.add(pid);

    const listB = await call('/api/v1/admin/products', { cookie: b });
    assert.ok(!listB.json.data.products.some((p) => p.id === pid), "Cor-Znix's product list must not contain Cor-Cotton's product");

    const getB = await call(`/api/v1/admin/products/${pid}`, { cookie: b });
    assert.equal(getB.status, 404, "fetching another company's product by id must 404");

    pass('PRODUCT_ISOLATION', 'list scoped, get-by-id 404s across companies');
  }

  // ---- 3. SKU master codes: per-company code uniqueness ----------------
  {
    const code = 'IZ';
    const label = `Isolation Fit ${TAG}`;
    const createdA = await call('/api/v1/admin/catalog/sku/fit-codes', { method: 'POST', cookie: a, body: { code, label } });
    assert.equal(createdA.status, 201);
    cleanupIds.fitCodes.add(createdA.json.data.id);

    // the SAME code, different label, in the OTHER company — must succeed.
    const createdB = await call('/api/v1/admin/catalog/sku/fit-codes', { method: 'POST', cookie: b, body: { code, label: `${label} B` } });
    assert.equal(createdB.status, 201, 'the same fit code must be usable independently in another company (brand_id, code) uniqueness');
    cleanupIds.fitCodes.add(createdB.json.data.id);

    const optionsB = (await call('/api/v1/admin/catalog/sku/options', { cookie: b })).json.data;
    assert.ok(!optionsB.fits.some((f) => f.id === createdA.json.data.id), "Cor-Znix's SKU options must not list Cor-Cotton's fit code");

    pass('SKU_MASTER_CODE_ISOLATION', 'per-(brand_id, code) uniqueness, options list scoped');
  }

  // ---- 4. content: navigation draft isolation --------------------------
  {
    const draftBBefore = (await call('/api/v1/admin/content/navigation', { cookie: b })).json.data;
    const itemKey = `nav_item_${TAG}`.replace(/-/g, '_');
    const draftA = (await call('/api/v1/admin/content/navigation', { cookie: a })).json.data;
    const upsertA = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: a,
      body: { itemKey, label: 'Isolation Nav Item', linkType: 'HOME', expectedVersion: draftA.document.workingVersion },
    });
    assert.equal(upsertA.status, 200, `Cor-Cotton nav upsert failed: ${JSON.stringify(upsertA.json)}`);

    const draftBAfter = (await call('/api/v1/admin/content/navigation', { cookie: b })).json.data;
    assert.equal(draftBAfter.document.workingVersion, draftBBefore.document.workingVersion, "Cor-Znix's navigation document must be untouched by Cor-Cotton's edit");
    const flatten = (items) => items.flatMap((i) => [i, ...flatten(i.children || [])]);
    assert.ok(!flatten(draftBAfter.items).some((i) => i.itemKey === itemKey), "Cor-Znix's navigation draft must not contain Cor-Cotton's new item");

    // cleanup the nav item via Cor-Cotton's own session
    const draftA2 = (await call('/api/v1/admin/content/navigation', { cookie: a })).json.data;
    const added = flatten(draftA2.items).find((i) => i.itemKey === itemKey);
    if (added) {
      await call(`/api/v1/admin/content/navigation/items/${added.id}?expectedVersion=${draftA2.document.workingVersion}`, { method: 'DELETE', cookie: a });
    }
    pass('CONTENT_DOCUMENT_ISOLATION', "content_documents (brand_id, doc_type, doc_key) — each company's navigation is independent");
  }

  console.log(JSON.stringify(results, null, 2));
  console.log(`\nNO_EXTERNAL_PROVIDER_CALLS: ${externalCalls === 0 ? 'PASS' : `FAIL (${externalCalls})`}`);
  console.log(`\nBRAND_SCOPE_CATALOG_VERIFICATION = ${externalCalls === 0 ? 'PASS' : 'FAIL'}`);
} catch (err) {
  console.error('\nFAILED:', err.message);
  console.error(err.stack);
  process.exitCode = 1;
} finally {
  await cleanup();
}
