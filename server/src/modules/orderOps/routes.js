import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { requireResourceBrand } from '../../middleware/requireResourceBrand.js';
import { PERMISSIONS } from '../staff/permissions.js';
import * as c from './controller.js';

// CMS order-operations surface. Mounted under /api/v1/admin (staff session +
// cmsOriginGuard already applied). The customer Order is created once at
// checkout — these routes confirm / process it and book its shipments.
const router = Router();

const ordersRead = requireStaffPermission(PERMISSIONS.ORDERS_READ);
const ordersManage = requireStaffPermission(PERMISSIONS.ORDERS_MANAGE);
const fulfillmentManage = requireStaffPermission(PERMISSIONS.FULFILLMENT_MANAGE);

// Phase 6 security pass (DESIGN.md §5.3) — every /orders/:id* and
// /shipments/:id* route now 404s outright on a cross-brand id before its
// handler runs at all (mechanical coverage for this module's whole
// existing `:id` surface, rather than auditing each handler one at a time).
// getOrder still re-checks via orderOpsRepository.order(id, req.brandId)
// too — belt and suspenders on the single highest-traffic read.
const orderBrand = requireResourceBrand('orders', { altColumn: 'order_number' });
const shipmentBrand = requireResourceBrand('shipments', { notFoundCode: 'SHIPMENT_NOT_FOUND', notFoundMessage: 'Shipment not found.' });

router.get('/orders', ordersRead, c.listOrders);
// Phase 5 — static paths before '/orders/:id'.
router.get('/orders/facets', ordersRead, c.getOrderFacets);
router.get('/orders/:id', ordersRead, orderBrand, c.getOrder);
router.get('/orders/:id/timeline', ordersRead, orderBrand, c.getOrderTimeline);
router.get('/orders/:id/returns', ordersRead, orderBrand, c.getOrderReturns);
router.post('/orders/:id/confirm', ordersManage, orderBrand, c.confirmOrder);
router.post('/orders/:id/start-processing', ordersManage, orderBrand, c.startProcessing);

router.post('/shipments/:id/book', fulfillmentManage, shipmentBrand, c.bookShipment);
router.get('/shipments/:id/events', ordersRead, shipmentBrand, c.shipmentEvents);

// Phase 2 · Slice 16 — Order Detail operational actions (post-booking).
router.post('/shipments/:id/label', fulfillmentManage, shipmentBrand, c.fetchShipmentLabel);
router.post('/shipments/:id/label/printed', fulfillmentManage, shipmentBrand, c.markShipmentLabelPrinted);
router.post('/shipments/:id/pickup', fulfillmentManage, shipmentBrand, c.requestShipmentPickup);
router.post('/shipments/:id/cancel', fulfillmentManage, shipmentBrand, c.cancelShipmentAtProvider);
router.post('/shipments/:id/package', fulfillmentManage, shipmentBrand, c.confirmShipmentPackage);
// One operator action = confirm package + book with the carrier + fetch label.
router.post('/shipments/:id/manifest', fulfillmentManage, shipmentBrand, c.manifestShipment);
router.post('/shipments/:id/automation/run', fulfillmentManage, shipmentBrand, c.runShipmentAutomation);
router.post('/shipments/:id/reconcile', fulfillmentManage, shipmentBrand, c.reconcileShipmentTracking);

// Phase 2 · Slice 17 — carrier documents (EPOD / QC / Sorter image + signature).
router.get('/shipments/:id/carrier-documents', ordersRead, shipmentBrand, c.listShipmentCarrierDocuments);
router.post('/shipments/:id/carrier-documents/fetch', fulfillmentManage, shipmentBrand, c.fetchShipmentCarrierDocument);
// carrier-documents/:id and ndr-actions/:actionId key off a CHILD artifact's
// own id, not a shipment/order id directly — not covered by requireResourceBrand
// here; flagged in PHASE-6.md as remaining follow-up (both require already
// knowing a valid parent shipment id, out of reach of the fixed list/get
// routes above).
router.get('/carrier-documents/:id/content', ordersRead, c.streamCarrierDocument);

// Phase 2 · Slice 18 — NDR (failed delivery attempt) actions.
router.get('/shipments/:id/ndr', ordersRead, shipmentBrand, c.getShipmentNdr);
router.post('/shipments/:id/ndr/action', fulfillmentManage, shipmentBrand, c.submitShipmentNdrAction);
router.post('/ndr-actions/:actionId/refresh', fulfillmentManage, c.refreshNdrAction);

export default router;
