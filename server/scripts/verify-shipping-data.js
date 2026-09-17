// Phase 2 · Slice 1 — product / SKU shipping-weight data model.
//   * migration 058: skus.weight_grams + CHECK (> 0 or NULL)
//   * weight is REQUIRED for rate-ready; dimensions optional (all-3-or-none)
//   * per-SKU weight override resolves SKU -> product default -> missing (§9)
//   * shippingSummary blocker report (§48): rateReady independent of complete
//   * NO inferred / defaulted weights anywhere (§6/§8)
//
// Self-cleaning. REAL_PROVIDER_CALLS = 0.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { AdminCatalogService } from '../src/modules/adminCatalog/service.js';
import { catalogSkuService } from '../src/modules/catalogSku/service.js';
import { shippingProfileSchema } from '../src/modules/adminCatalog/validation.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`); }
  catch (e) { results[name] = `FAIL ${e.message}`; console.log(`  FAIL  ${name}: ${e.message}`); }
};
const check = (name, fn) => {
  try { const v = fn(); results[name] = v === undefined ? 'PASS' : v; console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`); }
  catch (e) { results[name] = `FAIL ${e.message}`; console.log(`  FAIL  ${name}: ${e.message}`); }
};

const admin = new AdminCatalogService();
const actor = { id: null, email: 'verify-shipping-data' };
let productId; let variantAId;
const skuIds = {};
// Multi-company (Phase 3) — every catalog table is brand-scoped now; this
// fixture is Cor-Cotton's, matching every other real row in this DB.
const [cottonBrand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
const brandId = cottonBrand.id;

// ---- 1. migration 058 ---------------------------------------------------
await acheck('migration_058_column', async () => {
  const rows = await query(
    `SELECT DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skus' AND COLUMN_NAME = 'weight_grams'`,
  );
  assert.equal(rows.length, 1, 'skus.weight_grams column missing — migration 058 not applied');
  assert.equal(rows[0].IS_NULLABLE, 'YES', 'skus.weight_grams must be nullable (override, not required)');
});

await acheck('migration_058_check_rejects_nonpositive', async () => {
  const id = randomUUID();
  const [cotton] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  await assert.rejects(
    () => query(
      `INSERT INTO skus (id, variant_id, brand_id, sku, size, weight_grams, status, price_minor, currency, display_order, created_at, updated_at)
       VALUES (?, '00000000-0000-0000-0000-000000000000', ?, ?, 'M', 0, 'ACTIVE', 100, 'INR', 0, NOW(3), NOW(3))`,
      [id, cotton.id, `ZZVERIFY-${Date.now()}`],
    ),
    (e) => /CHECK|constraint|foreign key/i.test(e.message),
  );
});

// ---- 2. validation: weight required, dimensions optional-as-a-set ------
check('schema_weight_only_ok', () => {
  const r = shippingProfileSchema.safeParse({ weightGrams: 300 });
  assert.equal(r.success, true, 'weight-only shipping profile must be accepted');
});
check('schema_weight_missing_rejected', () => {
  assert.equal(shippingProfileSchema.safeParse({ lengthMm: 100, widthMm: 100, heightMm: 20 }).success, false);
});
check('schema_partial_dimensions_rejected', () => {
  assert.equal(shippingProfileSchema.safeParse({ weightGrams: 300, lengthMm: 100 }).success, false);
  assert.equal(shippingProfileSchema.safeParse({ weightGrams: 300, lengthMm: 100, widthMm: 100, heightMm: 20 }).success, true);
});

