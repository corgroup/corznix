import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { segmentService } from './service.js';

// Phase 6 security pass (DESIGN.md §5.3) — customer_segments.brand_id
// (Phase 4) was never filtered on by the :id routes.
const segmentBrand = requireResourceBrand('customer_segments', { notFoundCode: 'SEGMENT_NOT_FOUND', notFoundMessage: 'Segment not found.' });

// CMS customer-segments surface. The client only ever submits structured
// { attribute, operator, value } conditions — never SQL (§87). Rule
// validation + parameterized compilation happen entirely in the backend.
const audit = new StaffAuditRepository();
const router = Router();
const read = requireStaffPermission(PERMISSIONS.SEGMENTS_READ);
const manage = requireStaffPermission(PERMISSIONS.SEGMENTS_MANAGE);

const conditionSchema = z.object({
  attribute: z.string().min(1).max(60),
  operator: z.string().min(1).max(10),
  value: z.any(),
  channel: z.string().optional(),
  purpose: z.string().optional(),
}).passthrough();
const definitionSchema = z.object({
  match: z.enum(['ALL', 'ANY']).optional(),
  conditions: z.array(conditionSchema).min(1).max(20),
});

const createBody = z.object({
  segmentKey: z.string().min(2).max(80),
  name: z.string().min(2).max(160),
  description: z.string().max(500).optional(),
  definition: definitionSchema,
});
const metaBody = z.object({
  name: z.string().min(2).max(160).optional(),
  description: z.string().max(500).nullable().optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
});
const revisionBody = z.object({ definition: definitionSchema });
const previewBody = z.object({
  definition: definitionSchema.optional(),
  sampleSize: z.coerce.number().int().min(0).max(50).optional(),
});
const audienceQuery = z.object({
  channel: z.enum(['EMAIL', 'WHATSAPP']),
  purpose: z.enum(['MARKETING', 'NEWSLETTER']),
  revisionId: z.string().min(1).optional(),
});
const snapshotBody = z.object({
  reason: z.enum(['MANUAL', 'BROADCAST_AUDIENCE', 'PROMOTION', 'HISTORICAL_PROOF']).optional(),
});

const log = (req, action, id, metadata = null) => audit.log({
  staffUserId: req.staff.id, actorEmail: req.staff.email, action,
  resourceType: 'customer_segment', resourceId: id, metadata, ipAddress: req.ip,
});

router.get('/segments/meta/attributes', read, (req, res) => {
  res.json({ data: segmentService.attributes() });
});

router.get('/segments', read, async (req, res, next) => {
  try {
    const status = req.query?.status === 'ARCHIVED' || req.query?.status === 'ACTIVE' ? req.query.status : null;
    res.json({ data: { segments: await segmentService.list({ status, brandId: req.brandId }) } });
  } catch (err) { next(err); }
});

router.post('/segments', manage, async (req, res, next) => {
  try {
    const body = createBody.parse(req.body ?? {});
    const seg = await segmentService.create({ ...body, staffId: req.staff.id });
    await log(req, 'SEGMENT_CREATED', seg.id, { key: seg.key });
    res.status(201).json({ data: seg });
  } catch (err) { next(err); }
});

// Ad-hoc preview of an unsaved definition (rule builder "test" button).
router.post('/segments/preview', manage, async (req, res, next) => {
  try {
    const { definition, sampleSize } = previewBody.parse(req.body ?? {});
    if (!definition) throw Object.assign(new Error('definition is required'), { status: 400, code: 'VALIDATION_ERROR' });
    res.json({ data: await segmentService.preview({ definition, sampleSize }) });
  } catch (err) { next(err); }
});

router.get('/segments/:id', read, segmentBrand, async (req, res, next) => {
  try { res.json({ data: await segmentService.detail(req.params.id) }); } catch (err) { next(err); }
});

router.patch('/segments/:id', manage, segmentBrand, async (req, res, next) => {
  try {
    const body = metaBody.parse(req.body ?? {});
    const seg = await segmentService.updateMeta({ id: req.params.id, ...body });
    await log(req, 'SEGMENT_UPDATED', req.params.id, body);
    res.json({ data: seg });
  } catch (err) { next(err); }
});

router.post('/segments/:id/revisions', manage, segmentBrand, async (req, res, next) => {
  try {
    const { definition } = revisionBody.parse(req.body ?? {});
    const seg = await segmentService.addRevision({ id: req.params.id, definition, staffId: req.staff.id });
    await log(req, 'SEGMENT_REVISION_ADDED', req.params.id, { revision: seg.revision });
    res.status(201).json({ data: seg });
  } catch (err) { next(err); }
});

router.post('/segments/:id/preview', read, segmentBrand, async (req, res, next) => {
  try {
    const { definition, sampleSize } = previewBody.parse(req.body ?? {});
    res.json({ data: await segmentService.preview({ id: req.params.id, definition: definition ?? null, sampleSize }) });
  } catch (err) { next(err); }
});

router.get('/segments/:id/audience', read, segmentBrand, async (req, res, next) => {
  try {
    const { channel, purpose, revisionId } = audienceQuery.parse(req.query ?? {});
    const result = await segmentService.resolveAudience({ id: req.params.id, revisionId: revisionId ?? null, channel, purpose });
    // The audience payload carries contact keys — treat as a privileged read.
    res.json({ data: { ...result, recipients: undefined, recipientCount: result.recipients.length } });
  } catch (err) { next(err); }
});

router.post('/segments/:id/snapshot', manage, segmentBrand, async (req, res, next) => {
  try {
    const { reason } = snapshotBody.parse(req.body ?? {});
    const result = await segmentService.snapshot({ id: req.params.id, reason: reason ?? 'MANUAL', staffId: req.staff.id });
    await log(req, 'SEGMENT_SNAPSHOT_TAKEN', req.params.id, { snapshotId: result.snapshotId, memberCount: result.memberCount, reason: reason ?? 'MANUAL' });
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

export default router;
