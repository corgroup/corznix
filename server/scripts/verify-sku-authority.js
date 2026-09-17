// Phase 1B — canonical SKU authority verification.
//   * generator: formula, normalisation, missing segments, invalid design code
//   * duplicate detection + concurrency (two identical creates -> one wins)
//   * operational-history lock detection
//   * pre-operational size regeneration
//   * legacy migration readiness (dry run) — every legacy row is classified,
//     none is auto-migrated
//
// Self-cleaning: creates a throwaway product/variant/skus and removes them.
// REAL_PROVIDER_CALLS = 0 (no providers involved).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { generateSku, validateDesignCode, normalizeCode, sizeCodeStatus } from '../src/modules/catalogSku/generator.js';
import { catalogSkuService } from '../src/modules/catalogSku/service.js';
import { AdminCatalogService } from '../src/modules/adminCatalog/service.js';

const results = {};
const check = (name, fn) => {
  try { const v = fn(); results[name] = v === undefined ? 'PASS' : v; console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`); }
  catch (e) { results[name] = `FAIL ${e.message}`; console.log(`  FAIL  ${name}: ${e.message}`); }
};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`); }
  catch (e) { results[name] = `FAIL ${e.message}`; console.log(`  FAIL  ${name}: ${e.message}`); }
};

// ---- 1. generator unit rules ----------------------------------------
check('formula', () => {
  const g = generateSku({ productTypeCode: 'TS', fitCode: 'O', colorCode: 'BLK', designCode: 'ARI', sizeCode: 'M', sizeFamily: 'APPAREL' });
  assert.equal(g.ok, true); assert.equal(g.sku, 'COR-TS-O-BLK-ARI-M');
});
check('uppercase_normalisation', () => {
  const g = generateSku({ productTypeCode: 'ts', fitCode: 'o', colorCode: 'blk', designCode: 'ari', sizeCode: 'm', sizeFamily: 'APPAREL' });
  assert.equal(g.sku, 'COR-TS-O-BLK-ARI-M');
});
check('missing_color_no_partial', () => {
  const g = generateSku({ productTypeCode: 'TS', fitCode: 'O', designCode: 'ARI', sizeCode: 'M', sizeFamily: 'APPAREL' });
  assert.equal(g.ok, false);
  assert.ok(g.errors.some((e) => e.code === 'MISSING_COLOR'));
  assert.ok(!JSON.stringify(g).includes('COR-TS-O--ARI'));
});
check('design_code_hyphen_rejected', () => {
  const r = validateDesignCode('DESERT-RIDER');
  assert.equal(r.ok, false); assert.equal(r.code, 'DESIGN_CODE_INVALID');
});
check('design_code_lowercase_normalised', () => {
  assert.equal(validateDesignCode('ari').value, 'ARI');
});
check('design_code_space_rejected', () => assert.equal(validateDesignCode('DESERT RIDER').ok, false));
check('no_style_or_sequence_segment', () => {
  const g = generateSku({ productTypeCode: 'TS', fitCode: 'O', colorCode: 'BLK', designCode: 'ARI', sizeCode: 'M', sizeFamily: 'APPAREL' });
  assert.equal(g.sku.split('-').length, 6); // COR TS O BLK ARI M — no 7th
  assert.ok(!/-\d{3}-/.test(g.sku));
});
check('jeans_size_family', () => {
  assert.equal(sizeCodeStatus('JEANS', '32'), 'APPROVED');
  assert.equal(sizeCodeStatus('APPAREL', '32'), 'NEEDS_SIZE_POLICY_DECISION'); // numeric on apparel
  // Phase 2 (2026-09-03): apparel size run is now XS–XXXL.
  assert.equal(sizeCodeStatus('APPAREL', 'XS'), 'APPROVED');
  assert.equal(sizeCodeStatus('APPAREL', 'XXXL'), 'APPROVED');
});
check('size_not_approved_blocks', () => {
  // a genuinely unapproved apparel size (numeric)
  const g = generateSku({ productTypeCode: 'TS', fitCode: 'O', colorCode: 'BLK', designCode: 'ARI', sizeCode: '40', sizeFamily: 'APPAREL' });
  assert.equal(g.ok, false);
  assert.ok(g.errors.some((e) => e.code === 'SIZE_NOT_APPROVED'));
});

