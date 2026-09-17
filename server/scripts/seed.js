import { randomUUID } from 'node:crypto';
import mysql from 'mysql2/promise';
import { env } from '../src/config/env.js';
import { BRAND_SLUGS, ROLE_NAMES } from '@cor-group/shared-types';

const BRANDS = [
  { name: 'CORCOTTON', slug: BRAND_SLUGS.CORCOTTON },
  { name: 'Corznix', slug: BRAND_SLUGS.CORZNIX },
];

const ROLES = [
  { name: ROLE_NAMES.SUPER_ADMIN, description: 'Full access across every brand.' },
  { name: ROLE_NAMES.BRAND_ADMIN, description: 'Full access within one assigned brand.' },
  { name: ROLE_NAMES.EDITOR, description: 'Can create and edit content within one assigned brand.' },
  { name: ROLE_NAMES.VIEWER, description: 'Read-only access within one assigned brand.' },
];

// ==========================================================================
// CATALOG SEED DATA (Wave 3 of the CORCOTTON storefront migration)
//
// Migrated verbatim (values, not code) from
// corcotton-store/client/src/data/{products,collectionsData}.js — the same
// 13 mock storefront items, reshaped onto the real
// products/product_variants/skus schema (database/migrations/002_catalog.sql):
// the 4 "Oversized Cotton Tee" colorways become 4 variants of ONE product
// (they always shared `colorGroup` in the source mock); every other item is
// its own product with a single variant. Every variant gets one SKU per
// size in the shared size run (see sizeGuide.js's SIZES) at the same price
// — the source mock never varied price by size.
//
// Money: `priceMinor` is real paise (rupee price * 100) — this seed is the
// origin of the "money is minor units end-to-end in the backend" contract
// documented in docs/MIGRATION.md's Wave 3 section.
//
// Media: every row seeds a GRADIENT media placeholder (product_media.url =
// the literal CSS gradient string), never a real image URL — the source
// mock's 4 real product photos are bundled frontend assets (Vite-hashed
// build paths), not stable server-servable URLs, and this backend catalog
// is not yet the frontend's live data source this wave (see
// docs/MIGRATION.md, "Catalog Contract" / docs/MEDIA_ABSTRACTION.md).
// Real photography moves into this table once the Media Abstraction
// platform can serve it.
// ==========================================================================

const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];

const CATEGORIES = [
  { slug: 'tops', name: 'Tops', parentSlug: null, order: 1 },
  { slug: 'bottoms', name: 'Bottoms', parentSlug: null, order: 2 },
  { slug: 'accessories', name: 'Accessories', parentSlug: null, order: 3 },
  { slug: 'tshirts', name: 'T-Shirts', parentSlug: 'tops', order: 1 },
  { slug: 'polos', name: 'Polo Shirts', parentSlug: 'tops', order: 2 },
  { slug: 'shirts', name: 'Shirts', parentSlug: 'tops', order: 3 },
  { slug: 'sweatshirts', name: 'Sweatshirts', parentSlug: 'tops', order: 4 },
  { slug: 'hoodies', name: 'Hoodies', parentSlug: 'tops', order: 5 },
  { slug: 'cargo-pants', name: 'Cargo Pants', parentSlug: 'bottoms', order: 1 },
  { slug: 'joggers', name: 'Joggers', parentSlug: 'bottoms', order: 2 },
  { slug: 'trousers', name: 'Trousers', parentSlug: 'bottoms', order: 3 },
  { slug: 'shorts', name: 'Shorts', parentSlug: 'bottoms', order: 4 },
  { slug: 'sweatpants', name: 'Sweatpants', parentSlug: 'bottoms', order: 5 },
  { slug: 'caps', name: 'Headwear', parentSlug: 'accessories', order: 1 },
  { slug: 'bags', name: 'Bags', parentSlug: 'accessories', order: 2 },
  { slug: 'socks', name: 'Socks', parentSlug: 'accessories', order: 3 },
  { slug: 'other-accessories', name: 'Other Accessories', parentSlug: 'accessories', order: 4 },
];

const COLLECTIONS = [
  { slug: 'new-arrivals', name: 'New In', description: 'Fresh styles, just in.', order: 1 },
  { slug: 'bestsellers', name: 'Bestsellers', description: 'Most loved pieces by our community.', order: 2 },
];

