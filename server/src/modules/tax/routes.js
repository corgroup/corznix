import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import * as c from './controller.js';

// Company-level GST / HSN configuration. Under /api/v1/admin.
const router = Router();
const read = requireStaffPermission(PERMISSIONS.TAX_READ);
const manage = requireStaffPermission(PERMISSIONS.TAX_MANAGE);

router.get('/tax-profiles', read, c.listProfiles);
router.get('/tax-profiles/gaps', read, c.configurationGaps);
router.get('/tax-profiles/:id', read, c.getProfile);
router.post('/tax-profiles', manage, c.createProfile);
router.patch('/tax-profiles/:id', manage, c.patchProfile);
router.post('/tax-profiles/assign', manage, c.assignProduct);
router.delete('/tax-profiles/assign/:productId', manage, c.unassignProduct);

export default router;
