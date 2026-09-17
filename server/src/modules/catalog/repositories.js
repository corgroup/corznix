// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/modules/catalog/repositories.js.
//
// Changes made during adaptation (verified against target conventions —
// see docs/MIGRATION.md, "Backend Salvage Decisions"):
//   - `query()` returns rows directly here (target's
//     database/connection/pool.js) instead of `{ rows }` (source's
//     db/pool.js) — every `result.rows` became `result`.
//   - `uuid` (npm package) replaced with Node's built-in
//     `crypto.randomUUID()` — matches the pattern target's own
//     modules/media/service.js already uses; avoids adding a dependency
//     the target server doesn't otherwise need.
//   - No other logic changes. SQL, validation, and error codes are
//     unchanged from source (verified MySQL 8.x compatible: parameterized
//     queries throughout, no dynamic SQL built from unvalidated input
//     except column names, which come only from this file's own fixed
//     `updates` keys, never from request bodies directly).
import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

function translateDupEntry(err, code, message) {
  if (err.code === 'ER_DUP_ENTRY') {
    throw new AppError(code, message, 409);
  }
  throw err;
}

// Column-whitelisted partial UPDATE. `columnMap` maps caller-facing keys to
// real column names, so a request body can never name an arbitrary column.
// Only keys present in `patch` with a value !== undefined are written.
// `extraWhere` (multi-company, Phase 3) adds further `AND col = ?` clauses —
// used for `{ brand_id: brandId }` so an UPDATE can never reach a row
// belonging to another company; omitted keys (null/undefined) add nothing,
// preserving the storefront's unscoped callers.
async function applyUpdate(table, id, patch, columnMap, extraWhere = {}) {
  const entries = Object.entries(patch).filter(([key, value]) => value !== undefined && key in columnMap);
  if (entries.length === 0) return;
  const sets = entries.map(([key]) => `\`${columnMap[key]}\` = ?`).join(', ');
  const values = entries.map(([, value]) => value);
  values.push(id);
  const whereExtra = Object.entries(extraWhere).filter(([, v]) => v != null);
  const whereSql = whereExtra.map(([col]) => ` AND \`${col}\` = ?`).join('');
  values.push(...whereExtra.map(([, v]) => v));
  await query(`UPDATE \`${table}\` SET ${sets}, updated_at = NOW() WHERE id = ?${whereSql}`, values);
}

