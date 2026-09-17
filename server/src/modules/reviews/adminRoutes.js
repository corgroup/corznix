import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { reviewAdminService } from './adminService.js';

// CMS review moderation. Moderation moves `status` only — it NEVER edits the
// customer's text (§72). Every state change is audited and event-logged.
const audit = new StaffAuditRepository();
const router = Router();
const read = requireStaffPermission(PERMISSIONS.REVIEWS_READ);
const moderate = requireStaffPermission(PERMISSIONS.REVIEWS_MODERATE);

const listQuery = z.object({
  status: z.enum(['PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN']).optional(),
  productId: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).default({});

const moderateBody = z.object({
  action: z.enum(['PUBLISH', 'REJECT', 'HIDE']),
  reason: z.string().trim().max(255).optional(),
  expectedVersion: z.number().int().min(0),
});

const log = (req, action, id, metadata = null) => audit.log({
  staffUserId: req.staff.id, actorEmail: req.staff.email, action,
  resourceType: 'product_review', resourceId: id, metadata, ipAddress: req.ip,
});

router.get('/reviews', read, async (req, res, next) => {
  try { res.json({ data: { reviews: await reviewAdminService.list(listQuery.parse(req.query ?? {})) } }); } catch (err) { next(err); }
});

router.get('/reviews/:id', read, async (req, res, next) => {
  try { res.json({ data: await reviewAdminService.detail(req.params.id) }); } catch (err) { next(err); }
});

router.post('/reviews/:id/moderate', moderate, async (req, res, next) => {
  try {
    const { action, reason, expectedVersion } = moderateBody.parse(req.body ?? {});
    const result = await reviewAdminService.moderate({
      reviewId: req.params.id, action, reason: reason ?? null, expectedVersion, staffId: req.staff.id,
    });
    await log(req, 'REVIEW_MODERATED', req.params.id, { action, status: result.status, reason: reason ?? null });
    res.json({ data: result });
  } catch (err) { next(err); }
});

router.post('/reviews/aggregates/rebuild', moderate, async (req, res, next) => {
  try {
    const result = await reviewAdminService.rebuildAggregates();
    await log(req, 'REVIEW_AGGREGATES_REBUILT', null, result);
    res.json({ data: result });
  } catch (err) { next(err); }
});

export default router;
