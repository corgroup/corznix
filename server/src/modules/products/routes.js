import { Router } from 'express';
import * as productsController from './controller.js';

// REPLACES the `createStubRouter('products')` placeholder — this module's
// route architecture now has a real implementation behind it (Wave 3 of
// the CORCOTTON storefront migration — see docs/MIGRATION.md).
const router = Router();

router.get('/filters', productsController.getFilterOptions);
router.get('/by-slug/:slug', productsController.getProductBySlug);
// Legacy-compatible numeric id route — see controller.js's comment on why
// this is a variant lookup, not a product lookup.
router.get('/:storefrontId(\\d+)', productsController.getProductByVariantId);
router.get('/', productsController.listProducts);

export default router;
