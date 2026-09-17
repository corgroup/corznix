import { Router } from 'express';
import * as c from './controller.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';

// WP-12 / GAP-ORD-06 — the read-only CMS audit-log viewer. `staff_audit_logs`
// is append-only and written by every admin module; this is the only surface
// that reads it back. Mounted under /api/v1/admin (authenticateStaff +
// cmsOriginGuard applied once by modules/staff/routes.js). There is no write
// route by design — the trail is never editable from the CMS.
const router = Router();

const read = requireStaffPermission(PERMISSIONS.AUDIT_READ);

router.get('/audit-logs', read, c.listAuditLogs);
router.get('/audit-logs/facets', read, c.auditFacets);

export default router;
