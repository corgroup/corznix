// Admin catalog administration. Orchestrates the SAME catalog domain repos
// the storefront uses (no second implementation, Wave 8B §6) plus the
// product shipping-profile authority and the Wave 7A.1 fulfillment
// readiness re-evaluation. Never mutates inventory; never calls a provider.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// every method takes the caller's `brandId` (from `req.brandId`, resolved
// by `resolveBrandContext`) and threads it into the shared catalog repos'
// optional brandId parameter — reads never see another company's catalog,
// writes can never touch or create a row outside the caller's company.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { slugify } from '../../utils/slug.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { query } from '../../database/connection/pool.js';
import {
  ProductRepository,
  ProductVariantRepository,
  SkuRepository,
  CategoryRepository,
  CollectionRepository,
  SizeGuideRepository,
  ProductShippingProfileRepository,
  ProductMediaRepository,
} from '../catalog/repositories.js';
import { inventoryRepository } from '../inventory/repository.js';
import { fulfillmentService } from '../fulfillment/service.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { catalogSkuService } from '../catalogSku/service.js';
import { catalogSkuMasterRepository } from '../catalogSku/masterRepository.js';
import { taxRepository } from '../tax/repository.js';

// Phase 1B — a variant identity change (colour / design) or a product identity
// change (type / fit) regenerates that variant's non-locked CANONICAL SKUs.
const VARIANT_IDENTITY_FIELDS = ['colorCodeId', 'designName', 'designCode'];
const PRODUCT_IDENTITY_FIELDS = ['productTypeCodeId', 'fitCodeId'];

// Phase 2 §5-9. Two distinct states:
//  - shippingComplete  = all four canonical fields present (weight + full box).
//                        Manifestation-grade metadata.
//  - shippingRateReady = weight is resolvable. Weight is the checkout
//                        shipping-rate gate (§6); dimensions are optional
//                        physical defaults (§7).
function shippingComplete(row) {
  return Boolean(row && row.weight_grams && row.length_mm && row.width_mm && row.height_mm);
}

// Resolve a SKU's effective shipping weight: SKU override -> product default
// -> null (§9). `null` must surface as "not rate ready", never a guess.
function effectiveWeightGrams(skuWeightGrams, productWeightGrams) {
  const own = skuWeightGrams == null ? null : Number(skuWeightGrams);
  if (own != null) return own;
  return productWeightGrams == null ? null : Number(productWeightGrams);
}

function priceRange(minMinor, maxMinor) {
  if (minMinor == null) return null;
  return { minMinor: Number(minMinor), maxMinor: Number(maxMinor ?? minMinor), currency: 'INR' };
}