// One entry per real product (the 4 tee colorways are `variants` of the
// first entry, not separate products).
const PRODUCTS = [
  {
    slug: 'oversized-cotton-tee', name: 'Oversized Cotton Tee', category: 'tshirts', fit: 'Oversized Fit',
    description: 'An everyday essential cut for a relaxed, oversized fit. Made from 100% natural cotton for a soft handfeel that only gets better with wear.',
    variants: [
      { colorName: 'Black', colorHex: '#1a1a1a', badge: 'Bestseller', price: 1199, collections: ['bestsellers', 'new-arrivals'], createdAt: '2026-08-10', bg: 'linear-gradient(160deg, #2c2c2c, #050505)' },
      { colorName: 'White', colorHex: '#f5f5f0', badge: 'New', price: 1199, collections: ['new-arrivals'], createdAt: '2026-08-15', bg: 'linear-gradient(to bottom, #f5f5f0, #e5e5df)' },
      { colorName: 'Beige', colorHex: '#d9c7a9', badge: 'New', price: 1199, collections: ['bestsellers', 'new-arrivals'], createdAt: '2026-08-14', bg: 'linear-gradient(to bottom, #d9c7a9, #c4b090)' },
      { colorName: 'Camel Brown', colorHex: '#7b4b2a', badge: 'New', price: 1199, collections: ['new-arrivals'], createdAt: '2026-08-16', bg: 'linear-gradient(to bottom, #7b4b2a, #5c3820)' },
    ],
  },
  {
    slug: 'cotton-regular-shirt', name: 'Cotton Regular Shirt', category: 'shirts', fit: 'Regular Fit',
    description: 'A clean, regular-fit shirt in breathable cotton — sharp enough to layer up, easy enough to wear every day.',
    variants: [{ badge: 'Bestseller', price: 1699, collections: ['bestsellers', 'new-arrivals'], createdAt: '2026-08-05', bg: 'linear-gradient(to bottom, #F2F2F2, #E0E0E0)' }],
  },
  {
    slug: 'premium-cotton-hoodie', name: 'Premium Cotton Hoodie', category: 'hoodies', fit: 'Relaxed Fit',
    description: 'A relaxed-fit hoodie in heavyweight cotton, built for layering through cooler days without losing softness.',
    variants: [{ badge: 'New', price: 2699, collections: ['bestsellers', 'new-arrivals'], createdAt: '2026-08-17', bg: 'linear-gradient(to bottom, #EFEFEF, #DDDDDD)' }],
  },
  {
    slug: 'cotton-straight-trouser', name: 'Cotton Straight Trouser', category: 'trousers', fit: 'Regular Fit',
    description: 'A straight-leg trouser in structured cotton, tailored enough for the office and comfortable enough for everything after.',
    variants: [{ badge: 'Bestseller', price: 2099, collections: ['bestsellers'], createdAt: '2026-07-20', bg: 'linear-gradient(to bottom, #F1F1F1, #DFDFDF)' }],
  },
  {
    slug: 'cotton-relaxed-trouser', name: 'Cotton Relaxed Trouser', category: 'trousers', fit: 'Relaxed Fit',
    description: 'A relaxed-fit trouser in soft cotton twill — an easy everyday alternative to your usual denim.',
    variants: [{ badge: null, price: 1799, collections: ['bestsellers', 'new-arrivals'], createdAt: '2026-07-25', bg: 'linear-gradient(to bottom, #F4F4F4, #E2E2E2)' }],
  },
  {
    slug: 'ribbed-cotton-polo', name: 'Ribbed Cotton Polo', category: 'polos', fit: 'Regular Fit',
    description: 'A ribbed-knit cotton polo with a clean collar — smart-casual staple that layers well under a jacket or stands on its own.',
    variants: [{ badge: 'Bestseller', price: 1299, collections: ['bestsellers', 'new-arrivals'], createdAt: '2026-07-28', bg: 'linear-gradient(to bottom, #F3F3F3, #E1E1E1)' }],
  },
  {
    slug: 'cotton-sweatshirt', name: 'Cotton Sweatshirt', category: 'sweatshirts', fit: 'Relaxed Fit',
    description: 'A relaxed-fit crewneck sweatshirt in brushed cotton — a warm, low-key layer for cooler mornings.',
    variants: [{ badge: 'New', price: 1599, collections: ['new-arrivals'], createdAt: '2026-08-12', bg: 'linear-gradient(to bottom, #F0F0F0, #DEDEDE)' }],
  },
  {
    slug: 'oxford-cotton-shirt', name: 'Oxford Cotton Shirt', category: 'shirts', fit: 'Regular Fit',
    description: 'A classic Oxford-weave cotton shirt — durable, breathable, and sharp enough for the office or the weekend.',
    variants: [{ badge: 'Bestseller', price: 1799, collections: ['bestsellers', 'new-arrivals'], createdAt: '2026-07-15', bg: 'linear-gradient(to bottom, #F2F2F2, #E0E0E0)' }],
  },
  {
    slug: 'cotton-cargo-trouser', name: 'Cotton Cargo Trouser', category: 'cargo-pants', fit: 'Relaxed Fit',
    description: 'A relaxed-fit cargo trouser in durable cotton, with utility pockets built for actually carrying things.',
    variants: [{ badge: 'New', price: 2199, collections: ['new-arrivals'], createdAt: '2026-08-08', bg: 'linear-gradient(to bottom, #EEEEEE, #DCDCDC)' }],
  },
  {
    slug: 'cotton-drawstring-trouser', name: 'Cotton Drawstring Trouser', category: 'trousers', fit: 'Relaxed Fit',
    description: 'A relaxed drawstring trouser in soft cotton — pull-on ease with a clean, tailored look.',
    variants: [{ badge: null, price: 1699, collections: ['new-arrivals'], createdAt: '2026-07-30', bg: 'linear-gradient(to bottom, #F1F1F1, #DFDFDF)' }],
  },
];

