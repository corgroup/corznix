import { z } from 'zod';
import { AppError } from '../../utils/errors.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { documentService, invoiceService } from './service.js';
import { printService } from './printService.js';
import { orderCancellationService } from '../orderOps/cancellationService.js';
import { cancellationRefundService } from '../orderOps/cancellationRefundService.js';
import { fulfillmentRepository } from '../fulfillment/repository.js';

const audit = new StaffAuditRepository();
const ok = (res, data, status = 200) => res.status(status).json({ data });
const actor = (req) => ({ id: req.staff?.id, email: req.staff?.email, role: req.staff?.role, brandId: req.brandId, ip: req.ip });

const stationBody = z.object({ warehouseId: z.string().uuid(), name: z.string().trim().min(1).max(120) });
const stationPatch = z.object({ name: z.string().trim().min(1).max(120).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional() });
const printerBody = z.object({
  printStationId: z.string().uuid(), name: z.string().trim().min(1).max(120),
  printerType: z.enum(['A4_PDF', 'LABEL_4X6_PDF', 'ZPL']).optional(), labelSize: z.string().trim().max(16).optional(),
});
const printerPatch = z.object({ name: z.string().trim().min(1).max(120).optional(), status: z.enum(['ACTIVE', 'DISABLED']).optional(), printerType: z.enum(['A4_PDF', 'LABEL_4X6_PDF', 'ZPL']).optional() });
const jobBody = z.object({ documentId: z.string().uuid(), printerId: z.string().uuid(), copies: z.coerce.number().int().min(1).max(20).optional() });

// ---- admin: documents ----
export async function listOrderDocuments(req, res, next) {
  try { ok(res, { documents: await documentService.listForOrder(req.params.orderId) }); } catch (e) { next(e); }
}

export async function getDocument(req, res, next) {
  try {
    const doc = await documentService.get(req.params.docId);
    await documentService.assertStaffAccess(actor(req), doc);
    ok(res, { document: { id: doc.id, type: doc.document_type, status: doc.status, format: doc.format, snapshot: doc.snapshot } });
  } catch (e) { next(e); }
}

export async function downloadDocument(req, res, next) {
  try {
    const meta = await documentService.get(req.params.docId);
    await documentService.assertStaffAccess(actor(req), meta);
    const { bytes, contentType, filename } = await documentService.stream(req.params.docId);
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'DOCUMENT_DOWNLOADED', resourceType: 'document', resourceId: req.params.docId, ipAddress: req.ip });
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bytes);
  } catch (e) { next(e); }
}

export async function renderDocumentArtifact(req, res, next) {
  try {
    const meta = await documentService.get(req.params.docId);
    await documentService.assertStaffAccess(actor(req), meta);
    const doc = await documentService.render(req.params.docId);
    ok(res, { documentId: doc.id, status: doc.status, byteSize: doc.byte_size });
  } catch (e) { next(e); }
}

export async function generatePackingSlip(req, res, next) {
  try {
    const doc = await documentService.ensurePackingSlip(null, req.params.fulfillmentId, req.staff.id);
    await documentService.assertStaffAccess(actor(req), doc);
    const rendered = await documentService.render(doc.id).catch((e) => ({ status: 'FAILED', error: e.code }));
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'PACKING_SLIP_RENDERED', resourceType: 'document', resourceId: doc.id, ipAddress: req.ip });
    ok(res, { documentId: doc.id, type: doc.document_type, status: rendered.status }, 201);
  } catch (e) { next(e); }
}

export async function generateShippingLabel(req, res, next) {
  try {
    const doc = await documentService.ensureShippingLabel(null, req.params.shipmentId, req.staff.id);
    await documentService.assertStaffAccess(actor(req), doc);
    const rendered = await documentService.render(doc.id).catch((e) => ({ status: 'FAILED', error: e.code }));
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'SHIPPING_LABEL_RENDERED', resourceType: 'document', resourceId: doc.id, ipAddress: req.ip });
    ok(res, { documentId: doc.id, type: doc.document_type, status: rendered.status }, 201);
  } catch (e) { next(e); }
}

export async function getAdminInvoice(req, res, next) {
  try {
    const inv = await invoiceService.getForOrder(req.params.orderId);
    if (!inv) throw new AppError('INVOICE_NOT_FOUND', 'No invoice for this order yet.', 404);
    if (inv.blocked) throw new AppError('INVOICE_ISSUANCE_BLOCKED', `Tax configuration is ${inv.taxStatus}.`, 409, { meta: { taxStatus: inv.taxStatus, missing: inv.missing } });
    ok(res, invoiceDto(inv));
  } catch (e) { next(e); }
}

export async function regenerateInvoice(req, res, next) {
  try {
    const result = await invoiceService.issueForOrder(req.params.orderId);
    if (result.blocked) throw new AppError('INVOICE_ISSUANCE_BLOCKED', `Tax configuration is ${result.taxStatus}.`, 409, { meta: { taxStatus: result.taxStatus, missing: result.missing } });
    const rendered = await documentService.renderPending(req.params.orderId);
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'INVOICE_ISSUED', resourceType: 'invoice', resourceId: result.id, metadata: { invoiceNumber: result.invoice_number }, ipAddress: req.ip });
    ok(res, { invoiceNumber: result.invoice_number, documents: rendered });
  } catch (e) { next(e); }
}