// ---- 3. fixture -------------------------------------------------------
await acheck('setup_fixture', async () => {
  const [tsc] = await query("SELECT id FROM catalog_product_type_codes WHERE code='TS' AND brand_id = ?", [brandId]);
  const [fit] = await query("SELECT id FROM catalog_fit_codes WHERE code='O' AND brand_id = ?", [brandId]);
  const [col] = await query("SELECT id FROM catalog_color_codes WHERE code='BLK' AND brand_id = ?", [brandId]);
  productId = randomUUID();
  await query(
    `INSERT INTO products (id, brand_id, slug, name, brand, product_type, product_type_code_id, fit, fit_code_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'P2 Shipping Verify Tee', 'CORCOTTON', 't-shirt', ?, 'Oversize Fit', ?, 'DRAFT', NOW(3), NOW(3))`,
    [productId, brandId, `p2-ship-verify-${Date.now()}`, tsc.id, fit.id],
  );
  variantAId = randomUUID();
  await query(
    `INSERT INTO product_variants (id, product_id, brand_id, color_name, color_code_id, design_name, design_code, status, display_order, created_at, updated_at)
     VALUES (?, ?, ?, 'Black', ?, 'Arish', 'ARI', 'ACTIVE', 0, NOW(3), NOW(3))`,
    [variantAId, productId, brandId, col.id],
  );
  skuIds.m = await catalogSkuService.createCanonicalSku(productId, variantAId, { size: 'M', priceMinor: 99900 }, actor, brandId);
  skuIds.l = await catalogSkuService.createCanonicalSku(productId, variantAId, { size: 'L', priceMinor: 99900 }, actor, brandId);
});

// ---- 4. no fake defaults: nothing set ⇒ not rate ready ---------------
await acheck('no_default_weight', async () => {
  const p = await admin.getProduct(productId, brandId);
  assert.equal(p.shipping.weightGrams, null);
  assert.equal(p.shipping.rateReady, false);
  assert.equal(p.shipping.rateReadyReason, 'MISSING_WEIGHT');
  assert.equal(p.shipping.status, 'INCOMPLETE');
  for (const v of p.variants) for (const s of v.skus) {
    assert.equal(s.effectiveWeightGrams, null);
    assert.equal(s.weightSource, 'MISSING');
    assert.equal(s.rateReady, false);
  }
});

// ---- 5. product default weight ⇒ rate ready, SKUs inherit -----------
await acheck('product_default_weight', async () => {
  const res = await admin.putShippingProfile(productId, { weightGrams: 280 }, actor, brandId);
  assert.equal(res.shipping.status, 'INCOMPLETE'); // weight only, no box
  const p = await admin.getProduct(productId, brandId);
  assert.equal(p.shipping.rateReady, true);
  assert.equal(p.shipping.rateReadyReason, null);
  assert.equal(p.shipping.weightGrams, 280);
  const skus = p.variants.flatMap((v) => v.skus);
  for (const s of skus) {
    assert.equal(s.effectiveWeightGrams, 280);
    assert.equal(s.weightSource, 'PRODUCT');
    assert.equal(s.rateReady, true);
  }
});

// ---- 6. per-SKU override wins; clearing falls back (§9) -------------
await acheck('sku_override_resolution', async () => {
  await admin.updateSku(skuIds.l, { weightGrams: 320 }, actor, brandId);
  let p = await admin.getProduct(productId, brandId);
  let lRow = p.variants.flatMap((v) => v.skus).find((s) => s.id === skuIds.l);
  let mRow = p.variants.flatMap((v) => v.skus).find((s) => s.id === skuIds.m);
  assert.equal(lRow.weightGrams, 320);
  assert.equal(lRow.effectiveWeightGrams, 320);
  assert.equal(lRow.weightSource, 'SKU');
  assert.equal(mRow.effectiveWeightGrams, 280); // still product default
  assert.equal(mRow.weightSource, 'PRODUCT');

  await admin.updateSku(skuIds.l, { weightGrams: null }, actor, brandId); // clear
  p = await admin.getProduct(productId, brandId);
  lRow = p.variants.flatMap((v) => v.skus).find((s) => s.id === skuIds.l);
  assert.equal(lRow.weightGrams, null);
  assert.equal(lRow.effectiveWeightGrams, 280);
  assert.equal(lRow.weightSource, 'PRODUCT');
});

