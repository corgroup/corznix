import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import * as c from './controller.js';

// CMS documents + printing surface. Mounted under /api/v1/admin.
const router = Router();
const ordersRead = requireStaffPermission(PERMISSIONS.ORDERS_READ);
const ordersManage = requireStaffPermission(PERMISSIONS.ORDERS_MANAGE);
const fulfillmentManage = requireStaffPermission(PERMISSIONS.FULFILLMENT_MANAGE);
const whManage = requireStaffPermission(PERMISSIONS.WAREHOUSE_MANAGE);

router.get('/orders/:orderId/documents', ordersRead, c.listOrderDocuments);
router.get('/orders/:orderId/invoice', ordersRead, c.getAdminInvoice);
router.post('/orders/:orderId/invoice', ordersManage, c.regenerateInvoice);
router.post('/orders/:orderId/cancel', ordersManage, c.cancelOrder);
// Paying money back is its own permission, exactly as it is for returns.
router.post('/orders/:orderId/refund', requireStaffPermission(PERMISSIONS.RETURNS_REFUND), c.refundCancelledOrder);
router.get('/documents/:docId', ordersRead, c.getDocument);
router.get('/documents/:docId/download', ordersRead, c.downloadDocument);
router.post('/documents/:docId/render', fulfillmentManage, c.renderDocumentArtifact);
router.post('/fulfillments/:fulfillmentId/packing-slip', fulfillmentManage, c.generatePackingSlip);
router.post('/shipments/:shipmentId/label', fulfillmentManage, c.generateShippingLabel);

router.get('/print-stations', whManage, c.listStations);
router.post('/print-stations', whManage, c.createStation);
router.patch('/print-stations/:id', whManage, c.patchStation);
router.get('/print-stations/:id/printers', whManage, c.listPrinters);
router.post('/printers', whManage, c.createPrinter);
router.patch('/printers/:id', whManage, c.patchPrinter);

router.get('/print-jobs', fulfillmentManage, c.listJobs);
router.post('/print-jobs', fulfillmentManage, c.createJob);
router.post('/print-jobs/:id/retry', fulfillmentManage, c.retryJob);

export default router;
