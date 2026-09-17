import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { communicationTemplateService } from './templateService.js';
import { communicationService } from './service.js';

// Phase 6 security pass (DESIGN.md §5.3) — communication_templates.brand_id
// (Phase 4) was never filtered on by any of these :id lookups.
const templateBrand = requireResourceBrand('communication_templates', { notFoundCode: 'TEMPLATE_NOT_FOUND', notFoundMessage: 'Template not found.' });

// CMS communication surface — templates. No provider credentials ever pass
// through here. Marketing sends are campaigns (marketingCampaigns/).
const audit = new StaffAuditRepository();
const router = Router();
const read = requireStaffPermission(PERMISSIONS.COMMS_READ);
const manage = requireStaffPermission(PERMISSIONS.COMMS_MANAGE);

const varSchemaShape = z.record(z.object({ required: z.boolean().optional(), type: z.enum(['string', 'number']).optional() }));
const templateBody = z.object({
  templateKey: z.string().min(3).max(80),
  channel: z.enum(['EMAIL', 'WHATSAPP']),
  classification: z.enum(['TRANSACTIONAL', 'MARKETING']),
  subject: z.string().max(255).optional(),
  bodyTemplate: z.string().min(3),
  variableSchema: varSchemaShape.optional(),
  providerTemplateRef: z.string().max(120).optional(),
});
const statusBody = z.object({ status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']) });

const log = (req, action, id, metadata = null) => audit.log({
  staffUserId: req.staff.id, actorEmail: req.staff.email, action,
  resourceType: 'communication', resourceId: id, metadata, ipAddress: req.ip,
});

// ---- templates -----------------------------------------------------
router.get('/communications/templates', read, async (req, res, next) => {
  try {
    const { channel, classification } = req.query ?? {};
    res.json({ data: { templates: await communicationTemplateService.list({
      brandId: req.brandId,
      channel: ['EMAIL', 'WHATSAPP'].includes(channel) ? channel : null,
      classification: ['TRANSACTIONAL', 'MARKETING'].includes(classification) ? classification : null,
    }) } });
  } catch (err) { next(err); }
});

router.post('/communications/templates', manage, async (req, res, next) => {
  try {
    const t = await communicationTemplateService.create({ ...templateBody.parse(req.body ?? {}), staffId: req.staff.id });
    await log(req, 'COMM_TEMPLATE_CREATED', t.id, { key: t.templateKey, channel: t.channel, version: t.version });
    res.status(201).json({ data: t });
  } catch (err) { next(err); }
});

router.get('/communications/templates/:id', read, templateBrand, async (req, res, next) => {
  try { res.json({ data: await communicationTemplateService.detail(req.params.id) }); } catch (err) { next(err); }
});

router.post('/communications/templates/:id/status', manage, templateBrand, async (req, res, next) => {
  try {
    const { status } = statusBody.parse(req.body ?? {});
    const t = await communicationTemplateService.setStatus({ id: req.params.id, status });
    await log(req, 'COMM_TEMPLATE_STATUS_CHANGED', req.params.id, { status });
    res.json({ data: t });
  } catch (err) { next(err); }
});

// Broadcasts were retired in favour of campaigns (docs/MESSAGING.md): a
// segment is an audience source of a campaign now.

// Manual worker tick (ops / diagnostics — the background worker runs this on a
// timer). Enqueued marketing messages still hit the consent gate at send.
router.post('/communications/dispatch', manage, async (req, res, next) => {
  try { res.json({ data: await communicationService.dispatchDue({ limit: 50 }) }); } catch (err) { next(err); }
});

export default router;
