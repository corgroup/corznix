// Catalog storefront + Product Studio characterization baseline (Wave 8D, Phase 1).
//
// Freezes the OBSERVABLE contract of the catalog read surface BEFORE any Wave 8D
// change, so the later phases (normalized media, product<->category / <->collection
// mappings, API-driven size guides, public DTO extension) can prove
//   BEFORE == AFTER   for every field that already exists.
//
// Wave 8D is additive-only on these contracts: this script asserts the CURRENT
// key sets and ordering rules exactly. A later phase may ADD keys (the assertions
// use subset checks where a field is expected to grow) but must not remove or
// reshape one — re-running this script after each phase is the regression gate.
//
// Read-only for storefront endpoints. The admin (Product Studio) reads need a
// staff session, so one throwaway CATALOG_MANAGER is created and removed in
// `finally` — no catalog/product/media/size-guide row is created or mutated.
//
//   npm run verify:catalog:baseline
import assert from 'node:assert/strict';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';

// Provider tripwire — the catalog read surface must never reach a third-party host.
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
const gap = (n, note) => { results[n] = `DATA_GAP (${note})`; console.log(`  GAP   ${n} — ${note}`); };

const TAG = `catbase-${Date.now()}`;
const CM_EMAIL = `cm.${TAG}@catalog-baseline.test`;
const PW = 'Corcotton-CatalogBaseline-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];

let server, BASE;