// Inserts a row keyed by its unique `slug` column, or updates it in place
// if the slug already exists (idempotent — safe to re-run `npm run seed`).
// Always returns the row's authoritative id (the pre-existing one on a
// re-run, never the throwaway id generated for an insert that turned into
// an update) so callers can safely use it as a foreign key for children
// inserted later in the same run.
async function upsertBySlug(connection, table, columns, slug, brandId) {
  const id = randomUUID();
  // Migrations 077-084 made brand_id NOT NULL on categories/collections/products
  // and moved slug uniqueness to (brand_id, slug). Both the INSERT and the
  // id lookup below must therefore be brand-scoped.
  const scoped = { brand_id: brandId, ...columns };
  const cols = ['id', ...Object.keys(scoped)];
  const vals = [id, ...Object.values(scoped)];
  const placeholders = cols.map(() => '?').join(', ');
  const updateCols = Object.keys(columns).filter((c) => c !== 'slug');
  const updateClause = updateCols.length > 0
    ? updateCols.map((c) => `${c} = VALUES(${c})`).join(', ')
    : 'slug = VALUES(slug)';
  await connection.execute(
    `INSERT INTO ${table} (${cols.join(', ')}, created_at, updated_at) VALUES (${placeholders}, NOW(), NOW())
     ON DUPLICATE KEY UPDATE ${updateClause}`,
    vals,
  );
  const [rows] = await connection.execute(`SELECT id FROM ${table} WHERE brand_id = ? AND slug = ? LIMIT 1`, [brandId, slug]);
  return rows[0].id;
}

