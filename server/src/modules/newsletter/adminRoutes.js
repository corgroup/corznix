import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { newsletterService } from './service.js';
import { consentService } from '../consent/service.js';

// Phase 6 security pass (DESIGN.md §5.3) — newsletter_subscribers.brand_id
// (Phase 4) was never filtered on by the :id route.
const subscriberBrand = requireResourceBrand('newsletter_subscribers', { notFoundCode: 'SUBSCRIBER_NOT_FOUND', notFoundMessage: 'Subscriber not found.' });

const audit = new StaffAuditRepository();
const router = Router();
const read = requireStaffPermission(PERMISSIONS.MARKETING_READ);
const manage = requireStaffPermission(PERMISSIONS.MARKETING_MANAGE);

const listQuery = z.object({
  status: z.enum(['PENDING_CONFIRMATION', 'SUBSCRIBED', 'UNSUBSCRIBED']).optional(),
  source: z.string().trim().max(32).optional(),
  channel: z.enum(['EMAIL', 'WHATSAPP']).optional(),
  search: z.string().trim().max(255).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).default({});

const suppressBody = z.object({
  contactKey: z.string().trim().min(3).max(255),
  channel: z.enum(['EMAIL', 'WHATSAPP']),
  reason: z.enum(['HARD_BOUNCE', 'MANUAL_COMPLIANCE']),
  notes: z.string().trim().max(255).optional(),
});
const releaseBody = z.object({
  contactKey: z.string().trim().min(3).max(255),
  channel: z.enum(['EMAIL', 'WHATSAPP']),
  reason: z.enum(['HARD_BOUNCE', 'MANUAL_COMPLIANCE', 'CONSENT_REVOKED', 'UNSUBSCRIBED']).optional(),
});

router.get('/subscribers', read, async (req, res, next) => {
  try {
    res.json({ data: { subscribers: await newsletterService.list({ ...listQuery.parse(req.query ?? {}), brandId: req.brandId }), doubleOptInPolicy: await newsletterService.doubleOptInPolicy() } });
  } catch (err) { next(err); }
});

router.get('/subscribers/:id', read, subscriberBrand, async (req, res, next) => {
  try { res.json({ data: await newsletterService.detail(req.params.id) }); } catch (err) { next(err); }
});

router.post('/suppressions', manage, async (req, res, next) => {
  try {
    const body = suppressBody.parse(req.body ?? {});
    const result = await consentService.suppress({ ...body, staffId: req.staff.id });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'SUBSCRIBER_SUPPRESSED', resourceType: 'marketing_suppression', resourceId: body.contactKey, metadata: { channel: body.channel, reason: body.reason }, ipAddress: req.ip });
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

router.post('/suppressions/release', manage, async (req, res, next) => {
  try {
    const body = releaseBody.parse(req.body ?? {});
    const result = await consentService.releaseSuppression({ ...body, staffId: req.staff.id });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'SUBSCRIBER_SUPPRESSION_RELEASED', resourceType: 'marketing_suppression', resourceId: body.contactKey, ipAddress: req.ip });
    res.json({ data: result });
  } catch (err) { next(err); }
});

export default router;