async function get(path, cookie) {
  const headers = {};
  if (cookie) headers.cookie = cookie;
  const res = await fetch(`${BASE}${path}`, { headers });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function loginCookie(email) {
  const res = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email, password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
const hasKeys = (obj, keys, label) => {
  for (const k of keys) assert.ok(obj && k in obj, `${label}: missing key "${k}" (present: ${Object.keys(obj || {}).join(',')})`);
};
const isSortedAsc = (arr) => arr.every((v, i) => i === 0 || arr[i - 1] <= v);

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@catalog-baseline.test')").catch(() => {});
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@catalog-baseline.test'").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@catalog-baseline.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@catalog-baseline.test'");
  await staffAuthService.createStaffUser({ email: CM_EMAIL, password: PW, firstName: 'Cat', lastName: 'Base', role: 'CATALOG_MANAGER' });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const cm = await loginCookie(CM_EMAIL);

  // Anchor fixtures — the richest real product (4 variants, 13 media, 2 collections).
  const ANCHOR_SLUG = 'oversized-cotton-tee';

  // ---- 1. public product list DTO -------------------------------------
  {
    const r = await get('/api/v1/products?limit=8');
    assert.equal(r.status, 200);
    hasKeys(r.json, ['data'], 'products response');
    hasKeys(r.json.data, ['products', 'total', 'page', 'totalPages'], 'products.data');
    assert.ok(Array.isArray(r.json.data.products) && r.json.data.products.length > 0, 'at least one product');
    assert.ok(r.json.data.products.length <= 8, 'limit respected');

    const CARD_KEYS = [
      'productId', 'productSlug', 'productName', 'shortDescription', 'description',
      'fit', 'productType', 'categorySlug', 'categoryName', 'parentCategoryName', 'parentCategorySlug',
      'variantId', 'storefrontId', 'colorName', 'colorHex', 'badge', 'createdAt',
      'priceMinor', 'regularPriceMinor', 'onSale', 'sizes', 'media', 'colorSiblings',
    ];
    for (const p of r.json.data.products) {
      hasKeys(p, CARD_KEYS, 'product card');
      assert.ok(Number.isInteger(p.priceMinor), 'priceMinor is integer minor units');
      assert.ok(Number.isInteger(p.regularPriceMinor), 'regularPriceMinor is integer minor units');
      assert.ok(Array.isArray(p.sizes) && Array.isArray(p.media) && Array.isArray(p.colorSiblings));
      for (const m of p.media) hasKeys(m, ['id', 'mediaType', 'url', 'altText', 'position', 'variantId'], 'card media');
      assert.ok(isSortedAsc(p.media.map((m) => m.position)), 'card media ordered by position asc');
    }
    pass('PUBLIC_PRODUCT_LIST_DTO', `${r.json.data.total} products, card shape frozen`);
  }

  // ---- 2. public PDP by slug ----------------------------------------
  let anchorDetail;
  {
    const r = await get(`/api/v1/products/by-slug/${ANCHOR_SLUG}`);
    assert.equal(r.status, 200);
    anchorDetail = r.json.data;
    hasKeys(anchorDetail, [
      'id', 'slug', 'name', 'shortDescription', 'description', 'brand', 'fit', 'productType',
      'status', 'category', 'categories', 'collections', 'sizeGuide', 'variants',
    ], 'PDP detail');
    assert.equal(anchorDetail.status, 'ACTIVE');
    assert.ok(Array.isArray(anchorDetail.collections) && anchorDetail.collections.length >= 1, 'PDP collections array');
    for (const c of anchorDetail.collections) hasKeys(c, ['id', 'name', 'slug'], 'PDP collection');
    // Wave 8D additive: full ACTIVE category membership, primary first.
    assert.ok(Array.isArray(anchorDetail.categories) && anchorDetail.categories.length >= 1, 'PDP categories[]');
    for (const c of anchorDetail.categories) hasKeys(c, ['id', 'name', 'slug', 'isPrimary'], 'PDP category membership');
    assert.equal(anchorDetail.categories[0].isPrimary, true, 'primary category listed first');

    // category carries an optional nested parent
    assert.ok(anchorDetail.category && 'parent' in anchorDetail.category, 'PDP category.parent present (nullable)');
    hasKeys(anchorDetail.category, ['id', 'name', 'slug', 'parent'], 'PDP category');

    // variants -> skus -> availability, and per-variant media ordered by position
    assert.ok(anchorDetail.variants.length === 4, 'anchor has 4 variants');
    for (const v of anchorDetail.variants) {
      hasKeys(v, ['id', 'storefrontId', 'colorName', 'colorHex', 'badge', 'status', 'createdAt', 'skus', 'media'], 'PDP variant');
      assert.ok(isSortedAsc(v.media.map((m) => m.position)), 'PDP variant media ordered by position asc');
      for (const m of v.media) assert.ok('isPrimary' in m, 'PDP media carries isPrimary (additive)');
      assert.equal(v.media.filter((m) => m.isPrimary).length <= 1, true, 'at most one primary per variant scope');
      for (const s of v.skus) {
        hasKeys(s, ['id', 'sku', 'size', 'status', 'priceMinor', 'salePriceMinor', 'currency', 'availability'], 'PDP sku');
        assert.ok(Number.isInteger(s.priceMinor), 'PDP sku priceMinor integer');
        hasKeys(s.availability, ['status'], 'PDP sku availability');
      }
    }
    pass('PUBLIC_PDP_BY_SLUG_DTO', `${anchorDetail.variants.length} variants frozen`);
  }

  // ---- 3. PDP sizeGuide contract -----------------------------------
  {
    // Wave 8D Phase 3: size guides are API-driven. A product with an explicit
    // size_guide_id gets the full guide DTO on its PDP; an unmapped product
    // still returns null (the PDP Size Guide control stays hidden — no visual
    // change there). Mapping is explicit only, never inferred.
    const withGuide = Number((await query('SELECT COUNT(*) c FROM products WHERE size_guide_id IS NOT NULL'))[0].c);
    const anchorHasGuide = (await query("SELECT size_guide_id FROM products WHERE slug = ?", [ANCHOR_SLUG]))[0].size_guide_id != null;

    if (anchorHasGuide) {
      assert.ok(anchorDetail.sizeGuide && typeof anchorDetail.sizeGuide === 'object', 'mapped anchor returns a guide DTO');
      hasKeys(anchorDetail.sizeGuide, ['id', 'name', 'title', 'slug', 'unit', 'columns', 'rows'], 'PDP sizeGuide');
      assert.ok(anchorDetail.sizeGuide.columns.includes('size'), 'columns include "size"');
      for (const row of anchorDetail.sizeGuide.rows) assert.ok('size' in row, 'each guide row has a size');
      pass('PDP_SIZE_GUIDE_SOURCE', `API-driven; ${withGuide} product(s) mapped`);
    } else {
      assert.equal(anchorDetail.sizeGuide, null, 'unmapped anchor PDP sizeGuide is null');
      gap('PDP_SIZE_GUIDE_SOURCE', 'anchor not mapped to a guide');
    }

    // an unmapped product always returns null (control hidden — no regression)
    const unmapped = await get('/api/v1/products/by-slug/ribbed-cotton-polo');
    assert.equal(unmapped.json.data.sizeGuide, null, 'unmapped product PDP sizeGuide is null');
  }

  // ---- 4. PDP by numeric storefront id ----------------------------
  {
    const sfid = anchorDetail.variants[0].storefrontId;
    const r = await get(`/api/v1/products/${sfid}`);
    assert.equal(r.status, 200);
    hasKeys(r.json.data, ['activeVariantId', 'activeVariant', 'siblingVariants', 'variants', 'sizeGuide'], 'PDP by storefrontId');
    assert.equal(r.json.data.activeVariantId, r.json.data.activeVariant.id);
    assert.ok(r.json.data.siblingVariants.length >= 1);
    pass('PUBLIC_PDP_BY_STOREFRONT_ID_DTO');
  }

  // ---- 5. collections endpoint (merged collections + categories) --
  {
    const r = await get('/api/v1/collections');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json.data));
    for (const c of r.json.data) hasKeys(c, ['id', 'slug', 'name', 'description', 'parentCollection', 'displayOrder', 'itemCount'], 'collections list item');
    const slugs = r.json.data.map((c) => c.slug);
    for (const expected of ['bestsellers', 'new-arrivals', 'tshirts', 'tops']) {
      assert.ok(slugs.includes(expected), `collections list includes "${expected}"`);
    }
    // a category slug resolves its parent
    const tshirts = r.json.data.find((c) => c.slug === 'tshirts');
    assert.equal(tshirts.parentCollection, 'tops', 'category "tshirts" reports parent "tops"');

    const single = await get('/api/v1/collections/bestsellers');
    assert.equal(single.status, 200);
    hasKeys(single.json.data, ['id', 'slug', 'name', 'description', 'parentCollection', 'itemCount'], 'single collection');
    const cat = await get('/api/v1/collections/tshirts');
    assert.equal(cat.status, 200);
    assert.equal(cat.json.data.parentCollection, 'tops');
    const missing = await get('/api/v1/collections/does-not-exist-xyz');
    assert.equal(missing.status, 404);
    assert.equal(missing.json.error.code, 'COLLECTION_NOT_FOUND');
    pass('PUBLIC_COLLECTIONS_DTO', `${r.json.data.length} entries (merchandising + categories)`);
  }

  // ---- 6. search (same shape as list) ----------------------------
  {
    const r = await get('/api/v1/search?q=cotton');
    assert.equal(r.status, 200);
    hasKeys(r.json.data, ['query', 'products', 'total', 'page', 'totalPages'], 'search response');
    assert.equal(r.json.data.query, 'cotton');
    assert.ok(r.json.data.total >= 1, 'search finds "cotton" products');
    if (r.json.data.products.length) {
      hasKeys(r.json.data.products[0], ['productId', 'productSlug', 'priceMinor', 'media', 'sizes'], 'search product shape == list shape');
    }
    const empty = await get('/api/v1/search?q=');
    assert.equal(empty.status, 400, 'empty query rejected');
    pass('PUBLIC_SEARCH_DTO', `${r.json.data.total} hits for "cotton"`);
  }

  // ---- 7. filters + filter application --------------------------
  {
    const opts = await get('/api/v1/products/filters?category=tshirts');
    assert.equal(opts.status, 200);
    hasKeys(opts.json.data, ['colors', 'sizes'], 'filter options');
    for (const c of opts.json.data.colors) hasKeys(c, ['name', 'hex'], 'filter color');
    // One option per colour name: the colour filter matches on the name, so two
    // shades that share a name are one choice, not two identical entries.
    for (const [label, res] of [['category=tshirts', opts], ['all products', await get('/api/v1/products/filters')]]) {
      const names = res.json.data.colors.map((c) => String(c.name).toLowerCase());
      assert.equal(new Set(names).size, names.length, `filter colours are unique by name (${label}): ${names.join(', ')}`);
    }
    const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
    const idx = opts.json.data.sizes.map((s) => SIZE_ORDER.indexOf(s)).filter((i) => i !== -1);
    assert.ok(isSortedAsc(idx), 'filter sizes returned in size-run order');

    const byColor = await get('/api/v1/products?color=Black&limit=48');
    assert.ok(byColor.json.data.products.every((p) => p.colorName === 'Black'), 'color filter applied');
    const byFit = await get('/api/v1/products?fit=Oversized%20Fit&limit=48');
    assert.ok(byFit.json.data.products.every((p) => p.fit === 'Oversized Fit'), 'fit filter applied');
    const asc = await get('/api/v1/products?sort=price-asc&limit=48');
    assert.ok(isSortedAsc(asc.json.data.products.map((p) => p.priceMinor)), 'sort=price-asc orders by priceMinor');
    const priced = await get('/api/v1/products?minPrice=100000&maxPrice=200000&limit=48');
    assert.ok(priced.json.data.products.every((p) => p.priceMinor >= 100000 && p.priceMinor <= 200000), 'price window applied');
    pass('PUBLIC_FILTERS');
  }

  // ---- 8. Product Studio (admin) product GET DTO ----------------
  {
    const anchorId = anchorDetail.id;
    const r = await get(`/api/v1/admin/products/${anchorId}`, cm);
    assert.equal(r.status, 200);
    const d = r.json.data;
    hasKeys(d, [
      'id', 'slug', 'name', 'shortDescription', 'description', 'brand', 'productType', 'fit',
      'status', 'seoTitle', 'seoDescription', 'publishedAt', 'createdAt', 'updatedAt',
      'category', 'collections', 'sizeGuide', 'variants', 'media', 'inventorySummary', 'shipping',
    ], 'admin product DTO');
    for (const m of d.media) hasKeys(m, ['id', 'url', 'altText', 'position', 'mediaType', 'variantId'], 'admin media item');
    assert.ok(isSortedAsc(d.media.map((m) => m.position)), 'admin media ordered by position asc');
    hasKeys(d.inventorySummary, ['configuredSkus', 'totalSkus', 'totalOnHand', 'totalReserved', 'totalAvailable'], 'admin inventorySummary');
    hasKeys(d.shipping, ['status', 'weightGrams', 'lengthMm', 'widthMm', 'heightMm', 'updatedAt'], 'admin shipping');
    for (const v of d.variants) {
      hasKeys(v, ['id', 'storefrontId', 'colorName', 'colorHex', 'badge', 'status', 'displayOrder', 'skus'], 'admin variant');
      for (const s of v.skus) {
        hasKeys(s, ['id', 'sku', 'size', 'status', 'priceMinor', 'salePriceMinor', 'currency', 'displayOrder', 'inventory'], 'admin sku');
        assert.ok(Number.isInteger(s.priceMinor), 'admin sku priceMinor integer');
      }
    }
    pass('ADMIN_PRODUCT_STUDIO_DTO', `${d.media.length} media, ${d.variants.length} variants frozen`);
  }

  // ---- 9. admin picker lists (categories / collections / size guides) --
  {
    const cats = await get('/api/v1/admin/catalog/categories', cm);
    assert.equal(cats.status, 200);
    const catList = cats.json.data.categories || cats.json.data;
    assert.ok(Array.isArray(catList) && catList.length > 0);
    for (const c of catList) hasKeys(c, ['id', 'name', 'slug', 'parentId'], 'admin category picker');

    const cols = await get('/api/v1/admin/catalog/collections', cm);
    assert.equal(cols.status, 200);
    const colList = cols.json.data.collections || cols.json.data;
    for (const c of colList) hasKeys(c, ['id', 'name', 'slug', 'status'], 'admin collection picker');

    const guides = await get('/api/v1/admin/catalog/size-guides', cm);
    assert.equal(guides.status, 200);
    const guideList = guides.json.data.sizeGuides || guides.json.data;
    for (const g of guideList) hasKeys(g, ['id', 'name', 'slug', 'unit'], 'admin size-guide picker');
    pass('ADMIN_CATALOG_PICKERS', `${catList.length} categories, ${(colList).length} collections, ${(guideList).length} size guides`);
  }

  // ---- 10. media ordering determinism (row level) --------------
  {
    const rows = await query(
      "SELECT position FROM product_media WHERE product_id = ? AND status = 'ACTIVE' ORDER BY position ASC",
      [anchorDetail.id],
    );
    assert.ok(isSortedAsc(rows.map((r) => r.position)), 'product_media positions non-decreasing');
    pass('MEDIA_ORDERING_DETERMINISTIC', `${rows.length} active media rows on anchor`);
  }

  // ---- 11. reference-data census (report gaps, do not fill) ----
  {
    const census = {
      products_active: Number((await query("SELECT COUNT(*) c FROM products WHERE status='ACTIVE'"))[0].c),
      categories_active: Number((await query("SELECT COUNT(*) c FROM categories WHERE status='ACTIVE'"))[0].c),
      collections_active: Number((await query("SELECT COUNT(*) c FROM collections WHERE status='ACTIVE'"))[0].c),
      size_guides: Number((await query('SELECT COUNT(*) c FROM size_guides'))[0].c),
      products_with_size_guide: Number((await query('SELECT COUNT(*) c FROM products WHERE size_guide_id IS NOT NULL'))[0].c),
      product_media_rows: Number((await query('SELECT COUNT(*) c FROM product_media'))[0].c),
      media_asset_rows: Number((await query('SELECT COUNT(*) c FROM media'))[0].c),
      product_tax_profiles: Number((await query('SELECT COUNT(*) c FROM product_tax_profiles'))[0].c),
      tax_profiles: Number((await query('SELECT COUNT(*) c FROM tax_profiles'))[0].c),
    };
    results.CENSUS = census;
    console.log('  ---   CENSUS', JSON.stringify(census));
    if (census.products_with_size_guide === 0) gap('SIZE_GUIDE_ASSIGNMENTS', 'no product references a size guide');
    else pass('SIZE_GUIDE_ASSIGNMENTS', `${census.products_with_size_guide} product(s) mapped, ${census.size_guides} guide(s)`);
    if (census.product_tax_profiles === 0) gap('PRODUCT_TAX_PROFILES', 'no product has a tax profile (PRODUCT_HSN_GST_CONFIGURATION = MISSING)');
    if (census.media_asset_rows === 0) gap('MEDIA_ASSET_TABLE', 'media table empty; product_media.url is fully denormalized');
    else pass('MEDIA_ASSET_REGISTRY', `${census.media_asset_rows} normalized asset(s) linked from product_media`);
  }

  // ---- 12. site media (storefront hero / banner ownership) -------
  {
    const pub = await get('/api/v1/content/site-media');
    assert.equal(pub.status, 200);
    const map = pub.json.data.siteMedia;
    assert.ok(map && typeof map === 'object', 'site-media map');
    for (const [key, entry] of Object.entries(map)) {
      hasKeys(entry, ['key', 'url', 'mediaType', 'width', 'height', 'altText'], `site-media[${key}]`);
      assert.ok(/^https:\/\//.test(entry.url), `site-media[${key}].url is an absolute https URL`);
      assert.ok(['image', 'video'].includes(entry.mediaType));
    }
    const bound = Object.keys(map);
    for (const expected of ['home_hero_1', 'home_hero_2']) {
      assert.ok(bound.includes(expected), `site-media includes "${expected}"`);
      assert.equal(map[expected].mediaType, 'video', `${expected} is a video`);
    }

    const adminList = await get('/api/v1/admin/catalog/site-media', cm);
    assert.equal(adminList.status, 200);
    const keys = adminList.json.data.siteMedia.map((s) => s.key);
    for (const k of ['home_hero_1', 'home_hero_2', 'promo_banner', 'auth_banner', 'newsletter_banner']) assert.ok(keys.includes(k), `admin lists key "${k}"`);
    const unassigned = adminList.json.data.siteMedia.filter((s) => !s.assigned).map((s) => s.key);
    if (unassigned.length) gap('SITE_MEDIA_SLOTS', `unassigned: ${unassigned.join(', ')} (fill via CMS or seed:site-media with working provider creds)`);
    else pass('SITE_MEDIA_SLOTS', 'all slots assigned');

    // validation
    const badKey = await fetch(`${BASE}/api/v1/admin/catalog/site-media/not_a_key`, {
      method: 'PUT', headers: { origin: ORIGIN, cookie: cm, 'content-type': 'application/json' },
      body: JSON.stringify({ mediaId: '00000000-0000-4000-8000-000000000000' }),
    });
    assert.equal(badKey.status, 422, 'unknown site-media key rejected');
    pass('SITE_MEDIA_OWNERSHIP', `${bound.length} slot(s) served from the media registry`);
  }

  // ---- 13. provider tripwire -----------------------------------
  {
    assert.equal(externalCalls, 0, 'catalog read surface made zero outbound provider calls');
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCATALOG_BASELINE_CHARACTERIZATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCATALOG_BASELINE_CHARACTERIZATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
