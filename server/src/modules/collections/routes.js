import { Router } from 'express';
import * as collectionsController from './controller.js';

// New module (Wave 3 of the CORCOTTON storefront migration — see
// docs/MIGRATION.md). Thin HTTP layer over the shared catalog domain
// service (modules/catalog/service.js) — see that controller's comment for
// why collections/categories are merged into one response shape here.
const router = Router();

router.get('/', collectionsController.listCollections);
router.get('/:slug', collectionsController.getCollectionBySlug);

export default router;
