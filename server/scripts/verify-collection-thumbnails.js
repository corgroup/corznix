// Collection and category thumbnails come from real product photos.
//
// - Every collection/category with a thumbnail shows the photo of a product it
//   actually contains (same membership as its product count), never another's.
// - A collection with no products has no thumbnail (null), never a made-up one.
// - GET /api/v1/collections and /collections/:slug carry the image field.
//
//   npm run verify:collection-thumbnails
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

const { pool, query } = await import('../src/database/connection/pool.js');
const { default: catalogService } = await import('../src/modules/catalog/service.js');
const { createApp } = await import('../src/app.js');

const results = {};
const emptySlug = `qa-empty-${randomUUID().slice(0, 8)}`;
let emptyId = null;
const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

try {
  // 1 -- collections: the photo belongs to one of its own active products -------
  const collections = await catalogService.listCollections();
  let checkedCollections = 0;
  for (const c of collections) {
    if (!c.thumbnailUrl) {
      const withPhoto = await query(
        `SELECT COUNT(*) n FROM product_collections pc JOIN products p ON p.id = pc.product_id AND p.status = 'ACTIVE'
         JOIN product_media pm ON pm.product_id = p.id AND pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE'
         WHERE pc.collection_id = ?`, [c.id]);
      assert.equal(Number(withPhoto[0].n), 0, `collection ${c.slug} has a photographed product but no thumbnail`);
      continue;
    }
    const owned = await query(
      `SELECT COUNT(*) n FROM product_collections pc JOIN products p ON p.id = pc.product_id AND p.status = 'ACTIVE'
       JOIN product_media pm ON pm.product_id = p.id AND pm.status = 'ACTIVE'
       WHERE pc.collection_id = ? AND pm.url = ?`, [c.id, c.thumbnailUrl]);
    assert.ok(Number(owned[0].n) > 0, `collection ${c.slug} thumbnail is not one of its own products' photos`);
    checkedCollections += 1;
  }
  results.collectionsUseOwnPhotos = `PASS (${checkedCollections} with photos)`;

  // 2 -- categories: photo from the category or its subcategories ---------------
  const categories = await catalogService.listCategories();
  let checkedCategories = 0;
  for (const c of categories) {
    const ids = await catalogService.categoryRepository.selfAndDescendantIds(c.id);
    if (!c.thumbnailUrl) {
      // Products whose only media is a colour gradient have no photo to show.
      const withPhoto = await query(
        `SELECT COUNT(*) n FROM products p
         JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE'
         JOIN product_media pm ON pm.product_id = p.id AND pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE'
          AND (pm.variant_id = v.id OR pm.variant_id IS NULL)
         WHERE p.status = 'ACTIVE' AND p.category_id IN (${ids.map(() => '?').join(',')})`, ids);
      assert.equal(Number(withPhoto[0].n), 0, `category ${c.slug} has a photographed product but no thumbnail`);
      continue;
    }
    const owned = await query(
      `SELECT COUNT(*) n FROM products p JOIN product_media pm ON pm.product_id = p.id AND pm.status = 'ACTIVE'
       WHERE p.status = 'ACTIVE' AND pm.url = ? AND p.category_id IN (${ids.map(() => '?').join(',')})`, [c.thumbnailUrl, ...ids]);
    assert.ok(Number(owned[0].n) > 0, `category ${c.slug} thumbnail is not from its own products`);
    checkedCategories += 1;
  }
  results.categoriesUseOwnPhotos = `PASS (${checkedCategories} with photos)`;

  // 3 -- an empty collection has no thumbnail -----------------------------------
  emptyId = randomUUID();
  await query(
    "INSERT INTO collections (id, brand_id, slug, name, status, display_order) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), ?, 'QA Empty', 'ACTIVE', 999)",
    [emptyId, emptySlug]);
  assert.equal(await catalogService.collectionThumbnail(emptyId), null, 'an empty collection gets no picture');
  results.emptyCollectionHasNone = 'PASS';

  // 4 -- the API carries it -----------------------------------------------------
  const list = await fetch(`${BASE}/api/v1/collections`).then((r) => r.json());
  assert.ok(Array.isArray(list.data) && list.data.length, 'collections listed');
  assert.ok(list.data.every((row) => 'image' in row), 'every row has an image field');
  const empty = list.data.find((row) => row.slug === emptySlug);
  assert.equal(empty?.image, null, 'empty collection image is null in the API');
  // The API sends exactly the photo checked above (or null), for every row.
  // Having products does not imply a photo: products may only have colour
  // placeholders (the CI seed has none with photos).
  const expected = new Map([...collections, ...categories].map((c) => [c.slug, c.thumbnailUrl || null]));
  for (const row of list.data) {
    if (!expected.has(row.slug)) continue;
    assert.equal(row.image, expected.get(row.slug), `API image for ${row.slug} differs from its checked thumbnail`);
  }
  const one = await fetch(`${BASE}/api/v1/collections/${list.data[0].slug}`).then((r) => r.json());
  assert.ok('image' in one.data, 'single collection endpoint has an image field');
  results.apiCarriesImage = 'PASS';

  results.status = 'PASS';
  console.log('\nCOLLECTION_THUMBNAILS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nCOLLECTION_THUMBNAILS_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  if (emptyId) await query('DELETE FROM collections WHERE id = ?', [emptyId]).catch((e) => console.error('cleanup', e.message));
  await new Promise((resolve) => { server.close(resolve); });
  await pool.end();
}
