import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { heroBannerService } from './service.js';

// Homepage hero banners, under /api/v1/admin. Reuses the existing content
// permissions rather than inventing a new one — a hero banner is homepage
// content, and anyone trusted to edit the homepage is trusted to edit it.
const router = Router();
const read = requireStaffPermission(PERMISSIONS.CONTENT_READ);
const write = requireStaffPermission(PERMISSIONS.CONTENT_WRITE);

const ok = (res, data) => res.json({ data });
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

router.get('/content/hero-banners', read, wrap(async (req, res) =>
  ok(res, { banners: await heroBannerService.list(req.brandId) })));

router.post('/content/hero-banners', write, wrap(async (req, res) =>
  res.status(201).json({ data: await heroBannerService.create(req.brandId, req.body, req.staff?.id) })));

// A store with no slides yet: the built-in hero becomes editable slides.
router.post('/content/hero-banners/import-current', write, wrap(async (req, res) =>
  res.status(201).json({ data: await heroBannerService.importCurrent(req.brandId, req.staff?.id) })));

router.patch('/content/hero-banners/:id', write, wrap(async (req, res) =>
  ok(res, await heroBannerService.update(req.params.id, req.brandId, req.body, req.staff?.id))));

router.delete('/content/hero-banners/:id', write, wrap(async (req, res) =>
  ok(res, await heroBannerService.remove(req.params.id, req.brandId))));

router.post('/content/hero-banners/:id/duplicate', write, wrap(async (req, res) =>
  res.status(201).json({ data: await heroBannerService.duplicate(req.params.id, req.brandId, req.staff?.id) })));

// Whole-list reorder rather than per-row nudges: the client already knows the
// final order, and one request keeps the positions consistent.
router.put('/content/hero-banners/reorder', write, wrap(async (req, res) =>
  ok(res, { banners: await heroBannerService.reorder(req.brandId, req.body?.orderedIds) })));

export default router;
