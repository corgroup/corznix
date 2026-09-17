// One-off: create the two "Oversized Plain" tees the account holder supplied
// (Black + White), each with canonical SKUs XS–XXL, the given Cloudinary
// images, and 5 units of opening stock per size in the default warehouse.
//
// Idempotent — a product whose slug exists is not re-created, but stock is
// still topped up to the target and missing images are (re-)attached.
//
//   node scripts/seed-plain-tees.js
import { randomUUID } from 'node:crypto';
import { query, pool } from '../src/database/connection/pool.js';
import { catalogSkuService } from '../src/modules/catalogSku/service.js';
import { adminCatalogMediaService } from '../src/modules/adminCatalog/mediaService.js';
import { registerExistingAsset } from '../src/modules/media/service.js';
import { inventoryService } from '../src/modules/inventory/service.js';

const ACTOR = { id: null, email: 'seed:plain-tees' };
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const PRICE_MINOR = 119900;          // ₹1199 — matches the existing Oversized Cotton Tee; confirm in Product Studio
const TARGET_STOCK = 5;
const BRAND_ID = '43278e16-26eb-4bfe-b945-672ccc3fd486';       // CORCOTTON
const TS_CODE_ID = 'f8360dc9-a6b5-11f1-8428-ec2e98ca68dc';     // product type TS
const FIT_O_ID = 'f83b07b3-a6b5-11f1-8428-ec2e98ca68dc';       // fit O (Oversize)
const CATEGORY_TSHIRTS = '149f576c-2667-4dc8-8016-211c2f02e14a';
const WAREHOUSE_ID = '00000000-0000-4000-8000-000000000001';   // default dispatch warehouse

const PRODUCTS = [
  {
    slug: 'black-tshirt-oversize-plain',
    name: 'Black T-shirt Oversize Plain',
    colorName: 'Black', colorHex: '#111111', colorCodeId: 'f83c1855-a6b5-11f1-8428-ec2e98ca68dc',
    images: [
      'https://res.cloudinary.com/su6typhx/image/upload/v1787780196/corcotton/products/oversized-cotton-tee/lgkn9bwybmxevjxibvx8.jpg',
      'https://res.cloudinary.com/su6typhx/image/upload/v1787780196/corcotton/products/oversized-cotton-tee/lgkn9bwybmxevjxibvx8.jpg',
    ],
  },
  {
    slug: 'white-tshirt-oversize-plain',
    name: 'White T-shirt Oversize Plain',
    colorName: 'White', colorHex: '#FFFFFF', colorCodeId: 'f84126f5-a6b5-11f1-8428-ec2e98ca68dc',
    images: [
      'https://res.cloudinary.com/su6typhx/image/upload/v1787780462/corcotton/products/oversized-cotton-tee/yjefxxvk4dv6j8jiruj4.jpg',
      'https://res.cloudinary.com/su6typhx/image/upload/v1787780459/corcotton/products/oversized-cotton-tee/ynmyhdjz2lbw8ia5nunm.jpg',
    ],
  },
];

async function ensureProductAndVariant(p) {
  const found = await query('SELECT id FROM products WHERE slug = ? LIMIT 1', [p.slug]);
  if (found.length) {
    const productId = found[0].id;
    const v = await query('SELECT id FROM product_variants WHERE product_id = ? LIMIT 1', [productId]);
    console.log(`exists ${p.slug} -> ${productId}`);
    return { productId, variantId: v[0]?.id ?? null, created: false };
  }
  const productId = randomUUID();
  await query(
    `INSERT INTO products (id, brand_id, slug, name, brand, category_id, fit, product_type, product_type_code_id, fit_code_id,
        short_description, description, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'CORCOTTON', ?, 'Oversize Fit', 't-shirt', ?, ?, ?, ?, 'DRAFT', NOW(3), NOW(3))`,
    [productId, BRAND_ID, p.slug, p.name, CATEGORY_TSHIRTS, TS_CODE_ID, FIT_O_ID,
      `${p.colorName} oversized plain cotton t-shirt.`,
      `A plain oversized-fit t-shirt in ${p.colorName.toLowerCase()}, 100% cotton.`],
  );
  const variantId = randomUUID();
  await query(
    `INSERT INTO product_variants (id, product_id, brand_id, color_name, color_hex, color_code_id, design_name, design_code,
        status, display_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'Plain', 'PLN', 'ACTIVE', 0, NOW(3), NOW(3))`,
    [variantId, productId, BRAND_ID, p.colorName, p.colorHex, p.colorCodeId],
  );
  console.log(`create ${p.slug} -> ${productId}`);
  return { productId, variantId, created: true };
}

