// Size Guide Studio verification (Wave 8D, Phase 3).
//
// Proves: SIZE_GUIDE_CRUD, SIZE_GUIDE_VALIDATION, SIZE_GUIDE_EXPLICIT_MAPPING,
// SIZE_GUIDE_INFERENCE = 0 (a product's guide never changes when its title /
// category change), SIZE_GUIDE_ORDER (deterministic), SIZE_GUIDE_DELETE_SAFETY
// (mapped guide cannot be deleted), and that the real seeded "Oversized
// T-Shirt" guide reaches the storefront PDP unchanged in shape.
//
// Real HTTP listener + CATALOG_MANAGER session. Synthetic guides/products are
// removed in finally; the seeded "Oversized T-Shirt" guide is left intact.
//
//   npm run verify:size-guides
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

const TAG = `sg-${Date.now()}`;
const CM_EMAIL = `cm.${TAG}@size-guide.test`;
const VIEWER_EMAIL = `viewer.${TAG}@size-guide.test`;
const PW = 'Corcotton-SizeGuide-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;
const createdGuideIds = new Set();
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
const validGuide = (over = {}) => ({
  name: `Synthetic ${TAG}`,
  unit: 'in',
  columns: ['size', 'chest', 'length'],
  rows: [
    { size: 'S', displayOrder: 0, values: { chest: 38, length: 27 } },
    { size: 'M', displayOrder: 1, values: { chest: 40, length: 27.5 } },
    { size: 'L', displayOrder: 2, values: { chest: 42, length: 28 } },
  ],
  ...over,
});

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  for (const pid of createdProductIds) {
    await query('UPDATE products SET size_guide_id = NULL WHERE id = ?', [pid]).catch(() => {});
    await query('DELETE FROM products WHERE id = ?', [pid]).catch(() => {});
  }
  for (const gid of createdGuideIds) {
    await query('UPDATE products SET size_guide_id = NULL WHERE size_guide_id = ?', [gid]).catch(() => {});
    await query('DELETE FROM size_guides WHERE id = ?', [gid]).catch(() => {});
  }
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@size-guide.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@size-guide.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@size-guide.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@size-guide.test'");
  await staffAuthService.createStaffUser({ email: CM_EMAIL, password: PW, firstName: 'SG', lastName: 'Mgr', role: 'CATALOG_MANAGER' });
  await staffAuthService.createStaffUser({ email: VIEWER_EMAIL, password: PW, firstName: 'View', lastName: 'Only', role: 'VIEWER' });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const cm = await loginCookie(CM_EMAIL);
  const viewer = await loginCookie(VIEWER_EMAIL);

  // ---- 1. RBAC --------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/catalog/size-guides')).status, 401);
    assert.equal((await call('/api/v1/admin/catalog/size-guides', { cookie: viewer })).status, 200);
    const denied = await call('/api/v1/admin/catalog/size-guides', { method: 'POST', cookie: viewer, body: validGuide() });
    assert.equal(denied.status, 403);
    pass('SIZE_GUIDE_RBAC');
  }

  // ---- 2. CRUD -------------------------------------------------
  let guide;
  {
    const created = await call('/api/v1/admin/catalog/size-guides', { method: 'POST', cookie: cm, body: validGuide() });
    assert.equal(created.status, 201);
    guide = created.json.data;
    createdGuideIds.add(guide.id);
    assert.equal(guide.status, 'DRAFT', 'new guide is DRAFT');
    assert.deepEqual(guide.columns, ['size', 'chest', 'length']);
    assert.equal(guide.rows.length, 3);

    const got = await call(`/api/v1/admin/catalog/size-guides/${guide.id}`, { cookie: cm });
    assert.equal(got.json.data.usageCount, 0);

    const upd = await call(`/api/v1/admin/catalog/size-guides/${guide.id}`, { method: 'PATCH', cookie: cm, body: { notes: 'Tolerance ±0.5in', title: 'Synthetic Title' } });
    assert.equal(upd.json.data.notes, 'Tolerance ±0.5in');
    assert.equal(upd.json.data.title, 'Synthetic Title');

    const rows = await call(`/api/v1/admin/catalog/size-guides/${guide.id}/rows`, {
      method: 'PUT', cookie: cm,
      body: { rows: [
        { size: 'XS', displayOrder: 0, values: { chest: 36, length: 26 } },
        { size: 'S', displayOrder: 1, values: { chest: 38, length: 27 } },
      ] },
    });
    assert.equal(rows.json.data.rows.length, 2);
    assert.deepEqual(rows.json.data.rows.map((r) => r.size), ['XS', 'S'], 'rows ordered by displayOrder');

    const activated = await call(`/api/v1/admin/catalog/size-guides/${guide.id}/status`, { method: 'PATCH', cookie: cm, body: { status: 'ACTIVE' } });
    assert.equal(activated.json.data.status, 'ACTIVE');
    pass('SIZE_GUIDE_CRUD');
  }

  // ---- 3. validation -----------------------------------------
  {
    const cases = [
      ['empty name', validGuide({ name: '  ' })],
      ['missing size column', validGuide({ columns: ['chest', 'length'] })],
      ['bad unit', validGuide({ unit: 'meters' })],
      ['duplicate size', validGuide({ rows: [
        { size: 'M', displayOrder: 0, values: { chest: 40, length: 27 } },
        { size: 'M', displayOrder: 1, values: { chest: 42, length: 28 } },
      ] })],
      ['duplicate displayOrder', validGuide({ rows: [
        { size: 'S', displayOrder: 0, values: { chest: 38, length: 27 } },
        { size: 'M', displayOrder: 0, values: { chest: 40, length: 27 } },
      ] })],
      ['unknown column value', validGuide({ rows: [{ size: 'S', displayOrder: 0, values: { chest: 38, hips: 40 } }] })],
    ];
    for (const [label, body] of cases) {
      const r = await call('/api/v1/admin/catalog/size-guides', { method: 'POST', cookie: cm, body });
      assert.ok([400, 422].includes(r.status), `${label} -> ${r.status}`);
    }
    pass('SIZE_GUIDE_VALIDATION');
  }

  // ---- 4. explicit mapping + no inference -------------------
  {
    const p = await call('/api/v1/admin/products', { method: 'POST', cookie: cm, body: { name: `SG Product ${TAG}`, productType: 'tshirts' } });
    const productId = p.json.data.id;
    createdProductIds.add(productId);

    const assign = await call(`/api/v1/admin/products/${productId}/size-guide`, { method: 'PUT', cookie: cm, body: { sizeGuideId: guide.id } });
    assert.equal(assign.status, 200);
    assert.equal(assign.json.data.sizeGuide.id, guide.id);

    // Change everything an inference engine might key on.
    await call(`/api/v1/admin/products/${productId}`, { method: 'PATCH', cookie: cm, body: { name: 'Totally Different Slim Polo', productType: 'polos' } });
    const after = await call(`/api/v1/admin/products/${productId}`, { cookie: cm });
    assert.equal(after.json.data.sizeGuide.id, guide.id, 'size guide mapping unchanged after title/type change');

    // A DRAFT guide cannot be assigned.
    const draft = await call('/api/v1/admin/catalog/size-guides', { method: 'POST', cookie: cm, body: validGuide({ name: `Draft ${TAG}` }) });
    createdGuideIds.add(draft.json.data.id);
    const badAssign = await call(`/api/v1/admin/products/${productId}/size-guide`, { method: 'PUT', cookie: cm, body: { sizeGuideId: draft.json.data.id } });
    assert.equal(badAssign.status, 422, 'DRAFT guide rejected for assignment');

    results.SIZE_GUIDE_INFERENCE = 0;
    pass('SIZE_GUIDE_EXPLICIT_MAPPING');
  }

  // ---- 5. delete safety -----------------------------------
  {
    const del1 = await call(`/api/v1/admin/catalog/size-guides/${guide.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(del1.status, 409, 'mapped guide cannot be deleted');
    assert.equal(del1.json.error.code, 'SIZE_GUIDE_IN_USE');

    for (const pid of createdProductIds) {
      await call(`/api/v1/admin/products/${pid}/size-guide`, { method: 'PUT', cookie: cm, body: { sizeGuideId: null } });
    }
    const del2 = await call(`/api/v1/admin/catalog/size-guides/${guide.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(del2.status, 200);
    createdGuideIds.delete(guide.id);
    assert.equal((await query('SELECT COUNT(*) c FROM size_guide_rows WHERE size_guide_id = ?', [guide.id]))[0].c, 0, 'rows cascade on delete');
    pass('SIZE_GUIDE_DELETE_SAFETY');
  }

  // ---- 5b. facets + CSV export ------------------------------
  {
    assert.equal((await call('/api/v1/admin/catalog/size-guides/facets')).status, 401);
    const fac = await call('/api/v1/admin/catalog/size-guides/facets', { cookie: cm });
    assert.equal(fac.status, 200);
    const d = fac.json.data;
    assert.ok(typeof d.total === 'number' && d.total >= 1);
    assert.equal(d.active + d.inactive, d.total, 'active + inactive = total');
    assert.ok(Array.isArray(d.formats) && d.formats.length >= 1);
    assert.ok(typeof d.usedByProducts === 'number');

    const list = (await call('/api/v1/admin/catalog/size-guides', { cookie: cm })).json.data.sizeGuides;
    assert.ok(Array.isArray(list[0].columns), 'list rows carry columns[]');

    const csv = await fetch(`${BASE}/api/v1/admin/catalog/size-guides/export`, { headers: { origin: ORIGIN, cookie: cm } });
    assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-type') || '', /text\/csv/);
    assert.equal((await csv.text()).trim().split('\r\n')[0].replace('﻿', ''), 'Name,Slug,Unit,Columns,Rows,Used by products,Status,Updated');
    assert.equal((await fetch(`${BASE}/api/v1/admin/catalog/size-guides/export`, { headers: { origin: ORIGIN } })).status, 401);
    pass('SIZE_GUIDE_FACETS_AND_EXPORT');
  }

  // ---- 6. seeded "Oversized T-Shirt" guide reaches the PDP ---
  {
    const list = (await call('/api/v1/admin/catalog/size-guides', { cookie: cm })).json.data.sizeGuides;
    const seeded = list.find((g) => g.slug === 'oversized-tshirt');
    assert.ok(seeded, 'seeded Oversized T-Shirt guide present');
    assert.equal(seeded.status, 'ACTIVE');
    assert.ok(seeded.usageCount >= 1, 'mapped to at least one product');

    const detail = (await call(`/api/v1/admin/catalog/size-guides/${seeded.id}`, { cookie: cm })).json.data;
    assert.deepEqual(detail.columns, ['size', 'chest', 'width', 'length', 'shoulder', 'sleeve']);
    assert.ok(detail.columns.includes('chest') && detail.columns.includes('width'), 'Chest and Width kept as separate columns');
    assert.equal(detail.rows.length, 7);
    assert.equal(detail.rows[0].size, 'XS');
    assert.equal(detail.rows[0].values.chest, 39);
    assert.equal(detail.rows[0].valuesCm.chest, 99, 'cm variant persisted');

    const pdp = await call('/api/v1/products/by-slug/oversized-cotton-tee');
    assert.equal(pdp.json.data.sizeGuide.slug, 'oversized-tshirt', 'PDP serves the mapped guide');
    assert.deepEqual(pdp.json.data.sizeGuide.columns, ['size', 'chest', 'width', 'length', 'shoulder', 'sleeve']);
    assert.equal(pdp.json.data.sizeGuide.rows[6].size, 'XXXL');
    assert.equal(pdp.json.data.sizeGuide.rows[6].chest, 52);

    // An unmapped product still returns null (button stays hidden).
    const other = await call('/api/v1/products/by-slug/ribbed-cotton-polo');
    assert.equal(other.json.data.sizeGuide, null, 'unmapped product PDP sizeGuide is null');
    pass('SIZE_GUIDE_PDP_INTEGRATION');
  }

  // ---- 7. tripwire ---------------------------------------
  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nSIZE_GUIDE_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nSIZE_GUIDE_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
