import { Router } from 'express';
import * as c from './controller.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';

// WP-12 / GAP-INV-03 — QC-FAIL quarantine surface. Mounted under /api/v1/admin
// (authenticateStaff + cmsOriginGuard applied once by modules/staff/routes.js).
// Read is inventory.read; disposition (release back to sellable / scrap) is
// inventory.adjust — it moves real stock. Batches are only ever OPENED by the
// return QC path, never from here.
const router = Router();

const read = requireStaffPermission(PERMISSIONS.INVENTORY_READ);
const adjust = requireStaffPermission(PERMISSIONS.INVENTORY_ADJUST);

router.get('/inventory-quarantine', read, c.listQuarantine);
router.get('/inventory-quarantine/:id', read, c.getQuarantine);
router.post('/inventory-quarantine/:id/dispose', adjust, c.disposeQuarantine);

export default router;
