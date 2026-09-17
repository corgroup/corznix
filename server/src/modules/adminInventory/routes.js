import { Router } from 'express';
import * as c from './controller.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';

// WP-12 — the standalone Inventory CMS surface. Mounted under /api/v1/admin
// (authenticateStaff + cmsOriginGuard applied by modules/staff/routes.js).
// Read is inventory.read; the threshold editor is inventory.adjust (it is a
// real operational setting, like a stock adjustment). Per-warehouse staff
// scoping is enforced inside the service.
const router = Router();

const read = requireStaffPermission(PERMISSIONS.INVENTORY_READ);
const adjust = requireStaffPermission(PERMISSIONS.INVENTORY_ADJUST);

router.get('/inventory', read, c.listInventory);
router.get('/inventory/export', read, c.exportInventory);
router.get('/inventory/:warehouseId/:skuId', read, c.inventoryDetail);
router.patch('/inventory/:warehouseId/:skuId/threshold', adjust, c.setThreshold);

export default router;
