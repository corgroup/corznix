import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { internalChatService } from './service.js';

// Phase 6 security pass (DESIGN.md §5.3) — internal_conversations.brand_id
// (Phase 4) checked here too, on top of the service's own participant-
// membership check (a Cor-Cotton/Cor-Znix staff pair's direct thread is
// per-company since Phase 4's (brand_id, direct_key) widening).
const conversationBrand = requireResourceBrand('internal_conversations', { notFoundCode: 'CONVERSATION_NOT_FOUND', notFoundMessage: 'Conversation not found.' });

// Internal staff-to-staff messaging (Phase B). Mounted under /api/v1/admin
// (authenticateStaff + cmsOriginGuard already applied). Gated on the
// foundation cms.access permission — every staff member who can sign in to
// the CMS can message colleagues. Access to an individual conversation is
// enforced by participant membership in the service, not by role.

const audit = new StaffAuditRepository();
const router = Router();
const access = requireStaffPermission(PERMISSIONS.CMS_ACCESS);
const ok = (res, data) => res.status(200).json({ data });
const meId = (req) => req.staff?.id;

const directBody = z.object({
  otherStaffId: z.string().trim().min(1),
  orderId: z.string().trim().min(1).optional(),
  warehouseId: z.string().trim().min(1).optional(),
});
const groupBody = z.object({
  subject: z.string().trim().max(200).optional(),
  participantIds: z.array(z.string().trim().min(1)).min(1).max(20),
  orderId: z.string().trim().min(1).optional(),
  warehouseId: z.string().trim().min(1).optional(),
});
const messageBody = z.object({
  body: z.string().trim().min(1).max(5000),
  mentions: z.array(z.string().trim().min(1)).max(20).optional(),
});
const readBody = z.object({ lastMessageId: z.string().trim().min(1).nullable().optional() });

router.get('/internal/conversations', access, async (req, res, next) => {
  try { ok(res, await internalChatService.listForStaff(meId(req))); } catch (err) { next(err); }
});

router.get('/internal/conversations/unread-count', access, async (req, res, next) => {
  try { ok(res, await internalChatService.unreadTotal(meId(req))); } catch (err) { next(err); }
});

router.get('/internal/directory', access, async (req, res, next) => {
  try { ok(res, await internalChatService.directory({ excludeStaffId: meId(req) })); } catch (err) { next(err); }
});

router.post('/internal/conversations/direct', access, async (req, res, next) => {
  try {
    const { otherStaffId, orderId, warehouseId } = directBody.parse(req.body ?? {});
    const conversation = await internalChatService.openDirect({ brandId: req.brandId, meId: meId(req), otherStaffId, orderId: orderId ?? null, warehouseId: warehouseId ?? null });
    ok(res, conversation);
  } catch (err) { next(err); }
});

router.post('/internal/conversations/group', access, async (req, res, next) => {
  try {
    const { subject, participantIds, orderId, warehouseId } = groupBody.parse(req.body ?? {});
    const conversation = await internalChatService.createGroup({ brandId: req.brandId, meId: meId(req), subject, participantIds, orderId: orderId ?? null, warehouseId: warehouseId ?? null });
    ok(res, conversation);
  } catch (err) { next(err); }
});

router.get('/internal/conversations/:id', access, conversationBrand, async (req, res, next) => {
  try { ok(res, await internalChatService.getConversation({ meId: meId(req), conversationId: req.params.id })); } catch (err) { next(err); }
});

router.post('/internal/conversations/:id/messages', access, conversationBrand, async (req, res, next) => {
  try {
    const { body, mentions } = messageBody.parse(req.body ?? {});
    const result = await internalChatService.postMessage({ meId: meId(req), conversationId: req.params.id, body, mentions: mentions ?? [] });
    await audit.log({
      staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'INTERNAL_MESSAGE_SENT',
      resourceType: 'internal_conversation', resourceId: req.params.id, metadata: null, ipAddress: req.ip,
    }).catch(() => {});
    res.status(201).json({ data: result });
  } catch (err) { next(err); }
});

router.post('/internal/conversations/:id/read', access, conversationBrand, async (req, res, next) => {
  try {
    const { lastMessageId } = readBody.parse(req.body ?? {});
    ok(res, await internalChatService.markRead({ meId: meId(req), conversationId: req.params.id, lastMessageId: lastMessageId ?? null }));
  } catch (err) { next(err); }
});

export default router;
