import { Router } from 'express';
import * as c from './controller.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';

// CMS Warehouses module. Mounted under /api/v1/admin (authenticateStaff +
// cmsOriginGuard already applied by modules/staff/routes.js). Warehouse
// master data needs warehouse.read / warehouse.manage; inventory needs the
// existing inventory.read / inventory.adjust. Per-warehouse staff scoping is
// enforced inside the service (SUPER_ADMIN sees all).
const router = Router();

const whRead = requireStaffPermission(PERMISSIONS.WAREHOUSE_READ);
const whManage = requireStaffPermission(PERMISSIONS.WAREHOUSE_MANAGE);
const invRead = requireStaffPermission(PERMISSIONS.INVENTORY_READ);
const invAdjust = requireStaffPermission(PERMISSIONS.INVENTORY_ADJUST);

router.get('/warehouses', whRead, c.listWarehouses);
router.post('/warehouses', whManage, c.createWarehouse);
router.post('/warehouses/allocation-preview', whRead, c.previewAllocation);
// Static path — MUST precede '/warehouses/:id' or ':id' captures it.
router.get('/warehouses/provider-sync-status', whRead, c.providerSyncStatus);
router.get('/warehouses/:id', whRead, c.getWarehouse);
router.patch('/warehouses/:id', whManage, c.updateWarehouse);
router.patch('/warehouses/:id/status', whManage, c.setWarehouseStatus);
router.patch('/warehouses/:id/default', whManage, c.setWarehouseDefault);

router.post('/warehouses/:id/staff', whManage, c.assignStaff);
router.delete('/warehouses/:id/staff/:staffUserId', whManage, c.unassignStaff);

// Phase 2 §35 — carrier pickup-location mapping (case/space-sensitive).
router.put('/warehouses/:id/provider-locations/:providerCode', whManage, c.setProviderLocation);
router.delete('/warehouses/:id/provider-locations/:providerCode', whManage, c.removeProviderLocation);

router.get('/warehouses/:id/inventory', invRead, c.warehouseInventory);
router.post('/warehouses/:id/inventory/adjust', invAdjust, c.adjustInventory);

export default router;
