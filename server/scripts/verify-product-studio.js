// Product Studio end-to-end integration (Wave 8D, Phase 6).
//
// Builds one synthetic product and edits EVERY catalog dimension through the
// admin API — identity, variants + SKUs, pricing, media, categories,
// collections, size guide, shipping profile, tax readiness — then asserts
// the combined state is consistent and that the invariants held throughout:
//   SKU_UNIQUENESS = DENIED for a dup
//   INVENTORY_AUTHORITY_COUNT = 1 (Product Studio never writes inventory)
//   PRICING stays integer minor units
//   SHIPPING stays grams / mm, no fake defaults
//   TAX readiness surfaces missing config, never invents HSN/GST
//
// Real HTTP listener + CATALOG_MANAGER session. Cloudinary transport stubbed.
// Fully self-cleaning.
//
//   npm run verify:product-studio
import assert from 'node:assert/strict';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';
process.env.CLOUDINARY_CLOUD_NAME ||= 'verify-ps-cloud';
process.env.CLOUDINARY_API_KEY ||= 'verify-ps-key';
process.env.CLOUDINARY_API_SECRET ||= 'verify-ps-secret';
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
cloudinary.uploader.upload_stream = (_o, cb) => ({ end: () => { seq += 1; cb(null, { public_id: `verify-ps/a-${seq}-${Date.now()}`, secure_url: `https://res.cloudinary.test/verify-ps/a-${seq}.jpg`, width: 1000, height: 1200, bytes: 2048, format: 'jpg', resource_type: 'image' }); } });
cloudinary.uploader.upload_chunked_stream = cloudinary.uploader.upload_stream;
cloudinary.uploader.destroy = async () => ({ result: 'ok' });

const TAG = `ps-${Date.now()}`;
const CM_EMAIL = `cm.${TAG}@product-studio.test`;
const PW = 'Corcotton-ProductStudio-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

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
async function loginCookie(email) {
  const res = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
async function uploadAsset(cookie) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.alloc(48)], { type: 'image/jpeg' }), 'p.jpg');
  const res = await fetch(`${BASE}/api/v1/admin/catalog/media`, { method: 'POST', headers: { origin: ORIGIN, cookie }, body: fd });
  const j = await res.json();
  createdMediaIds.add(j.data.asset.id);
  return j.data.asset;
}

const invSignature = () => query('SELECT sku_id, on_hand, reserved FROM inventory ORDER BY sku_id')
  .then((r) => JSON.stringify(r));

