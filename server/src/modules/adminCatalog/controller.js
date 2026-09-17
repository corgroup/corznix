import { adminCatalogService } from './service.js';
import { adminCatalogMediaService } from './mediaService.js';
import { sizeGuideService } from './sizeGuideService.js';
import { categoryService } from './categoryService.js';
import { collectionService } from './collectionService.js';
import * as mediaRegistry from '../media/service.js';
import { isMediaConfigured } from '../../platform/media/index.js';
import { AppError } from '../../utils/errors.js';
import { toCsv, sendCsv } from './csv.js';
import * as v from './validation.js';

function actorOf(req) {
  return { id: req.staff?.id, email: req.staff?.email, ip: req.ip, requestId: req.id };
}
const ok = (res, data, status = 200) => res.status(status).json({ data });

export async function listProducts(req, res, next) {
  try {
    const q = v.listQuerySchema.parse(req.query);
    ok(res, await adminCatalogService.listProducts({
      q: q.q ?? null,
      status: q.status ?? null,
      shipping: q.shipping ?? null,
      categoryId: q.categoryId ?? null,
      collectionId: q.collectionId ?? null,
      sizeGuide: q.sizeGuide ?? null,
      productType: q.productType ?? null,
      sort: q.sort ?? 'updated',
      page: q.page ?? 1,
      limit: q.limit ?? 20,
    }, req.brandId));
  } catch (err) { next(err); }
}

export async function productFacets(req, res, next) {
  try {
    ok(res, await adminCatalogService.productFacets(req.brandId));
  } catch (err) { next(err); }
}

export async function getProduct(req, res, next) {
  try {
    ok(res, await adminCatalogService.getProduct(req.params.id, req.brandId));
  } catch (err) { next(err); }
}

export async function createProduct(req, res, next) {
  try {
    const body = v.createProductSchema.parse(req.body);
    ok(res, await adminCatalogService.createProduct(body, actorOf(req), req.brandId), 201);
  } catch (err) { next(err); }
}

