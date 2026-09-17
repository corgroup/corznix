import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import * as c from './adminController.js';

// CMS customer operations. Mounted under /api/v1/admin (staff session +
// cmsOriginGuard already applied). Read = customers.read; every mutation =
// customers.manage. Verified email/phone are never mutable here (§20).
const router = Router();

const read = requireStaffPermission(PERMISSIONS.CUSTOMERS_READ);
const manage = requireStaffPermission(PERMISSIONS.CUSTOMERS_MANAGE);
// Phase 6 security pass (DESIGN.md §5.3) — customers.brand_id (Phase 4) was
// never filtered on by the :id routes.
const customerBrand = requireResourceBrand('customers', { notFoundCode: 'CUSTOMER_NOT_FOUND', notFoundMessage: 'Customer not found.' });

router.get('/customers', read, c.listCustomers);
router.get('/customers/:id', read, customerBrand, c.getCustomer);
router.patch('/customers/:id', manage, customerBrand, c.updateCustomer);
router.post('/customers/:id/notes', manage, customerBrand, c.addCustomerNote);
router.post('/customers/:id/status', manage, customerBrand, c.setCustomerStatus);

export default router;
