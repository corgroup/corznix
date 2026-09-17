import { Router } from 'express';
import * as c from './controller.js';
import { heroBannerService } from '../heroBanners/service.js';

// Public storefront content. Mounted at /api/v1/content (see routes/index.js).
// Read-only — the admin surface for site media lives under
// /api/v1/admin/catalog/site-media (modules/adminCatalog/routes.js).
const router = Router();

router.get('/site-media', c.siteMedia);
router.get('/header', c.header);
router.get('/homepage', c.homepage);
// Live hero banners for the homepage: ACTIVE and inside their schedule only.
router.get('/hero-banners', async (req, res, next) => {
  try { res.json({ data: await heroBannerService.publicHero(req.brandId) }); } catch (err) { next(err); }
});
router.get('/pages', c.pagesIndex);
router.get('/pages/:slug', c.page);
router.get('/faq', c.faq);
router.get('/experience', c.experience);

export default router;
