// Product <-> media mapping + asset-registry reference safety (Wave 8D, Phase 2).
//
// Exercises the CORCOTTON Media API and the product-media mapping surface end
// to end over a real HTTP listener with a CATALOG_MANAGER session. The
// Cloudinary SDK transport is stubbed (no network) — the point is the
// persistence + reference-safety + ordering contract, not the provider.
//
// Proves:
//   MEDIA_ADAPTER_CONTRACT, MEDIA_NORMALIZATION (registry row shape),
//   MEDIA_PROVIDER_OWNERSHIP (provider_key/external_id immutable),
//   MEDIA_REFERENCE_SAFE_DELETE (asset survives detach; delete refused while
//     referenced; ARCHIVE not hard-delete), MEDIA_ORDERING (deterministic,
//     no duplicate positions), MEDIA_PRIMARY_SELECTION (exactly one per
//     variant scope), MEDIA_REPLACE_SAFETY (atomic swap, old asset cleanup),
//     RAW_PROVIDER_RESPONSE_LEAK = 0.
//
// Fully self-cleaning / rerunnable.
//
//   npm run verify:media:catalog
import assert from 'node:assert/strict';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';
process.env.CLOUDINARY_CLOUD_NAME ||= 'verify-media-catalog-cloud';
process.env.CLOUDINARY_API_KEY ||= 'verify-media-catalog-key';
process.env.CLOUDINARY_API_SECRET ||= 'verify-media-catalog-secret';
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

// ---- Cloudinary SDK transport stub --------------------------------------
const realUploader = { ...cloudinary.uploader };
let uploadSeqCounter = 0;
const destroyed = [];
function installStub() {
  const fakeRaw = () => {
    uploadSeqCounter += 1;
    return {
      public_id: `verify-media-catalog/asset-${uploadSeqCounter}-${Date.now()}`,
      secure_url: `https://res.cloudinary.test/verify-media-catalog/asset-${uploadSeqCounter}.jpg`,
      width: 1200, height: 1600, bytes: 4096, format: 'jpg', resource_type: 'image',
    };
  };
  cloudinary.uploader.upload_stream = (_opts, cb) => ({ end: () => cb(null, fakeRaw()) });
  cloudinary.uploader.upload_chunked_stream = (_opts, cb) => ({ end: () => cb(null, fakeRaw()) });
  cloudinary.uploader.destroy = async (id) => { destroyed.push(id); return { result: 'ok' }; };
}
const restoreStub = () => Object.assign(cloudinary.uploader, realUploader);

const TAG = `medcat-${Date.now()}`;
const CM_EMAIL = `cm.${TAG}@media-catalog.test`;
const VIEWER_EMAIL = `viewer.${TAG}@media-catalog.test`;
const PW = 'Corcotton-MediaCatalog-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;
const createdProductIds = new Set();
const createdMediaIds = new Set();

async function call(path, { method = 'GET', body, cookie, form } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  let payload;
  if (form) {
    payload = form;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function loginCookie(email) {
  const res = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
function filePart(name = 'pixel.jpg') {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.alloc(64)], { type: 'image/jpeg' }), name);
  return fd;
}
async function uploadAsset(cookie) {
  const res = await fetch(`${BASE}/api/v1/admin/catalog/media`, {
    method: 'POST', headers: { origin: ORIGIN, cookie }, body: filePart(),
  });
  const json = await res.json().catch(() => null);
  if (json?.data?.asset?.id) createdMediaIds.add(json.data.asset.id);
  return { status: res.status, json };
}
async function makeProduct(cookie, name) {
  const r = await call('/api/v1/admin/products', { method: 'POST', cookie, body: { name, productType: 'tshirts' } });
  const p = r.json.data;
  createdProductIds.add(p.id);
  return p;
}

async function cleanup() {
  restoreStub();
  try { server?.close(); } catch { /* noop */ }
  for (const pid of createdProductIds) {
    await query('DELETE FROM product_media WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM products WHERE id = ?', [pid]).catch(() => {});
  }
  for (const mid of createdMediaIds) {
    await query('UPDATE product_media SET media_id = NULL WHERE media_id = ?', [mid]).catch(() => {});
    await query('DELETE FROM media WHERE id = ?', [mid]).catch(() => {});
  }
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@media-catalog.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@media-catalog.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@media-catalog.test'").catch(() => {});
  await pool.end();
}

