// CMS Product Studio (admin catalog API) verification.
// Runs against the local dev database over a real HTTP listener. Creates a
// throwaway product/variant/SKU and uses the existing seeded PLACED orders
// for the readiness re-evaluation test; restores all state at the end.
//
//   npm run verify:cms:catalog
import assert from 'node:assert/strict';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';

// Provider tripwire — any outbound call to a non-loopback host is a defect
// (no Cloudinary / logistics / payment provider from the admin catalog path).
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
const pass = (n) => { results[n] = 'PASS'; console.log(`  PASS  ${n}`); };

const TAG = `cmscat-${Date.now()}`;
const CM_EMAIL = `cm.${TAG}@catalog-verify.test`;
const VIEWER_EMAIL = `viewer.${TAG}@catalog-verify.test`;
const PW = 'Corcotton-CmsCatalog-Strong-Passphrase';
// Match the server's own CMS allow-list so this passes in any environment.
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;
const createdProductIds = new Set();
const createdShippingProductIds = new Set();
// productId -> the shipping profile row that was there before this script
// touched it, or null if there was none. The cleanup below used to DELETE the
// profile of every product it wrote to, including real catalogue products it
// had not created — which silently destroyed seeded carrier weights and then
// surfaced elsewhere as an unrelated quote failure.
const shippingProfileBefore = new Map();
const PROFILE_COLS = ['id', 'product_id', 'weight_grams', 'length_mm', 'width_mm', 'height_mm', 'created_at', 'updated_at'];

async function rememberShippingProfile(productId) {
  if (shippingProfileBefore.has(productId)) return;
  const [row] = await query(
    `SELECT ${PROFILE_COLS.join(', ')} FROM product_shipping_profiles WHERE product_id = ?`, [productId]);
  shippingProfileBefore.set(productId, row || null);
}

