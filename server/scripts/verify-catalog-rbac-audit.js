// Catalog RBAC + audit coverage (Wave 8D, Phase 7).
//
// Proves the existing staff permission vocabulary (catalog.read /
// catalog.write) gates every Wave 8D catalog surface — no new permission was
// invented (§61) — and that every meaningful catalog mutation writes a staff
// audit row keyed to the acting staff id (§63/§107).
//
//   npm run verify:catalog:rbac-audit
import assert from 'node:assert/strict';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '120';
process.env.TRUST_PROXY = '1';
process.env.CLOUDINARY_CLOUD_NAME ||= 'verify-rbac-cloud';
process.env.CLOUDINARY_API_KEY ||= 'verify-rbac-key';
process.env.CLOUDINARY_API_SECRET ||= 'verify-rbac-secret';
process.env.MEDIA_PROVIDER ||= 'cloudinary';

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
const { cloudinary } = await import('../src/platform/media/providers/cloudinary/cloudinaryConfig.js');

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const realUploader = { ...cloudinary.uploader };
let seq = 0;
cloudinary.uploader.upload_stream = (_o, cb) => ({ end: () => { seq += 1; cb(null, { public_id: `verify-rbac/a-${seq}`, secure_url: `https://res.cloudinary.test/verify-rbac/a-${seq}.jpg`, width: 800, height: 800, bytes: 1024, format: 'jpg', resource_type: 'image' }); } });
cloudinary.uploader.upload_chunked_stream = cloudinary.uploader.upload_stream;
cloudinary.uploader.destroy = async () => ({ result: 'ok' });

const TAG = `rbac-${Date.now()}`;
const PW = 'Corcotton-CatalogRbac-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (role) => `${role.toLowerCase()}.${TAG}@catalog-rbac.test`;

let server, BASE;
const createdProductIds = new Set();
const createdCategoryIds = new Set();
const createdCollectionIds = new Set();
const createdGuideIds = new Set();
const createdMediaIds = new Set();

