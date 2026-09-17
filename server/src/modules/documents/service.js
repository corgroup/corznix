import { createHash } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { companyService } from '../company/service.js';
import { taxResolutionService, taxCalculationService } from '../tax/service.js';
import { documentRepository } from './repository.js';
import { documentStorage } from './storage.js';
import { renderDocument } from './renderers.js';
import { loadInvoiceImages } from './invoiceImages.js';

const sha256 = (v) => createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');

// Split an order-level discount (coupon) across its lines in proportion to
// each line's gross value, largest remainder first, so the parts add up to the
// discount exactly. The invoice used to ignore order discounts altogether.
function allocateDiscount(items, discountMinor) {
  const out = new Map(items.map((it) => [it.id, 0]));
  const gross = items.reduce((s, it) => s + Number(it.line_total_minor), 0);
  const discount = Math.min(Math.max(0, Math.round(Number(discountMinor) || 0)), gross);
  if (!discount || gross <= 0) return out;
  const shares = items.map((it) => {
    const exact = (discount * Number(it.line_total_minor)) / gross;
    return { id: it.id, minor: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = discount - shares.reduce((s, x) => s + x.minor, 0);
  for (const share of [...shares].sort((a, b) => b.remainder - a.remainder)) {
    if (left > 0) { share.minor += 1; left -= 1; }
    out.set(share.id, share.minor);
  }
  return out;
}
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const exec = async (c, sql, p = []) => (c ? await c.execute(sql, p) : [await query(sql, p)])[0];

// Documents a customer may ever see. Everything else is internal-only.
export const CUSTOMER_DOCUMENT_TYPES = Object.freeze(['INVOICE', 'CREDIT_NOTE']);
const CONTENT_TYPE = { A4_PDF: 'application/pdf', PDF4X6: 'application/pdf', ZPL: 'application/octet-stream', JSON: 'application/json' };

export class DocumentService {
  constructor({ repository = documentRepository, company = companyService, storage = documentStorage, imageLoader = loadInvoiceImages } = {}) {
    this.repository = repository;
    this.company = company;
    this.storage = storage;
    this.imageLoader = imageLoader;
  }

  /** Create the document record (PENDING_RENDER) from an immutable snapshot. Idempotent. */
  async ensure(connection, ref, build) {
    const run = async (c) => {
      const found = await this.repository.findDocument(c, ref);
      if (found) return found;
      const built = await build(c);
      try {
        return await this.repository.insertDocument(c, {
          type: ref.type, orderId: ref.orderId || built.orderId || null,
          fulfillmentId: ref.fulfillmentId || null, shipmentId: ref.shipmentId || null,
          warehouseId: built.warehouseId || null, format: 'PENDING', snapshot: built.snapshot, staffId: ref.staffId || null,
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') return this.repository.findDocument(c, ref);
        throw err;
      }
    };
    return connection ? run(connection) : withTransaction(run);
  }

  ensurePackingSlip(connection, fulfillmentId, staffId = null) {
    return this.ensure(connection, { type: 'PACKING_SLIP', fulfillmentId, staffId }, async (c) => {
      const [f] = await exec(c, 'SELECT * FROM fulfillments WHERE id = ? LIMIT 1', [fulfillmentId]);
      if (!f) throw new AppError('FULFILLMENT_NOT_FOUND', 'Fulfillment not found.', 404);
      const items = await exec(c,
        `SELECT fi.quantity, oi.sku, oi.product_name, oi.selected_size, oi.selected_color
           FROM fulfillment_items fi JOIN order_items oi ON oi.id = fi.order_item_id
          WHERE fi.fulfillment_id = ? ORDER BY oi.product_name`, [fulfillmentId]);
      return {
        orderId: f.order_id, warehouseId: f.warehouse_id,
        snapshot: {
          documentType: 'PACKING_SLIP', fulfillmentNumber: f.fulfillment_number, orderId: f.order_id,
          dispatchFrom: parse(f.warehouse_snapshot_json), shipTo: parse(f.shipping_address_snapshot_json),
          items: items.map((i) => ({ sku: i.sku, name: i.product_name, size: i.selected_size, color: i.selected_color, quantity: Number(i.quantity) })),
          generatedAt: new Date().toISOString(),
        },
      };
    });
  }

  ensureShippingLabel(connection, shipmentId, staffId = null) {
    return this.ensure(connection, { type: 'SHIPPING_LABEL', shipmentId, staffId }, async (c) => {
      const [s] = await exec(c,
        `SELECT s.*, f.order_id, f.warehouse_id, f.warehouse_snapshot_json, f.shipping_address_snapshot_json
           FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE s.id = ? LIMIT 1`, [shipmentId]);
      if (!s) throw new AppError('SHIPMENT_NOT_FOUND', 'Shipment not found.', 404);
      if (s.booking_status !== 'BOOKED') throw new AppError('SHIPMENT_NOT_BOOKED', 'A shipping label needs a booked shipment (AWB).', 409);
      return {
        orderId: s.order_id, warehouseId: s.warehouse_id,
        snapshot: {
          documentType: 'SHIPPING_LABEL', shipmentNumber: s.shipment_number, orderId: s.order_id,
          providerCode: s.provider_code, awbNumber: s.tracking_number, codCollectionMinor: Number(s.cod_collection_minor),
          dispatchFrom: parse(s.warehouse_snapshot_json), shipTo: parse(s.shipping_address_snapshot_json),
          generatedAt: new Date().toISOString(),
        },
      };
    });
  }

  ensureInvoiceDocument(connection, invoice, snapshot) {
    return this.ensure(connection, { type: 'INVOICE', orderId: invoice.order_id }, async () => ({ orderId: invoice.order_id, snapshot }));
  }

  ensureCreditNoteDocument(connection, creditNote, snapshot) {
    return this.ensure(connection, { type: 'CREDIT_NOTE', orderId: creditNote.order_id }, async () => ({ orderId: creditNote.order_id, snapshot }));
  }

  /**
   * Render a PENDING_RENDER / FAILED document into artefact bytes and store
   * them privately. Idempotent (a READY document is returned unchanged). The
   * document identity never changes across retries.
   */
  async render(documentId) {
    // 1. claim the document (RENDERING) under a short row lock.
    const claim = await withTransaction(async (c) => {
      const doc = await this.repository.documentById2(c, documentId);
      if (!doc) throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found.', 404);
      if (doc.status === 'READY') return { done: doc };
      await this.repository.setDocumentStatus(c, documentId, 'RENDERING');
      return { doc };
    });
    if (claim.done) return claim.done;
    const doc = claim.doc;

    // 2. render + store OUTSIDE the transaction (no DB locks during I/O).
    let failure = null;
    let artefact;
    try {
      const snapshot = parse(doc.snapshot_json);
      // Invoice thumbnails are loaded for the render only (never stored in the
      // snapshot); the loader never throws and skips what it cannot fetch.
      const images = doc.document_type === 'INVOICE' ? await this.imageLoader(snapshot) : undefined;
      artefact = await renderDocument(doc.document_type, snapshot, { images });
    } catch (err) { failure = err.code || 'DOCUMENT_RENDER_FAILED'; }
    let stored = null;
    if (!failure) {
      const key = this.storage.newKey(artefact.ext);
      try { stored = await this.storage.put(key, artefact.bytes); }
      catch (err) { await this.storage.remove(key); failure = err.code || 'DOCUMENT_STORAGE_FAILED'; }
    }

    // 3. commit the outcome, then signal failure.
    const outcome = await withTransaction(async (c) => {
      if (failure) { await this.repository.setDocumentStatus(c, documentId, 'FAILED', { failure_code: failure }); return { failure }; }
      await this.repository.setDocumentStatus(c, documentId, 'READY', {
        format: artefact.format, storage_key: stored.key, sha256: stored.sha256, byte_size: stored.byteSize, rendered_at: new Date(), failure_code: null,
      });
      return { ok: true };
    });
    if (outcome.failure) {
      throw new AppError(outcome.failure, outcome.failure === 'DOCUMENT_STORAGE_FAILED' ? 'Could not persist the document.' : 'The document could not be rendered.', 502);
    }
    return this.repository.documentById(documentId);
  }

  /** Best-effort: render every pending document for an order (post-commit). */
  async renderPending(orderId) {
    const pending = await this.repository.pendingDocumentsForOrder(orderId);
    const out = [];
    for (const d of pending) {
      try { out.push({ id: d.id, type: d.document_type, status: (await this.render(d.id)).status }); }
      catch (err) { out.push({ id: d.id, type: d.document_type, status: 'FAILED', error: err.code }); }
    }
    return out;
  }

  /** Return artefact bytes for a READY document, verifying integrity. */
  async stream(documentId) {
    const doc = await this.repository.documentById(documentId);
    if (!doc) throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found.', 404);
    if (doc.status !== 'READY' || !doc.storage_key) throw new AppError('DOCUMENT_NOT_READY', 'This document is not ready yet.', 409);
    const bytes = await this.storage.get(doc.storage_key);
    if (sha256(bytes) !== doc.sha256) throw new AppError('DOCUMENT_INTEGRITY_FAILED', 'The stored document failed its integrity check.', 502);
    return { doc, bytes, contentType: CONTENT_TYPE[doc.format] || 'application/octet-stream', filename: `${doc.document_type.toLowerCase()}-${documentId}.${doc.storage_key.split('.').pop()}` };
  }

  async get(documentId) {
    const doc = await this.repository.documentById(documentId);
    if (!doc) throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found.', 404);
    return { ...doc, snapshot: parse(doc.snapshot_json) };
  }

  async listForOrder(orderId, { customerScope = false } = {}) {
    const rows = await this.repository.documentsForOrder(orderId, customerScope ? { types: CUSTOMER_DOCUMENT_TYPES } : {});
    return rows.map((d) => ({ id: d.id, type: d.document_type, status: d.status, format: d.format, warehouseId: d.warehouse_id, byteSize: d.byte_size, createdAt: d.created_at }));
  }

  async assertStaffAccess(staff, doc) {
    // Phase 6 security pass — brand check FIRST (never leak existence across
    // companies), then the warehouse-assignment scope, unconditionally
    // against the now brand-bounded warehouseIds (see requireWarehouseAccess.js).
    if (staff?.brandId && doc.brand_id && doc.brand_id !== staff.brandId) {
      throw new AppError('DOCUMENT_NOT_FOUND', 'Document not found.', 404);
    }
    if (!doc.warehouse_id) return;
    const scope = await warehouseScopeForStaff(staff, staff?.brandId);
    if (!scope.warehouseIds.includes(doc.warehouse_id)) {
      throw new AppError('DOCUMENT_ACCESS_DENIED', 'This document belongs to a warehouse you are not assigned to.', 403);
    }
  }

  assertCustomerAllowed(doc) {
    if (!CUSTOMER_DOCUMENT_TYPES.includes(doc.document_type)) {
      throw new AppError('DOCUMENT_ACCESS_DENIED', 'This document is not available.', 403);
    }
  }
}

// GST reversal treatment for a cancellation is not configured — a credit note
// is recorded (invoice preserved) but flagged, never given fabricated tax.
export function evaluateCreditNoteTreatment() {
  return { treatmentStatus: 'PENDING_CONFIGURATION' };
}

export class InvoiceService {
  constructor({ repository = documentRepository, company = companyService, documents, resolution = taxResolutionService, calculation = taxCalculationService } = {}) {
    this.repository = repository;
    this.company = company;
    this.documents = documents || new DocumentService({ repository, company });
    this.resolution = resolution;
    this.calculation = calculation;
  }

  /** Establish the invoice identity + immutable snapshot. Blocked (no row, no number) when tax config is not READY. Idempotent. */
  async issueForOrder(orderId, { connection = null } = {}) {
    const run = async (c) => {
      const existing = await this.repository.invoiceByOrder(c, orderId);
      if (existing) return existing;

      const resolution = await this.resolution.resolveForOrder(c, orderId);
      if (resolution.status !== 'READY') {
        return { blocked: true, taxStatus: resolution.status, missing: resolution.missing };
      }

      const [order] = await exec(c, 'SELECT * FROM orders WHERE id = ? LIMIT 1', [orderId]);
      if (!order) throw new AppError('ORDER_NOT_FOUND', 'Order not found.', 404);
      const orderItems = await exec(c, 'SELECT * FROM order_items WHERE order_id = ? ORDER BY created_at, id', [orderId]);
      const discountByItem = allocateDiscount(orderItems, order.discount_minor);
      const netByItem = Object.fromEntries(orderItems.map((it) => [it.id, Number(it.line_total_minor) - discountByItem.get(it.id)]));
      const shipping = parse(order.shipping_address_snapshot);

      const calc = await this.calculation.compute(c, resolution.lines, netByItem, shipping, order.brand_id);
      const bySku = new Map(orderItems.map((it) => [it.id, it]));
      const lineItems = calc.items.map((l) => {
        const it = bySku.get(l.orderItemId);
        return {
          sku: l.sku, skuId: it?.sku_id || null,
          productName: l.productName, hsn: l.hsn, taxProfileId: l.taxProfileId, gstRateBps: l.gstRateBps, taxability: l.taxability,
          quantity: Number(it.quantity), unitPriceMinor: Number(it.unit_price_minor), discountMinor: discountByItem.get(it.id),
          taxableMinor: l.taxableMinor, taxMinor: l.taxMinor, totalMinor: l.totalMinor,
          imageUrl: parse(it.media_snapshot)?.url || null, color: it.selected_color || null, size: it.selected_size || null,
        };
      });

      const profile = await this.company.getProfile(order.brand_id, c);
      const fulfillments = await exec(c, "SELECT warehouse_snapshot_json FROM fulfillments WHERE order_id = ? AND fulfillment_type = 'INITIAL' ORDER BY sequence", [orderId]);
      const dispatch = fulfillments.length === 1 ? parse(fulfillments[0].warehouse_snapshot_json) : { multiOrigin: true, count: fulfillments.length };
      const subtotal = Number(order.subtotal_minor);
      const discount = Number(order.discount_minor || 0);
      const shippingMinor = Number(order.shipping_minor);
      const invoiceNumber = await this.repository.nextNumber(c, order.brand_id, 'INVOICE', 'INV');

      // GST is inside the prices, so the invoice total is what the order cost:
      // subtotal - discount + shipping (= orders.total_minor).
      const inv = await this.repository.insertInvoice(c, {
        orderId, invoiceNumber, currency: order.currency,
        supplier: profile
          ? { legalName: profile.legalName, tradeName: profile.tradeName, gstin: profile.gstin, address: profile.principalAddress, stateCode: profile.gstStateCode, stateName: profile.principalAddress?.state || null }
          : { legalName: 'CORCOTTON' },
        dispatch,
        billing: shipping,
        shipping,
        subtotalMinor: subtotal, discountMinor: discount, taxableMinor: calc.taxableMinor,
        cgstMinor: calc.cgstMinor, sgstMinor: calc.sgstMinor, igstMinor: calc.igstMinor,
        shippingMinor,
        grandTotalMinor: subtotal - discount + shippingMinor,
        onlinePaidMinor: Number(order.online_paid_minor), codDueMinor: Number(order.cod_due_minor),
        items: lineItems,
      });

      const doc = await this.documents.ensureInvoiceDocument(c, inv, this.#invoiceSnapshot(inv, lineItems, {
        orderNumber: order.order_number,
        placeOfSupply: calc.placeOfSupply,
        exchangeCreditMinor: Number(order.exchange_credit_applied_minor || 0),
      }));
      await this.repository.linkInvoiceDocument(c, inv.id, doc.id);
      return { ...inv, document_id: doc.id };
    };
    return connection ? run(connection) : withTransaction(run);
  }

  #invoiceSnapshot(inv, items, extras = {}) {
    return {
      documentType: 'INVOICE', invoiceNumber: inv.invoice_number, issuedAt: inv.issued_at,
      orderNumber: extras.orderNumber || null,
      placeOfSupply: extras.placeOfSupply || null,
      supplier: parse(inv.supplier_snapshot_json), dispatchFrom: parse(inv.dispatch_snapshot_json),
      billTo: parse(inv.billing_snapshot_json), shipTo: parse(inv.shipping_snapshot_json), currency: inv.currency,
      items: items.map((i) => ({
        sku: i.sku, productName: i.productName, hsn: i.hsn, gstRateBps: i.gstRateBps, quantity: i.quantity,
        unitPriceMinor: i.unitPriceMinor, discountMinor: i.discountMinor || 0, taxableMinor: i.taxableMinor, taxMinor: i.taxMinor, totalMinor: i.totalMinor,
        imageUrl: i.imageUrl || null, color: i.color || null, size: i.size || null,
      })),
      amounts: {
        subtotalMinor: Number(inv.subtotal_minor), discountMinor: Number(inv.discount_minor), taxableMinor: Number(inv.taxable_minor),
        cgstMinor: Number(inv.cgst_minor), sgstMinor: Number(inv.sgst_minor), igstMinor: Number(inv.igst_minor),
        shippingMinor: Number(inv.shipping_minor), grandTotalMinor: Number(inv.grand_total_minor),
        onlinePaidMinor: Number(inv.online_paid_minor), codDueMinor: Number(inv.cod_due_minor),
        exchangeCreditMinor: extras.exchangeCreditMinor || 0,
        pricesIncludeTax: true,
      },
    };
  }

  async issueCreditNoteForOrder(orderId, { reason = null, connection = null } = {}) {
    const run = async (c) => {
      const invoice = await this.repository.invoiceByOrder(c, orderId);
      if (!invoice) throw new AppError('INVOICE_NOT_FOUND', 'This order has no issued invoice to reverse.', 409);
      const existing = await this.repository.creditNoteByInvoice(c, invoice.id);
      if (existing) return existing;
      const treatment = evaluateCreditNoteTreatment();
      const creditNoteNumber = await this.repository.nextNumber(c, invoice.brand_id, 'CREDIT_NOTE', 'CN');
      const cn = await this.repository.insertCreditNote(c, {
        invoiceId: invoice.id, orderId, creditNoteNumber, amountMinor: Number(invoice.grand_total_minor), reason,
        treatmentStatus: treatment.treatmentStatus,
      });
      await this.repository.setInvoiceStatus(c, invoice.id, 'CANCELLED');
      const doc = await this.documents.ensureCreditNoteDocument(c, cn, {
        documentType: 'CREDIT_NOTE', creditNoteNumber, invoiceNumber: invoice.invoice_number,
        issuedAt: cn.issued_at, amountMinor: Number(invoice.grand_total_minor), reason,
        treatmentPending: treatment.treatmentStatus === 'PENDING_CONFIGURATION',
      });
      await this.repository.linkCreditNoteDocument(c, cn.id, doc.id);
      return { ...cn, document_id: doc.id };
    };
    return connection ? run(connection) : withTransaction(run);
  }

  async getForOrder(orderId) {
    const inv = await this.repository.invoiceByOrder(null, orderId);
    if (!inv) {
      // Distinguish "not issued yet" from "blocked on tax config".
      const [order] = [await query('SELECT order_status FROM orders WHERE id = ? LIMIT 1', [orderId]).then((r) => r[0])];
      if (order && ['CONFIRMED', 'PROCESSING', 'COMPLETED'].includes(order.order_status)) {
        const res = await this.resolution.resolveForOrder(null, orderId).catch(() => ({ status: 'INCOMPLETE', missing: [] }));
        if (res.status !== 'READY') return { blocked: true, taxStatus: res.status, missing: res.missing };
      }
      return null;
    }
    return { ...inv, items: await this.repository.invoiceItems(inv.id) };
  }
}

export const documentService = new DocumentService();
export const invoiceService = new InvoiceService({ documents: documentService });
