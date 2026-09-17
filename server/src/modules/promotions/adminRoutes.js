import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { promotionService } from './service.js';

// Phase 6 security pass (DESIGN.md §5.3) — promotions.brand_id (Phase 4) was
// never filtered on by the :id routes.
const promotionBrand = requireResourceBrand('promotions', { notFoundCode: 'PROMOTION_NOT_FOUND', notFoundMessage: 'Promotion not found.' });

// CMS promotions + coupons. Money is always computed by the engine — staff
// configure the RULE (percentage bps / fixed minor, caps, eligibility, limits,
// stacking), never a per-order amount.
const audit = new StaffAuditRepository();
const router = Router();
const read = requireStaffPermission(PERMISSIONS.PROMOTIONS_READ);
const manage = requireStaffPermission(PERMISSIONS.PROMOTIONS_MANAGE);

const idArray = z.array(z.string().min(1)).max(200).optional();
const draftShape = {
  name: z.string().min(2).max(160),
  description: z.string().max(500).optional(),
  triggerType: z.enum(['AUTOMATIC', 'CODE_REQUIRED']).optional(),
  discountType: z.enum(['PERCENTAGE', 'FIXED_AMOUNT']),
  discountScope: z.enum(['ORDER', 'ITEM']).optional(),
  discountValue: z.number().int().positive(),
  maxDiscountMinor: z.number().int().nonnegative().nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  minSubtotalMinor: z.number().int().nonnegative().optional(),
  minQuantity: z.number().int().nonnegative().optional(),
  eligibleProductIds: idArray,
  eligibleCategoryIds: idArray,
  eligibleCollectionIds: idArray,
  eligibleSegmentId: z.string().min(1).nullable().optional(),
  firstOrderOnly: z.boolean().optional(),
  usageLimitTotal: z.number().int().positive().nullable().optional(),
  usageLimitPerCustomer: z.number().int().positive().optional(),
  stackable: z.boolean().optional(),
  priority: z.number().int().optional(),
  restorePolicy: z.enum(['CONFIG_REQUIRED', 'NEVER_RESTORE', 'RESTORE_ON_FULL_CANCEL', 'RESTORE_ON_FULL_REFUND']).optional(),
};
const createBody = z.object(draftShape);
const updateBody = z.object({ ...draftShape, name: draftShape.name.optional(), discountType: draftShape.discountType.optional(), discountValue: draftShape.discountValue.optional(), status: z.enum(['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED']).optional() }).partial();
const couponBody = z.object({ code: z.string().min(3).max(64) });

const log = (req, action, id, metadata = null) => audit.log({
  staffUserId: req.staff.id, actorEmail: req.staff.email, action,
  resourceType: 'promotion', resourceId: id, metadata, ipAddress: req.ip,
});

router.get('/promotions', read, async (req, res, next) => {
  try {
    const status = ['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].includes(req.query?.status) ? req.query.status : null;
    res.json({ data: { promotions: await promotionService.list({ status, brandId: req.brandId }) } });
  } catch (err) { next(err); }
});

router.post('/promotions', manage, async (req, res, next) => {
  try {
    const p = await promotionService.create({ ...createBody.parse(req.body ?? {}), staffId: req.staff.id });
    await log(req, 'PROMOTION_CREATED', p.id, { name: p.name });
    res.status(201).json({ data: p });
  } catch (err) { next(err); }
});

router.get('/promotions/:id', read, promotionBrand, async (req, res, next) => {
  try { res.json({ data: await promotionService.detail(req.params.id) }); } catch (err) { next(err); }
});

router.patch('/promotions/:id', manage, promotionBrand, async (req, res, next) => {
  try {
    const p = await promotionService.update({ id: req.params.id, ...updateBody.parse(req.body ?? {}) });
    await log(req, 'PROMOTION_UPDATED', req.params.id, { version: p.version, status: p.status });
    res.json({ data: p });
  } catch (err) { next(err); }
});

router.post('/promotions/:id/coupons', manage, promotionBrand, async (req, res, next) => {
  try {
    const { code } = couponBody.parse(req.body ?? {});
    const p = await promotionService.addCoupon({ promotionId: req.params.id, code });
    await log(req, 'PROMOTION_COUPON_ISSUED', req.params.id, { code: code.trim().toUpperCase() });
    res.status(201).json({ data: p });
  } catch (err) { next(err); }
});

export default router;
