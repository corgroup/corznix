import { Router } from 'express';
import * as c from './controller.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';

// WP-12 / GAP-INV-04 — inter-warehouse transfers. Mounted under /api/v1/admin
// (authenticateStaff + cmsOriginGuard applied once by modules/staff/routes.js).
// Read is inventory.read; every stock-moving action is inventory.adjust — the
// same gate as a manual stock adjustment, which is what a transfer leg is.
// Per-warehouse staff scoping is enforced in the controller.
const router = Router();

const read = requireStaffPermission(PERMISSIONS.INVENTORY_READ);
const adjust = requireStaffPermission(PERMISSIONS.INVENTORY_ADJUST);

router.get('/warehouse-transfers', read, c.listTransfers);
router.get('/warehouse-transfers/:id', read, c.getTransfer);
router.post('/warehouse-transfers', adjust, c.createTransfer);
router.post('/warehouse-transfers/:id/dispatch', adjust, c.dispatchTransfer);
router.post('/warehouse-transfers/:id/receive', adjust, c.receiveTransfer);
router.post('/warehouse-transfers/:id/cancel', adjust, c.cancelTransfer);

export default router;
