import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { instagramService } from './service.js';

// CMS -> Providers -> Instagram (the connection) and the homepage builder's
// post picker. Mounted under /api/v1/admin. The access token is accepted once
// on connect and never returned, logged or put in an audit record.

const router = Router();
const audit = new StaffAuditRepository();
const read = requireStaffPermission(PERMISSIONS.PROVIDERS_READ);
const manage = requireStaffPermission(PERMISSIONS.PROVIDERS_MANAGE);
const contentRead = requireStaffPermission(PERMISSIONS.CONTENT_READ);

const send = (res, data) => res.json({ data });
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };
const log = (req, action, metadata) => audit.log({
  staffUserId: req.staff.id, actorEmail: req.staff.email, action,
  resourceType: 'instagram_connection', resourceId: req.brandId, metadata, ipAddress: req.ip,
}).catch(() => {});

router.get('/providers/social/INSTAGRAM/connection', read, wrap(async (req, res) => {
  send(res, await instagramService.status(req.brandId));
}));

router.put('/providers/social/INSTAGRAM/connection', manage, wrap(async (req, res) => {
  const result = await instagramService.connect(req.brandId, req.body?.accessToken, req.staff.id);
  await log(req, 'INSTAGRAM_CONNECTED', { username: result.status.username, synced: Boolean(result.sync) });
  send(res, result);
}));

router.post('/providers/social/INSTAGRAM/sync', manage, wrap(async (req, res) => {
  const result = await instagramService.sync(req.brandId);
  await log(req, 'INSTAGRAM_SYNCED', result);
  send(res, { sync: result, status: await instagramService.status(req.brandId) });
}));

router.delete('/providers/social/INSTAGRAM/connection', manage, wrap(async (req, res) => {
  const result = await instagramService.disconnect(req.brandId);
  await log(req, 'INSTAGRAM_DISCONNECTED', result);
  send(res, { ...result, status: await instagramService.status(req.brandId) });
}));

// The homepage builder picks from what has been synced.
router.get('/instagram/posts', contentRead, wrap(async (req, res) => {
  send(res, { posts: await instagramService.listPosts(req.brandId, { limit: 200 }), status: await instagramService.status(req.brandId) });
}));

export default router;