export async function cancelOrder(req, res, next) {
  try {
    const { reason, expectedUpdatedAt } = z.object({
      reason: z.string().trim().max(255).optional(),
      expectedUpdatedAt: z.string().datetime().optional(),
    }).parse(req.body ?? {});
    // WP-09 — the full cancellation cascade (order status + inventory restore
    // + fulfilment CANCELLED + shipment void + credit note + notification).
    const outcome = await orderCancellationService.cancel(req.params.orderId, {
      reason: reason ?? null,
      expectedUpdatedAt: expectedUpdatedAt ?? null,
      actor: { id: req.staff?.id, email: req.staff?.email, ip: req.ip, requestId: req.id },
    });
    ok(res, outcome);
  } catch (e) { next(e); }
}

/**
 * Retry the refund on a cancelled order. The cancellation already attempts it;
 * this exists for the states a provider can leave behind — FAILED, BLOCKED, or
 * an ambiguous timeout someone has since reconciled. A refund that succeeded or
 * is still in flight is returned as it stands, never sent again.
 */
export async function refundCancelledOrder(req, res, next) {
  try {
    const outcome = await cancellationRefundService.refundCancelledOrder(req.params.orderId, { retry: true });
    await audit.log({
      staffUserId: req.staff?.id ?? null, actorEmail: req.staff?.email ?? null, ipAddress: req.ip,
      action: 'ORDER_REFUND_RETRIED', resourceType: 'order', resourceId: req.params.orderId,
      metadata: { status: outcome.status, amountMinor: outcome.amountMinor, refundNumber: outcome.refund?.refundNumber || null },
    });
    ok(res, outcome);
  } catch (e) { next(e); }
}

// ---- admin: print stations / printers / jobs ----
export async function listStations(req, res, next) { try { ok(res, { stations: await printService.listStations(actor(req)) }); } catch (e) { next(e); } }
export async function createStation(req, res, next) { try { ok(res, await printService.createStation(actor(req), stationBody.parse(req.body)), 201); } catch (e) { next(e); } }
export async function patchStation(req, res, next) { try { ok(res, await printService.updateStation(actor(req), req.params.id, stationPatch.parse(req.body))); } catch (e) { next(e); } }
export async function listPrinters(req, res, next) { try { ok(res, { printers: await printService.listPrinters(actor(req), req.params.id) }); } catch (e) { next(e); } }
export async function createPrinter(req, res, next) { try { ok(res, await printService.createPrinter(actor(req), printerBody.parse(req.body)), 201); } catch (e) { next(e); } }
export async function patchPrinter(req, res, next) { try { ok(res, await printService.updatePrinter(actor(req), req.params.id, printerPatch.parse(req.body))); } catch (e) { next(e); } }
export async function listJobs(req, res, next) { try { ok(res, { jobs: await printService.listJobs(actor(req), { stationId: req.query.stationId, status: req.query.status }) }); } catch (e) { next(e); } }

export async function createJob(req, res, next) {
  try {
    const body = jobBody.parse(req.body);
    const job = await printService.queueJob(actor(req), body);
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'PRINT_JOB_CREATED', resourceType: 'print_job', resourceId: job.id, metadata: { documentId: body.documentId }, ipAddress: req.ip });
    ok(res, job, 201);
  } catch (e) { next(e); }
}

export async function retryJob(req, res, next) { try { ok(res, await printService.retryJob(actor(req), req.params.id)); } catch (e) { next(e); } }

// ---- customer ----
export async function getCustomerInvoice(req, res, next) {
  try {
    // Ownership check first — a stranger's order id looks identical to a missing one.
    const order = await fulfillmentRepository.orderByOwner(req.customer.id, req.params.orderId);
    if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
    const inv = await invoiceService.getForOrder(order.id);
    if (!inv) throw new AppError('INVOICE_NOT_READY', 'Your invoice is being prepared.', 404);
    if (inv.blocked) throw new AppError('INVOICE_NOT_READY', 'Your invoice is being prepared.', 409);
    if (!inv.document_id) throw new AppError('INVOICE_NOT_READY', 'Your invoice is being prepared.', 409);
    const meta = await documentService.get(inv.document_id);
    documentService.assertCustomerAllowed(meta);
    if (meta.status !== 'READY') throw new AppError('INVOICE_NOT_READY', 'Your invoice is being prepared.', 409);
    const { bytes, contentType, filename } = await documentService.stream(inv.document_id);
    res.set('Content-Type', contentType);
    res.set('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(bytes);
  } catch (e) { next(e); }
}

function invoiceDto(inv) {
  const money = (k) => Number(inv[k]);
  return {
    invoiceNumber: inv.invoice_number, orderId: inv.order_id, issuedAt: inv.issued_at, status: inv.status,
    currency: inv.currency,
    supplier: JSON.parse(inv.supplier_snapshot_json), dispatchFrom: inv.dispatch_snapshot_json ? JSON.parse(inv.dispatch_snapshot_json) : null,
    billTo: JSON.parse(inv.billing_snapshot_json), shipTo: JSON.parse(inv.shipping_snapshot_json),
    amounts: {
      subtotalMinor: money('subtotal_minor'), discountMinor: money('discount_minor'), taxableMinor: money('taxable_minor'),
      cgstMinor: money('cgst_minor'), sgstMinor: money('sgst_minor'), igstMinor: money('igst_minor'),
      shippingMinor: money('shipping_minor'), grandTotalMinor: money('grand_total_minor'),
      onlinePaidMinor: money('online_paid_minor'), codDueMinor: money('cod_due_minor'),
    },
    items: (inv.items || []).map((i) => ({
      sku: i.sku, productName: i.product_name, quantity: Number(i.quantity),
      unitPriceMinor: Number(i.unit_price_minor), totalMinor: Number(i.total_minor),
    })),
  };
}