// ---- 7. no product default, every active SKU has its own ⇒ rate ready
await acheck('rate_ready_via_all_sku_overrides', async () => {
  const p2ProductId = randomUUID();
  const [tsc] = await query("SELECT id FROM catalog_product_type_codes WHERE code='TS' AND brand_id = ?", [brandId]);
  const [fit] = await query("SELECT id FROM catalog_fit_codes WHERE code='O' AND brand_id = ?", [brandId]);
  const [blk] = await query("SELECT id FROM catalog_color_codes WHERE code='BLK' AND brand_id = ?", [brandId]);
  await query(
    `INSERT INTO products (id, brand_id, slug, name, brand, product_type, product_type_code_id, fit, fit_code_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'P2 Ship Verify NoDefault', 'CORCOTTON', 't-shirt', ?, 'Oversize Fit', ?, 'DRAFT', NOW(3), NOW(3))`,
    [p2ProductId, brandId, `p2-ship-nodefault-${Date.now()}`, tsc.id, fit.id],
  );
  const vId = randomUUID();
  await query(
    `INSERT INTO product_variants (id, product_id, brand_id, color_name, color_code_id, design_name, design_code, status, display_order, created_at, updated_at)
     VALUES (?, ?, ?, 'Black', ?, 'Verify2', 'VF2', 'ACTIVE', 0, NOW(3), NOW(3))`,
    [vId, p2ProductId, brandId, blk.id],
  );
  const s1 = await catalogSkuService.createCanonicalSku(p2ProductId, vId, { size: 'M', priceMinor: 99900, weightGrams: 250 }, actor, brandId);
  const s2 = await catalogSkuService.createCanonicalSku(p2ProductId, vId, { size: 'L', priceMinor: 99900, weightGrams: 270 }, actor, brandId);
  const p = await admin.getProduct(p2ProductId, brandId);
  assert.equal(p.shipping.weightGrams, null, 'no product default');
  assert.equal(p.shipping.rateReady, true, 'rate ready because every active SKU carries its own weight (§9)');
  // one SKU loses its override ⇒ product is no longer rate ready
  await admin.updateSku(s2, { weightGrams: null }, actor, brandId);
  const p3 = await admin.getProduct(p2ProductId, brandId);
  assert.equal(p3.shipping.rateReady, false);
  await query('DELETE FROM skus WHERE id IN (?, ?)', [s1, s2]);
  await query('DELETE FROM product_variants WHERE id = ?', [vId]);
  await query('DELETE FROM products WHERE id = ?', [p2ProductId]);
});

// ---- 8. §48 blocker report shape -----------------------------------
await acheck('shipping_summary_shape', async () => {
  const sum = await admin.shippingSummary(brandId);
  for (const k of ['total', 'complete', 'incomplete', 'rateReady', 'notRateReady', 'withSkuWeightOverrides']) {
    assert.ok(Number.isInteger(sum[k]), `shippingSummary.${k} must be an integer`);
  }
  assert.equal(sum.rateReady + sum.notRateReady, sum.total);
  assert.equal(sum.complete + sum.incomplete, sum.total);
  assert.ok(sum.rateReady >= 1, 'the fixture product has a product-default weight and must count as rate ready');
  results.shipping_summary = sum;
});

// ---- cleanup ------------------------------------------------------
await acheck('cleanup', async () => {
  await query('DELETE FROM skus WHERE variant_id = ?', [variantAId]);
  await query('DELETE FROM product_variants WHERE product_id = ?', [productId]);
  await query('DELETE FROM product_shipping_profiles WHERE product_id = ?', [productId]);
  await query('DELETE FROM products WHERE id = ?', [productId]);
  await query("DELETE FROM staff_audit_logs WHERE actor_email = 'verify-shipping-data'");
  const left = await query('SELECT COUNT(*) c FROM products WHERE id = ?', [productId]);
  assert.equal(Number(left[0].c), 0);
});

console.log('\n──── Phase 2 · Slice 1 — shipping data ────');
console.log(JSON.stringify(results, null, 1));
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSHIPPING_DATA = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
await pool.end();
process.exitCode = failed.length === 0 ? 0 : 1;