export class CategoryRepository {
  async create({ id = randomUUID(), name, slug, parentId = null, displayOrder = 0, status = 'ACTIVE' }) {
    try {
      await query(
        `INSERT INTO categories (id, name, slug, parent_id, display_order, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, name, slug, parentId, displayOrder, status],
      );
    } catch (err) {
      translateDupEntry(err, 'VALIDATION_ERROR', 'A category with this slug already exists.');
    }
    return this.findById(id);
  }

  // `brandId` is optional and appended-only (implementation/multi-company/
  // DESIGN.md §4.1, Phase 3) — the storefront's catalog/service.js calls
  // these without it (unscoped, deferred to Phase 4's storefront
  // host->brand mapping); adminCatalog/service.js always passes it.
  async findById(id, brandId = null) {
    const rows = brandId
      ? await query('SELECT * FROM categories WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId])
      : await query('SELECT * FROM categories WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findBySlug(slug) {
    const rows = await query('SELECT * FROM categories WHERE slug = ? LIMIT 1', [slug]);
    return rows[0] || null;
  }

  async findAll({ status = null, brandId = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (brandId) { where.push('brand_id = ?'); params.push(brandId); }
    const sql = `SELECT * FROM categories${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY display_order ASC`;
    return query(sql, params);
  }

  // self + direct children ids (the category tree here is only ever 2 levels deep)
  async selfAndDescendantIds(categoryId) {
    const rows = await query('SELECT id FROM categories WHERE id = ? OR parent_id = ?', [categoryId, categoryId]);
    return rows.map((r) => r.id);
  }

  // Every category's parent link, any status — what selfAndDescendantIds reads
  // one category at a time, for callers that need the whole tree at once.
  async parentLinks() {
    return query('SELECT id, parent_id FROM categories');
  }

  // Storefront variant count per category, on the grain listVariantRows counts
  // (ACTIVE variants of ACTIVE products with at least one ACTIVE sku) — one
  // grouped query instead of a full listing query per category.
  async activeVariantCounts() {
    const rows = await query(
      `SELECT p.category_id, COUNT(DISTINCT v.id) AS c
         FROM products p
         JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE'
         JOIN skus s ON s.variant_id = v.id AND s.status = 'ACTIVE'
        WHERE p.status = 'ACTIVE' AND p.category_id IS NOT NULL
        GROUP BY p.category_id`,
    );
    return new Map(rows.map((r) => [r.category_id, Number(r.c)]));
  }

  // The product's ACTIVE category memberships (Wave 8D M2M), primary first.
  async findActiveForProduct(productId) {
    return query(
      `SELECT c.id, c.name, c.slug, pc.is_primary
       FROM product_categories pc JOIN categories c ON c.id = pc.category_id
       WHERE pc.product_id = ? AND c.status = 'ACTIVE'
       ORDER BY pc.is_primary DESC, pc.position ASC`,
      [productId],
    );
  }
}

export class CollectionRepository {
  async create({ id = randomUUID(), name, slug, description = null, displayOrder = 0, status = 'ACTIVE', publishedAt = null }) {
    try {
      await query(
        `INSERT INTO collections (id, name, slug, description, display_order, status, published_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, name, slug, description, displayOrder, status, publishedAt],
      );
    } catch (err) {
      translateDupEntry(err, 'VALIDATION_ERROR', 'A collection with this slug already exists.');
    }
    return this.findById(id);
  }

  // `brandId` optional/appended-only — see CategoryRepository's note above.
  async findById(id, brandId = null) {
    const rows = brandId
      ? await query('SELECT * FROM collections WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId])
      : await query('SELECT * FROM collections WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findBySlug(slug) {
    const rows = await query('SELECT * FROM collections WHERE slug = ? LIMIT 1', [slug]);
    return rows[0] || null;
  }

  async findAll({ status = null, brandId = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (brandId) { where.push('brand_id = ?'); params.push(brandId); }
    const sql = `SELECT * FROM collections${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY display_order ASC`;
    return query(sql, params);
  }

  async countProducts(collectionId) {
    const rows = await query(
      `SELECT COUNT(DISTINCT pc.product_id) AS c FROM product_collections pc
       JOIN products p ON p.id = pc.product_id AND p.status = 'ACTIVE'
       WHERE pc.collection_id = ?`,
      [collectionId],
    );
    return Number(rows[0].c);
  }

  // countProducts for every collection in one grouped query.
  async productCounts() {
    const rows = await query(
      `SELECT pc.collection_id, COUNT(DISTINCT pc.product_id) AS c FROM product_collections pc
       JOIN products p ON p.id = pc.product_id AND p.status = 'ACTIVE'
       GROUP BY pc.collection_id`,
    );
    return new Map(rows.map((r) => [r.collection_id, Number(r.c)]));
  }

  async addProduct(productId, collectionId) {
    // Append at the end of the collection's manual order (Wave 8D:
    // product_collections.position is unique per collection).
    await query(
      `INSERT IGNORE INTO product_collections (product_id, collection_id, position, created_at)
       SELECT ?, ?, COALESCE(MAX(position), -1) + 1, NOW(3)
       FROM product_collections WHERE collection_id = ?`,
      [productId, collectionId, collectionId],
    );
  }

  async findForProduct(productId) {
    const rows = await query(
      `SELECT c.* FROM collections c
       JOIN product_collections pc ON pc.collection_id = c.id
       WHERE pc.product_id = ?`,
      [productId],
    );
    return rows;
  }
}

export class SizeGuideRepository {
  async create({ id = randomUUID(), name, slug, unit = 'in', status = 'ACTIVE' }) {
    try {
      await query(
        `INSERT INTO size_guides (id, name, slug, unit, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, name, slug, unit, status],
      );
    } catch (err) {
      translateDupEntry(err, 'VALIDATION_ERROR', 'A size guide with this slug already exists.');
    }
    return this.findById(id);
  }

  // `brandId` optional/appended-only — see CategoryRepository's note above.
  async findById(id, brandId = null) {
    const rows = brandId
      ? await query('SELECT * FROM size_guides WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId])
      : await query('SELECT * FROM size_guides WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findAll({ status = null, brandId = null } = {}) {
    const where = [];
    const params = [];
    if (status) { where.push('status = ?'); params.push(status); }
    if (brandId) { where.push('brand_id = ?'); params.push(brandId); }
    const sql = `SELECT * FROM size_guides${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY name ASC`;
    return query(sql, params);
  }

  async addRow({ id = randomUUID(), sizeGuideId, size, chest = null, length = null, shoulder = null, sleeve = null, displayOrder = 0 }) {
    await query(
      `INSERT INTO size_guide_rows (id, size_guide_id, size, chest, length, shoulder, sleeve, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, sizeGuideId, size, chest, length, shoulder, sleeve, displayOrder],
    );
    return { id, sizeGuideId, size, chest, length, shoulder, sleeve, displayOrder };
  }

  async findRows(sizeGuideId) {
    return query('SELECT * FROM size_guide_rows WHERE size_guide_id = ? ORDER BY display_order ASC', [sizeGuideId]);
  }

  async usageCount(sizeGuideId) {
    const rows = await query('SELECT COUNT(*) AS c FROM products WHERE size_guide_id = ?', [sizeGuideId]);
    return Number(rows[0]?.c || 0);
  }
}

export class ProductRepository {
  async create({
    id = randomUUID(), slug, name, shortDescription = null, description = null, brand = 'CORCOTTON',
    categoryId = null, fit = null, productType, productTypeCodeId = null, fitCodeId = null,
    sizeGuideId = null, status = 'DRAFT',
    publishedAt = null, seoTitle = null, seoDescription = null,
  }) {
    try {
      await query(
        `INSERT INTO products (id, slug, name, short_description, description, brand, category_id, fit, product_type, product_type_code_id, fit_code_id, size_guide_id, status, published_at, seo_title, seo_description, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, slug, name, shortDescription, description, brand, categoryId, fit, productType, productTypeCodeId, fitCodeId, sizeGuideId, status, publishedAt, seoTitle, seoDescription],
      );
    } catch (err) {
      translateDupEntry(err, 'VALIDATION_ERROR', 'A product with this slug already exists.');
    }
    return this.findById(id);
  }

  // `brandId` optional/appended-only — see CategoryRepository's note above.
  async findById(id, brandId = null) {
    const rows = brandId
      ? await query('SELECT * FROM products WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId])
      : await query('SELECT * FROM products WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findBySlug(slug) {
    const rows = await query('SELECT * FROM products WHERE slug = ? LIMIT 1', [slug]);
    return rows[0] || null;
  }

  static UPDATE_COLUMNS = {
    slug: 'slug', name: 'name', shortDescription: 'short_description', description: 'description',
    brand: 'brand', categoryId: 'category_id', fit: 'fit', productType: 'product_type',
    productTypeCodeId: 'product_type_code_id', fitCodeId: 'fit_code_id',
    sizeGuideId: 'size_guide_id', status: 'status', publishedAt: 'published_at',
    seoTitle: 'seo_title', seoDescription: 'seo_description', seoKeywords: 'seo_keywords',
    fabric: 'fabric', gsm: 'gsm', displayPriceMinor: 'display_price_minor',
  };

  async update(id, patch, brandId = null) {
    try {
      await applyUpdate('products', id, patch, ProductRepository.UPDATE_COLUMNS, { brand_id: brandId });
    } catch (err) {
      translateDupEntry(err, 'VALIDATION_ERROR', 'A product with this slug already exists.');
    }
    return this.findById(id, brandId);
  }

  // Admin-grain listing: every product (any status) with variant/sku counts,
  // effective price range across ACTIVE skus, and shipping-profile
  // completeness — the storefront listVariantRows is variant-grain and
  // ACTIVE-only, so it cannot serve Product Studio. Admin-only (no
  // storefront caller), so `brandId` is required, not optional.
  async listAdmin({
    q = null, status = null, shipping = null, categoryId = null, collectionId = null,
    sizeGuide = null, productType = null, sort = 'updated', page = 1, limit = 20, brandId,
  } = {}) {
    const where = ['p.brand_id = ?'];
    const params = [brandId];
    if (q) {
      where.push('(p.name LIKE ? OR p.slug LIKE ? OR EXISTS (SELECT 1 FROM product_variants v2 JOIN skus s2 ON s2.variant_id=v2.id WHERE v2.product_id=p.id AND s2.sku LIKE ?))');
      params.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (status) { where.push('p.status = ?'); params.push(status); }
    if (categoryId) { where.push('p.category_id = ?'); params.push(categoryId); }
    if (collectionId) {
      where.push('EXISTS (SELECT 1 FROM product_collections pc WHERE pc.product_id = p.id AND pc.collection_id = ?)');
      params.push(collectionId);
    }
    // Additive (Phase 3 product-module redesign): both filters use existing
    // columns/indexes and leave every existing caller path unchanged.
    if (sizeGuide === 'assigned') where.push('p.size_guide_id IS NOT NULL');
    else if (sizeGuide === 'unassigned') where.push('p.size_guide_id IS NULL');
    if (productType) { where.push('p.product_type = ?'); params.push(productType); }
    // Rate-ready = weight resolvable (product default, or every ACTIVE sku has
    // its own). Mirrors adminCatalog service `shipping.rateReady` / facets.
    const rateReadyExpr = `(
      psp.weight_grams IS NOT NULL
      OR (
        EXISTS (SELECT 1 FROM skus rs JOIN product_variants rv ON rv.id = rs.variant_id
                WHERE rv.product_id = p.id AND rs.status = 'ACTIVE')
        AND NOT EXISTS (SELECT 1 FROM skus rs JOIN product_variants rv ON rv.id = rs.variant_id
                        WHERE rv.product_id = p.id AND rs.status = 'ACTIVE' AND rs.weight_grams IS NULL)
      )
    )`;
    if (shipping === 'COMPLETE') {
      where.push('(psp.weight_grams IS NOT NULL AND psp.length_mm IS NOT NULL AND psp.width_mm IS NOT NULL AND psp.height_mm IS NOT NULL)');
    } else if (shipping === 'INCOMPLETE') {
      where.push('(psp.product_id IS NULL OR psp.weight_grams IS NULL OR psp.length_mm IS NULL OR psp.width_mm IS NULL OR psp.height_mm IS NULL)');
    } else if (shipping === 'RATE_READY') {
      where.push(rateReadyExpr);
    } else if (shipping === 'NOT_RATE_READY') {
      where.push(`NOT ${rateReadyExpr}`);
    }

    const ORDER_BY = {
      updated: 'p.updated_at DESC',
      created: 'p.created_at DESC',
      name: 'p.name ASC',
      name_desc: 'p.name DESC',
    };
    const orderBy = ORDER_BY[sort] || ORDER_BY.updated;

    const base = `
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN product_shipping_profiles psp ON psp.product_id = p.id
      WHERE ${where.join(' AND ')}
    `;
    const total = Number((await query(`SELECT COUNT(*) AS c ${base}`, params))[0].c);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * limit;

    const rows = await query(`
      SELECT
        p.id, p.slug, p.name, p.status, p.product_type, p.fit, p.category_id,
        p.size_guide_id, p.updated_at, p.created_at, p.published_at,
        c.name AS category_name, c.slug AS category_slug,
        psp.weight_grams, psp.length_mm, psp.width_mm, psp.height_mm,
        -- = 'IMAGE', not <> 'GRADIENT': the CMS product list renders this in an
        -- <img src>, so a VIDEO row breaks it the same way a gradient string does.
        (SELECT pm.url FROM product_media pm
           WHERE pm.product_id = p.id AND pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE'
           ORDER BY pm.is_primary DESC, pm.position ASC LIMIT 1) AS primary_media_url,
        (SELECT COUNT(*) FROM product_collections pc WHERE pc.product_id = p.id) AS collection_count,
        ${rateReadyExpr} AS rate_ready,
        (SELECT COUNT(*) FROM product_variants v WHERE v.product_id = p.id) AS variant_count,
        (SELECT COUNT(*) FROM skus s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = p.id) AS sku_count,
        (SELECT MIN(COALESCE(s.sale_price_minor, s.price_minor)) FROM skus s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = p.id AND s.status = 'ACTIVE') AS min_price_minor,
        (SELECT MAX(s.price_minor) FROM skus s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = p.id AND s.status = 'ACTIVE') AS max_price_minor
      ${base}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `, [...params, Number(limit), Number(offset)]);

    return { rows, total, page: safePage, totalPages };
  }

  // One row per ACTIVE variant with its ACTIVE-sku effective price range and
  // size run — the grain the storefront actually displays (one card per
  // color).
  async listVariantRows({
    categoryIds = null, collectionId = null, colorName = null, size = null, fit = null,
    minPriceMinor = null, maxPriceMinor = null, sort = 'newest', page = 1, limit = 8,
  }) {
    const where = ["p.status = 'ACTIVE'", "v.status = 'ACTIVE'"];
    const params = [];

    if (categoryIds && categoryIds.length > 0) {
      where.push(`p.category_id IN (${categoryIds.map(() => '?').join(',')})`);
      params.push(...categoryIds);
    }
    if (collectionId) {
      where.push('EXISTS (SELECT 1 FROM product_collections pc WHERE pc.product_id = p.id AND pc.collection_id = ?)');
      params.push(collectionId);
    }
    if (colorName) {
      where.push('v.color_name = ?');
      params.push(colorName);
    }
    // Wave 3.5 addition: the storefront's Mega Menu "Shop by Fit" pills
    // (Collection.jsx's `?fit=` param, see docs/MIGRATION.md) need a real
    // fit filter to reach the database — this was missing entirely before
    // (fixture-only filtering), which would have silently reintroduced the
    // already-fixed "?fit= query ignored" defect once wired to this API.
    if (fit) {
      where.push('p.fit = ?');
      params.push(fit);
    }
    if (size) {
      where.push("EXISTS (SELECT 1 FROM skus s2 WHERE s2.variant_id = v.id AND s2.status = 'ACTIVE' AND s2.size = ?)");
      params.push(size);
    }

    const having = [];
    if (minPriceMinor != null) having.push(`MIN(COALESCE(s.sale_price_minor, s.price_minor)) >= ${Number(minPriceMinor)}`);
    if (maxPriceMinor != null) having.push(`MIN(COALESCE(s.sale_price_minor, s.price_minor)) <= ${Number(maxPriceMinor)}`);

    // `sort=manual` orders a collection listing by the operator-curated
    // product_collections.position (Wave 8D). Opt-in only — every other
    // caller keeps its existing default ordering unchanged.
    const wantManual = sort === 'manual' && Boolean(collectionId);
    const manualSelect = wantManual
      ? ', (SELECT pcpos.position FROM product_collections pcpos WHERE pcpos.product_id = p.id AND pcpos.collection_id = ?) AS collection_position'
      : '';

    const ORDER_BY = {
      'newest': 'v.created_at DESC',
      'price-asc': 'min_price_minor ASC',
      'price-desc': 'min_price_minor DESC',
      'featured': 'is_bestseller DESC, v.created_at DESC',
      'popular': 'v.created_at DESC',
      'manual': wantManual ? 'collection_position ASC, v.created_at DESC' : 'v.created_at DESC',
    };
    const orderBy = ORDER_BY[sort] || ORDER_BY.newest;

    const sql = `
      SELECT
        p.id AS product_id, p.slug AS product_slug, p.name AS product_name,
        p.short_description, p.description, p.fit, p.product_type, p.display_price_minor,
        c.slug AS category_slug, c.name AS category_name, c.parent_id AS category_parent_id,
        v.id AS variant_id, v.storefront_id, v.color_name, v.color_hex, v.badge, v.created_at AS variant_created_at,
        MIN(COALESCE(s.sale_price_minor, s.price_minor)) AS min_price_minor,
        MAX(s.price_minor) AS max_regular_price_minor,
        MIN(s.sale_price_minor) AS min_sale_price_minor,
        EXISTS (SELECT 1 FROM product_collections pc2 JOIN collections col2 ON col2.id = pc2.collection_id WHERE pc2.product_id = p.id AND col2.slug = 'bestsellers') AS is_bestseller
        ${manualSelect}
      FROM products p
      JOIN product_variants v ON v.product_id = p.id
      JOIN skus s ON s.variant_id = v.id AND s.status = 'ACTIVE'
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')}
      GROUP BY v.id
      ${having.length ? `HAVING ${having.join(' AND ')}` : ''}
      ORDER BY ${orderBy}
    `;

    // The manual-order subquery adds one leading `?` (collectionId) to the
    // SELECT clause, before every WHERE param.
    const execParams = wantManual ? [collectionId, ...params] : params;

    const countRows = await query(`SELECT COUNT(*) AS c FROM (${sql}) x`, execParams);
    const total = Number(countRows[0].c);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * limit;

    const pageRows = await query(`${sql} LIMIT ? OFFSET ?`, [...execParams, Number(limit), Number(offset)]);

    return { rows: pageRows, total, page: safePage, totalPages };
  }

  // Wave 4 (Real Search) addition. Same grain/shape as listVariantRows
  // (one row per ACTIVE variant) so CatalogService.attachMediaAndSizes can
  // enrich search results identically to a normal listing — one Product
  // shape everywhere (migration brief §13), never a second SearchProduct
  // contract.
  //
  // INDEXING NOTE: plain LIKE against `name`/`short_description`/category
  // name. At today's real catalog size (~10 products) this is genuinely
  // fine — no index was added speculatively. If the catalog grows into the
  // hundreds+ of products, the first real scaling step is a MySQL
  // FULLTEXT index on `products(name, short_description)` and switching
  // this query to MATCH...AGAINST; documented here rather than built now
  // with no evidence it's needed yet (migration brief §18/§52).
  async searchVariantRows({ q, page = 1, limit = 8 }) {
    const like = `%${q}%`;
    // Simple, honest relevance heuristic — not a real ranking algorithm:
    // a name that starts with the query sorts first, then any other
    // match, newest-first within each group.
    const relevance = "CASE WHEN p.name LIKE ? THEN 0 ELSE 1 END";
    const prefixLike = `${q}%`;

    const where = [
      "p.status = 'ACTIVE'",
      "v.status = 'ACTIVE'",
      '(p.name LIKE ? OR p.short_description LIKE ? OR p.description LIKE ? OR c.name LIKE ?)',
    ];
    const matchParams = [like, like, like, like];

    const sql = `
      SELECT
        p.id AS product_id, p.slug AS product_slug, p.name AS product_name,
        p.short_description, p.description, p.fit, p.product_type, p.display_price_minor,
        c.slug AS category_slug, c.name AS category_name, c.parent_id AS category_parent_id,
        v.id AS variant_id, v.storefront_id, v.color_name, v.color_hex, v.badge, v.created_at AS variant_created_at,
        MIN(COALESCE(s.sale_price_minor, s.price_minor)) AS min_price_minor,
        MAX(s.price_minor) AS max_regular_price_minor,
        MIN(s.sale_price_minor) AS min_sale_price_minor
      FROM products p
      JOIN product_variants v ON v.product_id = p.id
      JOIN skus s ON s.variant_id = v.id AND s.status = 'ACTIVE'
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE ${where.join(' AND ')}
      GROUP BY v.id
      ORDER BY ${relevance} ASC, v.created_at DESC
    `;
    const sqlParams = [...matchParams, prefixLike];

    const countRows = await query(`SELECT COUNT(*) AS c FROM (${sql}) x`, sqlParams);
    const total = Number(countRows[0].c);

    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(Math.max(1, page), totalPages);
    const offset = (safePage - 1) * limit;

    const pageRows = await query(`${sql} LIMIT ? OFFSET ?`, [...sqlParams, Number(limit), Number(offset)]);

    return { rows: pageRows, total, page: safePage, totalPages };
  }

  async distinctFilterOptions({ categoryIds = null, collectionId = null }) {
    const where = ["p.status = 'ACTIVE'", "v.status = 'ACTIVE'", "s.status = 'ACTIVE'"];
    const params = [];
    if (categoryIds && categoryIds.length > 0) {
      where.push(`p.category_id IN (${categoryIds.map(() => '?').join(',')})`);
      params.push(...categoryIds);
    }
    if (collectionId) {
      where.push('EXISTS (SELECT 1 FROM product_collections pc WHERE pc.product_id = p.id AND pc.collection_id = ?)');
      params.push(collectionId);
    }

    // One option per colour NAME. The colour filter matches on the name
    // (v.color_name = ?), so two shades both called "White" (#f5f5f0 and
    // #FFFFFF) are one choice — DISTINCT name+hex listed each such colour
    // twice in the storefront filter. The hex is only a swatch hint, so any
    // one shade of the name is correct; MIN keeps it stable.
    const colorsRows = await query(
      `SELECT v.color_name AS name, MIN(v.color_hex) AS hex FROM products p
       JOIN product_variants v ON v.product_id = p.id
       JOIN skus s ON s.variant_id = v.id
       WHERE ${where.join(' AND ')} AND v.color_name IS NOT NULL
       GROUP BY v.color_name
       ORDER BY v.color_name`,
      params,
    );
    const sizesRows = await query(
      `SELECT DISTINCT s.size FROM products p
       JOIN product_variants v ON v.product_id = p.id
       JOIN skus s ON s.variant_id = v.id
       WHERE ${where.join(' AND ')}`,
      params,
    );

    return {
      colors: colorsRows.map((r) => ({ name: r.name, hex: r.hex })),
      sizes: sizesRows.map((r) => r.size),
    };
  }
}

export class ProductVariantRepository {
  // `brandId` required — denormalized from the parent product (DESIGN.md
  // §4.1: product_variants is directly, not transitively, scoped). Callers
  // must always pass the PARENT PRODUCT's brand_id, never a separately
  // supplied one, so a variant can never end up in a different company than
  // its own product.
  async create({
    id = randomUUID(), productId, brandId, colorName = null, colorHex = null, colorCodeId = null,
    designName = null, designCode = null, badge = null,
    status = 'ACTIVE', displayOrder = 0, createdAt = null,
  }) {
    const createdAtSql = createdAt ? '?' : 'NOW()';
    const params = [id, productId, brandId, colorName, colorHex, colorCodeId, designName, designCode, badge, status, displayOrder];
    if (createdAt) params.push(createdAt);
    await query(
      `INSERT INTO product_variants (id, product_id, brand_id, color_name, color_hex, color_code_id, design_name, design_code, badge, status, display_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${createdAtSql}, NOW())`,
      params,
    );
    return this.findById(id);
  }

  // `brandId` optional/appended-only — see CategoryRepository's note above.
  async findById(id, brandId = null) {
    const rows = brandId
      ? await query('SELECT * FROM product_variants WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId])
      : await query('SELECT * FROM product_variants WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findByStorefrontId(storefrontId) {
    const rows = await query('SELECT * FROM product_variants WHERE storefront_id = ? LIMIT 1', [storefrontId]);
    return rows[0] || null;
  }

  async findForProduct(productId, brandId = null) {
    return brandId
      ? query('SELECT * FROM product_variants WHERE product_id = ? AND brand_id = ? ORDER BY display_order ASC, created_at ASC', [productId, brandId])
      : query('SELECT * FROM product_variants WHERE product_id = ? ORDER BY display_order ASC, created_at ASC', [productId]);
  }

  static UPDATE_COLUMNS = {
    colorName: 'color_name', colorHex: 'color_hex', colorCodeId: 'color_code_id',
    designName: 'design_name', designCode: 'design_code', badge: 'badge',
    status: 'status', displayOrder: 'display_order',
  };

  async update(id, patch, brandId = null) {
    await applyUpdate('product_variants', id, patch, ProductVariantRepository.UPDATE_COLUMNS, { brand_id: brandId });
    return this.findById(id, brandId);
  }
}

export class SkuRepository {
  // `brandId` required — denormalized from the parent product/variant
  // (DESIGN.md §4.1: skus is directly, not transitively, scoped). Callers
  // must always pass the parent's brand_id.
  async create({
    id = randomUUID(), variantId, brandId, sku, size, status = 'ACTIVE', priceMinor, salePriceMinor = null,
    currency = 'INR', displayOrder = 0, weightGrams = null,
  }) {
    try {
      await query(
        `INSERT INTO skus (id, variant_id, brand_id, sku, size, weight_grams, status, price_minor, sale_price_minor, currency, display_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [id, variantId, brandId, sku, size, weightGrams ?? null, status, priceMinor, salePriceMinor, currency, displayOrder],
      );
    } catch (err) {
      translateDupEntry(err, 'SKU_ALREADY_EXISTS', 'This SKU or size already exists for this variant.');
    }
    return this.findById(id);
  }

  // `brandId` optional/appended-only — see CategoryRepository's note above.
  async findById(id, brandId = null) {
    const rows = brandId
      ? await query('SELECT * FROM skus WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId])
      : await query('SELECT * FROM skus WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findForVariant(variantId) {
    return query('SELECT * FROM skus WHERE variant_id = ? ORDER BY display_order ASC', [variantId]);
  }

  async findActiveForVariantIds(variantIds) {
    if (!variantIds || variantIds.length === 0) return [];
    const placeholders = variantIds.map(() => '?').join(',');
    return query(
      `SELECT * FROM skus WHERE variant_id IN (${placeholders}) AND status = 'ACTIVE' ORDER BY display_order ASC`,
      variantIds,
    );
  }

  async findForProductId(productId, brandId = null) {
    return brandId
      ? query(
          `SELECT s.* FROM skus s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = ? AND s.brand_id = ? ORDER BY s.display_order ASC`,
          [productId, brandId],
        )
      : query(
          `SELECT s.* FROM skus s JOIN product_variants v ON v.id = s.variant_id WHERE v.product_id = ? ORDER BY s.display_order ASC`,
          [productId],
        );
  }

  static UPDATE_COLUMNS = {
    sku: 'sku', size: 'size', status: 'status', priceMinor: 'price_minor',
    salePriceMinor: 'sale_price_minor', currency: 'currency', displayOrder: 'display_order',
    weightGrams: 'weight_grams',
  };

  async update(id, patch, brandId = null) {
    try {
      await applyUpdate('skus', id, patch, SkuRepository.UPDATE_COLUMNS, { brand_id: brandId });
    } catch (err) {
      translateDupEntry(err, 'SKU_ALREADY_EXISTS', 'This SKU code or size already exists for this variant.');
    }
    return this.findById(id, brandId);
  }
}

// Product-level shipping metadata (weight_grams / length_mm / width_mm /
// height_mm — the carrier-neutral canonical fields consumed by
// fulfillment readiness). One row per product (uk_product_shipping_profiles_
// product) — the DEFAULT. Per-SKU weight overrides live on skus.weight_grams
// (migration 058); read-time resolution is SKU -> product default -> missing.
export class ProductShippingProfileRepository {
  async findByProductId(productId) {
    const rows = await query('SELECT * FROM product_shipping_profiles WHERE product_id = ? LIMIT 1', [productId]);
    return rows[0] || null;
  }

  async findByProductIds(productIds) {
    if (!productIds || productIds.length === 0) return [];
    const placeholders = productIds.map(() => '?').join(',');
    return query(`SELECT * FROM product_shipping_profiles WHERE product_id IN (${placeholders})`, productIds);
  }

  // Upsert on the product uniqueness key. weight_grams is the checkout
  // rate gate (brief §6) and is required by the schema; length/width/height
  // are physical defaults (brief §7) and may be null (all three together or
  // none — enforced in adminCatalog validation). The DB CHECK (> 0 or NULL)
  // is the final guard.
  async upsert(productId, { weightGrams, lengthMm = null, widthMm = null, heightMm = null }) {
    await query(
      `INSERT INTO product_shipping_profiles (id, product_id, weight_grams, length_mm, width_mm, height_mm, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE weight_grams = VALUES(weight_grams), length_mm = VALUES(length_mm),
         width_mm = VALUES(width_mm), height_mm = VALUES(height_mm), updated_at = NOW()`,
      [randomUUID(), productId, weightGrams, lengthMm ?? null, widthMm ?? null, heightMm ?? null],
    );
    return this.findByProductId(productId);
  }

  // Distinct orders whose non-terminal fulfillments contain a SKU of this
  // product — the only orders whose readiness a profile change can affect.
  async nonTerminalOrderIdsForProduct(productId) {
    const rows = await query(
      `SELECT DISTINCT f.order_id
       FROM fulfillments f
       JOIN fulfillment_items fi ON fi.fulfillment_id = f.id
       JOIN skus s ON s.id = fi.sku_id
       JOIN product_variants v ON v.id = s.variant_id
       WHERE v.product_id = ? AND f.status NOT IN ('FULFILLED', 'CANCELLED')`,
      [productId],
    );
    return rows.map((row) => row.order_id);
  }
}

export class ProductMediaRepository {
  async create({ id = randomUUID(), productId, variantId = null, mediaType = 'IMAGE', url, altText = null, position = 0, status = 'ACTIVE' }) {
    await query(
      `INSERT INTO product_media (id, product_id, variant_id, media_type, url, alt_text, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [id, productId, variantId, mediaType, url, altText, position, status],
    );
    return { id, productId, variantId, mediaType, url, altText, position, status };
  }

  async findForProduct(productId) {
    return query(
      "SELECT * FROM product_media WHERE product_id = ? AND status = 'ACTIVE' ORDER BY position ASC",
      [productId],
    );
  }

  async findForVariantIds(variantIds) {
    if (!variantIds || variantIds.length === 0) return [];
    const placeholders = variantIds.map(() => '?').join(',');
    return query(
      `SELECT * FROM product_media WHERE status = 'ACTIVE' AND (variant_id IN (${placeholders}) OR (variant_id IS NULL AND product_id IN (
        SELECT DISTINCT product_id FROM product_variants WHERE id IN (${placeholders})
      ))) ORDER BY position ASC`,
      [...variantIds, ...variantIds],
    );
  }
}
