import { Router } from 'express';
import * as brandsController from './controller.js';

const router = Router();

router.get('/', brandsController.getBrands);
router.get('/:slug', brandsController.getBrandBySlug);

export default router;