export async function updateProduct(req, res, next) {
  try {
    const body = v.updateProductSchema.parse(req.body);
    ok(res, await adminCatalogService.updateProduct(req.params.id, body, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function setProductStatus(req, res, next) {
  try {
    const { status } = v.setStatusSchema.parse(req.body);
    ok(res, await adminCatalogService.setProductStatus(req.params.id, status, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function bulkProductStatus(req, res, next) {
  try {
    const body = v.bulkStatusSchema.parse(req.body);
    ok(res, await adminCatalogService.bulkSetProductStatus(body.ids, body.status, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function createVariant(req, res, next) {
  try {
    const body = v.createVariantSchema.parse(req.body);
    ok(res, await adminCatalogService.createVariant(req.params.id, body, actorOf(req), req.brandId), 201);
  } catch (err) { next(err); }
}

export async function updateVariant(req, res, next) {
  try {
    const body = v.updateVariantSchema.parse(req.body);
    ok(res, await adminCatalogService.updateVariant(req.params.id, body, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function createSku(req, res, next) {
  try {
    const { variantId, ...rest } = v.createSkuSchema.parse(req.body);
    ok(res, await adminCatalogService.createSku(req.params.id, variantId, rest, actorOf(req), req.brandId), 201);
  } catch (err) { next(err); }
}

export async function updateSku(req, res, next) {
  try {
    const body = v.updateSkuSchema.parse(req.body);
    ok(res, await adminCatalogService.updateSku(req.params.id, body, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function putShippingProfile(req, res, next) {
  try {
    const body = v.shippingProfileSchema.parse(req.body);
    ok(res, await adminCatalogService.putShippingProfile(req.params.id, body, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function assignSizeGuide(req, res, next) {
  try {
    const { sizeGuideId } = v.assignSizeGuideSchema.parse(req.body);
    ok(res, await adminCatalogService.assignSizeGuide(req.params.id, sizeGuideId, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function listSizeGuides(req, res, next) {
  // Rich list (all statuses + row/usage counts). The Product editor picker
  // filters to ACTIVE client-side; the pre-8D lightweight fields are a subset.
  try { ok(res, await sizeGuideService.list(req.brandId)); } catch (err) { next(err); }
}

export async function getSizeGuide(req, res, next) {
  try { ok(res, await sizeGuideService.get(req.params.guideId, req.brandId)); } catch (err) { next(err); }
}

export async function sizeGuideFacets(req, res, next) {
  try { ok(res, await sizeGuideService.facets(req.brandId)); } catch (err) { next(err); }
}

export async function exportSizeGuides(req, res, next) {
  try {
    const { headers, rows } = await sizeGuideService.exportRows(req.brandId);
    sendCsv(res, 'size-guides', toCsv(headers, rows));
  } catch (err) { next(err); }
}

export async function createSizeGuide(req, res, next) {
  try {
    const body = v.createSizeGuideSchema.parse(req.body);
    ok(res, await sizeGuideService.create(body, actorOf(req), req.brandId), 201);
  } catch (err) { next(err); }
}

export async function updateSizeGuide(req, res, next) {
  try {
    const body = v.updateSizeGuideSchema.parse(req.body);
    ok(res, await sizeGuideService.update(req.params.guideId, body, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function setSizeGuideRows(req, res, next) {
  try {
    const { rows } = v.setSizeGuideRowsSchema.parse(req.body);
    ok(res, await sizeGuideService.setRows(req.params.guideId, rows, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function setSizeGuideStatus(req, res, next) {
  try {
    const { status } = v.setSizeGuideStatusSchema.parse(req.body);
    ok(res, await sizeGuideService.setStatus(req.params.guideId, status, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function deleteSizeGuide(req, res, next) {
  try { ok(res, await sizeGuideService.remove(req.params.guideId, actorOf(req), req.brandId)); } catch (err) { next(err); }
}
export async function listCategories(req, res, next) {
  // Rich list (tree info + product counts). The pre-8D picker fields
  // (id/name/slug/parentId) are a subset.
  try { ok(res, await categoryService.list(req.brandId)); } catch (err) { next(err); }
}

export async function categoryFacets(req, res, next) {
  try { ok(res, await categoryService.facets(req.brandId)); } catch (err) { next(err); }
}

export async function exportCategories(req, res, next) {
  try {
    const { headers, rows } = await categoryService.exportRows(req.brandId);
    sendCsv(res, 'categories', toCsv(headers, rows));
  } catch (err) { next(err); }
}

export async function getCategory(req, res, next) {
  try { ok(res, await categoryService.get(req.params.categoryId, req.brandId)); } catch (err) { next(err); }
}

export async function createCategory(req, res, next) {
  try {
    const body = v.createCategorySchema.parse(req.body);
    ok(res, await categoryService.create(body, actorOf(req), req.brandId), 201);
  } catch (err) { next(err); }
}

export async function updateCategory(req, res, next) {
  try {
    const body = v.updateCategorySchema.parse(req.body);
    ok(res, await categoryService.update(req.params.categoryId, body, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function setCategoryStatus(req, res, next) {
  try {
    const { status } = v.setCategoryStatusSchema.parse(req.body);
    ok(res, await categoryService.setStatus(req.params.categoryId, status, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function deleteCategory(req, res, next) {
  try { ok(res, await categoryService.remove(req.params.categoryId, actorOf(req), req.brandId, { confirmReferences: req.query.confirmReferences === 'true' })); } catch (err) { next(err); }
}

export async function getProductCategories(req, res, next) {
  try { ok(res, await categoryService.getProductCategories(req.params.id, req.brandId)); } catch (err) { next(err); }
}

export async function setProductCategories(req, res, next) {
  try {
    const { categories } = v.setProductCategoriesSchema.parse(req.body);
    ok(res, await categoryService.setProductCategories(req.params.id, categories, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}
export async function listCollections(req, res, next) {
  // Rich list (product counts + status). Pre-8D picker fields are a subset.
  try { ok(res, await collectionService.list(req.brandId)); } catch (err) { next(err); }
}

export async function getCollection(req, res, next) {
  try { ok(res, await collectionService.get(req.params.collectionId, req.brandId)); } catch (err) { next(err); }
}

export async function collectionFacets(req, res, next) {
  try { ok(res, await collectionService.facets(req.brandId)); } catch (err) { next(err); }
}

export async function exportCollections(req, res, next) {
  try {
    const { headers, rows } = await collectionService.exportRows(req.brandId);
    sendCsv(res, 'collections', toCsv(headers, rows));
  } catch (err) { next(err); }
}

export async function createCollection(req, res, next) {
  try {
    const body = v.createCollectionSchema.parse(req.body);
    ok(res, await collectionService.create(body, actorOf(req), req.brandId), 201);
  } catch (err) { next(err); }
}

export async function updateCollection(req, res, next) {
  try {
    const body = v.updateCollectionSchema.parse(req.body);
    ok(res, await collectionService.update(req.params.collectionId, body, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function setCollectionStatus(req, res, next) {
  try {
    const { status } = v.setCollectionStatusSchema.parse(req.body);
    ok(res, await collectionService.setStatus(req.params.collectionId, status, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function deleteCollection(req, res, next) {
  try { ok(res, await collectionService.remove(req.params.collectionId, actorOf(req), req.brandId, { confirmReferences: req.query.confirmReferences === 'true' })); } catch (err) { next(err); }
}

export async function setCollectionMembers(req, res, next) {
  try {
    const { productIds } = v.setCollectionMembersSchema.parse(req.body);
    ok(res, await collectionService.setMembers(req.params.collectionId, productIds, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function addCollectionMember(req, res, next) {
  try {
    const { productId } = v.collectionMemberSchema.parse(req.body);
    ok(res, await collectionService.addMember(req.params.collectionId, productId, actorOf(req), req.brandId), 201);
  } catch (err) { next(err); }
}

export async function removeCollectionMember(req, res, next) {
  try {
    ok(res, await collectionService.removeMember(req.params.collectionId, req.params.productId, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}

export async function reorderCollection(req, res, next) {
  try {
    const { orderedProductIds } = v.reorderCollectionSchema.parse(req.body);
    ok(res, await collectionService.reorder(req.params.collectionId, orderedProductIds, actorOf(req), req.brandId));
  } catch (err) { next(err); }
}
export async function shippingSummary(req, res, next) {
  try { ok(res, await adminCatalogService.shippingSummary(req.brandId)); } catch (err) { next(err); }
}

// ---- media library ------------------------------------------------------
// `media.brand_id` has carried real tenant scoping since migration 001 —
// this used to hardcode a Cor-Cotton lookup (`corcottonBrandId()`); now it
// uses the caller's actual `req.brandId` like everything else in Phase 3.

export async function listMediaLibrary(req, res, next) {
  try {
    const q = v.mediaLibraryQuerySchema.parse(req.query);
    ok(res, await mediaRegistry.listMedia({
      brandId: req.brandId,
      status: q.status ?? 'ACTIVE',
      q: q.q ?? null,
      page: q.page ?? 1,
      limit: q.limit ?? 24,
    }));
  } catch (err) { next(err); }
}

export async function uploadMediaAsset(req, res, next) {
  try {
    if (!isMediaConfigured()) {
      throw new AppError('MEDIA_PROVIDER_UNAVAILABLE', 'The configured media provider has no credentials on the server.', 503);
    }
    if (!req.file) throw new AppError('MEDIA_VALIDATION_FAILED', 'Attach a file under the "file" form field.', 400);
    const asset = await mediaRegistry.uploadMedia(req.file.buffer, {
      brandId: req.brandId,
      uploadedBy: null,
      originalFilename: req.file.originalname || null,
    });
    ok(res, { asset }, 201);
  } catch (err) { next(err); }
}

export async function getMediaAsset(req, res, next) {
  try {
    const asset = await mediaRegistry.findMediaById(req.params.mediaId);
    if (!asset) throw new AppError('MEDIA_NOT_FOUND', 'Media asset not found.', 404);
    ok(res, { asset, references: await mediaRegistry.referenceCount(asset.id) });
  } catch (err) { next(err); }
}

export async function deleteMediaAsset(req, res, next) {
  try {
    const { force } = v.deleteAssetQuerySchema.parse(req.query);
    const result = await mediaRegistry.removeMediaAsset(req.params.mediaId, { force: force ?? false });
    if (!result.removed) {
      const status = result.reason === 'MEDIA_NOT_FOUND' ? 404 : 409;
      throw new AppError(result.reason, result.reason === 'MEDIA_ASSET_IN_USE'
        ? `Asset is still mapped to ${result.references} product media slot(s).` : 'Media asset not found.', status);
    }
    ok(res, result);
  } catch (err) { next(err); }
}

// ---- product <-> media mapping ----------------------------------------

export async function listProductMedia(req, res, next) {
  try { ok(res, await adminCatalogMediaService.listForProduct(req.params.id)); } catch (err) { next(err); }
}

export async function attachProductMedia(req, res, next) {
  try {
    const body = v.attachMediaSchema.parse(req.body);
    ok(res, await adminCatalogMediaService.attach(req.params.id, body, actorOf(req)), 201);
  } catch (err) { next(err); }
}

export async function updateProductMedia(req, res, next) {
  try {
    const body = v.updateMediaMappingSchema.parse(req.body);
    ok(res, await adminCatalogMediaService.updateMapping(req.params.id, req.params.mappingId, body, actorOf(req)));
  } catch (err) { next(err); }
}

export async function detachProductMedia(req, res, next) {
  try {
    ok(res, await adminCatalogMediaService.detach(req.params.id, req.params.mappingId, actorOf(req)));
  } catch (err) { next(err); }
}

export async function setProductMediaPrimary(req, res, next) {
  try {
    ok(res, await adminCatalogMediaService.setPrimary(req.params.id, req.params.mappingId, actorOf(req)));
  } catch (err) { next(err); }
}

export async function reorderProductMedia(req, res, next) {
  try {
    const body = v.reorderMediaSchema.parse(req.body);
    ok(res, await adminCatalogMediaService.reorder(req.params.id, {
      variantId: body.variantId ?? null,
      orderedMappingIds: body.orderedMappingIds,
    }, actorOf(req)));
  } catch (err) { next(err); }
}

export async function replaceProductMedia(req, res, next) {
  try {
    if (!isMediaConfigured()) {
      throw new AppError('MEDIA_PROVIDER_UNAVAILABLE', 'The configured media provider has no credentials on the server.', 503);
    }
    if (!req.file) throw new AppError('MEDIA_VALIDATION_FAILED', 'Attach a replacement file under the "file" form field.', 400);
    ok(res, await adminCatalogMediaService.replace(req.params.id, req.params.mappingId, {
      buffer: req.file.buffer,
      brandId: req.brandId,
      uploadedBy: null,
      originalFilename: req.file.originalname || null,
    }, actorOf(req)));
  } catch (err) { next(err); }
}
