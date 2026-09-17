// Collection management + manual membership + ordering (Wave 8D, Phase 5).
//
// Proves: COLLECTION_CRUD, COLLECTION_SLUG (conflict + rename-keeps-slug),
// MANUAL_MEMBERSHIP (bulk set / add / idempotent add / remove-resequences /
// duplicate + unknown rejection), COLLECTION_ORDERING (deterministic, no
// duplicate positions, two-phase reorder), inactive-product membership
// retained, COLLECTION_DELETE_SAFETY, and storefront regression — the merged
// public collections DTO + routes unchanged, and `sort=manual` honours the
// curated order while the default sort is untouched.
//
//   npm run verify:collections
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

const TAG = `col-${Date.now()}`;
const CM_EMAIL = `cm.${TAG}@collections.test`;
const VIEWER_EMAIL = `viewer.${TAG}@collections.test`;
const PW = 'Corcotton-Collections-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;
const createdCollectionIds = new Set();
const createdProductIds = [];

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
async function mkCollection(cookie, body) {
  const r = await call('/api/v1/admin/catalog/collections', { method: 'POST', cookie, body });
  if (r.json?.data?.id) createdCollectionIds.add(r.json.data.id);
  return r;
}
let skuSeq = 0;
let skuIdentity = null;
async function skuCodes(cookie) {
  if (!skuIdentity) {
    const opts = (await call('/api/v1/admin/catalog/sku/options', { cookie })).json.data;
    skuIdentity = {
      productTypeCodeId: opts.productTypes.find((t) => t.code === 'TS').id,
      fitCodeId: opts.fits.find((f) => f.code === 'O').id,
      colorCodeId: opts.colors.find((c) => c.code === 'BLK').id,
    };
  }
  return skuIdentity;
}
async function mkActiveProduct(cookie, name) {
  // Phase 1B — the SKU string is backend-generated from the product/variant
  // canonical identity (type / fit / colour / design + size). A distinct
  // design code per product keeps the generated SKU strings unique.
  const codes = await skuCodes(cookie);
  skuSeq += 1;
  const p = (await call('/api/v1/admin/products', { method: 'POST', cookie, body: { name, productType: 'tshirts', productTypeCodeId: codes.productTypeCodeId, fit: 'Oversize Fit', fitCodeId: codes.fitCodeId } })).json.data;
  createdProductIds.push(p.id);
  const withVariant = (await call(`/api/v1/admin/products/${p.id}/variants`, { method: 'POST', cookie, body: { colorName: 'Black', colorHex: '111111', colorCodeId: codes.colorCodeId, designName: `Col ${TAG} ${skuSeq}`, designCode: `C${skuSeq}` } })).json.data;
  const variantId = withVariant.variants[0].id;
  await call(`/api/v1/admin/products/${p.id}/skus`, { method: 'POST', cookie, body: { variantId, size: 'M', priceMinor: 119900 } });
  await call(`/api/v1/admin/products/${p.id}/status`, { method: 'PATCH', cookie, body: { status: 'ACTIVE' } });
  return p;
}

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  for (const cid of createdCollectionIds) await query('DELETE FROM product_collections WHERE collection_id = ?', [cid]).catch(() => {});
  for (const pid of createdProductIds) {
    await query('DELETE FROM product_collections WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM products WHERE id = ?', [pid]).catch(() => {});
  }
  for (const cid of createdCollectionIds) await query('DELETE FROM collections WHERE id = ?', [cid]).catch(() => {});
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@collections.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@collections.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@collections.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@collections.test'");
  await staffAuthService.createStaffUser({ email: CM_EMAIL, password: PW, firstName: 'Col', lastName: 'Mgr', role: 'CATALOG_MANAGER' });
  await staffAuthService.createStaffUser({ email: VIEWER_EMAIL, password: PW, firstName: 'View', lastName: 'Only', role: 'VIEWER' });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const cm = await loginCookie(CM_EMAIL);
  const viewer = await loginCookie(VIEWER_EMAIL);

  // ---- 1. RBAC --------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/catalog/collections')).status, 401);
    assert.equal((await call('/api/v1/admin/catalog/collections', { cookie: viewer })).status, 200);
    assert.equal((await call('/api/v1/admin/catalog/collections', { method: 'POST', cookie: viewer, body: { name: 'X' } })).status, 403);
    pass('COLLECTION_RBAC');
  }

  // ---- 2. CRUD + slug -----------------------------------------
  let collection;
  {
    const r = await mkCollection(cm, { name: `Curated ${TAG}`, description: 'a curated edit' });
    assert.equal(r.status, 201);
    collection = r.json.data;
    assert.equal(collection.status, 'ACTIVE');
    assert.equal(collection.productCount, 0);
    assert.ok(Array.isArray(collection.members) && collection.members.length === 0);

    const renamed = await call(`/api/v1/admin/catalog/collections/${collection.id}`, { method: 'PATCH', cookie: cm, body: { name: `Renamed ${TAG}` } });
    assert.equal(renamed.json.data.slug, collection.slug, 'rename does not change the slug');

    const conflict = await mkCollection(cm, { name: 'Dupe', slug: collection.slug });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'COLLECTION_SLUG_CONFLICT');
    pass('COLLECTION_CRUD_AND_SLUG');
  }

  // ---- 3. manual membership + ordering -----------------------
  const p1 = await mkActiveProduct(cm, `Col P1 ${TAG}`);
  const p2 = await mkActiveProduct(cm, `Col P2 ${TAG}`);
  const p3 = await mkActiveProduct(cm, `Col P3 ${TAG}`);
  {
    const set = await call(`/api/v1/admin/catalog/collections/${collection.id}/members`, {
      method: 'PUT', cookie: cm, body: { productIds: [p1.id, p2.id, p3.id] },
    });
    assert.equal(set.status, 200);
    assert.deepEqual(set.json.data.members.map((m) => m.id), [p1.id, p2.id, p3.id]);
    assert.deepEqual(set.json.data.members.map((m) => m.position), [0, 1, 2]);

    // duplicate / unknown rejection
    assert.equal((await call(`/api/v1/admin/catalog/collections/${collection.id}/members`, { method: 'PUT', cookie: cm, body: { productIds: [p1.id, p1.id] } })).status, 422);
    assert.equal((await call(`/api/v1/admin/catalog/collections/${collection.id}/members`, { method: 'PUT', cookie: cm, body: { productIds: ['00000000-0000-4000-8000-000000000000'] } })).status, 422);
    // the failed writes didn't disturb the membership
    assert.equal((await call(`/api/v1/admin/catalog/collections/${collection.id}`, { cookie: cm })).json.data.members.length, 3);

    // add (append) + idempotent add
    const p4 = await mkActiveProduct(cm, `Col P4 ${TAG}`);
    const added = await call(`/api/v1/admin/catalog/collections/${collection.id}/members`, { method: 'POST', cookie: cm, body: { productId: p4.id } });
    assert.equal(added.json.data.members[3].id, p4.id);
    assert.equal(added.json.data.members[3].position, 3);
    const again = await call(`/api/v1/admin/catalog/collections/${collection.id}/members`, { method: 'POST', cookie: cm, body: { productId: p4.id } });
    assert.equal(again.json.data.members.length, 4, 'adding an existing member is idempotent');

    // reorder: p3, p1, p4, p2
    const reordered = await call(`/api/v1/admin/catalog/collections/${collection.id}/reorder`, {
      method: 'POST', cookie: cm, body: { orderedProductIds: [p3.id, p1.id, p4.id, p2.id] },
    });
    assert.deepEqual(reordered.json.data.members.map((m) => m.id), [p3.id, p1.id, p4.id, p2.id]);
    assert.deepEqual(reordered.json.data.members.map((m) => m.position), [0, 1, 2, 3]);
    const dbDup = await query('SELECT position, COUNT(*) c FROM product_collections WHERE collection_id = ? GROUP BY position HAVING c > 1', [collection.id]);
    assert.equal(dbDup.length, 0, 'no duplicate positions in the DB');

    // reorder must be the exact current set
    assert.equal((await call(`/api/v1/admin/catalog/collections/${collection.id}/reorder`, { method: 'POST', cookie: cm, body: { orderedProductIds: [p3.id, p1.id] } })).status, 422);

    // remove resequences
    const removed = await call(`/api/v1/admin/catalog/collections/${collection.id}/members/${p4.id}`, { method: 'DELETE', cookie: cm });
    assert.deepEqual(removed.json.data.members.map((m) => m.id), [p3.id, p1.id, p2.id]);
    assert.deepEqual(removed.json.data.members.map((m) => m.position), [0, 1, 2]);
    pass('MANUAL_MEMBERSHIP_AND_ORDERING');
  }

  // ---- 4. inactive product stays a member -------------------
  {
    await call(`/api/v1/admin/products/${p2.id}/status`, { method: 'PATCH', cookie: cm, body: { status: 'ARCHIVED' } });
    const detail = (await call(`/api/v1/admin/catalog/collections/${collection.id}`, { cookie: cm })).json.data;
    const p2row = detail.members.find((m) => m.id === p2.id);
    assert.ok(p2row && p2row.status === 'ARCHIVED', 'archived product retained in membership');
    const list = (await call('/api/v1/admin/catalog/collections', { cookie: cm })).json.data.collections.find((c) => c.id === collection.id);
    assert.equal(list.productCount, 3);
    assert.equal(list.activeProductCount, 2, 'active count excludes the archived product');
    await call(`/api/v1/admin/products/${p2.id}/status`, { method: 'PATCH', cookie: cm, body: { status: 'ACTIVE' } });
    pass('COLLECTION_INACTIVE_PRODUCT_RETAINED');
  }

  // ---- 4b. facets + CSV export ----------------------------
  {
    assert.equal((await call('/api/v1/admin/catalog/collections/facets')).status, 401);
    const fac = await call('/api/v1/admin/catalog/collections/facets', { cookie: cm });
    assert.equal(fac.status, 200);
    const d = fac.json.data;
    assert.ok(typeof d.total === 'number' && d.total >= 1);
    assert.ok(d.active <= d.total);
    assert.equal(d.manualOrder, true);
    assert.ok(typeof d.productsAssigned === 'number');

    // list() now carries member thumbnails (array, possibly empty)
    const list = await call('/api/v1/admin/catalog/collections', { cookie: cm });
    assert.ok(Array.isArray(list.json.data.collections[0].thumbnails), 'thumbnails present on list rows');

    const csv = await fetch(`${BASE}/api/v1/admin/catalog/collections/export`, { headers: { origin: ORIGIN, cookie: cm } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    const text = await csv.text();
    assert.equal(text.trim().split('\r\n')[0].replace('﻿', ''), 'Name,Slug,Products,Active products,Display order,Status,Created,Updated');
    assert.equal((await fetch(`${BASE}/api/v1/admin/catalog/collections/export`, { headers: { origin: ORIGIN } })).status, 401);
    pass('COLLECTION_FACETS_AND_EXPORT');
  }

  // ---- 5. delete safety -----------------------------------
  {
    const inUse = await call(`/api/v1/admin/catalog/collections/${collection.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(inUse.status, 409);
    assert.equal(inUse.json.error.code, 'COLLECTION_IN_USE');

    await call(`/api/v1/admin/catalog/collections/${collection.id}/members`, { method: 'PUT', cookie: cm, body: { productIds: [] } });
    const empty = await mkCollection(cm, { name: `Empty ${TAG}` });
    const del = await call(`/api/v1/admin/catalog/collections/${empty.json.data.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(del.status, 200);
    createdCollectionIds.delete(empty.json.data.id);
    pass('COLLECTION_DELETE_SAFETY');
  }

  // ---- 6. storefront regression -------------------------
  {
    // merged public DTO: merchandising + category slugs, parentCollection field
    const pub = await call('/api/v1/collections');
    assert.equal(pub.status, 200);
    const slugs = pub.json.data.map((c) => c.slug);
    for (const s of ['bestsellers', 'new-arrivals', 'tshirts', 'tops']) assert.ok(slugs.includes(s), `merged collections DTO still includes "${s}"`);
    for (const c of pub.json.data) assert.ok('parentCollection' in c && 'itemCount' in c && 'displayOrder' in c);
    assert.equal((await call('/api/v1/collections/bestsellers')).status, 200);

    // sort=manual honours the curated order and follows a reorder
    await call(`/api/v1/admin/catalog/collections/${collection.id}/members`, {
      method: 'PUT', cookie: cm, body: { productIds: [p3.id, p1.id] },
    });
    const manual1 = await call(`/api/v1/products?collection=${collection.slug}&sort=manual`);
    assert.equal(manual1.status, 200);
    assert.deepEqual(manual1.json.data.products.map((p) => p.productSlug), [p3.slug, p1.slug], 'sort=manual honours curated order');

    await call(`/api/v1/admin/catalog/collections/${collection.id}/reorder`, { method: 'POST', cookie: cm, body: { orderedProductIds: [p1.id, p3.id] } });
    const manual2 = await call(`/api/v1/products?collection=${collection.slug}&sort=manual`);
    assert.deepEqual(manual2.json.data.products.map((p) => p.productSlug), [p1.slug, p3.slug], 'reorder reflected in sort=manual');

    // default (non-manual) sort still works and is a valid known sort — not an error
    const def = await call(`/api/v1/products?collection=${collection.slug}`);
    assert.equal(def.status, 200);
    assert.equal(def.json.data.products.length, 2, 'default collection listing unchanged in count');
    pass('COLLECTION_STOREFRONT_REGRESSION');
  }

  // ---- 7. tripwire -------------------------------------
  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCOLLECTION_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCOLLECTION_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
