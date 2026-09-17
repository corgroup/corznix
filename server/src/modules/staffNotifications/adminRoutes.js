import { Router } from 'express';
import { z } from 'zod';
import { staffNotificationService } from './service.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';

// Staff notification feed — the read/act surface for the CMS topbar bell.
// Mounted under /api/v1/admin (authenticateStaff + cmsOriginGuard already
// applied by modules/staff/routes.js). Every authenticated staff member sees
// the operational feed; the deep-linked target route still enforces its own
// permission. No write route creates notifications — those are written by
// domain flows via staffNotificationService.record().

const router = Router();
const ok = (res, data) => res.status(200).json({ data });
const staffId = (req) => req.staff?.id;

const feedQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  before: z.string().trim().min(1).max(40).optional(),
  category: z.enum(['ORDER', 'RETURN', 'SHIPMENT', 'INVENTORY', 'SYSTEM', 'MESSAGE', 'MENTION', 'SUPPORT', 'CAREERS']).optional(),
  unread: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
  // Mentions tab — only rows addressed to this staff member.
  mine: z
    .union([z.literal('true'), z.literal('false'), z.literal('1'), z.literal('0')])
    .transform((v) => v === 'true' || v === '1')
    .optional(),
});

const readBody = z.object({ ids: z.array(z.string().min(1)).min(1).max(200) });

router.get('/notifications', async (req, res, next) => {
  try {
    const q = feedQuery.parse(req.query ?? {});
    const scope = await warehouseScopeForStaff(req.staff);
    ok(res, await staffNotificationService.feed(staffId(req), {
      scope,
      limit: q.limit,
      before: q.before || null,
      category: q.category || null,
      unreadOnly: Boolean(q.unread),
      staffAddressedOnly: Boolean(q.mine),
    }));
  } catch (err) { next(err); }
});

router.get('/notifications/unread-count', async (req, res, next) => {
  try {
    const scope = await warehouseScopeForStaff(req.staff);
    ok(res, await staffNotificationService.unreadCount(staffId(req), scope));
  } catch (err) { next(err); }
});

router.post('/notifications/read', async (req, res, next) => {
  try {
    const body = readBody.parse(req.body ?? {});
    const scope = await warehouseScopeForStaff(req.staff);
    ok(res, await staffNotificationService.markRead(staffId(req), body.ids, scope));
  } catch (err) { next(err); }
});

router.post('/notifications/read-all', async (req, res, next) => {
  try {
    const scope = await warehouseScopeForStaff(req.staff);
    ok(res, await staffNotificationService.markAllRead(staffId(req), scope));
  } catch (err) { next(err); }
});

export default router;