// ---- 2. integration: canonical create + duplicate + concurrency ----
const admin = new AdminCatalogService();
let productId; let variantId; const createdSkuIds = [];
// Multi-company (Phase 3) — every catalog table is brand-scoped now; this
// fixture is Cor-Cotton's, matching every other real row in this DB.
const [cottonBrand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
const brandId = cottonBrand.id;

await acheck('setup_fixture', async () => {
  const [tsc] = await query("SELECT id FROM catalog_product_type_codes WHERE code='TS' AND brand_id = ?", [brandId]);
  const [fit] = await query("SELECT id FROM catalog_fit_codes WHERE code='O' AND brand_id = ?", [brandId]);
  const [col] = await query("SELECT id FROM catalog_color_codes WHERE code='BLK' AND brand_id = ?", [brandId]);
  productId = randomUUID();
  await query(
    `INSERT INTO products (id, brand_id, slug, name, brand, product_type, product_type_code_id, fit, fit_code_id, status, created_at, updated_at)
     VALUES (?, ?, ?, 'P1B Verify Tee', 'CORCOTTON', 't-shirt', ?, 'Oversize Fit', ?, 'DRAFT', NOW(3), NOW(3))`,
    [productId, brandId, `p1b-verify-${Date.now()}`, tsc.id, fit.id],
  );
  variantId = randomUUID();
  await query(
    `INSERT INTO product_variants (id, product_id, brand_id, color_name, color_code_id, design_name, design_code, status, display_order, created_at, updated_at)
     VALUES (?, ?, ?, 'Black', ?, 'Arish', 'ARI', 'ACTIVE', 0, NOW(3), NOW(3))`,
    [variantId, productId, brandId, col.id],
  );
});

await acheck('canonical_create', async () => {
  const skuId = await catalogSkuService.createCanonicalSku(productId, variantId, { size: 'M', priceMinor: 99900 }, { id: null, email: 'verify' }, brandId);
  createdSkuIds.push(skuId);
  const [row] = await query('SELECT sku, sku_kind FROM skus WHERE id = ?', [skuId]);
  assert.equal(row.sku, 'COR-TS-O-BLK-ARI-M');
  assert.equal(row.sku_kind, 'CANONICAL');
});

await acheck('duplicate_rejected', async () => {
  await assert.rejects(
    () => catalogSkuService.createCanonicalSku(productId, variantId, { size: 'M', priceMinor: 99900 }, {}, brandId),
    (e) => e.code === 'SKU_ALREADY_EXISTS',
  );
});

await acheck('concurrency_one_winner', async () => {
  const attempt = () => catalogSkuService.createCanonicalSku(productId, variantId, { size: 'L', priceMinor: 99900 }, {}, brandId).then(
    (id) => ({ ok: true, id }), (e) => ({ ok: false, code: e.code }),
  );
  const [a, b] = await Promise.all([attempt(), attempt()]);
  const wins = [a, b].filter((r) => r.ok);
  const fails = [a, b].filter((r) => !r.ok);
  assert.equal(wins.length, 1, `expected exactly one winner, got ${wins.length}`);
  assert.equal(fails[0].code, 'SKU_ALREADY_EXISTS');
  createdSkuIds.push(wins[0].id);
  const rows = await query("SELECT COUNT(*) c FROM skus WHERE sku = 'COR-TS-O-BLK-ARI-L'");
  assert.equal(Number(rows[0].c), 1);
});

await acheck('preview_states', async () => {
  const incomplete = await catalogSkuService.previewForVariant(variantId, {}, brandId);
  assert.equal(incomplete.status, 'INCOMPLETE');
  const dup = await catalogSkuService.previewForVariant(variantId, { sizeCode: 'M' }, brandId);
  assert.equal(dup.status, 'DUPLICATE');
  assert.equal(dup.preview, 'COR-TS-O-BLK-ARI-M');
  const ready = await catalogSkuService.previewForVariant(variantId, { sizeCode: 'XL' }, brandId);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.preview, 'COR-TS-O-BLK-ARI-XL');
});

await acheck('pre_operational_size_regenerate', async () => {
  const skuId = await catalogSkuService.createCanonicalSku(productId, variantId, { size: 'S', priceMinor: 99900 }, {}, brandId);
  createdSkuIds.push(skuId);
  await catalogSkuService.updateCanonicalSkuSize(skuId, 'XL', {}, brandId);
  const [row] = await query('SELECT sku, size FROM skus WHERE id = ?', [skuId]);
  assert.equal(row.sku, 'COR-TS-O-BLK-ARI-XL');
  assert.equal(row.size, 'XL');
});

// A variant recode must actually rewrite the SKUs that encode that identity.
// The regeneration runs INSIDE updateVariant's transaction but used to read the
// variant identity on a separate pool connection, so it could not see the
// uncommitted UPDATE. It rebuilt the SKU from the OLD identity, found the
// result unchanged, and reported nothing to do — updateVariant returned 200
// while every SKU silently kept the design code it was supposed to lose.
// Nothing here exercised a recode before, which is why it survived.
await acheck('variant_recode_rewrites_skus', async () => {
  const recodeVariantId = randomUUID();
  const [col] = await query("SELECT id FROM catalog_color_codes WHERE code='BLK' AND brand_id = ?", [brandId]);
  await query(
    `INSERT INTO product_variants (id, product_id, brand_id, color_name, color_code_id, design_name, design_code, status, display_order, created_at, updated_at)
     VALUES (?, ?, ?, 'Black', ?, 'Tempo', 'TMP', 'ACTIVE', 5, NOW(3), NOW(3))`,
    [recodeVariantId, productId, brandId, col.id],
  );
  const skuId = await catalogSkuService.createCanonicalSku(
    productId, recodeVariantId, { size: 'L', priceMinor: 99900 }, {}, brandId);
  createdSkuIds.push(skuId);
  assert.equal((await query('SELECT sku FROM skus WHERE id = ?', [skuId]))[0].sku, 'COR-TS-O-BLK-TMP-L');

  await admin.updateVariant(recodeVariantId, { designName: 'Stubborn', designCode: 'STB' }, {}, brandId);

  const [after] = await query('SELECT sku FROM skus WHERE id = ?', [skuId]);
  const [v] = await query('SELECT design_code FROM product_variants WHERE id = ?', [recodeVariantId]);
  assert.equal(v.design_code, 'STB', 'the variant itself must carry the new code');
  assert.equal(after.sku, 'COR-TS-O-BLK-STB-L',
    `the SKU must be rewritten to the new identity, got ${after.sku} while the variant says ${v.design_code}`);
  await query('DELETE FROM skus WHERE id = ?', [skuId]);
  createdSkuIds.splice(createdSkuIds.indexOf(skuId), 1);
  await query('DELETE FROM product_variants WHERE id = ?', [recodeVariantId]);
});

