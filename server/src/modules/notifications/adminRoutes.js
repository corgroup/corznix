import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { buildNotificationCatalog } from './catalog.js';

// WP-07 — the lifecycle-notification catalogue for the CMS Communications
// page. Read-only; gated on comms.read (same as the templates list). Template
// creation / activation still uses the existing
// POST /communications/templates + /status endpoints.
const router = Router();

router.get(
  '/communications/notification-policies',
  requireStaffPermission(PERMISSIONS.COMMS_READ),
  async (req, res, next) => {
    try {
      res.json({ data: { policies: await buildNotificationCatalog() } });
    } catch (err) { next(err); }
  },
);

export default router;