// Replace a product's open-ended specifications in place. Full replacement,
// not merge: the editor always sends the complete list, so a removed row must
// disappear rather than linger on the PDP. Only called when the caller
// actually supplied `specifications` (undefined = leave untouched).
async function writeSpecifications(conn, { productId, brandId, specifications }) {
  await conn.execute('DELETE FROM product_specifications WHERE product_id = ?', [productId]);
  let order = 0;
  for (const spec of specifications) {
    await conn.execute(
      `INSERT INTO product_specifications (id, brand_id, product_id, label, value, display_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), brandId, productId, spec.label, spec.value, order],
    );
    order += 1;
  }
}

export class AdminCatalogService {
  constructor(deps = {}) {
    this.products = deps.products || new ProductRepository();
    this.variants = deps.variants || new ProductVariantRepository();
    this.skus = deps.skus || new SkuRepository();
    this.categories = deps.categories || new CategoryRepository();
    this.collections = deps.collections || new CollectionRepository();
    this.sizeGuides = deps.sizeGuides || new SizeGuideRepository();
    this.shippingProfiles = deps.shippingProfiles || new ProductShippingProfileRepository();
    this.media = deps.media || new ProductMediaRepository();
    this.inventory = deps.inventory || inventoryRepository;
    this.fulfillment = deps.fulfillment || fulfillmentService;
    this.audit = deps.audit || new StaffAuditRepository();
  }

  audit_(actor, entry) {
    return this.audit.log({
      staffUserId: actor?.id || null,
      actorEmail: actor?.email || null,
      ipAddress: actor?.ip || null,
      requestId: actor?.requestId || null,
      ...entry,
    });
  }

  // ---- products ---------------------------------------------------------

  async listProducts(queryInput, brandId) {
    const { rows, total, page, totalPages } = await this.products.listAdmin({ ...queryInput, brandId });
    return {
      products: rows.map((row) => ({
        id: row.id,
        slug: row.slug,
        name: row.name,
        status: row.status,
        productType: row.product_type,
        fit: row.fit,
        category: row.category_id ? { id: row.category_id, name: row.category_name, slug: row.category_slug } : null,
        sizeGuideId: row.size_guide_id,
        // Additive (Phase 3): a thumbnail URL for the list, resolved through the
        // same provider-neutral product_media table the editor uses — never a
        // direct provider reference. `collectionCount` mirrors the M2M membership.
        primaryMedia: row.primary_media_url || null,
        collectionCount: Number(row.collection_count || 0),
        variantCount: Number(row.variant_count),
        skuCount: Number(row.sku_count),
        price: priceRange(row.min_price_minor, row.max_price_minor),
        shipping: {
          status: shippingComplete(row) ? 'COMPLETE' : 'INCOMPLETE',
          // Rate-ready now mirrors the detail view: product default weight OR
          // every ACTIVE sku carrying its own (`rate_ready` computed in SQL).
          rateReady: Boolean(Number(row.rate_ready)),
          weightGrams: row.weight_grams ?? null,
          lengthMm: row.length_mm ?? null,
          widthMm: row.width_mm ?? null,
          heightMm: row.height_mm ?? null,
        },
        publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
        updatedAt: new Date(row.updated_at).toISOString(),
        createdAt: new Date(row.created_at).toISOString(),
      })),
      total,
      page,
      totalPages,
    };
  }

  async getProduct(id, brandId) {
    const product = await this.products.findById(id, brandId);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    const [variants, collections, category, shippingProfile, sizeGuide, mediaRows, taxProfileRow, categoryRows] = await Promise.all([
      this.variants.findForProduct(product.id, brandId),
      this.collections.findForProduct(product.id),
      product.category_id ? this.categories.findById(product.category_id, brandId) : null,
      this.shippingProfiles.findByProductId(product.id),
      product.size_guide_id ? this.sizeGuides.findById(product.size_guide_id, brandId) : null,
      this.media.findForProduct(product.id),
      // B4 (Phase 3) — surface the assigned tax profile read-only. Assignment
      // still goes through the tax module (`POST /tax-profiles/assign`,
      // `tax.manage`); this never invents HSN/GST.
      taxRepository.profileForProduct(null, product.id)
        .then(async (p) => (p ? { ...p, rateBands: await taxRepository.bandsForProfile(null, p.id) } : null)),
      query(
        `SELECT c.id, c.name, c.slug, c.status, pc.is_primary, pc.position
         FROM product_categories pc JOIN categories c ON c.id = pc.category_id
         WHERE pc.product_id = ? ORDER BY pc.is_primary DESC, pc.position ASC`,
        [product.id],
      ),
    ]);

    const allSkus = await this.skus.findForProductId(product.id, brandId);
    // Inventory is warehouse-scoped: one row per (warehouse, sku). Product
    // Studio shows the aggregate across every warehouse (read-only).
    const inventoryRows = allSkus.length
      ? await this.inventory.findForSkuIds(allSkus.map((s) => s.id))
      : [];
    // Phase 1B — which SKUs have operational history (identity locked).
    const lockedSkuIds = allSkus.length
      ? await catalogSkuMasterRepository.skusWithOperationalHistory(allSkus.map((s) => s.id))
      : new Set();
    // Per-warehouse breakdown so the editor can show WHERE the stock sits and
    // target an adjustment at one warehouse. The aggregate below is unchanged.
    const warehouseNames = new Map(
      (await query('SELECT id, code, name FROM warehouses')).map((w) => [w.id, { code: w.code, name: w.name }]),
    );
    const byWarehouse = new Map();
    for (const row of inventoryRows) {
      const list = byWarehouse.get(row.sku_id) || [];
      const wh = warehouseNames.get(row.warehouse_id) || {};
      list.push({
        warehouseId: row.warehouse_id,
        warehouseCode: wh.code || null,
        warehouseName: wh.name || null,
        onHand: Number(row.on_hand),
        reserved: Number(row.reserved),
      });
      byWarehouse.set(row.sku_id, list);
    }

    const invBySku = new Map();
    for (const row of inventoryRows) {
      const acc = invBySku.get(row.sku_id) || { sku_id: row.sku_id, on_hand: 0, reserved: 0 };
      acc.on_hand += Number(row.on_hand);
      acc.reserved += Number(row.reserved);
      invBySku.set(row.sku_id, acc);
    }

    const productWeightGrams = shippingProfile?.weight_grams ?? null;
    const skusByVariant = new Map();
    for (const sku of allSkus) {
      if (!skusByVariant.has(sku.variant_id)) skusByVariant.set(sku.variant_id, []);
      const inv = invBySku.get(sku.id);
      const effWeight = effectiveWeightGrams(sku.weight_grams, productWeightGrams);
      skusByVariant.get(sku.variant_id).push({
        id: sku.id,
        sku: sku.sku,
        skuKind: sku.sku_kind,
        identityLocked: lockedSkuIds.has(sku.id),
        size: sku.size,
        // Phase 2 §9 — own override (null ⇒ inherits product default), the
        // resolved value, and its source.
        weightGrams: sku.weight_grams == null ? null : Number(sku.weight_grams),
        effectiveWeightGrams: effWeight,
        weightSource: sku.weight_grams != null ? 'SKU' : (productWeightGrams != null ? 'PRODUCT' : 'MISSING'),
        rateReady: effWeight != null,
        status: sku.status,
        priceMinor: Number(sku.price_minor),
        salePriceMinor: sku.sale_price_minor == null ? null : Number(sku.sale_price_minor),
        currency: sku.currency,
        displayOrder: sku.display_order,
        // Read-only inventory visibility. `available` is derived from the
        // backend's own on_hand/reserved — never editable here (§25/§26).
        inventoryByWarehouse: byWarehouse.get(sku.id) || [],
        inventory: inv
          ? { onHand: Number(inv.on_hand), reserved: Number(inv.reserved), available: Number(inv.on_hand) - Number(inv.reserved) }
          : { configured: false },
      });
    }

    // Open-ended specifications, ordered as the merchandiser arranged them.
    const specifications = await query(
      'SELECT label, value FROM product_specifications WHERE product_id = ? ORDER BY display_order, label',
      [product.id],
    );

    const totalOnHand = inventoryRows.reduce((sum, r) => sum + Number(r.on_hand), 0);
    const totalReserved = inventoryRows.reduce((sum, r) => sum + Number(r.reserved), 0);

    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      shortDescription: product.short_description,
      description: product.description,
      brand: product.brand,
      productType: product.product_type,
      fit: product.fit,
      productTypeCodeId: product.product_type_code_id || null,
      fitCodeId: product.fit_code_id || null,
      status: product.status,
      seoTitle: product.seo_title,
      seoDescription: product.seo_description,
      seoKeywords: product.seo_keywords,
      fabric: product.fabric,
      gsm: product.gsm === null || product.gsm === undefined ? null : Number(product.gsm),
      displayPriceMinor: product.display_price_minor == null ? null : Number(product.display_price_minor),
      specifications: specifications.map((r) => ({ label: r.label, value: r.value })),
      publishedAt: product.published_at ? new Date(product.published_at).toISOString() : null,
      createdAt: new Date(product.created_at).toISOString(),
      updatedAt: new Date(product.updated_at).toISOString(),
      // `category` = the primary (mirrors products.category_id) — unchanged
      // pre-8D field. `categories` = the full M2M membership (Wave 8D, additive).
      category: category ? { id: category.id, name: category.name, slug: category.slug } : null,
      categories: categoryRows.map((c) => ({
        id: c.id, name: c.name, slug: c.slug, status: c.status,
        isPrimary: Boolean(c.is_primary), position: c.position,
      })),
      collections: collections.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
      sizeGuide: sizeGuide ? { id: sizeGuide.id, name: sizeGuide.name, slug: sizeGuide.slug } : null,
      taxProfile: taxProfileRow ? {
        id: taxProfileRow.id,
        name: taxProfileRow.name,
        hsnSac: taxProfileRow.hsn_sac,
        taxability: taxProfileRow.taxability,
        gstRateBps: Number(taxProfileRow.gst_rate_bps),
        rateBands: taxProfileRow.rateBands || [],
        status: taxProfileRow.status,
      } : null,
      variants: variants.map((v) => ({
        id: v.id,
        storefrontId: v.storefront_id,
        colorName: v.color_name,
        colorHex: v.color_hex,
        colorCodeId: v.color_code_id || null,
        designName: v.design_name || null,
        designCode: v.design_code || null,
        badge: v.badge,
        status: v.status,
        displayOrder: v.display_order,
        skus: skusByVariant.get(v.id) || [],
      })),
      // Wave 8D: writes go through the media-mapping API
      // (/products/:id/media/*). `mediaId` links the row to the provider-
      // neutral asset registry; `isPrimary` is the featured slot per
      // variant scope. Additive — the pre-8D keys are unchanged.
      media: mediaRows.map((m) => ({
        id: m.id, url: m.url, altText: m.alt_text, position: m.position,
        mediaType: m.media_type, variantId: m.variant_id,
        mediaId: m.media_id ?? null, isPrimary: Boolean(m.is_primary),
      })),
      inventorySummary: { configuredSkus: inventoryRows.length, totalSkus: allSkus.length, totalOnHand, totalReserved, totalAvailable: totalOnHand - totalReserved },
      shipping: (() => {
        const activeSkus = allSkus.filter((s) => s.status === 'ACTIVE');
        // Rate-ready: product default weight set, OR every active SKU carries
        // its own weight (§9). No active SKU ⇒ nothing to ship yet.
        const allSkusHaveWeight = activeSkus.length > 0 && activeSkus.every((s) => s.weight_grams != null);
        const rateReady = productWeightGrams != null || allSkusHaveWeight;
        return {
          status: shippingComplete(shippingProfile) ? 'COMPLETE' : 'INCOMPLETE',
          rateReady,
          rateReadyReason: rateReady ? null : 'MISSING_WEIGHT',
          weightGrams: productWeightGrams,
          lengthMm: shippingProfile?.length_mm ?? null,
          widthMm: shippingProfile?.width_mm ?? null,
          heightMm: shippingProfile?.height_mm ?? null,
          skusWithWeightOverride: activeSkus.filter((s) => s.weight_grams != null).length,
          activeSkuCount: activeSkus.length,
          updatedAt: shippingProfile?.updated_at ? new Date(shippingProfile.updated_at).toISOString() : null,
        };
      })(),
    };
  }

  async createProduct(input, actor, brandId) {
    const slugCandidate = input.slug || slugify(input.name);
    if (!slugCandidate) throw new AppError('VALIDATION_ERROR', 'Could not derive a slug from the product name.', 400);

    const id = randomUUID();
    try {
      await withTransaction(async (conn) => {
        await conn.execute(
          `INSERT INTO products (id, brand_id, slug, name, short_description, description, brand, category_id, fit, product_type, product_type_code_id, fit_code_id, size_guide_id, status, seo_title, seo_description, seo_keywords, fabric, gsm, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, NOW(), NOW())`,
          [
            id, brandId, slugCandidate, input.name, input.shortDescription ?? null, input.description ?? null,
            input.brand ?? 'CORCOTTON', input.categoryId ?? null, input.fit ?? null, input.productType,
            input.productTypeCodeId ?? null, input.fitCodeId ?? null,
            input.sizeGuideId ?? null, input.seoTitle ?? null, input.seoDescription ?? null,
            input.seoKeywords ?? null, input.fabric ?? null, input.gsm ?? null,
          ],
        );
        if (input.specifications) {
          await writeSpecifications(conn, { productId: id, brandId, specifications: input.specifications });
        }
        for (const collectionId of input.collectionIds || []) {
          // Append at the end of the collection's manual order (Wave 8D:
          // product_collections.position is unique per collection).
          await conn.execute(
            `INSERT IGNORE INTO product_collections (product_id, collection_id, position, created_at)
             SELECT ?, ?, COALESCE(MAX(position), -1) + 1, NOW(3)
             FROM product_collections WHERE collection_id = ?`,
            [id, collectionId, collectionId],
          );
        }
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('SLUG_TAKEN', 'A product with this slug already exists.', 409);
      if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.code === 'ER_NO_REFERENCED_ROW') {
        throw new AppError('VALIDATION_ERROR', 'Referenced category, size guide, or collection does not exist.', 422);
      }
      throw err;
    }

    await this.audit_(actor, { action: 'PRODUCT_CREATED', resourceType: 'product', resourceId: id, metadata: { name: input.name, slug: slugCandidate, status: 'DRAFT' } });
    return this.getProduct(id, brandId);
  }

  async updateProduct(id, patch, actor, brandId) {
    const existing = await this.products.findById(id, brandId);
    if (!existing) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    const { collectionIds, specifications, ...productPatch } = patch;
    const changedFields = Object.keys(productPatch).filter((k) => productPatch[k] !== undefined);

    try {
      await withTransaction(async (conn) => {
        if (changedFields.length) {
          const columnMap = ProductRepository.UPDATE_COLUMNS;
          const cols = changedFields.filter((k) => k in columnMap);
          if (cols.length) {
            const sets = cols.map((k) => `\`${columnMap[k]}\` = ?`).join(', ');
            await conn.execute(
              `UPDATE products SET ${sets}, updated_at = NOW() WHERE id = ? AND brand_id = ?`,
              [...cols.map((k) => productPatch[k] ?? null), id, brandId],
            );
          }
        }
        if (Array.isArray(specifications)) {
          await writeSpecifications(conn, { productId: id, brandId, specifications });
        }
        if (Array.isArray(collectionIds)) {
          await conn.execute('DELETE FROM product_collections WHERE product_id = ?', [id]);
          for (const collectionId of collectionIds) {
            await conn.execute(
              `INSERT IGNORE INTO product_collections (product_id, collection_id, position, created_at)
               SELECT ?, ?, COALESCE(MAX(position), -1) + 1, NOW(3)
               FROM product_collections WHERE collection_id = ?`,
              [id, collectionId, collectionId],
            );
          }
        }
        // Phase 1B — type / fit change ripples into every variant's CANONICAL
        // SKU strings (locked SKUs cause the whole update to fail — brief §21).
        if (PRODUCT_IDENTITY_FIELDS.some((f) => changedFields.includes(f))) {
          const [vrows] = await conn.execute('SELECT id FROM product_variants WHERE product_id = ?', [id]);
          for (const v of vrows) {
            await catalogSkuService.regenerateVariantCanonicalSkus(conn, v.id, actor, brandId);
          }
        }
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('SLUG_TAKEN', 'A product with this slug already exists.', 409);
      if (/ER_NO_REFERENCED_ROW/.test(err.code || '')) {
        throw new AppError('VALIDATION_ERROR', 'Referenced category, size guide, or collection does not exist.', 422);
      }
      throw err;
    }

    await this.audit_(actor, {
      action: 'PRODUCT_UPDATED',
      resourceType: 'product',
      resourceId: id,
      metadata: { fields: [...changedFields, ...(Array.isArray(collectionIds) ? ['collections'] : [])] },
    });
    return this.getProduct(id, brandId);
  }

  async setProductStatus(id, status, actor, brandId) {
    const existing = await this.products.findById(id, brandId);
    if (!existing) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);
    if (existing.status === status) return this.getProduct(id, brandId);

    const patch = { status };
    // First activation stamps published_at; it is never cleared afterwards.
    if (status === 'ACTIVE' && !existing.published_at) patch.publishedAt = new Date();
    await this.products.update(id, patch, brandId);

    await this.audit_(actor, {
      action: 'PRODUCT_STATUS_CHANGED',
      resourceType: 'product',
      resourceId: id,
      metadata: { from: existing.status, to: status },
    });
    return this.getProduct(id, brandId);
  }

  // Bulk status change — the Products-list bulk action bar. Each id goes
  // through setProductStatus (audit + published_at stamp unchanged); results
  // are per-id so a partial failure surfaces in the UI. No new authority.
  async bulkSetProductStatus(ids, status, actor, brandId) {
    const results = [];
    for (const id of ids) {
      try {
        await this.setProductStatus(id, status, actor, brandId);
        results.push({ id, ok: true });
      } catch (err) {
        results.push({ id, ok: false, error: err.code || 'ERROR' });
      }
    }
    const changed = results.filter((r) => r.ok).length;
    return { requested: ids.length, changed, failed: ids.length - changed, status, results };
  }

  // ---- variants --------------------------------------------------------

  async createVariant(productId, input, actor, brandId) {
    const product = await this.products.findById(productId, brandId);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    const variant = await this.variants.create({
      productId,
      brandId,
      colorName: input.colorName,
      colorHex: input.colorHex ? (input.colorHex.startsWith('#') ? input.colorHex : `#${input.colorHex}`) : null,
      colorCodeId: input.colorCodeId ?? null,
      designName: input.designName ?? null,
      designCode: input.designCode ? String(input.designCode).trim().toUpperCase() : null,
      badge: input.badge ?? null,
      status: input.status || 'ACTIVE',
      displayOrder: input.displayOrder ?? 0,
    });

    await this.audit_(actor, { action: 'VARIANT_CREATED', resourceType: 'product_variant', resourceId: variant.id, metadata: { productId, colorName: input.colorName } });
    return this.getProduct(productId, brandId);
  }

  async updateVariant(variantId, patch, actor, brandId) {
    const variant = await this.variants.findById(variantId, brandId);
    if (!variant) throw new AppError('VARIANT_NOT_FOUND', 'Variant not found.', 404);

    const normalized = { ...patch };
    if (normalized.colorHex && !normalized.colorHex.startsWith('#')) normalized.colorHex = `#${normalized.colorHex}`;
    if (typeof normalized.designCode === 'string') normalized.designCode = normalized.designCode.trim().toUpperCase() || null;

    const identityChanged = VARIANT_IDENTITY_FIELDS.some((f) => normalized[f] !== undefined);
    await withTransaction(async (conn) => {
      const columnMap = { colorName: 'color_name', colorHex: 'color_hex', colorCodeId: 'color_code_id', designName: 'design_name', designCode: 'design_code', badge: 'badge', status: 'status', displayOrder: 'display_order' };
      const cols = Object.keys(normalized).filter((k) => normalized[k] !== undefined && k in columnMap);
      if (cols.length) {
        await conn.execute(
          `UPDATE product_variants SET ${cols.map((k) => `\`${columnMap[k]}\` = ?`).join(', ')}, updated_at = NOW(3) WHERE id = ? AND brand_id = ?`,
          [...cols.map((k) => normalized[k] ?? null), variantId, brandId],
        );
      }
      if (identityChanged) {
        await catalogSkuService.regenerateVariantCanonicalSkus(conn, variantId, actor, brandId);
      }
    });

    await this.audit_(actor, {
      action: 'VARIANT_UPDATED',
      resourceType: 'product_variant',
      resourceId: variantId,
      metadata: { productId: variant.product_id, fields: Object.keys(patch) },
    });
    return this.getProduct(variant.product_id, brandId);
  }

  // ---- skus -----------------------------------------------------------

  async createSku(productId, variantId, input, actor, brandId) {
    const [product, variant] = await Promise.all([
      this.products.findById(productId, brandId),
      this.variants.findById(variantId, brandId),
    ]);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);
    if (!variant || variant.product_id !== productId) {
      throw new AppError('VARIANT_NOT_FOUND', 'Variant does not belong to this product.', 404);
    }

    // Phase 1B — the SKU string is generated + validated by the backend SKU
    // authority from the product/variant identity components. The client only
    // chooses the size (brief §14/§19).
    await catalogSkuService.createCanonicalSku(productId, variantId, input, actor, brandId);
    return this.getProduct(productId, brandId);
  }

  async updateSku(skuId, patch, actor, brandId) {
    const sku = await this.skus.findById(skuId, brandId);
    if (!sku) throw new AppError('SKU_NOT_FOUND', 'SKU not found.', 404);
    const variant = await this.variants.findById(sku.variant_id, brandId);

    // Enforce the sale <= regular rule against the resulting values (the DB
    // CHECK is the final guard, but give a clean 422 first).
    const nextPrice = patch.priceMinor ?? Number(sku.price_minor);
    const nextSale = patch.salePriceMinor === undefined ? (sku.sale_price_minor == null ? null : Number(sku.sale_price_minor)) : patch.salePriceMinor;
    if (nextSale != null && nextSale > nextPrice) {
      throw new AppError('VALIDATION_ERROR', 'Sale price cannot exceed the regular price.', 422);
    }

    // Identity change (size) goes through the SKU authority — it regenerates
    // the canonical string, revalidates uniqueness, and refuses if the SKU is
    // LEGACY or has operational history (brief §20/§21).
    if (patch.size !== undefined && patch.size !== sku.size) {
      await catalogSkuService.updateCanonicalSkuSize(skuId, patch.size, actor, brandId);
    }
    const { size, ...commercial } = patch; // eslint-disable-line no-unused-vars
    if (Object.keys(commercial).length) {
      await this.skus.update(skuId, commercial, brandId);
    }
    await this.audit_(actor, {
      action: 'SKU_UPDATED',
      resourceType: 'sku',
      resourceId: skuId,
      metadata: { productId: variant?.product_id, variantId: sku.variant_id, fields: Object.keys(patch) },
    });
    return this.getProduct(variant?.product_id, brandId);
  }

  // ---- shipping metadata ---------------------------------------------

  async putShippingProfile(productId, dims, actor, brandId) {
    const product = await this.products.findById(productId, brandId);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    let profile;
    try {
      profile = await this.shippingProfiles.upsert(productId, dims);
    } catch (err) {
      // DB CHECK (> 0 or NULL) — should already be caught by validation.
      if (err.code === 'ER_CHECK_CONSTRAINT_VIOLATED') {
        throw new AppError('VALIDATION_ERROR', 'Shipping dimensions and weight must be positive.', 422);
      }
      throw err;
    }

    await this.audit_(actor, {
      action: 'SHIPPING_PROFILE_UPDATED',
      resourceType: 'product',
      resourceId: productId,
      metadata: { weightGrams: dims.weightGrams, lengthMm: dims.lengthMm, widthMm: dims.widthMm, heightMm: dims.heightMm },
    });

    // Re-evaluate booking readiness for ONLY the non-terminal fulfillments
    // that contain a SKU of this product. Reuses the Wave 7A.1 service —
    // idempotent, never calls a provider, keeps shipments DRAFT (§35-38).
    const readiness = await this.#reevaluateAffectedReadiness(productId);

    return { shipping: this.#shippingDto(profile), readiness };
  }

  async #reevaluateAffectedReadiness(productId) {
    const orderIds = await this.shippingProfiles.nonTerminalOrderIdsForProduct(productId);
    let changed = 0;
    const errors = [];
    for (const orderId of orderIds) {
      try {
        const result = await this.fulfillment.reevaluateReadiness(orderId);
        if (result?.changed) changed += 1;
      } catch (err) {
        errors.push({ orderId, message: err.message });
      }
    }
    return { affectedOrders: orderIds.length, changed, errors };
  }

  #shippingDto(profile) {
    return {
      status: shippingComplete(profile) ? 'COMPLETE' : 'INCOMPLETE',
      weightGrams: profile?.weight_grams ?? null,
      lengthMm: profile?.length_mm ?? null,
      widthMm: profile?.width_mm ?? null,
      heightMm: profile?.height_mm ?? null,
      updatedAt: profile?.updated_at ? new Date(profile.updated_at).toISOString() : null,
    };
  }

  // ---- size guide --------------------------------------------------

  async listSizeGuides(brandId) {
    const guides = await this.sizeGuides.findAll({ status: 'ACTIVE', brandId });
    return guides.map((g) => ({ id: g.id, name: g.name, title: g.title || g.name, slug: g.slug, unit: g.unit }));
  }

  async assignSizeGuide(productId, sizeGuideId, actor, brandId) {
    const product = await this.products.findById(productId, brandId);
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);
    if (sizeGuideId) {
      const guide = await this.sizeGuides.findById(sizeGuideId, brandId);
      if (!guide) throw new AppError('SIZE_GUIDE_NOT_FOUND', 'Size guide not found.', 422);
      if (guide.status !== 'ACTIVE') throw new AppError('SIZE_GUIDE_INVALID', 'Only an ACTIVE size guide can be assigned to a product.', 422);
    }
    await this.products.update(productId, { sizeGuideId: sizeGuideId ?? null }, brandId);
    await this.audit_(actor, {
      action: 'SIZE_GUIDE_ASSIGNED',
      resourceType: 'product',
      resourceId: productId,
      metadata: { from: product.size_guide_id, to: sizeGuideId },
    });
    return this.getProduct(productId, brandId);
  }

  // ---- helpers for pickers --------------------------------------

  async listCategories(brandId) {
    const rows = await this.categories.findAll({ brandId });
    return rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, parentId: c.parent_id }));
  }

  async listCollections(brandId) {
    const rows = await this.collections.findAll({ brandId });
    return rows.map((c) => ({ id: c.id, name: c.name, slug: c.slug, status: c.status }));
  }

  // Phase 2 §48 — shipping-metadata blocker report. `rateReady` (weight
  // resolvable) is the checkout-rate gate and is independent of `complete`
  // (full box for manifestation accuracy). No inferred defaults anywhere.
  async shippingSummary(brandId) {
    const rows = await query(
      `SELECT
         COUNT(*) AS total,
         SUM(psp.weight_grams IS NOT NULL AND psp.length_mm IS NOT NULL
             AND psp.width_mm IS NOT NULL AND psp.height_mm IS NOT NULL) AS complete,
         SUM(
           psp.weight_grams IS NOT NULL
           OR (
             EXISTS (SELECT 1 FROM skus s JOIN product_variants v ON v.id = s.variant_id
                     WHERE v.product_id = p.id AND s.status = 'ACTIVE')
             AND NOT EXISTS (SELECT 1 FROM skus s JOIN product_variants v ON v.id = s.variant_id
                             WHERE v.product_id = p.id AND s.status = 'ACTIVE' AND s.weight_grams IS NULL)
           )
         ) AS rate_ready,
         SUM(EXISTS (SELECT 1 FROM skus s JOIN product_variants v ON v.id = s.variant_id
                     WHERE v.product_id = p.id AND s.weight_grams IS NOT NULL)) AS with_sku_weight_overrides
       FROM products p
       LEFT JOIN product_shipping_profiles psp ON psp.product_id = p.id
       WHERE p.status <> 'ARCHIVED' AND p.brand_id = ?`,
      [brandId],
    );
    const total = Number(rows[0].total);
    const complete = Number(rows[0].complete || 0);
    const rateReady = Number(rows[0].rate_ready || 0);
    return {
      total,
      complete,
      incomplete: total - complete,
      rateReady,
      notRateReady: total - rateReady,
      withSkuWeightOverrides: Number(rows[0].with_sku_weight_overrides || 0),
    };
  }

  // Phase 3 (product-module redesign) — real summary counts for the Products
  // list insight strip. Every number is derived from live catalog state; no
  // sell-through / ABC / days-of-inventory (unsupported). `needsAttention` =
  // an ACTIVE product that cannot be sold with real shipping rates yet
  // (weight not resolvable — same rule as getProduct.shipping.rateReady).
  async productFacets(brandId) {
    const rateReadyExpr = `(
      psp.weight_grams IS NOT NULL
      OR (
        EXISTS (SELECT 1 FROM skus s JOIN product_variants v ON v.id = s.variant_id
                WHERE v.product_id = p.id AND s.status = 'ACTIVE')
        AND NOT EXISTS (SELECT 1 FROM skus s JOIN product_variants v ON v.id = s.variant_id
                        WHERE v.product_id = p.id AND s.status = 'ACTIVE' AND s.weight_grams IS NULL)
      )
    )`;
    const rows = await query(
      `SELECT
         COUNT(*) AS total,
         SUM(p.status = 'DRAFT')    AS draft,
         SUM(p.status = 'ACTIVE')   AS active,
         SUM(p.status = 'ARCHIVED') AS archived,
         SUM(${rateReadyExpr})                       AS rate_ready,
         SUM(p.size_guide_id IS NOT NULL)            AS size_guide_assigned,
         SUM(p.status = 'ACTIVE' AND NOT ${rateReadyExpr}) AS needs_attention
       FROM products p
       LEFT JOIN product_shipping_profiles psp ON psp.product_id = p.id
       WHERE p.brand_id = ?`,
      [brandId],
    );
    const r = rows[0];
    const total = Number(r.total || 0);
    const rateReady = Number(r.rate_ready || 0);
    const sizeGuideAssigned = Number(r.size_guide_assigned || 0);
    return {
      total,
      byStatus: {
        DRAFT: Number(r.draft || 0),
        ACTIVE: Number(r.active || 0),
        ARCHIVED: Number(r.archived || 0),
      },
      shipping: { rateReady, notRateReady: total - rateReady },
      sizeGuide: { assigned: sizeGuideAssigned, unassigned: total - sizeGuideAssigned },
      needsAttention: Number(r.needs_attention || 0),
    };
  }
}

export const adminCatalogService = new AdminCatalogService();
