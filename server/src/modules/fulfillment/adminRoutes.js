import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import * as c from './adminController.js';

// WP-11 — the standalone Fulfillment CMS surface. Mounted under
// /api/v1/admin (staff session + cmsOriginGuard applied by
// modules/staff/routes.js). Per-warehouse staff scoping is enforced in the
// controller.
const router = Router();

const read = requireStaffPermission(PERMISSIONS.FULFILLMENT_READ);
const manage = requireStaffPermission(PERMISSIONS.FULFILLMENT_MANAGE);
// Phase 6 security pass (DESIGN.md §5.3) — fulfillments.brand_id (Phase 5)
// was never filtered on by the :id routes.
const fulfillmentBrand = requireResourceBrand('fulfillments', { notFoundCode: 'FULFILLMENT_NOT_FOUND', notFoundMessage: 'Fulfillment not found.' });

router.get('/fulfillments', read, c.listFulfillments);
router.get('/fulfillments/:id', read, fulfillmentBrand, c.getFulfillment);
router.post('/fulfillments/:id/transition', manage, fulfillmentBrand, c.transitionFulfillment);

export default router;