async function ensureSkus(productId, variantId) {
  for (const size of SIZES) {
    const existing = await query(
      "SELECT id FROM skus WHERE variant_id = ? AND size = ? AND sku_kind = 'CANONICAL' LIMIT 1", [variantId, size],
    );
    if (existing.length) continue;
    // eslint-disable-next-line no-await-in-loop
    await catalogSkuService.createCanonicalSku(
      productId, variantId, { size, priceMinor: PRICE_MINOR, weightGrams: null, status: 'ACTIVE' }, ACTOR, BRAND_ID,
    );
  }
  return query('SELECT id, sku, size FROM skus WHERE variant_id = ? ORDER BY sku', [variantId]);
}

async function ensureImages(productId, variantId, images, name) {
  const have = await query("SELECT url FROM product_media WHERE product_id = ? AND status = 'ACTIVE'", [productId]);
  const haveUrls = new Set(have.map((r) => r.url));
  let pos = have.length;
  for (const url of images) {
    if (haveUrls.has(url) && images.filter((u) => u === url).length <= [...haveUrls].filter((u) => u === url).length) continue;
    // eslint-disable-next-line no-await-in-loop
    const asset = await registerExistingAsset({ url, brandId: BRAND_ID, resourceType: 'image', altText: name });
    // eslint-disable-next-line no-await-in-loop
    await adminCatalogMediaService.attach(productId, { mediaId: asset.id, variantId, isPrimary: pos === 0 }, ACTOR)
      .catch((e) => console.log(`  image attach: ${e.code || e.message}`));
    haveUrls.add(url);
    pos += 1;
  }
}

async function topUpStock(skuRows) {
  for (const s of skuRows) {
    // eslint-disable-next-line no-await-in-loop
    const cur = await query('SELECT on_hand FROM inventory WHERE warehouse_id = ? AND sku_id = ?', [WAREHOUSE_ID, s.id]);
    const have = cur.length ? Number(cur[0].on_hand) : 0;
    if (have >= TARGET_STOCK) { console.log(`  stock ${s.sku}: already ${have}`); continue; }
    // eslint-disable-next-line no-await-in-loop
    const r = await inventoryService.adjustStock({
      warehouseId: WAREHOUSE_ID, skuId: s.id, delta: TARGET_STOCK - have,
      reason: 'Opening stock (seed-plain-tees)', actorStaffId: null,
    });
    console.log(`  stock ${s.sku}: ${r.onHandBefore} -> ${r.onHandAfter}`);
  }
}

try {
  for (const p of PRODUCTS) {
    // eslint-disable-next-line no-await-in-loop
    const { productId, variantId } = await ensureProductAndVariant(p);
    // eslint-disable-next-line no-await-in-loop
    const skuRows = await ensureSkus(productId, variantId);
    console.log(`  SKUs: ${skuRows.map((r) => r.sku).join(', ')}`);
    // eslint-disable-next-line no-await-in-loop
    await ensureImages(productId, variantId, p.images, p.name);
    // eslint-disable-next-line no-await-in-loop
    await topUpStock(skuRows);
    // eslint-disable-next-line no-await-in-loop
    await query("UPDATE product_variants SET status = 'ACTIVE' WHERE id = ?", [variantId]);
    // eslint-disable-next-line no-await-in-loop
    await query("UPDATE products SET status = 'ACTIVE', published_at = COALESCE(published_at, NOW(3)), updated_at = NOW(3) WHERE id = ?", [productId]);
    console.log(`  -> ACTIVE\n`);
  }
  console.log('Done. NOTE: price is a placeholder (₹1199) and weight_grams is NULL —');
  console.log('set the real price + shipping weight per SKU in CMS → Product Studio before REAL-mode checkout.');
} finally {
  await pool.end();
}