async function seedCatalog(connection, brandId) {
  // Categories — parents first, so children can resolve parent_id.
  const categoryIdBySlug = new Map();
  for (const cat of CATEGORIES.filter((c) => c.parentSlug === null)) {
    const id = await upsertBySlug(
      connection, 'categories',
      { name: cat.name, slug: cat.slug, parent_id: null, display_order: cat.order },
      cat.slug, brandId,
    );
    categoryIdBySlug.set(cat.slug, id);
    console.log(`category ${cat.slug}`);
  }
  for (const cat of CATEGORIES.filter((c) => c.parentSlug !== null)) {
    const parentId = categoryIdBySlug.get(cat.parentSlug);
    const id = await upsertBySlug(
      connection, 'categories',
      { name: cat.name, slug: cat.slug, parent_id: parentId, display_order: cat.order },
      cat.slug, brandId,
    );
    categoryIdBySlug.set(cat.slug, id);
    console.log(`category ${cat.slug} (in ${cat.parentSlug})`);
  }

  // Collections (flat merchandising groups).
  const collectionIdBySlug = new Map();
  for (const col of COLLECTIONS) {
    const id = await upsertBySlug(
      connection, 'collections',
      { name: col.name, slug: col.slug, description: col.description, display_order: col.order },
      col.slug, brandId,
    );
    collectionIdBySlug.set(col.slug, id);
    console.log(`collection ${col.slug}`);
  }

  // Products + variants + skus + gradient media.
  for (const p of PRODUCTS) {
    const categoryId = categoryIdBySlug.get(p.category);
    const productId = await upsertBySlug(
      connection, 'products',
      {
        name: p.name, slug: p.slug, short_description: null, description: p.description,
        brand: 'CORCOTTON', category_id: categoryId, fit: p.fit, product_type: p.category,
        size_guide_id: null, status: 'ACTIVE', published_at: null, seo_title: null, seo_description: null,
      },
      p.slug, brandId,
    );
    // `product_categories` is the real membership table; `products.category_id`
    // is only the is_primary row denormalised for the storefront
    // (adminCatalog/categoryService.js keeps the two in step). Seeding one and
    // not the other left every seeded product with an empty PDP `categories[]`
    // — invisible locally, where CMS edits had backfilled the memberships, and
    // the reason verify:catalog:baseline failed on a fresh database.
    if (categoryId) {
      // eslint-disable-next-line no-await-in-loop
      await connection.execute(
        `INSERT INTO product_categories (product_id, category_id, is_primary, position, created_at)
         VALUES (?, ?, 1, 0, NOW(3))
         ON DUPLICATE KEY UPDATE is_primary = 1, position = 0`,
        [productId, categoryId]);
    }
    console.log(`product  ${p.slug}`);

    for (const v of p.variants) {
      // Variant rows are inserted (not upserted by a natural key — a color
      // has no slug of its own) in fixed source order so `storefront_id`
      // (AUTO_INCREMENT) lands on 1..13 in the same order as the source
      // mock's numeric `id`, preserving `/products/:id` URL compatibility.
      // Safe to re-run: skipped if this product/color pairing already has
      // an active variant.
      const [existing] = await connection.execute(
        `SELECT id FROM product_variants WHERE product_id = ? AND ${v.colorName ? 'color_name = ?' : 'color_name IS NULL'} LIMIT 1`,
        v.colorName ? [productId, v.colorName] : [productId],
      );
      let variantId = existing[0]?.id;
      if (!variantId) {
        variantId = randomUUID();
        await connection.execute(
          `INSERT INTO product_variants (id, brand_id, product_id, color_name, color_hex, badge, status, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 0, ?, NOW())`,
          [variantId, brandId, productId, v.colorName ?? null, v.colorHex ?? null, v.badge, `${v.createdAt} 00:00:00`],
        );
      }

      const [[{ storefront_id: storefrontId }]] = await connection.execute(
        'SELECT storefront_id FROM product_variants WHERE id = ?', [variantId],
      );
      console.log(`  variant #${storefrontId} ${v.colorName ?? '(single)'}`);

      const priceMinor = Math.round(v.price * 100);
      for (const size of SIZES) {
        const sku = `V${storefrontId}-${size}`;
        await connection.execute(
          `INSERT INTO skus (id, brand_id, variant_id, sku, size, status, price_minor, sale_price_minor, currency, display_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, NULL, 'INR', ?, NOW(), NOW())
           ON DUPLICATE KEY UPDATE price_minor = VALUES(price_minor), status = 'ACTIVE'`,
          [randomUUID(), brandId, variantId, sku, size, priceMinor, SIZES.indexOf(size)],
        );
      }

      // One GRADIENT placeholder per variant — see this file's banner
      // comment on why real photography isn't seeded here yet.
      const [existingMedia] = await connection.execute(
        "SELECT id FROM product_media WHERE variant_id = ? AND media_type = 'GRADIENT' LIMIT 1",
        [variantId],
      );
      if (existingMedia.length === 0) {
        await connection.execute(
          `INSERT INTO product_media (id, product_id, variant_id, media_type, url, alt_text, position, status, created_at, updated_at)
           VALUES (?, ?, ?, 'GRADIENT', ?, ?, 0, 'ACTIVE', NOW(), NOW())`,
          [randomUUID(), productId, variantId, v.bg, p.name],
        );
      }

      for (const collectionSlug of v.collections) {
        const collectionId = collectionIdBySlug.get(collectionSlug);
        if (!collectionId) continue;
        await connection.execute(
          'INSERT IGNORE INTO product_collections (product_id, collection_id, created_at) VALUES (?, ?, NOW())',
          [productId, collectionId],
        );
      }
    }
  }
}

async function main() {
  let connection;
  try {
    connection = await mysql.createConnection({
      host: env.DB_HOST,
      port: env.DB_PORT,
      database: env.DB_NAME,
      user: env.DB_USER,
      password: env.DB_PASSWORD,
    });
  } catch (err) {
    console.error(
      `\nSeed failed: could not reach MySQL at ${env.DB_HOST}:${env.DB_PORT} (database "${env.DB_NAME}").\n` +
        'Copy server/.env.example to server/.env, start MySQL, run "npm run migrate" first, and verify the DB_* credentials.\n' +
        `Underlying error: ${err.message}\n`
    );
    process.exitCode = 1;
    return;
  }

  try {
    for (const brand of BRANDS) {
      await connection.execute(
        `INSERT INTO brands (id, name, slug, status)
         VALUES (?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [randomUUID(), brand.name, brand.slug]
      );
      console.log(`brand   ${brand.slug}`);
    }

    for (const role of ROLES) {
      await connection.execute(
        `INSERT INTO roles (id, name, description)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE description = VALUES(description)`,
        [randomUUID(), role.name, role.description]
      );
      console.log(`role    ${role.name}`);
    }

    // The seeded catalog belongs to CORCOTTON (products carry brand:
    // 'CORCOTTON'). Resolve the real brand row id -- categories/collections/
    // products all require a NOT NULL brand_id since migrations 077-084.
    const [brandRows] = await connection.execute("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
    if (!brandRows.length) throw new Error("seed: brand 'corcotton' missing - cannot seed a brand-scoped catalog");
    await seedCatalog(connection, brandRows[0].id);

    console.log('Seed complete.');
  } finally {
    await connection.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exitCode = 1;
});
