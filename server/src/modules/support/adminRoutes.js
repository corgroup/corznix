import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { supportAdminService } from './adminService.js';
import { supportRepository } from './repository.js';
import { documentStorage } from '../documents/storage.js';
import { AppError } from '../../utils/errors.js';

const audit = new StaffAuditRepository();
const router = Router();
const read = requireStaffPermission(PERMISSIONS.SUPPORT_READ);
const manage = requireStaffPermission(PERMISSIONS.SUPPORT_MANAGE);
// Phase 6 security pass (DESIGN.md §5.3) — support_tickets.brand_id (Phase 4)
// was never filtered on by the :id routes.
const ticketBrand = requireResourceBrand('support_tickets', { notFoundCode: 'TICKET_NOT_FOUND', notFoundMessage: 'Ticket not found.', altColumn: 'ticket_number' });

const listQuery = z.object({
  status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED']).optional(),
  category: z.enum(['GENERAL', 'ORDER', 'DELIVERY', 'PAYMENT', 'RETURN', 'EXCHANGE', 'PRODUCT']).optional(),
  priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
  assignedStaffId: z.string().trim().min(1).optional(),
  warehouseId: z.string().trim().min(1).optional(),
  q: z.string().trim().min(1).max(120).optional(),
  unassigned: z.coerce.boolean().optional(),
  mine: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).default({});

const assignBody = z.object({ staffId: z.string().trim().min(1).nullable(), expectedVersion: z.number().int().min(0) });
const replyBody = z.object({
  body: z.string().trim().min(1).max(5000),
  visibility: z.enum(['CUSTOMER', 'INTERNAL']),
  notifyWarehouse: z.coerce.boolean().optional(),
});
const priorityBody = z.object({ priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']) });
const statusBody = z.object({ status: z.enum(['OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'WAITING_INTERNAL', 'RESOLVED', 'CLOSED']) });

const log = (req, action, id, metadata = null) => audit.log({
  staffUserId: req.staff.id, actorEmail: req.staff.email, action,
  resourceType: 'support_ticket', resourceId: id, metadata, ipAddress: req.ip,
});

router.get('/support/tickets', read, async (req, res, next) => {
  try {
    const filters = listQuery.parse(req.query ?? {});
    const warehouseScope = await warehouseScopeForStaff(req.staff);
    res.json({ data: await supportAdminService.list({ ...filters, warehouseScope, mineStaffId: filters.mine ? req.staff.id : null }) });
  } catch (err) { next(err); }
});

router.get('/support/facets', read, async (req, res, next) => {
  try {
    const warehouseScope = await warehouseScopeForStaff(req.staff);
    res.json({ data: await supportAdminService.facets(warehouseScope) });
  } catch (err) { next(err); }
});

router.get('/support/tickets/:id', read, ticketBrand, async (req, res, next) => {
  try { res.json({ data: await supportAdminService.detail(req.params.id) }); } catch (err) { next(err); }
});

// An attachment a customer sent, read by staff. Gated by SUPPORT_READ and
// by the ticket brand guard the other :id routes use, then checked again
// against the ticket in the path — an attachment id from one ticket cannot
// be read through another ticket's URL.
router.get('/support/tickets/:id/attachments/:attachmentId', read, ticketBrand, async (req, res, next) => {
  try {
    const row = await supportRepository.attachmentForTicket(req.params.id, req.params.attachmentId);
    if (!row) throw new AppError('SUPPORT_ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404);
    const bytes = await documentStorage.get(row.storage_key);
    res.setHeader('Content-Type', row.content_type);
    res.setHeader('Content-Length', row.byte_size);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `inline; filename="${row.file_name.replace(/[^\w.\- ]+/g, '_')}"`);
    res.setHeader('Cache-Control', 'private, max-age=0, no-store');
    res.send(bytes);
  } catch (err) { next(err); }
});

router.post('/support/tickets/:id/assign', manage, ticketBrand, async (req, res, next) => {
  try {
    const { staffId, expectedVersion } = assignBody.parse(req.body ?? {});
    const result = await supportAdminService.assign({ ticketIdOrNumber: req.params.id, staffId, expectedVersion, actorStaffId: req.staff.id });
    await log(req, 'SUPPORT_TICKET_ASSIGNED', req.params.id, { to: staffId });
    res.json({ data: result });
  } catch (err) { next(err); }
});

router.post('/support/tickets/:id/reply', manage, ticketBrand, async (req, res, next) => {
  try {
    const { body, visibility, notifyWarehouse } = replyBody.parse(req.body ?? {});
    const result = await supportAdminService.reply({ ticketIdOrNumber: req.params.id, body, visibility, notifyWarehouse: Boolean(notifyWarehouse), actorStaffId: req.staff.id });
    await log(req, visibility === 'CUSTOMER' ? 'SUPPORT_STAFF_REPLIED' : 'SUPPORT_INTERNAL_NOTE_ADDED', req.params.id, notifyWarehouse ? { notifyWarehouse: true } : null);
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

router.post('/support/tickets/:id/priority', manage, ticketBrand, async (req, res, next) => {
  try {
    const { priority } = priorityBody.parse(req.body ?? {});
    const result = await supportAdminService.setPriority({ ticketIdOrNumber: req.params.id, priority, actorStaffId: req.staff.id });
    await log(req, 'SUPPORT_TICKET_PRIORITY_CHANGED', req.params.id, { priority });
    res.json({ data: result });
  } catch (err) { next(err); }
});

router.post('/support/tickets/:id/status', manage, ticketBrand, async (req, res, next) => {
  try {
    const { status } = statusBody.parse(req.body ?? {});
    const result = await supportAdminService.transition({ ticketIdOrNumber: req.params.id, toStatus: status, actorStaffId: req.staff.id });
    await log(req, 'SUPPORT_TICKET_STATUS_CHANGED', req.params.id, { status });
    res.json({ data: result });
  } catch (err) { next(err); }
});

export default router;
