import { Router } from 'express';
import multer from 'multer';
import * as c from './controller.js';
import * as contentController from '../content/controller.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';

// Product Studio admin API. Mounted under /api/v1/admin (see
// modules/staff/routes.js) — so authenticateStaff + cmsOriginGuard already
// apply. Reads need catalog.read; every mutation needs catalog.write.
// Media operations are catalog operations — no separate media.* permission
// (Wave 8D §61: reuse the existing vocabulary).
const router = Router();

const read = requireStaffPermission(PERMISSIONS.CATALOG_READ);
const write = requireStaffPermission(PERMISSIONS.CATALOG_WRITE);

// Images/video up to 25 MB in memory — the provider adapter chooses single
// vs chunked upload above 10 MB. Accept only image/* and video/*.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    cb(null, /^(image|video)\//.test(file.mimetype));
  },
});

router.get('/catalog/size-guides', read, c.listSizeGuides);
router.get('/catalog/size-guides/facets', read, c.sizeGuideFacets);
router.get('/catalog/size-guides/export', read, c.exportSizeGuides);
router.post('/catalog/size-guides', write, c.createSizeGuide);
router.get('/catalog/size-guides/:guideId', read, c.getSizeGuide);
router.patch('/catalog/size-guides/:guideId', write, c.updateSizeGuide);
router.put('/catalog/size-guides/:guideId/rows', write, c.setSizeGuideRows);
router.patch('/catalog/size-guides/:guideId/status', write, c.setSizeGuideStatus);
router.delete('/catalog/size-guides/:guideId', write, c.deleteSizeGuide);
router.get('/catalog/categories', read, c.listCategories);
router.get('/catalog/categories/facets', read, c.categoryFacets);
router.get('/catalog/categories/export', read, c.exportCategories);
router.post('/catalog/categories', write, c.createCategory);
router.get('/catalog/categories/:categoryId', read, c.getCategory);
router.patch('/catalog/categories/:categoryId', write, c.updateCategory);
router.patch('/catalog/categories/:categoryId/status', write, c.setCategoryStatus);
router.delete('/catalog/categories/:categoryId', write, c.deleteCategory);
router.get('/catalog/collections', read, c.listCollections);
router.get('/catalog/collections/facets', read, c.collectionFacets);
router.get('/catalog/collections/export', read, c.exportCollections);
router.post('/catalog/collections', write, c.createCollection);
router.get('/catalog/collections/:collectionId', read, c.getCollection);
router.patch('/catalog/collections/:collectionId', write, c.updateCollection);
router.patch('/catalog/collections/:collectionId/status', write, c.setCollectionStatus);
router.delete('/catalog/collections/:collectionId', write, c.deleteCollection);
router.put('/catalog/collections/:collectionId/members', write, c.setCollectionMembers);
router.post('/catalog/collections/:collectionId/members', write, c.addCollectionMember);
router.delete('/catalog/collections/:collectionId/members/:productId', write, c.removeCollectionMember);
router.post('/catalog/collections/:collectionId/reorder', write, c.reorderCollection);
router.get('/catalog/shipping-summary', read, c.shippingSummary);

// Media Library (asset registry).
router.get('/catalog/media', read, c.listMediaLibrary);
router.post('/catalog/media', write, upload.single('file'), c.uploadMediaAsset);
router.get('/catalog/media/:mediaId', read, c.getMediaAsset);
router.delete('/catalog/media/:mediaId', write, c.deleteMediaAsset);

// Site media (storefront hero / banner slots -> media assets).
router.get('/catalog/site-media', read, contentController.adminListSiteMedia);
router.put('/catalog/site-media/:key', write, contentController.adminSetSiteMedia);

router.get('/products', read, c.listProducts);
// Static path — declared before '/products/:id' so it is never captured as an id.
router.get('/products/facets', read, c.productFacets);
router.post('/products', write, c.createProduct);
// Static path — declared before '/products/:id' so it is never captured as an id.
router.post('/products/bulk-status', write, c.bulkProductStatus);
router.get('/products/:id', read, c.getProduct);
router.patch('/products/:id', write, c.updateProduct);
router.patch('/products/:id/status', write, c.setProductStatus);

router.post('/products/:id/variants', write, c.createVariant);
router.patch('/variants/:id', write, c.updateVariant);

router.post('/products/:id/skus', write, c.createSku);
router.patch('/skus/:id', write, c.updateSku);

router.put('/products/:id/shipping', write, c.putShippingProfile);
router.put('/products/:id/size-guide', write, c.assignSizeGuide);

router.get('/products/:id/categories', read, c.getProductCategories);
router.put('/products/:id/categories', write, c.setProductCategories);

// Product <-> media mapping.
router.get('/products/:id/media', read, c.listProductMedia);
router.post('/products/:id/media', write, c.attachProductMedia);
router.post('/products/:id/media/reorder', write, c.reorderProductMedia);
router.patch('/products/:id/media/:mappingId', write, c.updateProductMedia);
router.delete('/products/:id/media/:mappingId', write, c.detachProductMedia);
router.post('/products/:id/media/:mappingId/primary', write, c.setProductMediaPrimary);
router.post('/products/:id/media/:mappingId/replace', write, upload.single('file'), c.replaceProductMedia);

export default router;