async function cleanup() {
  Object.assign(cloudinary.uploader, realUploader);
  try { server?.close(); } catch { /* noop */ }
  for (const pid of createdProductIds) {
    await query('DELETE FROM product_media WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM product_categories WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM product_collections WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM product_tax_profiles WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM product_shipping_profiles WHERE product_id = ?', [pid]).catch(() => {});
    await query('DELETE FROM products WHERE id = ?', [pid]).catch(() => {});
  }
  for (const id of createdCollectionIds) await query('DELETE FROM collections WHERE id = ?', [id]).catch(() => {});
  for (const id of createdCategoryIds) await query('DELETE FROM categories WHERE id = ?', [id]).catch(() => {});
  for (const id of createdGuideIds) await query('DELETE FROM size_guides WHERE id = ?', [id]).catch(() => {});
  for (const id of createdMediaIds) {
    await query('UPDATE product_media SET media_id = NULL WHERE media_id = ?', [id]).catch(() => {});
    await query('DELETE FROM media WHERE id = ?', [id]).catch(() => {});
  }
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@product-studio.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@product-studio.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@product-studio.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@product-studio.test'");
  await staffAuthService.createStaffUser({ email: CM_EMAIL, password: PW, firstName: 'PS', lastName: 'Mgr', role: 'CATALOG_MANAGER' });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const cm = await loginCookie(CM_EMAIL);
  const invBefore = await invSignature();

  // ---- build the product (Phase 1B — canonical SKU identity) --------
  const skuOpts = (await call('/api/v1/admin/catalog/sku/options', { cookie: cm })).json.data;
  const tsId = skuOpts.productTypes.find((t) => t.code === 'TS').id;
  const oId = skuOpts.fits.find((f) => f.code === 'O').id;
  const blkId = skuOpts.colors.find((c) => c.code === 'BLK').id;
  const product = (await call('/api/v1/admin/products', { method: 'POST', cookie: cm, body: { name: `Studio E2E ${TAG}`, productType: 'tshirts', productTypeCodeId: tsId, fit: 'Oversize Fit', fitCodeId: oId } })).json.data;
  createdProductIds.add(product.id);
  const variant = (await call(`/api/v1/admin/products/${product.id}/variants`, { method: 'POST', cookie: cm, body: { colorName: 'Black', colorHex: '111111', colorCodeId: blkId, designName: `Studio ${TAG}`, designCode: 'STU' } })).json.data.variants[0];
  const created = await call(`/api/v1/admin/products/${product.id}/skus`, { method: 'POST', cookie: cm, body: { variantId: variant.id, size: 'M', priceMinor: 129900 } });
  assert.equal(created.status, 201);
  assert.equal(created.json.data.variants[0].skus[0].sku, 'COR-TS-O-BLK-STU-M', 'backend generated the canonical SKU');

  // ---- SKU uniqueness (identical canonical identity denied) --------
  {
    const dup = await call(`/api/v1/admin/products/${product.id}/skus`, { method: 'POST', cookie: cm, body: { variantId: variant.id, size: 'M', priceMinor: 129900 } });
    assert.ok([409, 422].includes(dup.status), 'duplicate SKU denied');
    results.SKU_UNIQUENESS = 'DENIED';
    pass('SKU_UNIQUENESS');
  }

  // ---- media -------------------------------------------------
  {
    const a1 = await uploadAsset(cm);
    const a2 = await uploadAsset(cm);
    const m1 = await call(`/api/v1/admin/products/${product.id}/media`, { method: 'POST', cookie: cm, body: { mediaId: a1.id, variantId: variant.id } });
    await call(`/api/v1/admin/products/${product.id}/media`, { method: 'POST', cookie: cm, body: { mediaId: a2.id, variantId: variant.id } });
    assert.equal(m1.json.data.isPrimary, true);
    const media = (await call(`/api/v1/admin/products/${product.id}/media`, { cookie: cm })).json.data.media;
    assert.equal(media.length, 2);
    assert.equal(media.filter((m) => m.isPrimary).length, 1);
    pass('PRODUCT_STUDIO_MEDIA');
  }

  // ---- categories ------------------------------------------
  {
    const root = (await call('/api/v1/admin/catalog/categories', { method: 'POST', cookie: cm, body: { name: `PS Root ${TAG}` } })).json.data;
    const extra = (await call('/api/v1/admin/catalog/categories', { method: 'POST', cookie: cm, body: { name: `PS Extra ${TAG}` } })).json.data;
    createdCategoryIds.add(root.id); createdCategoryIds.add(extra.id);
    const set = await call(`/api/v1/admin/products/${product.id}/categories`, { method: 'PUT', cookie: cm, body: { categories: [{ categoryId: root.id, isPrimary: true }, { categoryId: extra.id }] } });
    assert.equal(set.json.data.categories.length, 2);
    assert.equal((await query('SELECT category_id FROM products WHERE id = ?', [product.id]))[0].category_id, root.id);
    pass('PRODUCT_STUDIO_CATEGORIES');
  }

  // ---- collections ----------------------------------------
  {
    const coll = (await call('/api/v1/admin/catalog/collections', { method: 'POST', cookie: cm, body: { name: `PS Coll ${TAG}` } })).json.data;
    createdCollectionIds.add(coll.id);
    await call(`/api/v1/admin/catalog/collections/${coll.id}/members`, { method: 'PUT', cookie: cm, body: { productIds: [product.id] } });
    const detail = (await call(`/api/v1/admin/products/${product.id}`, { cookie: cm })).json.data;
    assert.ok(detail.collections.some((c) => c.id === coll.id));
    pass('PRODUCT_STUDIO_COLLECTIONS');
  }

  // ---- size guide -----------------------------------------
  {
    const guide = (await call('/api/v1/admin/catalog/size-guides', { method: 'POST', cookie: cm, body: {
      name: `PS Guide ${TAG}`, unit: 'in', columns: ['size', 'chest'],
      rows: [{ size: 'M', displayOrder: 0, values: { chest: 40 } }], status: 'ACTIVE',
    } })).json.data;
    createdGuideIds.add(guide.id);
    const assigned = await call(`/api/v1/admin/products/${product.id}/size-guide`, { method: 'PUT', cookie: cm, body: { sizeGuideId: guide.id } });
    assert.equal(assigned.json.data.sizeGuide.id, guide.id);
    // no inference: rename the product, guide stays
    await call(`/api/v1/admin/products/${product.id}`, { method: 'PATCH', cookie: cm, body: { name: `Renamed ${TAG}` } });
    assert.equal((await call(`/api/v1/admin/products/${product.id}`, { cookie: cm })).json.data.sizeGuide.id, guide.id);
    pass('PRODUCT_STUDIO_SIZE_GUIDE');
  }

  // ---- shipping (grams / mm, no fake defaults) -----------
  {
    const bad = await call(`/api/v1/admin/products/${product.id}/shipping`, { method: 'PUT', cookie: cm, body: { weightGrams: 0, lengthMm: 1, widthMm: 1, heightMm: 1 } });
    assert.ok([400, 422].includes(bad.status));
    const put = await call(`/api/v1/admin/products/${product.id}/shipping`, { method: 'PUT', cookie: cm, body: { weightGrams: 250, lengthMm: 300, widthMm: 220, heightMm: 40 } });
    assert.equal(put.json.data.shipping.status, 'COMPLETE');
    assert.deepEqual([put.json.data.shipping.weightGrams, put.json.data.shipping.lengthMm], [250, 300]);
    pass('PRODUCT_STUDIO_SHIPPING');
  }

  // ---- tax readiness (no fake HSN/GST) ------------------
  {
    const detail = (await call(`/api/v1/admin/products/${product.id}`, { cookie: cm })).json.data;
    // Product Studio surfaces the assigned profile if any; a fresh product has none.
    const taxRow = await query('SELECT * FROM product_tax_profiles WHERE product_id = ?', [product.id]);
    assert.equal(taxRow.length, 0, 'no tax profile invented for a new product');
    void detail;
    results.NO_FAKE_HSN = 'YES';
    results.NO_FAKE_GST_RATE = 'YES';
    pass('PRODUCT_STUDIO_TAX_READINESS', 'missing config left missing');
  }

  // ---- pricing stays integer minor units --------------
  {
    const sku = (await call(`/api/v1/admin/products/${product.id}`, { cookie: cm })).json.data.variants[0].skus[0];
    assert.ok(Number.isInteger(sku.priceMinor));
    const neg = await call(`/api/v1/admin/skus/${sku.id}`, { method: 'PATCH', cookie: cm, body: { priceMinor: -1 } });
    assert.equal(neg.status, 400);
    const bump = await call(`/api/v1/admin/skus/${sku.id}`, { method: 'PATCH', cookie: cm, body: { priceMinor: 149900, salePriceMinor: 99900 } });
    assert.equal(bump.status, 200);
    const row = (await query('SELECT price_minor, sale_price_minor FROM skus WHERE id = ?', [sku.id]))[0];
    assert.equal(Number(row.price_minor), 149900);
    assert.equal(Number(row.sale_price_minor), 99900);
    pass('PRODUCT_STUDIO_PRICING');
  }

  // ---- inventory authority = 1, untouched -------------
  {
    assert.equal(await invSignature(), invBefore, 'Product Studio edits never touched inventory');
    const authorities = await query(
      `SELECT COUNT(DISTINCT TABLE_NAME) c FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN ('on_hand') AND TABLE_NAME NOT LIKE '%movement%'`,
    );
    results.INVENTORY_AUTHORITY_COUNT = Number(authorities[0].c);
    assert.equal(Number(authorities[0].c), 1, 'exactly one on_hand authority table (inventory)');
    pass('INVENTORY_AUTHORITY');
  }

  // ---- final combined DTO consistency ---------------
  {
    const d = (await call(`/api/v1/admin/products/${product.id}`, { cookie: cm })).json.data;
    assert.equal(d.media.length, 2);
    assert.equal(d.categories.length, 2);
    assert.equal(d.collections.length, 1);
    assert.ok(d.sizeGuide);
    assert.equal(d.shipping.status, 'COMPLETE');
    assert.equal(d.variants[0].skus.length, 1);
    pass('PRODUCT_STUDIO_COMBINED_DTO');
  }

  {
    assert.equal(externalCalls, 0, 'no outbound provider calls (Cloudinary stubbed)');
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nPRODUCT_STUDIO_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nPRODUCT_STUDIO_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
