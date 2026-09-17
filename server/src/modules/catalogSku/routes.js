import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { catalogSkuService } from './service.js';
import { previewSchema, createProductTypeCodeSchema, createFitCodeSchema } from './validation.js';

// Canonical SKU identity API. Mounted under /api/v1/admin (staff/routes.js) —
// authenticateStaff + cmsOriginGuard already apply.
const router = Router();
const read = requireStaffPermission(PERMISSIONS.CATALOG_READ);
const write = requireStaffPermission(PERMISSIONS.CATALOG_WRITE);
const ok = (res, data, status = 200) => res.status(status).json({ data });

function actorOf(req) {
  return { id: req.staff?.id, email: req.staff?.email, ip: req.ip, requestId: req.id };
}

// The canonical option lists for the Product Studio SKU controls.
router.get('/catalog/sku/options', read, async (req, res, next) => {
  try { ok(res, await catalogSkuService.getOptions(req.brandId)); } catch (e) { next(e); }
});

// Operator-created master codes. Governed extension of the migration-057 seed
// — `catalog.write`, format-validated, audited. The SKU authority is unchanged:
// new codes go INTO the master table, so generation + uniqueness still apply.
router.post('/catalog/sku/type-codes', write, async (req, res, next) => {
  try {
    const body = createProductTypeCodeSchema.parse(req.body ?? {});
    ok(res, await catalogSkuService.createProductTypeCode(body, actorOf(req), req.brandId), 201);
  } catch (e) { next(e); }
});
router.post('/catalog/sku/fit-codes', write, async (req, res, next) => {
  try {
    const body = createFitCodeSchema.parse(req.body ?? {});
    ok(res, await catalogSkuService.createFitCode(body, actorOf(req), req.brandId), 201);
  } catch (e) { next(e); }
});

// Live preview from a variant + a candidate size. Never persists.
router.post('/catalog/sku/preview', read, async (req, res, next) => {
  try {
    const { variantId, sizeCode } = previewSchema.parse(req.body ?? {});
    ok(res, await catalogSkuService.previewForVariant(variantId, { sizeCode }, req.brandId));
  } catch (e) { next(e); }
});

// Lock / canonical state for one existing SKU.
router.get('/catalog/sku/:skuId/identity', read, async (req, res, next) => {
  try { ok(res, await catalogSkuService.skuLockState(req.params.skuId, req.brandId)); } catch (e) { next(e); }
});

// Phase 1B legacy migration readiness (dry run only — no apply endpoint).
router.get('/catalog/sku/migration-readiness', read, async (req, res, next) => {
  try { ok(res, await catalogSkuService.migrationReadiness(req.brandId)); } catch (e) { next(e); }
});

// Identity mutations run through adminCatalog (createSku / updateVariant /
// updateProduct), which audit with their own actor.

export default router;