await acheck('operational_history_lock', async () => {
  // give the M sku a fake order line -> it must now be identity-locked
  const skuId = createdSkuIds[0];
  const [oi] = await query('SELECT id, order_id, sku_id FROM order_items LIMIT 1');
  if (!oi) return 'SKIP (no order_items fixture)';
  // Restore THIS line's own sku_id, not "some SKU from another product".
  // The old cleanup picked an arbitrary row with LIMIT 1, so it permanently
  // rewrote a real order line to an unrelated SKU -- which left that order's
  // items disagreeing with its own consumed reservation, and the fulfilment
  // backfill could then never allocate it.
  const originalSkuId = oi.sku_id;
  await query('UPDATE order_items SET sku_id = ? WHERE id = ?', [skuId, oi.id]);
  try {
    const state = await catalogSkuService.skuLockState(skuId, brandId);
    assert.equal(state.identityLocked, true);
    await assert.rejects(() => catalogSkuService.updateCanonicalSkuSize(skuId, 'S', {}, brandId), (e) => e.code === 'SKU_IDENTITY_LOCKED');
  } finally {
    await query('UPDATE order_items SET sku_id = ? WHERE id = ?', [originalSkuId, oi.id]);
  }
});

await acheck('unsupported_product_type_blocks', async () => {
  // point the product at an unmapped type -> creating a new size must fail cleanly
  await query('UPDATE products SET product_type_code_id = NULL WHERE id = ?', [productId]);
  try {
    await assert.rejects(
      () => catalogSkuService.createCanonicalSku(productId, variantId, { size: 'XL', priceMinor: 99900 }, {}, brandId),
      (e) => e.code === 'NEEDS_PRODUCT_TYPE_MAPPING',
    );
  } finally {
    const [tsc] = await query("SELECT id FROM catalog_product_type_codes WHERE code='TS' AND brand_id = ?", [brandId]);
    await query('UPDATE products SET product_type_code_id = ? WHERE id = ?', [tsc.id, productId]);
  }
});

// ---- 3. legacy migration readiness (dry run) ------------------------
await acheck('migration_readiness_dryrun', async () => {
  // Format-agnostic: the seed's legacy SKU string format differs between the
  // hand-built dev DB ('SKU-…') and a fresh CI seed ('V<n>-<size>'). What the
  // dry run must guarantee is that it mutates nothing — snapshot the kind
  // counts around the call and assert they are byte-identical after.
  const kindCounts = async () => {
    const rows = await query("SELECT sku_kind, COUNT(*) c FROM skus GROUP BY sku_kind");
    return Object.fromEntries(rows.map((r) => [r.sku_kind, Number(r.c)]));
  };
  const before = await kindCounts();
  const r = await catalogSkuService.migrationReadiness(brandId);
  const after = await kindCounts();
  assert.ok(r.legacySkuCount >= 78, `expected >=78 legacy skus, got ${r.legacySkuCount}`);
  // every legacy row lacking a design code must be blocked, never auto-recoded
  assert.ok(r.byReason.NEEDS_DESIGN_CODE >= 1);
  assert.deepEqual(after, before, 'a dry run must not recode any SKU (sku_kind counts unchanged)');
  assert.ok((after.LEGACY ?? 0) >= 78, 'legacy SKUs must not have been recoded by a dry run');
  results.migration_readiness_summary = { legacy: r.legacySkuCount, ready: r.ready, blocked: r.blocked, byReason: r.byReason };
});

// ---- cleanup ------------------------------------------------------
await acheck('cleanup', async () => {
  await query('DELETE FROM skus WHERE variant_id = ?', [variantId]);
  await query('DELETE FROM product_variants WHERE id = ?', [variantId]);
  await query('DELETE FROM products WHERE id = ?', [productId]);
  await query("DELETE FROM staff_audit_logs WHERE actor_email = 'verify'");
  const left = await query('SELECT COUNT(*) c FROM products WHERE id = ?', [productId]);
  assert.equal(Number(left[0].c), 0);
});

console.log('\n──── SKU authority ────');
console.log(JSON.stringify(results, null, 1));
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSKU_AUTHORITY = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
await pool.end();
process.exitCode = failed.length === 0 ? 0 : 1;
