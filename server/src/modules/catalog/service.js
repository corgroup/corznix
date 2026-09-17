// ADAPTED_SOURCE_TO_TARGET from
// corcotton-store/server/src/modules/catalog/service.js. Logic is
// unchanged from source (verified against target conventions — only the
// repository layer underneath it changed, see repositories.js's banner
// comment). This is the shared catalog domain engine — the `products` and
// `collections` HTTP modules are thin controllers/routes over this one
// service, so there is exactly one catalog implementation in the target
// server (migration brief §6/§7: never two competing implementations).
import { AppError } from '../../utils/errors.js';
import { inventoryService } from '../inventory/service.js';
import { query } from '../../database/connection/pool.js';

// The ORDER BY of categoryThumbnail as a comparator, so the best of several
// per-category winners is picked exactly as one query over all of them would:
// product created DESC, variant-specific photo first (under DESC MySQL puts
// NULL after 0 and 1), variant created ASC, media position ASC, media id ASC.
const timeOf = (value) => (value == null ? -Infinity : new Date(value).getTime());
const variantMatchRank = (value) => (value == null ? -1 : Number(value));
function compareThumbnailCandidates(a, b) {
  return (timeOf(b.product_created_at) - timeOf(a.product_created_at))
    || (variantMatchRank(b.variant_match) - variantMatchRank(a.variant_match))
    || (timeOf(a.variant_created_at) - timeOf(b.variant_created_at))
    || (Number(a.media_position) - Number(b.media_position))
    || (a.media_id < b.media_id ? -1 : a.media_id > b.media_id ? 1 : 0);
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
const sizeSort = (a, b) => {
  const ai = SIZE_ORDER.indexOf(a);
  const bi = SIZE_ORDER.indexOf(b);
  if (ai === -1 && bi === -1) return a.localeCompare(b);
  if (ai === -1) return 1;
  if (bi === -1) return -1;
  return ai - bi;
};

function mediaDto(row) {
  return {
    id: row.id,
    mediaType: row.media_type,
    url: row.url,
    altText: row.alt_text,
    position: row.position,
    variantId: row.variant_id,
    // Wave 8D (additive). `isPrimary` is the featured slot per variant
    // scope; the provider-neutral asset id is admin-only and never exposed
    // here (§66 — no provider identity in the public DTO).
    isPrimary: Boolean(row.is_primary),
  };
}

export class CatalogService {
  constructor({ categoryRepository, collectionRepository, sizeGuideRepository, productRepository, variantRepository, skuRepository, mediaRepository }) {
    this.categoryRepository = categoryRepository;
    this.collectionRepository = collectionRepository;
    this.sizeGuideRepository = sizeGuideRepository;
    this.productRepository = productRepository;
    this.variantRepository = variantRepository;
    this.skuRepository = skuRepository;
    this.mediaRepository = mediaRepository;
  }

  // Load-tested 2026-09-15: GET /collections ran 91 queries — for every
  // category its tree (twice), a full listing count and page query, and a
  // thumbnail query; for every collection a count and a thumbnail — and the
  // API + MySQL saturated the one vCPU at ~80 requests/s. The same answers now
  // come from a fixed handful of grouped queries (verify:catalog-listing-batch
  // proves every count and picture matches the per-item methods below).
  async listCategories() {
    const [categories, links, counts, bestByCategory] = await Promise.all([
      this.categoryRepository.findAll({ status: 'ACTIVE' }),
      this.categoryRepository.parentLinks(),
      this.categoryRepository.activeVariantCounts(),
      this.categoryThumbnailCandidates(),
    ]);
    const children = new Map();
    for (const link of links) {
      if (link.parent_id) children.set(link.parent_id, [...(children.get(link.parent_id) || []), link.id]);
    }
    return categories.map((c) => {
      // Same membership as selfAndDescendantIds: itself + direct children.
      const ids = [c.id, ...(children.get(c.id) || [])];
      const best = ids.map((id) => bestByCategory.get(id)).filter(Boolean).sort(compareThumbnailCandidates)[0];
      return {
        id: c.id,
        name: c.name,
        slug: c.slug,
        parentId: c.parent_id,
        displayOrder: c.display_order,
        productCount: ids.reduce((sum, id) => sum + (counts.get(id) || 0), 0),
        thumbnailUrl: best?.url || null,
      };
    });
  }

  // The best picture per single category, ranked exactly as categoryThumbnail
  // ranks rows. The best for a category + its children is then the best of
  // those per-category winners under the same ordering.
  async categoryThumbnailCandidates() {
    const rows = await query(
      `SELECT category_id, url, product_created_at, variant_match, variant_created_at, media_position, media_id FROM (
         SELECT p.category_id, pm.url, p.created_at AS product_created_at, (pm.variant_id = v.id) AS variant_match,
                v.created_at AS variant_created_at, pm.position AS media_position, pm.id AS media_id,
                ROW_NUMBER() OVER (PARTITION BY p.category_id
                  ORDER BY p.created_at DESC, (pm.variant_id = v.id) DESC, v.created_at ASC, pm.position ASC, pm.id ASC) AS rn
           FROM products p
           JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE'
           JOIN product_media pm ON pm.product_id = p.id AND pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE'
            AND (pm.variant_id = v.id OR pm.variant_id IS NULL)
          WHERE p.status = 'ACTIVE' AND p.category_id IS NOT NULL
       ) ranked WHERE rn = 1`,
    );
    return new Map(rows.map((r) => [r.category_id, r]));
  }

  // The best picture per collection, ranked exactly as collectionThumbnail.
  async collectionThumbnails() {
    const rows = await query(
      `SELECT collection_id, url FROM (
         SELECT pc.collection_id, pm.url,
                ROW_NUMBER() OVER (PARTITION BY pc.collection_id
                  ORDER BY pc.position ASC, (pm.variant_id = v.id) DESC, v.created_at ASC, pm.position ASC, pm.id ASC) AS rn
           FROM product_collections pc
           JOIN products p ON p.id = pc.product_id AND p.status = 'ACTIVE'
           JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE'
           JOIN product_media pm ON pm.product_id = p.id AND pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE'
            AND (pm.variant_id = v.id OR pm.variant_id IS NULL)
       ) ranked WHERE rn = 1`,
    );
    return new Map(rows.map((r) => [r.collection_id, r.url]));
  }

  // A category or collection's picture is the photo of a product it actually
  // contains, chosen with the same membership its product count uses. There is
  // no image column for either, and the storefront used to fill the gap with a
  // hand-kept placeholder file: old sample photos that no longer loaded and
  // flat grey gradients on every card. A new category now gets a real picture
  // the moment it has a photographed product, with nothing to maintain.
  async categoryThumbnail(categoryIds) {
    if (!categoryIds?.length) return null;
    const rows = await query(
      `SELECT pm.url FROM products p
         JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE'
         JOIN product_media pm ON pm.product_id = p.id AND pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE'
          AND (pm.variant_id = v.id OR pm.variant_id IS NULL)
        WHERE p.status = 'ACTIVE' AND p.category_id IN (${categoryIds.map(() => '?').join(',')})
        ORDER BY p.created_at DESC, (pm.variant_id = v.id) DESC, v.created_at ASC, pm.position ASC, pm.id ASC
        LIMIT 1`, categoryIds);
    return rows[0]?.url || null;
  }

  async collectionThumbnail(collectionId) {
    const rows = await query(
      `SELECT pm.url FROM product_collections pc
         JOIN products p ON p.id = pc.product_id AND p.status = 'ACTIVE'
         JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE'
         JOIN product_media pm ON pm.product_id = p.id AND pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE'
          AND (pm.variant_id = v.id OR pm.variant_id IS NULL)
        WHERE pc.collection_id = ?
        ORDER BY pc.position ASC, (pm.variant_id = v.id) DESC, v.created_at ASC, pm.position ASC, pm.id ASC
        LIMIT 1`, [collectionId]);
    return rows[0]?.url || null;
  }

  async countProductsInCategory(categoryId) {
    const ids = await this.categoryRepository.selfAndDescendantIds(categoryId);
    if (ids.length === 0) return 0;
    const { total } = await this.productRepository.listVariantRows({ categoryIds: ids, page: 1, limit: 1 });
    return total;
  }

  async listCollections() {
    const [collections, counts, thumbnails] = await Promise.all([
      this.collectionRepository.findAll({ status: 'ACTIVE' }),
      this.collectionRepository.productCounts(),
      this.collectionThumbnails(),
    ]);
    return collections.map((c) => ({
      id: c.id,
      name: c.name,
      slug: c.slug,
      description: c.description,
      displayOrder: c.display_order,
      productCount: counts.get(c.id) || 0,
      thumbnailUrl: thumbnails.get(c.id) || null,
    }));
  }

  async resolveCategoryIds(categorySlug) {
    if (!categorySlug) return null;
    const category = await this.categoryRepository.findBySlug(categorySlug);
    // An archived (non-storefront) category resolves to "no products" rather
    // than leaking its membership (§67).
    if (!category || category.status !== 'ACTIVE') return [];
    return this.categoryRepository.selfAndDescendantIds(category.id);
  }

  async resolveCollectionId(collectionSlug) {
    if (!collectionSlug) return null;
    const collection = await this.collectionRepository.findBySlug(collectionSlug);
    return collection ? collection.id : '__none__';
  }

  // Map of category id -> row, so a leaf category (what products actually
  // reference, e.g. "tshirts") can resolve its parent's display name (e.g.
  // "Tops") without an extra query per row.
  async getCategoryMap() {
    const categories = await this.categoryRepository.findAll();
    return new Map(categories.map((c) => [c.id, c]));
  }

  // All variants of every product represented in `rows`, regardless of the
  // current page/filter — so a color swatch row can show every real
  // colorway.
  async getSiblingVariantsByProduct(productIds) {
    const uniqueIds = [...new Set(productIds)];
    const byProduct = new Map();
    await Promise.all(uniqueIds.map(async (productId) => {
      const variants = await this.variantRepository.findForProduct(productId);
      byProduct.set(productId, variants.filter((v) => v.status === 'ACTIVE'));
    }));
    return byProduct;
  }

  async attachMediaAndSizes(rows) {
    const variantIds = rows.map((r) => r.variant_id);
    const [mediaRows, skuRows, categoryMap, siblingsByProduct] = await Promise.all([
      this.mediaRepository.findForVariantIds(variantIds),
      this.skuRepository.findActiveForVariantIds(variantIds),
      this.getCategoryMap(),
      this.getSiblingVariantsByProduct(rows.map((r) => r.product_id)),
    ]);

    const mediaByVariant = new Map();
    for (const m of mediaRows) {
      const key = m.variant_id || `product:${m.product_id}`;
      if (!mediaByVariant.has(key)) mediaByVariant.set(key, []);
      mediaByVariant.get(key).push(m);
    }
    const sizesByVariant = new Map();
    for (const s of skuRows) {
      if (!sizesByVariant.has(s.variant_id)) sizesByVariant.set(s.variant_id, []);
      sizesByVariant.get(s.variant_id).push(s.size);
    }

    return rows.map((row) => {
      const variantMedia = mediaByVariant.get(row.variant_id) || mediaByVariant.get(`product:${row.product_id}`) || [];
      const sizes = (sizesByVariant.get(row.variant_id) || []).slice().sort(sizeSort);
      const parentCategory = row.category_parent_id ? categoryMap.get(row.category_parent_id) : null;
      const siblings = siblingsByProduct.get(row.product_id) || [];
      const colorSiblings = siblings.length > 1
        ? siblings.slice().sort((a, b) => a.storefront_id - b.storefront_id).map((v) => ({
          storefrontId: v.storefront_id, colorName: v.color_name, colorHex: v.color_hex, active: v.id === row.variant_id,
        }))
        : [];
      return {
        productId: row.product_id,
        productSlug: row.product_slug,
        productName: row.product_name,
        shortDescription: row.short_description,
        description: row.description,
        fit: row.fit,
        productType: row.product_type,
        categorySlug: row.category_slug,
        categoryName: row.category_name,
        parentCategoryName: parentCategory ? parentCategory.name : row.category_name,
        parentCategorySlug: parentCategory ? parentCategory.slug : row.category_slug,
        variantId: row.variant_id,
        storefrontId: row.storefront_id,
        colorName: row.color_name,
        colorHex: row.color_hex,
        badge: row.badge,
        createdAt: row.variant_created_at,
        // A card shows no size, so it shows the product's stated standard price
        // when the CMS set one. Without it this falls back to the cheapest
        // active SKU, which is what every card showed before.
        priceMinor: row.display_price_minor == null ? Number(row.min_price_minor) : Number(row.display_price_minor),
        regularPriceMinor: Number(row.max_regular_price_minor),
        onSale: row.min_sale_price_minor != null,
        sizes,
        media: variantMedia.map(mediaDto),
        colorSiblings,
      };
    });
  }

  async listProducts({ categorySlug = null, collectionSlug = null, color = null, size = null, fit = null, minPrice = null, maxPrice = null, sort = 'newest', page = 1, limit = 8 } = {}) {
    const categoryIds = await this.resolveCategoryIds(categorySlug);
    if (categoryIds && categoryIds.length === 0) {
      return { products: [], total: 0, page: 1, totalPages: 1 };
    }
    const collectionId = await this.resolveCollectionId(collectionSlug);
    if (collectionId === '__none__') {
      return { products: [], total: 0, page: 1, totalPages: 1 };
    }

    const { rows, total, page: safePage, totalPages } = await this.productRepository.listVariantRows({
      categoryIds, collectionId, colorName: color, size, fit,
      minPriceMinor: minPrice, maxPriceMinor: maxPrice, sort, page, limit,
    });

    const products = await this.attachMediaAndSizes(rows);
    return { products, total, page: safePage, totalPages };
  }

  // Wave 4 (Real Search). Delegates to the same repository grain and the
  // same attachMediaAndSizes enrichment listProducts uses — search results
  // are indistinguishable in shape from a normal listing, so ProductCard/
  // ProductGrid need no special-casing (migration brief §13).
  async searchProducts({ q, page = 1, limit = 8 } = {}) {
    const { rows, total, page: safePage, totalPages } = await this.productRepository.searchVariantRows({ q, page, limit });
    const products = await this.attachMediaAndSizes(rows);
    return { products, total, page: safePage, totalPages };
  }

  async getFilterOptions({ categorySlug = null, collectionSlug = null } = {}) {
    const categoryIds = await this.resolveCategoryIds(categorySlug);
    if (categoryIds && categoryIds.length === 0) return { colors: [], sizes: [] };
    const collectionId = await this.resolveCollectionId(collectionSlug);
    if (collectionId === '__none__') return { colors: [], sizes: [] };

    const options = await this.productRepository.distinctFilterOptions({ categoryIds, collectionId });
    return { colors: options.colors, sizes: options.sizes.slice().sort(sizeSort) };
  }

  async getSizeGuideDto(sizeGuideId) {
    if (!sizeGuideId) return null;
    const sizeGuide = await this.sizeGuideRepository.findById(sizeGuideId);
    if (!sizeGuide || sizeGuide.status !== 'ACTIVE') return null;
    const rows = await this.sizeGuideRepository.findRows(sizeGuide.id);
    const configuredColumns = typeof sizeGuide.columns_json === 'string' ? JSON.parse(sizeGuide.columns_json) : sizeGuide.columns_json;
    const columns = Array.isArray(configuredColumns) && configuredColumns.length
      ? configuredColumns : ['size', 'chest', 'length', 'shoulder', 'sleeve'];
    return {
      id: sizeGuide.id,
      name: sizeGuide.name,
      title: sizeGuide.title || sizeGuide.name,
      description: sizeGuide.description || null,
      slug: sizeGuide.slug,
      unit: sizeGuide.unit,
      columns,
      rows: rows.map((r) => {
        const values = typeof r.values_json === 'string' ? JSON.parse(r.values_json) : r.values_json;
        return values && typeof values === 'object' ? { size: r.size, ...values }
          : { size: r.size, chest: r.chest, length: r.length, shoulder: r.shoulder, sleeve: r.sleeve };
      }),
    };
  }

  // Every ACTIVE guide that has rows, as the same DTO the PDP renders. The
  // storefront's standalone Size Guide page used to draw a hardcoded fixture
  // whose chart disagreed with the CMS guide the product page shows for the
  // same garment — one site, two size charts, and the fixture was missing
  // sizes the store actually sells. Reading the guides from here leaves only
  // one chart to keep correct.
  async listPublicSizeGuides(brandId = null) {
    const guides = await this.sizeGuideRepository.findAll({ status: 'ACTIVE', brandId });
    const dtos = await Promise.all(guides.map((g) => this.getSizeGuideDto(g.id)));
    return dtos.filter((g) => g && g.rows.length > 0);
  }

  async getProductBySlug(slug) {
    const product = await this.productRepository.findBySlug(slug);
    if (!product || product.status !== 'ACTIVE') throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);
    return this.buildProductDetail(product);
  }

  async buildProductDetail(product) {
    const [variants, media, collections, category, sizeGuide, categoryMemberships] = await Promise.all([
      this.variantRepository.findForProduct(product.id),
      this.mediaRepository.findForProduct(product.id),
      this.collectionRepository.findForProduct(product.id),
      product.category_id ? this.categoryRepository.findById(product.category_id) : null,
      this.getSizeGuideDto(product.size_guide_id),
      this.categoryRepository.findActiveForProduct
        ? this.categoryRepository.findActiveForProduct(product.id)
        : [],
    ]);
    const parentCategory = category?.parent_id ? await this.categoryRepository.findById(category.parent_id) : null;

    const variantDtos = await Promise.all(variants.map(async (v) => {
      const skus = await this.skuRepository.findForVariant(v.id);
      const availabilityRows = skus.length ? await inventoryService.getAvailabilityForItems(
        skus.map((s) => ({ skuId: s.id, quantity: 1 })),
      ) : [];
      const availabilityBySku = new Map(availabilityRows.map((row) => [row.skuId, row]));
      const variantMedia = media.filter((m) => m.variant_id === v.id || (!m.variant_id));
      return {
        id: v.id,
        storefrontId: v.storefront_id,
        colorName: v.color_name,
        colorHex: v.color_hex,
        badge: v.badge,
        status: v.status,
        createdAt: v.created_at,
        skus: skus.map((s) => ({
          id: s.id, sku: s.sku, size: s.size, status: s.status,
          priceMinor: s.price_minor, salePriceMinor: s.sale_price_minor, currency: s.currency,
          availability: {
            status: availabilityBySku.get(s.id)?.status || 'INVENTORY_NOT_CONFIGURED',
            // The most one order line can take: stock available, capped at the
            // cart's per-line limit. The server still enforces it on add.
            maxQuantity: Math.max(0, Math.min(99, Number(availabilityBySku.get(s.id)?.available ?? 0))),
          },
        })),
        media: variantMedia.map(mediaDto),
      };
    }));

    const specifications = await query(
      'SELECT label, value FROM product_specifications WHERE product_id = ? ORDER BY display_order, label',
      [product.id],
    );

    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      shortDescription: product.short_description,
      description: product.description,
      brand: product.brand,
      fit: product.fit,
      productType: product.product_type,
      status: product.status,
      // The CMS has captured these since Wave 8B but the public payload dropped
      // them, so the storefront had nothing to render a <title> or description
      // from. Null is meaningful: the storefront falls back to the product name
      // rather than inventing copy.
      seoTitle: product.seo_title || null,
      seoDescription: product.seo_description || null,
      seoKeywords: product.seo_keywords || null,
      // Structured specifications for the PDP "Product Details" table. Before
      // this the PDP printed a hardcoded "100% Natural Cotton" for every
      // product; null now means "not captured", and the row is omitted.
      fabric: product.fabric || null,
      gsm: product.gsm == null ? null : Number(product.gsm),
      // The price a product shows before a size is chosen. Null means the
      // storefront falls back to the cheapest active SKU, as it always has.
      displayPriceMinor: product.display_price_minor == null ? null : Number(product.display_price_minor),
      specifications: specifications.map((r) => ({ label: r.label, value: r.value })),
      category: category ? {
        id: category.id, name: category.name, slug: category.slug,
        parent: parentCategory ? { id: parentCategory.id, name: parentCategory.name, slug: parentCategory.slug } : null,
      } : null,
      // Wave 8D (additive): the full ACTIVE category membership. `category`
      // above stays the primary for existing consumers.
      categories: categoryMemberships.map((c) => ({
        id: c.id, name: c.name, slug: c.slug, isPrimary: Boolean(c.is_primary),
      })),
      collections: collections
        .filter((c) => c.status === 'ACTIVE')
        .map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
      sizeGuide,
      variants: variantDtos,
    };
  }

  async getVariantByStorefrontId(storefrontId) {
    const variant = await this.variantRepository.findByStorefrontId(storefrontId);
    if (!variant || variant.status !== 'ACTIVE') throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);
    const product = await this.productRepository.findById(variant.product_id);
    if (!product || product.status !== 'ACTIVE') throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    const detail = await this.buildProductDetail(product);
    const activeVariant = detail.variants.find((v) => v.id === variant.id);
    const siblingVariants = detail.variants.filter((v) => v.status === 'ACTIVE');

    return { ...detail, activeVariantId: variant.id, activeVariant, siblingVariants };
  }
}

// Single shared instance — see modules/products and modules/collections'
// controller.js files, which both import this instead of constructing
// their own CatalogService (migration brief §6: never two competing
// catalog implementations).
import {
  CategoryRepository, CollectionRepository, SizeGuideRepository,
  ProductRepository, ProductVariantRepository, SkuRepository, ProductMediaRepository,
} from './repositories.js';

export const catalogService = new CatalogService({
  categoryRepository: new CategoryRepository(),
  collectionRepository: new CollectionRepository(),
  sizeGuideRepository: new SizeGuideRepository(),
  productRepository: new ProductRepository(),
  variantRepository: new ProductVariantRepository(),
  skuRepository: new SkuRepository(),
  mediaRepository: new ProductMediaRepository(),
});

export default catalogService;
