import { Router } from 'express';
import catalogService from '../catalog/service.js';

// Public size guides — the ACTIVE guides for the requesting brand, in the
// same DTO the PDP already renders.
//
// The storefront's standalone /size-guide page had no API to read, so it drew
// a hardcoded fixture: a chart that disagreed with the CMS guide shown on the
// product page for the same garment, and that stopped at XXL while the store
// sells XXXL. The guides already existed in the CMS; only this read was
// missing.
const router = Router();

router.get('/', async (req, res, next) => {
  try {
    res.json({ data: { sizeGuides: await catalogService.listPublicSizeGuides(req.brandId) } });
  } catch (err) { next(err); }
});

export default router;