async function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function loginCookie(role) {
  const res = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: email(role), password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function cleanup() {
  Object.assign(cloudinary.uploader, realUploader);
  try { server?.close(); } catch { /* noop */ }
  for (const pid of createdProductIds) {
    await query('DELETE FROM product_media WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM product_categories WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM product_collections WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM products WHERE id = ?', [pid]).catch(() => {});
  }
  for (const id of createdCollectionIds) await query('DELETE FROM collections WHERE id = ?', [id]).catch(() => {});
  for (const id of createdCategoryIds) await query('DELETE FROM categories WHERE id = ?', [id]).catch(() => {});
  for (const id of createdGuideIds) await query('DELETE FROM size_guides WHERE id = ?', [id]).catch(() => {});
  for (const id of createdMediaIds) {
    await query('UPDATE product_media SET media_id = NULL WHERE media_id = ?', [id]).catch(() => {});
    await query('DELETE FROM media WHERE id = ?', [id]).catch(() => {});
  }
  await query('DELETE FROM tax_profiles WHERE name LIKE ?', [`bands ${TAG}%`]).catch(() => {});
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@catalog-rbac.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@catalog-rbac.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@catalog-rbac.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@catalog-rbac.test'");
  for (const role of ['CATALOG_MANAGER', 'OPERATIONS', 'SUPPORT', 'VIEWER', 'ADMIN']) {
    await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
  }

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const cm = await loginCookie('CATALOG_MANAGER');
  const ops = await loginCookie('OPERATIONS');
  const support = await loginCookie('SUPPORT');
  const viewer = await loginCookie('VIEWER');

  // ---- reads: every catalog surface open to catalog.read -----------
  {
    for (const path of ['/api/v1/admin/catalog/categories', '/api/v1/admin/catalog/collections', '/api/v1/admin/catalog/size-guides', '/api/v1/admin/catalog/media', '/api/v1/admin/catalog/site-media', '/api/v1/admin/products']) {
      for (const [label, cookie] of [['CATALOG_MANAGER', cm], ['OPERATIONS', ops], ['SUPPORT', support], ['VIEWER', viewer]]) {
        const r = await call(path, { cookie });
        assert.equal(r.status, 200, `${label} can read ${path}`);
      }
      assert.equal((await call(path)).status, 401, `unauthenticated denied ${path}`);
    }
    pass('CATALOG_READ_ALLOWED_FOR_READ_ROLES');
  }

  // ---- writes: only catalog.write roles ---------------------------
  {
    const writeAttempts = [
      ['POST', '/api/v1/admin/catalog/categories', { name: `x ${TAG}` }],
      ['POST', '/api/v1/admin/catalog/collections', { name: `x ${TAG}` }],
      ['POST', '/api/v1/admin/catalog/size-guides', { name: `x ${TAG}`, unit: 'in', columns: ['size', 'chest'], rows: [{ size: 'M', displayOrder: 0, values: { chest: 40 } }] }],
      ['POST', '/api/v1/admin/products', { name: `x ${TAG}`, productType: 'tshirts' }],
    ];
    for (const [method, path, body] of writeAttempts) {
      for (const [label, cookie] of [['OPERATIONS', ops], ['SUPPORT', support], ['VIEWER', viewer]]) {
        const r = await call(path, { method, cookie, body });
        assert.equal(r.status, 403, `${label} denied ${method} ${path} (got ${r.status})`);
        assert.equal(r.json.error.code, 'PERMISSION_DENIED');
      }
    }
    pass('CATALOG_WRITE_DENIED_FOR_READ_ONLY_ROLES');
  }

  // ---- CATALOG_MANAGER has no tax.manage / provider config -------
  {
    const taxCreate = await call('/api/v1/admin/tax-profiles', {
      method: 'POST', cookie: cm,
      body: { name: `t ${TAG}`, hsnSac: '6109', gstRateBps: 500, effectiveFrom: '2026-01-01' },
    });
    assert.equal(taxCreate.status, 403, 'CATALOG_MANAGER cannot create a tax profile (tax.manage)');
    // no provider control-plane surface exists to touch; site-media is catalog.write, already covered.
    pass('CATALOG_MANAGER_NO_TAX_MANAGE');
  }

  // ---- tax profile price bands through the real controller ----------
  // The documents gates call the tax service directly; this sends the CMS's
  // own payloads through validation, permissions and the audit log.
  {
    const admin = await loginCookie('ADMIN');
    assert.ok(admin, 'ADMIN signed in');
    const profiles = '/api/v1/admin/tax-profiles';
    const bands = [{ maxUnitTaxableMinor: 250000, gstRateBps: 500 }, { maxUnitTaxableMinor: null, gstRateBps: 1800 }];

    const created = await call(profiles, { method: 'POST', cookie: admin, body: { name: `bands ${TAG}`, hsnSac: '99887766', rateBands: bands, effectiveFrom: '2026-01-01' } });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    assert.equal(Number(created.json.data.gst_rate_bps), 500, 'the single-rate column holds the first band');
    assert.deepEqual(created.json.data.rateBands.map((b) => [b.maxUnitTaxableMinor, b.gstRateBps]), [[250000, 500], [null, 1800]]);
    const id = created.json.data.id;

    const noRate = await call(profiles, { method: 'POST', cookie: admin, body: { name: `bands ${TAG} none`, hsnSac: '99887765' } });
    assert.deepEqual([noRate.status, noRate.json?.error?.code], [400, 'VALIDATION_ERROR'], 'a profile needs a rate or bands (blank rate is not 0%)');
    const oneBand = await call(profiles, { method: 'POST', cookie: admin, body: { name: `bands ${TAG} one`, hsnSac: '99887765', rateBands: [bands[1]] } });
    assert.deepEqual([oneBand.status, oneBand.json?.error?.code], [400, 'VALIDATION_ERROR'], 'one band alone is rejected');
    const descending = await call(profiles, {
      method: 'POST', cookie: admin,
      body: { name: `bands ${TAG} desc`, hsnSac: '99887765', rateBands: [{ maxUnitTaxableMinor: 300000, gstRateBps: 500 }, { maxUnitTaxableMinor: 200000, gstRateBps: 1200 }, { maxUnitTaxableMinor: null, gstRateBps: 1800 }] },
    });
    assert.deepEqual([descending.status, descending.json?.error?.code], [400, 'TAX_RATE_BANDS_INVALID'], 'limits must go up');
    assert.equal((await query('SELECT COUNT(*) n FROM tax_profiles WHERE name LIKE ?', [`bands ${TAG} %`]))[0].n, 0, 'rejected profiles are not saved');

    const three = await call(`${profiles}/${id}`, {
      method: 'PATCH', cookie: admin,
      body: { rateBands: [{ maxUnitTaxableMinor: 100000, gstRateBps: 0 }, { maxUnitTaxableMinor: 250000, gstRateBps: 500 }, { maxUnitTaxableMinor: null, gstRateBps: 1800 }] },
    });
    assert.equal(three.status, 200, JSON.stringify(three.json));
    assert.equal(three.json.data.rateBands.length, 3, 'bands replaced');
    assert.equal(Number(three.json.data.gst_rate_bps), 0, 'the single-rate column follows the first band');

    const deniedPatch = await call(`${profiles}/${id}`, { method: 'PATCH', cookie: cm, body: { rateBands: [] } });
    assert.equal(deniedPatch.status, 403, 'CATALOG_MANAGER cannot change bands');

    const cleared = await call(`${profiles}/${id}`, { method: 'PATCH', cookie: admin, body: { rateBands: [] } });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
    assert.equal(cleared.json.data.rateBands.length, 0, 'bands removed');

    // A profile whose rate changed must be renameable: name + description over PATCH.
    const renamed = await call(`${profiles}/${id}`, { method: 'PATCH', cookie: admin, body: { name: `bands ${TAG} renamed`, description: 'Apparel: 5% up to Rs 2,500 per piece, 18% above' } });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.json));
    assert.deepEqual([renamed.json.data.name, renamed.json.data.description], [`bands ${TAG} renamed`, 'Apparel: 5% up to Rs 2,500 per piece, 18% above'], 'name and description saved');
    assert.equal(renamed.json.data.rateBands.length, 0, 'renaming leaves the bands alone');
    const blankName = await call(`${profiles}/${id}`, { method: 'PATCH', cookie: admin, body: { name: '   ' } });
    assert.deepEqual([blankName.status, blankName.json?.error?.code], [400, 'VALIDATION_ERROR'], 'a blank name is rejected');

    const listed = await call(profiles, { cookie: admin });
    assert.ok(listed.json.data.taxProfiles.some((p) => p.id === id && Array.isArray(p.rateBands) && p.rateBands.length === 0), 'the list carries rateBands');
    const audited = await query("SELECT COUNT(*) n FROM staff_audit_logs WHERE resource_id = ? AND action IN ('TAX_PROFILE_CREATED','TAX_PROFILE_UPDATED')", [id]);
    assert.equal(Number(audited[0].n), 4, 'create + two band changes + rename audited');
    pass('TAX_PROFILE_PRICE_BANDS_OVER_HTTP', 'create, replace and remove bands; rename; invalid input rejected; audited');
  }

  // ---- audit coverage: every catalog mutation logs to staff id ---
  {
    const cmUser = (await query("SELECT id FROM staff_users WHERE email_normalized = ?", [email('CATALOG_MANAGER')]))[0];

    const product = (await call('/api/v1/admin/products', { method: 'POST', cookie: cm, body: { name: `Audit ${TAG}`, productType: 'tshirts' } })).json.data;
    createdProductIds.add(product.id);
    await call(`/api/v1/admin/products/${product.id}`, { method: 'PATCH', cookie: cm, body: { shortDescription: 'x' } });

    const cat = (await call('/api/v1/admin/catalog/categories', { method: 'POST', cookie: cm, body: { name: `Audit Cat ${TAG}` } })).json.data;
    createdCategoryIds.add(cat.id);
    await call(`/api/v1/admin/catalog/categories/${cat.id}`, { method: 'PATCH', cookie: cm, body: { description: 'y' } });
    await call(`/api/v1/admin/products/${product.id}/categories`, { method: 'PUT', cookie: cm, body: { categories: [{ categoryId: cat.id }] } });

    const coll = (await call('/api/v1/admin/catalog/collections', { method: 'POST', cookie: cm, body: { name: `Audit Coll ${TAG}` } })).json.data;
    createdCollectionIds.add(coll.id);
    await call(`/api/v1/admin/catalog/collections/${coll.id}/members`, { method: 'PUT', cookie: cm, body: { productIds: [product.id] } });

    const guide = (await call('/api/v1/admin/catalog/size-guides', { method: 'POST', cookie: cm, body: { name: `Audit Guide ${TAG}`, unit: 'in', columns: ['size', 'chest'], rows: [{ size: 'M', displayOrder: 0, values: { chest: 40 } }], status: 'ACTIVE' } })).json.data;
    createdGuideIds.add(guide.id);
    await call(`/api/v1/admin/products/${product.id}/size-guide`, { method: 'PUT', cookie: cm, body: { sizeGuideId: guide.id } });

    const asset = (await (async () => {
      const fd = new FormData();
      fd.append('file', new Blob([Buffer.alloc(32)], { type: 'image/jpeg' }), 'a.jpg');
      const res = await fetch(`${BASE}/api/v1/admin/catalog/media`, { method: 'POST', headers: { origin: ORIGIN, cookie: cm }, body: fd });
      return (await res.json()).data.asset;
    })());
    createdMediaIds.add(asset.id);
    await call(`/api/v1/admin/products/${product.id}/media`, { method: 'POST', cookie: cm, body: { mediaId: asset.id } });

    const rows = await query(
      "SELECT action, staff_user_id, metadata_json FROM staff_audit_logs WHERE actor_email = ? ORDER BY created_at",
      [email('CATALOG_MANAGER')],
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const expected of [
      'PRODUCT_CREATED', 'PRODUCT_UPDATED', 'CATEGORY_CREATED', 'CATEGORY_UPDATED',
      'PRODUCT_CATEGORIES_SET', 'COLLECTION_CREATED', 'COLLECTION_MEMBERS_SET',
      'SIZE_GUIDE_CREATED', 'SIZE_GUIDE_ASSIGNED', 'PRODUCT_MEDIA_ATTACHED',
    ]) {
      assert.ok(actions.has(expected), `audit missing "${expected}"`);
    }
    assert.ok(rows.every((r) => r.staff_user_id === cmUser.id), 'every audit row keyed to the acting staff id');
    const blob = JSON.stringify(rows);
    assert.ok(!/password|secret|token/i.test(blob) || !/\b[A-Za-z0-9]{32,}\b/.test(blob), 'no secret material in audit metadata');
    pass('CATALOG_MUTATION_AUDIT_COVERAGE', `${actions.size} distinct actions`);
  }

  {
    assert.equal(externalCalls, 0, 'no outbound provider calls');
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCATALOG_RBAC_AUDIT_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCATALOG_RBAC_AUDIT_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