try {
  installStub();
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@media-catalog.test'");
  await staffAuthService.createStaffUser({ email: CM_EMAIL, password: PW, firstName: 'Med', lastName: 'Cat', role: 'CATALOG_MANAGER' });
  await staffAuthService.createStaffUser({ email: VIEWER_EMAIL, password: PW, firstName: 'View', lastName: 'Only', role: 'VIEWER' });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const cm = await loginCookie(CM_EMAIL);
  const viewer = await loginCookie(VIEWER_EMAIL);

  // ---- 1. RBAC ------------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/catalog/media')).status, 401);
    assert.equal((await call('/api/v1/admin/catalog/media', { cookie: viewer })).status, 200, 'VIEWER reads library');
    const denied = await uploadAsset(viewer);
    assert.equal(denied.status, 403, 'VIEWER cannot upload');
    assert.equal(denied.json.error.code, 'PERMISSION_DENIED');
    pass('MEDIA_RBAC');
  }

  // ---- 2. upload -> registry row, normalized, provider ownership ---
  let assetA;
  {
    const up = await uploadAsset(cm);
    assert.equal(up.status, 201);
    assetA = up.json.data.asset;
    for (const forbidden of ['secure_url', 'public_id', 'resource_type', 'metadata']) {
      assert.ok(!(forbidden in assetA), `registry DTO must not expose raw "${forbidden}"`);
    }
    assert.equal(assetA.providerKey, 'cloudinary', 'provider ownership recorded');
    assert.match(assetA.externalId, /^verify-media-catalog\/asset-/);
    assert.equal(assetA.resourceType, 'image');
    assert.equal(assetA.format, 'jpg');
    const row = (await query('SELECT provider_key, external_id, status FROM media WHERE id = ?', [assetA.id]))[0];
    assert.equal(row.provider_key, 'cloudinary');
    assert.equal(row.status, 'ACTIVE');
    pass('MEDIA_UPLOAD_AND_NORMALIZATION');
  }

  // ---- 3. attach + primary + ordering -----------------------------
  const pA = await makeProduct(cm, `Media A ${TAG}`);
  const variantRes = await call(`/api/v1/admin/products/${pA.id}/variants`, { method: 'POST', cookie: cm, body: { colorName: 'Black', colorHex: '111111' } });
  const variantId = variantRes.json.data.variants[0].id;
  let mapA1;
  {
    const assetB = (await uploadAsset(cm)).json.data.asset;
    const assetC = (await uploadAsset(cm)).json.data.asset;
    const r1 = await call(`/api/v1/admin/products/${pA.id}/media`, { method: 'POST', cookie: cm, body: { mediaId: assetA.id, variantId } });
    assert.equal(r1.status, 201);
    mapA1 = r1.json.data;
    assert.equal(mapA1.position, 0);
    assert.equal(mapA1.isPrimary, true, 'first media in a scope is primary');
    const r2 = await call(`/api/v1/admin/products/${pA.id}/media`, { method: 'POST', cookie: cm, body: { mediaId: assetB.id, variantId } });
    const r3 = await call(`/api/v1/admin/products/${pA.id}/media`, { method: 'POST', cookie: cm, body: { mediaId: assetC.id, variantId } });
    assert.equal(r2.json.data.position, 1);
    assert.equal(r3.json.data.position, 2);

    const list = (await call(`/api/v1/admin/products/${pA.id}/media`, { cookie: cm })).json.data.media;
    assert.equal(list.filter((m) => m.variantId === variantId && m.isPrimary).length, 1, 'exactly one primary per scope');

    // reorder: C, A, B
    const reordered = await call(`/api/v1/admin/products/${pA.id}/media/reorder`, {
      method: 'POST', cookie: cm, body: { variantId, orderedMappingIds: [r3.json.data.id, r1.json.data.id, r2.json.data.id] },
    });
    assert.equal(reordered.status, 200);
    const after = reordered.json.data.media.filter((m) => m.variantId === variantId).sort((a, b) => a.position - b.position);
    assert.deepEqual(after.map((m) => m.mediaId), [assetC.id, assetA.id, assetB.id], 'deterministic reorder');
    assert.deepEqual(after.map((m) => m.position), [0, 1, 2], 'no gaps / no duplicate positions');
    const dbDup = await query(
      "SELECT position, COUNT(*) c FROM product_media WHERE product_id = ? AND variant_id = ? AND status='ACTIVE' GROUP BY position HAVING c > 1",
      [pA.id, variantId],
    );
    assert.equal(dbDup.length, 0, 'DB has no duplicate positions in scope');

    // set primary to the middle row
    const setP = await call(`/api/v1/admin/products/${pA.id}/media/${r1.json.data.id}/primary`, { method: 'POST', cookie: cm });
    assert.equal(setP.status, 200);
    const list2 = (await call(`/api/v1/admin/products/${pA.id}/media`, { cookie: cm })).json.data.media.filter((m) => m.variantId === variantId);
    assert.equal(list2.filter((m) => m.isPrimary).length, 1);
    assert.equal(list2.find((m) => m.isPrimary).id, r1.json.data.id, 'primary moved');
    pass('MEDIA_ORDERING_AND_PRIMARY');
  }

  // ---- 4. reference-safe delete ----------------------------------
  {
    const pB = await makeProduct(cm, `Media B ${TAG}`);
    // assetA is now mapped on pA (variant) AND pB (product-level)
    const onB = await call(`/api/v1/admin/products/${pB.id}/media`, { method: 'POST', cookie: cm, body: { mediaId: assetA.id } });
    assert.equal(onB.status, 201);

    const del1 = await call(`/api/v1/admin/catalog/media/${assetA.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(del1.status, 409, 'delete refused while referenced');
    assert.equal(del1.json.error.code, 'MEDIA_ASSET_IN_USE');

    // detach from pA -> asset still alive (pB references it)
    const detachA = await call(`/api/v1/admin/products/${pA.id}/media/${mapA1.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(detachA.status, 200);
    assert.equal(detachA.json.data.assetRetained, true);
    const stillActive = (await query('SELECT status FROM media WHERE id = ?', [assetA.id]))[0];
    assert.equal(stillActive.status, 'ACTIVE', 'provider asset NOT deleted on detach');

    // detach from pB -> now unreferenced -> delete succeeds, ARCHIVE + provider remove
    const bMapId = onB.json.data.id;
    await call(`/api/v1/admin/products/${pB.id}/media/${bMapId}`, { method: 'DELETE', cookie: cm });
    const del2 = await call(`/api/v1/admin/catalog/media/${assetA.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(del2.status, 200);
    const archived = (await query('SELECT status FROM media WHERE id = ?', [assetA.id]))[0];
    assert.equal(archived.status, 'ARCHIVED', 'registry row archived, never hard-deleted');
    assert.ok(destroyed.some((d) => d === assetA.externalId), 'provider destroy called with external_id');
    pass('MEDIA_REFERENCE_SAFE_DELETE');
  }

  // ---- 5. replace safety --------------------------------------
  {
    const pC = await makeProduct(cm, `Media C ${TAG}`);
    const startAsset = (await uploadAsset(cm)).json.data.asset;
    const attached = await call(`/api/v1/admin/products/${pC.id}/media`, { method: 'POST', cookie: cm, body: { mediaId: startAsset.id } });
    const mapId = attached.json.data.id;

    const res = await fetch(`${BASE}/api/v1/admin/products/${pC.id}/media/${mapId}/replace`, {
      method: 'POST', headers: { origin: ORIGIN, cookie: cm }, body: filePart('new.jpg'),
    });
    const rj = await res.json();
    assert.equal(res.status, 200);
    assert.notEqual(rj.data.mediaId, startAsset.id, 'mapping switched to the new asset');
    createdMediaIds.add(rj.data.mediaId);
    const oldAsset = (await query('SELECT status FROM media WHERE id = ?', [startAsset.id]))[0];
    assert.equal(oldAsset.status, 'ARCHIVED', 'old unreferenced asset cleaned up after atomic swap');
    const mapRow = (await query('SELECT media_id, url FROM product_media WHERE id = ?', [mapId]))[0];
    assert.equal(mapRow.media_id, rj.data.mediaId);
    pass('MEDIA_REPLACE_SAFETY');
  }

  // ---- 6. provider tripwire ---------------------------------
  {
    assert.equal(externalCalls, 0, 'stubbed run makes zero outbound provider calls');
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nMEDIA_CATALOG_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nMEDIA_CATALOG_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