async function restoreShippingProfile(productId) {
  const before = shippingProfileBefore.get(productId);
  await query('DELETE FROM product_shipping_profiles WHERE product_id = ?', [productId]).catch(() => {});
  if (!before) return;
  await query(
    `INSERT INTO product_shipping_profiles (${PROFILE_COLS.join(', ')}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    PROFILE_COLS.map((c) => before[c])).catch(() => {});
}

async function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
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
const invSignature = async () => JSON.stringify({
  inv: await query('SELECT sku_id,on_hand,reserved FROM inventory ORDER BY sku_id'),
  movements: Number((await query('SELECT COUNT(*) c FROM inventory_movements'))[0].c),
});

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  for (const pid of createdShippingProductIds) {
    // Put back exactly what was there — which for a product this script
    // created is nothing, and for a real catalogue product is its original
    // weight and dimensions.
    await restoreShippingProfile(pid);
  }
  for (const pid of createdProductIds) {
    await query('DELETE FROM products WHERE id = ?', [pid]).catch(() => {});
  }
  // Restore readiness on any seeded order touched by the shipping test.
  const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
  const orders = await query(
    `SELECT DISTINCT f.order_id FROM fulfillments f WHERE f.status NOT IN ('FULFILLED','CANCELLED')`,
  );
  for (const { order_id } of orders) {
    await fulfillmentService.reevaluateReadiness(order_id).catch(() => {});
  }
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@catalog-verify.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@catalog-verify.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@catalog-verify.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@catalog-verify.test'");
  await staffAuthService.createStaffUser({ email: CM_EMAIL, password: PW, firstName: 'Cat', lastName: 'Mgr', role: 'CATALOG_MANAGER' });
  await staffAuthService.createStaffUser({ email: VIEWER_EMAIL, password: PW, firstName: 'View', lastName: 'Only', role: 'VIEWER' });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const cm = await loginCookie(CM_EMAIL);
  const viewer = await loginCookie(VIEWER_EMAIL);

  const invBefore = await invSignature();

  // ---- auth + RBAC ---------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/products')).status, 401, 'unauthenticated admin catalog denied');
    assert.equal((await call('/api/v1/admin/products', { cookie: viewer })).status, 200, 'VIEWER can read products');
    const vw = await call('/api/v1/admin/products', { method: 'POST', cookie: viewer, body: { name: 'X', productType: 'tee' } });
    assert.equal(vw.status, 403, 'VIEWER cannot create');
    assert.equal(vw.json.error.code, 'PERMISSION_DENIED');
    pass('AUTH_AND_RBAC');
  }

  // ---- product list: search / filter / pagination / shipping status --
  {
    const list = await call('/api/v1/admin/products?limit=5&sort=name', { cookie: cm });
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.json.data.products) && list.json.data.products.length > 0);
    assert.ok(list.json.data.products.length <= 5, 'pagination limit respected');
    assert.ok('total' in list.json.data && 'totalPages' in list.json.data);
    for (const p of list.json.data.products) {
      assert.ok(['COMPLETE', 'INCOMPLETE'].includes(p.shipping.status), 'shipping status derived');
      assert.ok(typeof p.variantCount === 'number' && typeof p.skuCount === 'number');
    }
    const incomplete = await call('/api/v1/admin/products?shipping=INCOMPLETE&limit=50', { cookie: cm });
    assert.ok(incomplete.json.data.products.every((p) => p.shipping.status === 'INCOMPLETE'), 'shipping filter works');
    const drafts = await call('/api/v1/admin/products?status=DRAFT&limit=50', { cookie: cm });
    assert.ok(drafts.json.data.products.every((p) => p.status === 'DRAFT'), 'status filter works');

    // ---- Phase 3 additive list facets ------------------------------------
    for (const p of list.json.data.products) {
      assert.ok('primaryMedia' in p, 'row carries primaryMedia (url or null)');
      assert.ok(typeof p.collectionCount === 'number', 'row carries collectionCount');
    }
    const desc = await call('/api/v1/admin/products?sort=name_desc&limit=50', { cookie: cm });
    assert.equal(desc.status, 200);
    const names = desc.json.data.products.map((p) => p.name);
    assert.deepEqual(names, [...names].sort((a, b) => b.localeCompare(a)), 'sort=name_desc orders Z-A');
    const noGuide = await call('/api/v1/admin/products?sizeGuide=unassigned&limit=50', { cookie: cm });
    assert.ok(noGuide.json.data.products.every((p) => !p.sizeGuideId), 'sizeGuide=unassigned filter works');
    const withGuide = await call('/api/v1/admin/products?sizeGuide=assigned&limit=50', { cookie: cm });
    assert.ok(withGuide.json.data.products.every((p) => p.sizeGuideId), 'sizeGuide=assigned filter works');
    assert.equal((await call('/api/v1/admin/products?sort=bogus', { cookie: cm })).status, 400, 'unknown sort rejected');
    pass('PRODUCT_LIST');
  }

  // ---- Phase 3 — product facets (real summary counts, no fake analytics) --
  {
    const f = await call('/api/v1/admin/products/facets', { cookie: cm });
    assert.equal(f.status, 200);
    const d = f.json.data;
    assert.ok(typeof d.total === 'number' && d.total > 0);
    assert.equal(d.byStatus.DRAFT + d.byStatus.ACTIVE + d.byStatus.ARCHIVED, d.total, 'status counts sum to total');
    assert.equal(d.shipping.rateReady + d.shipping.notRateReady, d.total, 'shipping counts sum to total');
    assert.equal(d.sizeGuide.assigned + d.sizeGuide.unassigned, d.total, 'size-guide counts sum to total');
    assert.ok(d.needsAttention <= d.byStatus.ACTIVE, 'needsAttention is a subset of ACTIVE');
    assert.equal((await call('/api/v1/admin/products/facets')).status, 401, 'facets requires a session');
    pass('PRODUCT_FACETS');
  }

  // ---- Phase 1B — canonical SKU identity option ids ----------------
  const skuOpts = (await call('/api/v1/admin/catalog/sku/options', { cookie: cm })).json.data;
  const TS_ID = skuOpts.productTypes.find((t) => t.code === 'TS').id;
  const RLX_ID = skuOpts.fits.find((f) => f.code === 'RLX').id;
  const BLK_ID = skuOpts.colors.find((c) => c.code === 'BLK').id;

  // ---- create (DRAFT) -----------------------------------------------
  let product;
  {
    const created = await call('/api/v1/admin/products', {
      method: 'POST', cookie: cm,
      body: { name: `Studio Test Tee ${TAG}`, productType: 'tshirts', productTypeCodeId: TS_ID, shortDescription: 'verify fixture', fit: 'Relaxed Fit', fitCodeId: RLX_ID },
    });
    assert.equal(created.status, 201);
    product = created.json.data;
    createdProductIds.add(product.id);
    assert.equal(product.status, 'DRAFT', 'new product is DRAFT');
    assert.match(product.slug, /^studio-test-tee-cmscat-\d+$/, 'slug derived from name');
    const row = (await query('SELECT status FROM products WHERE id = ?', [product.id]))[0];
    assert.equal(row.status, 'DRAFT');
    pass('PRODUCT_CREATE_DRAFT');
  }

  // ---- update basic field, then publish ---------------------------
  {
    const upd = await call(`/api/v1/admin/products/${product.id}`, {
      method: 'PATCH', cookie: cm, body: { shortDescription: 'updated copy', description: 'Long form.' },
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.json.data.shortDescription, 'updated copy');
    assert.equal(upd.json.data.name, product.name, 'unrelated field preserved');

    const dupSlug = await call(`/api/v1/admin/products/${product.id}`, { method: 'PATCH', cookie: cm, body: { slug: 'oversized-cotton-tee' } });
    assert.equal(dupSlug.status, 409, 'slug uniqueness enforced server-side');

    const status = await call(`/api/v1/admin/products/${product.id}/status`, { method: 'PATCH', cookie: cm, body: { status: 'ACTIVE' } });
    assert.equal(status.status, 200);
    assert.equal(status.json.data.status, 'ACTIVE');
    assert.ok(status.json.data.publishedAt, 'published_at stamped on first activation');
    pass('PRODUCT_UPDATE_AND_PUBLISH');
  }

  // ---- bulk status change (Products-list bulk bar) ---------------
  {
    assert.equal((await call('/api/v1/admin/products/bulk-status', { method: 'POST', body: { ids: [product.id], status: 'ARCHIVED' } })).status, 401,
      'bulk-status requires a session');
    const arch = await call('/api/v1/admin/products/bulk-status', { method: 'POST', cookie: cm, body: { ids: [product.id], status: 'ARCHIVED' } });
    assert.equal(arch.status, 200);
    assert.equal(arch.json.data.changed, 1);
    assert.equal(arch.json.data.failed, 0);
    assert.equal((await query('SELECT status FROM products WHERE id = ?', [product.id]))[0].status, 'ARCHIVED', 'row archived');
    // Idempotent — a second archive is a no-op change, not an error.
    const again = await call('/api/v1/admin/products/bulk-status', { method: 'POST', cookie: cm, body: { ids: [product.id], status: 'ARCHIVED' } });
    assert.equal(again.status, 200);
    // Restore for the rest of the suite.
    const back = await call('/api/v1/admin/products/bulk-status', { method: 'POST', cookie: cm, body: { ids: [product.id], status: 'ACTIVE' } });
    assert.equal(back.json.data.changed, 1);
    assert.equal((await query('SELECT status FROM products WHERE id = ?', [product.id]))[0].status, 'ACTIVE');
    // A partial-failure surfaces per-id, not as a 500.
    const mixed = await call('/api/v1/admin/products/bulk-status', { method: 'POST', cookie: cm, body: { ids: [product.id, '00000000-0000-4000-8000-0000000dead0'], status: 'ACTIVE' } });
    assert.equal(mixed.status, 200);
    assert.equal(mixed.json.data.failed, 1, 'unknown id reported as failed');
    assert.equal((await call('/api/v1/admin/products/bulk-status', { method: 'POST', cookie: viewer, body: { ids: [product.id], status: 'DRAFT' } })).status, 403,
      'VIEWER cannot bulk-change status');
    pass('PRODUCT_BULK_STATUS');
  }

  // ---- variants ---------------------------------------------------
  let variant;
  {
    const v1 = await call(`/api/v1/admin/products/${product.id}/variants`, {
      method: 'POST', cookie: cm, body: { colorName: 'Ink Black', colorHex: '111111', badge: 'New', colorCodeId: BLK_ID, designName: `Verify ${TAG}`, designCode: 'VER' },
    });
    assert.equal(v1.status, 201);
    variant = v1.json.data.variants.find((x) => x.colorName === 'Ink Black');
    assert.ok(variant && variant.colorHex === '#111111', 'hex normalized with #');

    const vu = await call(`/api/v1/admin/variants/${variant.id}`, { method: 'PATCH', cookie: cm, body: { badge: 'Core' } });
    assert.equal(vu.status, 200);
    assert.equal(vu.json.data.variants.find((x) => x.id === variant.id).badge, 'Core');
    pass('VARIANTS');
  }

  // ---- SKU: canonical generation, uniqueness, inventory identity ---
  {
    const s1 = await call(`/api/v1/admin/products/${product.id}/skus`, {
      method: 'POST', cookie: cm,
      body: { variantId: variant.id, size: 'M', priceMinor: 129900 },
    });
    assert.equal(s1.status, 201);
    const sku = s1.json.data.variants.find((v) => v.id === variant.id).skus.find((s) => s.size === 'M');
    assert.equal(sku.sku, 'COR-TS-RLX-BLK-VER-M', 'backend-generated canonical SKU string');
    assert.equal(sku.skuKind, 'CANONICAL');
    assert.equal(sku.priceMinor, 129900, 'price persisted as integer minor units');
    assert.deepEqual(sku.inventory, { configured: false }, 'no inventory row auto-created');

    // identical canonical identity (same variant + size) -> safe conflict
    const dup = await call(`/api/v1/admin/products/${product.id}/skus`, {
      method: 'POST', cookie: cm, body: { variantId: variant.id, size: 'M', priceMinor: 129900 },
    });
    assert.ok([409, 422].includes(dup.status), 'duplicate canonical SKU rejected');
    const skuCount = Number((await query('SELECT COUNT(*) c FROM skus WHERE sku = ?', ['COR-TS-RLX-BLK-VER-M']))[0].c);
    assert.equal(skuCount, 1, 'no partial writes from the failed create');
    pass('SKU_CREATE_AND_UNIQUENESS');
  }

  // ---- pricing validation ---------------------------------------
  {
    const sku = (await call(`/api/v1/admin/products/${product.id}`, { cookie: cm })).json.data
      .variants.find((v) => v.id === variant.id).skus[0];
    const neg = await call(`/api/v1/admin/skus/${sku.id}`, { method: 'PATCH', cookie: cm, body: { priceMinor: -1 } });
    assert.equal(neg.status, 400, 'negative price rejected');
    const badSale = await call(`/api/v1/admin/skus/${sku.id}`, { method: 'PATCH', cookie: cm, body: { salePriceMinor: 200000 } });
    assert.equal(badSale.status, 422, 'sale > regular rejected');
    const goodSale = await call(`/api/v1/admin/skus/${sku.id}`, { method: 'PATCH', cookie: cm, body: { priceMinor: 149900, salePriceMinor: 99900 } });
    assert.equal(goodSale.status, 200);
    const row = (await query('SELECT price_minor, sale_price_minor FROM skus WHERE id = ?', [sku.id]))[0];
    assert.equal(Number(row.price_minor), 149900);
    assert.equal(Number(row.sale_price_minor), 99900);
    pass('PRICING_MINOR_UNITS');
  }

  // ---- size guide assignment (explicit) ------------------------
  {
    const guides = (await call('/api/v1/admin/catalog/size-guides', { cookie: cm })).json.data.sizeGuides;
    // A rejected assignment is always exercised; the positive path needs a
    // real reusable guide (none seeded on some environments).
    const badAssign = await call(`/api/v1/admin/products/${product.id}/size-guide`, {
      method: 'PUT', cookie: cm, body: { sizeGuideId: '00000000-0000-0000-0000-000000000000' },
    });
    assert.equal(badAssign.status, 422, 'unknown size guide rejected');
    if (guides.length > 0) {
      const assign = await call(`/api/v1/admin/products/${product.id}/size-guide`, { method: 'PUT', cookie: cm, body: { sizeGuideId: guides[0].id } });
      assert.equal(assign.status, 200);
      assert.equal(assign.json.data.sizeGuide.id, guides[0].id);
      const clear = await call(`/api/v1/admin/products/${product.id}/size-guide`, { method: 'PUT', cookie: cm, body: { sizeGuideId: null } });
      assert.equal(clear.json.data.sizeGuide, null);
      pass('SIZE_GUIDE_EXPLICIT');
    } else {
      results.SIZE_GUIDE_EXPLICIT = 'PARTIAL (no reusable size guides in this environment; rejection path verified)';
      console.log(`  PART  SIZE_GUIDE_EXPLICIT — ${results.SIZE_GUIDE_EXPLICIT}`);
    }
  }

  // ---- shipping metadata: invalid rejection --------------------
  {
    for (const bad of [{ weightGrams: 0, lengthMm: 1, widthMm: 1, heightMm: 1 },
      { weightGrams: 100, lengthMm: -1, widthMm: 1, heightMm: 1 },
      { weightGrams: 100, lengthMm: 1, widthMm: 1 },
      { weightGrams: 'x', lengthMm: 1, widthMm: 1, heightMm: 1 },
      { weightGrams: 100.5, lengthMm: 1, widthMm: 1, heightMm: 1 }]) {
      const r = await call(`/api/v1/admin/products/${product.id}/shipping`, { method: 'PUT', cookie: cm, body: bad });
      assert.ok([400, 422].includes(r.status), `invalid shipping rejected: ${JSON.stringify(bad)} -> ${r.status}`);
    }
    const p = (await call(`/api/v1/admin/products/${product.id}`, { cookie: cm })).json.data;
    assert.equal(p.shipping.status, 'INCOMPLETE', 'no fake defaults written');
    assert.equal(p.shipping.weightGrams, null);
    // B4 (Phase 3) — getProduct surfaces the assigned tax profile; a fresh
    // product has none and none is invented.
    assert.ok('taxProfile' in p, 'getProduct carries taxProfile key');
    assert.equal(p.taxProfile, null, 'no tax profile invented for a new product');
    pass('SHIPPING_INVALID_REJECTED');
  }

  // ---- shipping profile write on the test product (always runs) ------
  {
    await rememberShippingProfile(product.id);
    createdShippingProductIds.add(product.id);
    const dims = { weightGrams: 250, lengthMm: 300, widthMm: 220, heightMm: 40 };
    const put = await call(`/api/v1/admin/products/${product.id}/shipping`, { method: 'PUT', cookie: cm, body: dims });
    assert.equal(put.status, 200);
    assert.equal(put.json.data.shipping.status, 'COMPLETE');
    assert.deepEqual(
      [put.json.data.shipping.weightGrams, put.json.data.shipping.lengthMm, put.json.data.shipping.widthMm, put.json.data.shipping.heightMm],
      [250, 300, 220, 40], 'canonical grams/mm persisted exactly (kg/cm conversion is UI-side)',
    );
    const again = await call(`/api/v1/admin/products/${product.id}/shipping`, { method: 'PUT', cookie: cm, body: dims });
    assert.equal(again.json.data.readiness.changed, 0, 're-saving identical metadata changes nothing');
    const reloaded = (await call(`/api/v1/admin/products/${product.id}`, { cookie: cm })).json.data;
    assert.equal(reloaded.shipping.status, 'COMPLETE');
    pass('SHIPPING_METADATA_WRITE');
  }

  // ---- readiness re-evaluation on a real seeded blocked fulfillment
  {
    const blocked = (await query(
      `SELECT f.id fid, f.order_id FROM fulfillments f
       WHERE f.status NOT IN ('FULFILLED','CANCELLED') AND f.readiness_status='BLOCKED'
         AND f.block_reason='MISSING_SHIPPING_METADATA' LIMIT 1`,
    ))[0];
    if (!blocked) {
      results.SHIPPING_READINESS_REEVAL = 'PARTIAL (no seeded BLOCKED/MISSING_SHIPPING_METADATA fulfillment in this environment)';
      console.log(`  PART  SHIPPING_READINESS_REEVAL — ${results.SHIPPING_READINESS_REEVAL}`);
    } else {

    const prods = await query(
      `SELECT DISTINCT v.product_id FROM fulfillment_items fi
       JOIN skus s ON s.id=fi.sku_id JOIN product_variants v ON v.id=s.variant_id
       WHERE fi.fulfillment_id = ?`, [blocked.fid],
    );
    const orderBefore = JSON.stringify((await query('SELECT * FROM orders WHERE id = ?', [blocked.order_id]))[0]);
    const shipmentsBefore = await query('SELECT id,status FROM shipments WHERE fulfillment_id = ?', [blocked.fid]);

    const dims = { weightGrams: 250, lengthMm: 300, widthMm: 220, heightMm: 40 };

    // The assertions below walk a fulfilment from BLOCKED to READY one product
    // at a time, so every one of its products has to start WITHOUT metadata.
    // That used to be inherited from the environment: it held only while no
    // one had seeded carrier weights, and stopped holding the moment someone
    // did. Establish it here instead, having first recorded what to put back.
    for (const { product_id: pid } of prods) {
      // eslint-disable-next-line no-await-in-loop
      await rememberShippingProfile(pid);
      createdShippingProductIds.add(pid);
      // eslint-disable-next-line no-await-in-loop
      await query('DELETE FROM product_shipping_profiles WHERE product_id = ?', [pid]);
    }
    // Re-derive the stored readiness from the state just established, so the
    // loop starts from a real BLOCKED rather than a stale one.
    const { fulfillmentService: fulfillmentForSetup } = await import('../src/modules/fulfillment/service.js');
    await fulfillmentForSetup.reevaluateReadiness(blocked.order_id);

    let lastReadiness;
    for (let i = 0; i < prods.length; i += 1) {
      const pid = prods[i].product_id;
      const put = await call(`/api/v1/admin/products/${pid}/shipping`, { method: 'PUT', cookie: cm, body: dims });
      assert.equal(put.status, 200);
      assert.equal(put.json.data.shipping.status, 'COMPLETE');
      assert.deepEqual(
        [put.json.data.shipping.weightGrams, put.json.data.shipping.lengthMm, put.json.data.shipping.widthMm, put.json.data.shipping.heightMm],
        [250, 300, 220, 40], 'canonical grams/mm persisted exactly',
      );
      lastReadiness = put.json.data.readiness;
      const f = (await query('SELECT readiness_status, block_reason FROM fulfillments WHERE id = ?', [blocked.fid]))[0];
      if (i < prods.length - 1) {
        assert.equal(f.readiness_status, 'BLOCKED', 'still blocked while another item lacks metadata (no false READY)');
      } else {
        assert.equal(f.readiness_status, 'READY', 'flips to READY once every item has metadata');
        assert.equal(f.block_reason, null);
      }
    }
    assert.ok(lastReadiness.affectedOrders >= 1 && lastReadiness.changed >= 1, 'readiness summary reports the change');

    // shipment stays DRAFT; no provider fields
    for (const s of await query("SELECT status, provider_code, tracking_number, external_shipment_id FROM shipments WHERE fulfillment_id = ?", [blocked.fid])) {
      assert.equal(s.status, 'DRAFT', 'shipment remains DRAFT (no booking)');
      assert.equal(s.provider_code, null);
      assert.equal(s.tracking_number, null);
      assert.equal(s.external_shipment_id, null);
    }
    void shipmentsBefore;

    // idempotency: same PUT again -> no change
    const again = await call(`/api/v1/admin/products/${prods[prods.length - 1].product_id}/shipping`, { method: 'PUT', cookie: cm, body: dims });
    assert.equal(again.json.data.readiness.changed, 0, 're-saving identical metadata changes nothing');

    // order snapshot immutable
    assert.equal(JSON.stringify((await query('SELECT * FROM orders WHERE id = ?', [blocked.order_id]))[0]), orderBefore, 'order snapshot unchanged');
    pass('SHIPPING_READINESS_REEVAL');
    }
  }

  // ---- audit trail from session identity -------------------------
  {
    const rows = await query(
      "SELECT action, staff_user_id, metadata_json FROM staff_audit_logs WHERE actor_email = ? ORDER BY created_at", [CM_EMAIL],
    );
    const actions = new Set(rows.map((r) => r.action));
    const expected = ['PRODUCT_CREATED', 'PRODUCT_UPDATED', 'PRODUCT_STATUS_CHANGED', 'VARIANT_CREATED', 'VARIANT_UPDATED', 'SKU_CREATED', 'SKU_UPDATED', 'SHIPPING_PROFILE_UPDATED'];
    // SIZE_GUIDE_ASSIGNED only fires when a real guide was assignable above.
    if (results.SIZE_GUIDE_EXPLICIT === 'PASS') expected.push('SIZE_GUIDE_ASSIGNED');
    for (const a of expected) {
      assert.ok(actions.has(a), `audit missing ${a}`);
    }
    assert.ok(rows.every((r) => r.staff_user_id), 'every audit row keyed to the authenticated staff id');
    const blob = JSON.stringify(rows);
    assert.ok(!/password|token|secret|hash/i.test(blob) || !/\b[A-Za-z0-9]{32,}\b/.test(blob), 'no secret material in audit');
    pass('AUDIT_TRAIL');
  }

  // ---- inventory isolation + provider tripwire ------------------
  {
    assert.equal(await invSignature(), invBefore, 'no inventory mutation from Product Studio edits');
    assert.equal(externalCalls, 0, 'zero outbound provider calls');
    pass('INVENTORY_ISOLATION_AND_NO_PROVIDER');
  }

  // ---- storefront still serves ---------------------------------
  {
    assert.equal((await call('/api/v1/products?limit=1')).status, 200);
    assert.equal((await call('/api/v1/collections')).status, 200);
    pass('STOREFRONT_REGRESSION');
  }

  console.log('\nCMS_CATALOG_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCMS_CATALOG_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
