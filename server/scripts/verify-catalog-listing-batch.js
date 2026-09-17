// GET /collections used to run 91 queries (a count + page + thumbnail query
// per category and per collection) and saturated production's single vCPU at
// ~80 requests/s in the 2026-09-15 load test. listCategories/listCollections
// now answer from a few grouped queries. This gate proves the grouped answers
// are identical to the per-item methods for EVERY category and collection in
// the database: same productCount, same thumbnailUrl. Read-only.
import assert from 'node:assert/strict';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
const { default: catalogService } = await import('../src/modules/catalog/service.js');
const { pool } = await import('../src/database/connection/pool.js');

const results = {};
const check = async (name, fn) => {
  try { await fn(); results[name] = 'PASS'; } catch (error) { results[name] = `FAIL ${error.message}`; }
};

try {
  const categories = await catalogService.listCategories();
  const collections = await catalogService.listCollections();

  await check('CATEGORIES_MATCH_PER_ITEM', async () => {
    for (const c of categories) {
      const ids = await catalogService.categoryRepository.selfAndDescendantIds(c.id);
      assert.equal(c.productCount, await catalogService.countProductsInCategory(c.id), `productCount for category ${c.slug}`);
      assert.equal(c.thumbnailUrl, await catalogService.categoryThumbnail(ids), `thumbnailUrl for category ${c.slug}`);
    }
  });

  await check('COLLECTIONS_MATCH_PER_ITEM', async () => {
    for (const c of collections) {
      assert.equal(c.productCount, await catalogService.collectionRepository.countProducts(c.id), `productCount for collection ${c.slug}`);
      assert.equal(c.thumbnailUrl, await catalogService.collectionThumbnail(c.id), `thumbnailUrl for collection ${c.slug}`);
    }
  });

  await check('ORDER_AND_SHAPE_UNCHANGED', async () => {
    const activeCategories = await catalogService.categoryRepository.findAll({ status: 'ACTIVE' });
    assert.deepEqual(categories.map((c) => c.id), activeCategories.map((c) => c.id), 'categories keep display_order order');
    const activeCollections = await catalogService.collectionRepository.findAll({ status: 'ACTIVE' });
    assert.deepEqual(collections.map((c) => c.id), activeCollections.map((c) => c.id), 'collections keep display_order order');
    for (const c of categories) assert.deepEqual(Object.keys(c).sort(), ['displayOrder', 'id', 'name', 'parentId', 'productCount', 'slug', 'thumbnailUrl']);
    for (const c of collections) assert.deepEqual(Object.keys(c).sort(), ['description', 'displayOrder', 'id', 'name', 'productCount', 'slug', 'thumbnailUrl']);
  });

  console.log(`checked ${categories.length} categories, ${collections.length} collections`);
} finally {
  await pool.end();
}

console.log(JSON.stringify(results, null, 2));
const failed = Object.values(results).filter((v) => v.startsWith('FAIL'));
console.log(`CATALOG_LISTING_BATCH = ${failed.length ? `FAIL (${failed.length})` : 'PASS'}`);
process.exitCode = failed.length ? 1 : 0;
