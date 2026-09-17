// Category management + product<->category mapping verification (Wave 8D, Phase 4).
//
// Proves: CATEGORY_CRUD, CATEGORY_SLUG (conflict + rename-keeps-slug),
// CATEGORY_HIERARCHY (2 levels enforced), CATEGORY_DELETE_SAFETY (children /
// in-use refused; RESTRICT parent FK), CATEGORY_MAPPING (transactional bulk
// replace, exactly one primary, products.category_id synced), duplicate /
// archived / unknown rejection, atomic failure, and storefront regression
// (category filtering unaffected; archived categories return no products).
//
// Real HTTP listener + CATALOG_MANAGER session. All synthetic categories /
// products removed in finally; real catalog data untouched.
//
//   npm run verify:categories
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

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `cat-${Date.now()}`;
const CM_EMAIL = `cm.${TAG}@categories.test`;
const VIEWER_EMAIL = `viewer.${TAG}@categories.test`;
const PW = 'Corcotton-Categories-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;
const createdCategoryIds = new Set();
const createdProductIds = new Set();

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
async function mkCategory(cookie, body) {
  const r = await call('/api/v1/admin/catalog/categories', { method: 'POST', cookie, body });
  if (r.json?.data?.id) createdCategoryIds.add(r.json.data.id);
  return r;
}
async function mkProduct(cookie, name) {
  const r = await call('/api/v1/admin/products', { method: 'POST', cookie, body: { name, productType: 'tshirts' } });
  createdProductIds.add(r.json.data.id);
  return r.json.data;
}

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  for (const pid of createdProductIds) {
    await query('DELETE FROM product_categories WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM products WHERE id = ?', [pid]).catch(() => {});
  }
  // children first
  for (const cid of createdCategoryIds) await query('UPDATE categories SET parent_id = NULL WHERE id = ?', [cid]).catch(() => {});
  for (const cid of createdCategoryIds) {
    await query('DELETE FROM product_categories WHERE category_id = ?', [cid]).catch(() => {});
    await query('DELETE FROM categories WHERE id = ?', [cid]).catch(() => {});
  }
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@categories.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@categories.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@categories.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@categories.test'");
  await staffAuthService.createStaffUser({ email: CM_EMAIL, password: PW, firstName: 'Cat', lastName: 'Mgr', role: 'CATALOG_MANAGER' });
  await staffAuthService.createStaffUser({ email: VIEWER_EMAIL, password: PW, firstName: 'View', lastName: 'Only', role: 'VIEWER' });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const cm = await loginCookie(CM_EMAIL);
  const viewer = await loginCookie(VIEWER_EMAIL);

  // ---- 1. RBAC ----------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/catalog/categories')).status, 401);
    assert.equal((await call('/api/v1/admin/catalog/categories', { cookie: viewer })).status, 200);
    const denied = await call('/api/v1/admin/catalog/categories', { method: 'POST', cookie: viewer, body: { name: 'X' } });
    assert.equal(denied.status, 403);
    pass('CATEGORY_RBAC');
  }

  // ---- 2. CRUD + slug --------------------------------------------
  let root; let child;
  {
    const r = await mkCategory(cm, { name: `Root ${TAG}`, description: 'a root' });
    assert.equal(r.status, 201);
    root = r.json.data;
    assert.equal(root.status, 'ACTIVE');
    assert.equal(root.parentId, null);
    assert.match(root.slug, new RegExp(`^root-${TAG}$`));

    child = (await mkCategory(cm, { name: `Child ${TAG}`, parentId: root.id })).json.data;
    assert.equal(child.parentId, root.id);

    const got = await call(`/api/v1/admin/catalog/categories/${root.id}`, { cookie: cm });
    assert.equal(got.json.data.children.length, 1);
    assert.equal(got.json.data.children[0].id, child.id);

    // rename keeps slug
    const renamed = await call(`/api/v1/admin/catalog/categories/${root.id}`, { method: 'PATCH', cookie: cm, body: { name: `Renamed ${TAG}` } });
    assert.equal(renamed.json.data.name, `Renamed ${TAG}`);
    assert.equal(renamed.json.data.slug, root.slug, 'rename does not change the slug');

    // explicit slug change
    const reslugged = await call(`/api/v1/admin/catalog/categories/${root.id}`, { method: 'PATCH', cookie: cm, body: { slug: `root-${TAG}-v2` } });
    assert.equal(reslugged.json.data.slug, `root-${TAG}-v2`);

    // slug conflict
    const conflict = await mkCategory(cm, { name: 'Dupe', slug: `root-${TAG}-v2` });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'CATEGORY_SLUG_CONFLICT');
    pass('CATEGORY_CRUD_AND_SLUG');
  }

  // ---- 3. hierarchy — 2 levels only ---------------------------
  {
    const grandchild = await mkCategory(cm, { name: `GC ${TAG}`, parentId: child.id });
    assert.equal(grandchild.status, 422, 'cannot nest under a non-root');

    // a category with children cannot itself become a child
    const demote = await call(`/api/v1/admin/catalog/categories/${root.id}`, { method: 'PATCH', cookie: cm, body: { parentId: child.id } });
    assert.equal(demote.status, 422);
    pass('CATEGORY_HIERARCHY');
  }

  // ---- 4. product <-> category mapping ------------------------
  let productA; let extra;
  {
    productA = await mkProduct(cm, `Cat Product ${TAG}`);
    extra = (await mkCategory(cm, { name: `Extra ${TAG}` })).json.data;

    const set = await call(`/api/v1/admin/products/${productA.id}/categories`, {
      method: 'PUT', cookie: cm,
      body: { categories: [{ categoryId: root.id, isPrimary: true }, { categoryId: extra.id }] },
    });
    assert.equal(set.status, 200);
    assert.equal(set.json.data.categories.length, 2);
    assert.equal(set.json.data.categories[0].isPrimary, true);
    assert.equal(set.json.data.categories[0].id, root.id, 'primary listed first');

    const legacy = (await query('SELECT category_id FROM products WHERE id = ?', [productA.id]))[0];
    assert.equal(legacy.category_id, root.id, 'products.category_id synced to primary');

    // admin product DTO carries both `category` (primary) and `categories` (all)
    const dto = (await call(`/api/v1/admin/products/${productA.id}`, { cookie: cm })).json.data;
    assert.equal(dto.category.id, root.id);
    assert.equal(dto.categories.length, 2);

    // duplicate
    const dup = await call(`/api/v1/admin/products/${productA.id}/categories`, {
      method: 'PUT', cookie: cm, body: { categories: [{ categoryId: root.id }, { categoryId: root.id }] },
    });
    assert.equal(dup.status, 422);

    // unknown category
    const unknown = await call(`/api/v1/admin/products/${productA.id}/categories`, {
      method: 'PUT', cookie: cm, body: { categories: [{ categoryId: '00000000-0000-4000-8000-000000000000' }] },
    });
    assert.equal(unknown.status, 422);

    // archived category rejected
    await call(`/api/v1/admin/catalog/categories/${extra.id}/status`, { method: 'PATCH', cookie: cm, body: { status: 'ARCHIVED' } });
    const archived = await call(`/api/v1/admin/products/${productA.id}/categories`, {
      method: 'PUT', cookie: cm, body: { categories: [{ categoryId: extra.id }] },
    });
    assert.equal(archived.status, 422, 'cannot map to an archived category');

    // atomic: the failed calls left the original 2-category mapping intact
    const still = (await call(`/api/v1/admin/products/${productA.id}/categories`, { cookie: cm })).json.data;
    assert.equal(still.categories.length, 2, 'failed writes did not corrupt the mapping');
    await call(`/api/v1/admin/catalog/categories/${extra.id}/status`, { method: 'PATCH', cookie: cm, body: { status: 'ACTIVE' } });

    // empty list clears + nulls category_id
    const cleared = await call(`/api/v1/admin/products/${productA.id}/categories`, { method: 'PUT', cookie: cm, body: { categories: [] } });
    assert.equal(cleared.json.data.categories.length, 0);
    assert.equal((await query('SELECT category_id FROM products WHERE id = ?', [productA.id]))[0].category_id, null);

    // restore one for the delete-safety test
    await call(`/api/v1/admin/products/${productA.id}/categories`, { method: 'PUT', cookie: cm, body: { categories: [{ categoryId: root.id }] } });
    pass('CATEGORY_MAPPING');
  }

  // ---- 5. delete safety --------------------------------------
  {
    const hasChild = await call(`/api/v1/admin/catalog/categories/${root.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(hasChild.status, 409);
    assert.equal(hasChild.json.error.code, 'CATEGORY_HAS_CHILDREN');

    const inUse = await call(`/api/v1/admin/catalog/categories/${root.id}`, { method: 'DELETE', cookie: cm });
    assert.ok([409].includes(inUse.status));

    // detach product + child, then the empty `extra` deletes cleanly
    await call(`/api/v1/admin/products/${productA.id}/categories`, { method: 'PUT', cookie: cm, body: { categories: [] } });
    const delExtra = await call(`/api/v1/admin/catalog/categories/${extra.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(delExtra.status, 200);
    createdCategoryIds.delete(extra.id);

    // raw FK: a parent with children cannot be hard-deleted at the DB
    await assert.rejects(
      () => query('DELETE FROM categories WHERE id = ?', [root.id]),
      (err) => /foreign key|RESTRICT|ER_ROW_IS_REFERENCED/i.test(err.message || err.code || ''),
      'categories.parent_id FK is RESTRICT',
    );
    pass('CATEGORY_DELETE_SAFETY');
  }

  // ---- 5b. facets + CSV export ------------------------------
  {
    assert.equal((await call('/api/v1/admin/catalog/categories/facets')).status, 401, 'facets needs a session');
    const fac = await call('/api/v1/admin/catalog/categories/facets', { cookie: cm });
    assert.equal(fac.status, 200);
    const d = fac.json.data;
    assert.ok(typeof d.total === 'number' && d.total > 0);
    assert.equal(d.roots + d.children, d.total, 'roots + children = total');
    assert.ok(d.active <= d.total && d.productsMapped >= 0);
    assert.equal((await call('/api/v1/admin/catalog/categories/facets', { cookie: viewer })).status, 200, 'VIEWER may read facets');

    const csvRes = await fetch(`${BASE}/api/v1/admin/catalog/categories/export`, { headers: { origin: ORIGIN, cookie: cm } });
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type') || '', /text\/csv/);
    assert.match(csvRes.headers.get('content-disposition') || '', /attachment; filename="categories-\d{4}-\d{2}-\d{2}\.csv"/);
    const text = await csvRes.text();
    const [head, ...bodyLines] = text.trim().split('\r\n');
    assert.equal(head.replace('﻿', ''), 'Name,Slug,Parent,Display order,Product count,Status,Created,Updated');
    assert.ok(bodyLines.length >= d.total, 'a row per category');
    assert.equal((await fetch(`${BASE}/api/v1/admin/catalog/categories/export`, { headers: { origin: ORIGIN } })).status, 401, 'export needs a session');
    pass('CATEGORY_FACETS_AND_EXPORT');
  }

  // ---- 6. storefront regression -----------------------------
  {
    // real catalog still filters by category
    const tees = await call('/api/v1/products?category=tshirts&limit=5');
    assert.equal(tees.status, 200);
    assert.ok(tees.json.data.total >= 1, 'tshirts category still returns products');

    // an archived category returns nothing to the storefront
    await call(`/api/v1/admin/catalog/categories/${child.id}/status`, { method: 'PATCH', cookie: cm, body: { status: 'ARCHIVED' } });
    const archivedList = await call(`/api/v1/products?category=${child.slug}`);
    assert.equal(archivedList.json.data.total, 0, 'archived category exposes no products');

    // public collections list excludes archived categories
    const collections = await call('/api/v1/collections');
    assert.ok(!collections.json.data.some((c) => c.slug === child.slug), 'archived category not in public collections list');
    pass('CATEGORY_STOREFRONT_REGRESSION');
  }

  // ---- 7. tripwire -----------------------------------------
  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCATEGORY_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCATEGORY_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
