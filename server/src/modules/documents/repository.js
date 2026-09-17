import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? await connection.execute(sql, params) : [await query(sql, params)])[0];

export class DocumentRepository {
  // Multi-company (DESIGN.md §9 risk: "Invoice numbering / GST identity
  // bleeds") — the counter row itself is per-(brand_id, name) now
  // (migration 082): each company's invoice/credit-note sequence starts
  // and runs completely independently, a real GST requirement not just a
  // technical one. `prefix` is no longer a caller-supplied literal
  // ("COR-INV"/"COR-CN") — derived here from the brand's own order_prefix
  // (migration 081), so Cor-Znix numbers never read "COR-...".
  async nextNumber(connection, brandId, name, docSuffix) {
    const [brandRow] = await exec(connection, 'SELECT order_prefix FROM brands WHERE id = ?', [brandId]);
    const prefix = `${brandRow?.order_prefix || 'ORD'}-${docSuffix}`;
    await exec(connection, 'INSERT INTO document_counters (brand_id, name, value) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE name = name', [brandId, name]);
    await exec(connection, 'UPDATE document_counters SET value = value + 1 WHERE brand_id = ? AND name = ?', [brandId, name]);
    const [row] = await exec(connection, 'SELECT value FROM document_counters WHERE brand_id = ? AND name = ? FOR UPDATE', [brandId, name]);
    return `${prefix}-${new Date().getFullYear()}-${String(row.value).padStart(6, '0')}`;
  }

  findDocument(connection, { type, orderId = null, fulfillmentId = null, shipmentId = null, version = 1 }) {
    const key = `${type}:${shipmentId || fulfillmentId || orderId || ''}:${version}`;
    return exec(connection, 'SELECT * FROM documents WHERE dedupe_key = ? LIMIT 1', [key]).then((r) => r[0] || null);
  }

  documentById(id) {
    return query('SELECT * FROM documents WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);
  }

  documentsForOrder(orderId, { types = null } = {}) {
    const filter = types ? ` AND document_type IN (${types.map(() => '?').join(',')})` : '';
    return query(`SELECT * FROM documents WHERE order_id = ?${filter} ORDER BY created_at`, [orderId, ...(types || [])]);
  }

  async insertDocument(connection, d) {
    const id = randomUUID();
    // Every document type resolves an orderId before reaching here (see
    // DocumentService#ensure* callers) — derive brand_id from that order,
    // same pattern as invoices/credit_notes.
    await exec(connection,
      `INSERT INTO documents (id, brand_id, document_type, order_id, fulfillment_id, shipment_id, warehouse_id, status, format, snapshot_json, sha256, created_by_staff_id)
       VALUES (?, (SELECT brand_id FROM orders WHERE id = ?), ?, ?, ?, ?, ?, 'PENDING_RENDER', ?, ?, ?, ?)`,
      [id, d.orderId || null, d.type, d.orderId || null, d.fulfillmentId || null, d.shipmentId || null, d.warehouseId || null,
        d.format || 'PENDING', JSON.stringify(d.snapshot), d.sha256 || '', d.staffId || null]);
    return exec(connection, 'SELECT * FROM documents WHERE id = ?', [id]).then((r) => r[0]);
  }

  documentById2(connection, id) {
    return exec(connection, 'SELECT * FROM documents WHERE id = ? LIMIT 1 FOR UPDATE', [id]).then((r) => r[0] || null);
  }

  setDocumentStatus(connection, id, status, extra = {}) {
    const sets = ['status = ?', 'updated_at = NOW(3)'];
    const params = [status];
    for (const [k, v] of Object.entries(extra)) { sets.push(`${k} = ?`); params.push(v); }
    params.push(id);
    return exec(connection, `UPDATE documents SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  pendingDocumentsForOrder(orderId) {
    return query("SELECT * FROM documents WHERE order_id = ? AND status IN ('PENDING_RENDER','FAILED','RENDERING')", [orderId]);
  }

  linkInvoiceDocument(connection, invoiceId, documentId) {
    return exec(connection, 'UPDATE invoices SET document_id = ?, updated_at = NOW(3) WHERE id = ?', [documentId, invoiceId]);
  }

  linkCreditNoteDocument(connection, creditNoteId, documentId) {
    return exec(connection, 'UPDATE credit_notes SET document_id = ? WHERE id = ?', [documentId, creditNoteId]);
  }

  // ---- invoices ----
  invoiceByOrder(connection, orderId) {
    return exec(connection, 'SELECT * FROM invoices WHERE order_id = ? LIMIT 1', [orderId]).then((r) => r[0] || null);
  }

  invoiceItems(invoiceId) {
    return query('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY id', [invoiceId]);
  }

  // Multi-company (DESIGN.md §9 risk: "Invoice numbering / GST identity
  // bleeds") — brand_id derived from the order's own row, never a separate
  // caller-supplied value: an invoice can never disagree with its order's
  // company.
  async insertInvoice(connection, inv) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO invoices (id, brand_id, order_id, invoice_number, currency, tax_status, issue_status, supplier_snapshot_json, dispatch_snapshot_json,
         billing_snapshot_json, shipping_snapshot_json, subtotal_minor, discount_minor, taxable_minor,
         cgst_minor, sgst_minor, igst_minor, shipping_minor, grand_total_minor, online_paid_minor, cod_due_minor)
       VALUES (?, (SELECT brand_id FROM orders WHERE id = ?), ?, ?, ?, 'READY', 'ISSUED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, inv.orderId, inv.orderId, inv.invoiceNumber, inv.currency, JSON.stringify(inv.supplier), JSON.stringify(inv.dispatch || null),
        JSON.stringify(inv.billing), JSON.stringify(inv.shipping), inv.subtotalMinor, inv.discountMinor, inv.taxableMinor,
        inv.cgstMinor, inv.sgstMinor, inv.igstMinor, inv.shippingMinor, inv.grandTotalMinor, inv.onlinePaidMinor, inv.codDueMinor]);
    for (const li of inv.items) {
      await exec(connection,
        `INSERT INTO invoice_items (id, invoice_id, sku, sku_id, product_name, hsn_sac, tax_profile_id, gst_rate_bps, taxability, quantity, unit_price_minor, discount_minor, taxable_minor, tax_minor, total_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), id, li.sku, li.skuId || null, li.productName, li.hsn || null, li.taxProfileId || null, li.gstRateBps ?? null, li.taxability || null,
          li.quantity, li.unitPriceMinor, li.discountMinor, li.taxableMinor, li.taxMinor, li.totalMinor]);
    }
    return exec(connection, 'SELECT * FROM invoices WHERE id = ?', [id]).then((r) => r[0]);
  }

  setInvoiceStatus(connection, id, status) {
    return exec(connection, 'UPDATE invoices SET status = ?, updated_at = NOW(3) WHERE id = ?', [status, id]);
  }

  creditNoteByInvoice(connection, invoiceId) {
    return exec(connection, 'SELECT * FROM credit_notes WHERE invoice_id = ? LIMIT 1', [invoiceId]).then((r) => r[0] || null);
  }

  // brand_id derived from the invoice it reverses — same reasoning as invoices.
  async insertCreditNote(connection, cn) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO credit_notes (id, brand_id, invoice_id, order_id, credit_note_number, amount_minor, reason, treatment_status)
       VALUES (?, (SELECT brand_id FROM invoices WHERE id = ?), ?, ?, ?, ?, ?, ?)`,
      [id, cn.invoiceId, cn.invoiceId, cn.orderId, cn.creditNoteNumber, cn.amountMinor, cn.reason || null, cn.treatmentStatus || 'ISSUED']);
    return exec(connection, 'SELECT * FROM credit_notes WHERE id = ?', [id]).then((r) => r[0]);
  }

  // ---- print stations / printers / jobs ----
  // Phase 6 security pass (DESIGN.md §5.3) — brandId is now REQUIRED
  // wherever a station/printer is read or mutated by id, filtered at the
  // SQL level so a cross-brand id 404s regardless of any warehouse-
  // assignment scope layered on top (defense in depth, same pattern as
  // adminWarehouses' #assertAccess).
  stations(brandId) { return query('SELECT * FROM print_stations WHERE brand_id = ? ORDER BY name', [brandId]); }
  station(id, brandId) { return query('SELECT * FROM print_stations WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]).then((r) => r[0] || null); }
  async createStation({ warehouseId, name }) {
    const id = randomUUID();
    await query(
      'INSERT INTO print_stations (id, brand_id, warehouse_id, name) VALUES (?, (SELECT brand_id FROM warehouses WHERE id = ?), ?, ?)',
      [id, warehouseId, warehouseId, name]);
    return query('SELECT * FROM print_stations WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);
  }
  updateStation(id, brandId, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`);
    return query(`UPDATE print_stations SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ? AND brand_id = ?`, [...Object.values(fields), id, brandId]).then(() => this.station(id, brandId));
  }
  printers(stationId, brandId) { return query('SELECT * FROM printers WHERE print_station_id = ? AND brand_id = ? ORDER BY name', [stationId, brandId]); }
  printer(id, brandId) {
    return query(
      `SELECT p.*, s.warehouse_id, s.status AS station_status FROM printers p JOIN print_stations s ON s.id = p.print_station_id WHERE p.id = ? AND p.brand_id = ? LIMIT 1`,
      [id, brandId]).then((r) => r[0] || null);
  }
  async createPrinter({ printStationId, name, printerType, labelSize }) {
    const id = randomUUID();
    await query(
      'INSERT INTO printers (id, brand_id, print_station_id, name, printer_type, label_size) VALUES (?, (SELECT brand_id FROM print_stations WHERE id = ?), ?, ?, ?, ?)',
      [id, printStationId, printStationId, name, printerType || 'A4_PDF', labelSize || null]);
    return query('SELECT * FROM printers WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null);
  }
  updatePrinter(id, brandId, fields) {
    const sets = Object.keys(fields).map((k) => `${k} = ?`);
    return query(`UPDATE printers SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ? AND brand_id = ?`, [...Object.values(fields), id, brandId]).then(() => this.printer(id, brandId));
  }

  async createJob({ documentId, printerId, printStationId, staffId, copies }) {
    const id = randomUUID();
    await query('INSERT INTO print_jobs (id, document_id, printer_id, print_station_id, requested_by_staff_id, copies) VALUES (?, ?, ?, ?, ?, ?)',
      [id, documentId, printerId, printStationId, staffId || null, copies || 1]);
    return this.job(id);
  }
  job(id) { return query('SELECT * FROM print_jobs WHERE id = ? LIMIT 1', [id]).then((r) => r[0] || null); }
  jobs({ stationId = null, status = null } = {}) {
    const w = [];
    const p = [];
    if (stationId) { w.push('print_station_id = ?'); p.push(stationId); }
    if (status) { w.push('status = ?'); p.push(status); }
    return query(`SELECT * FROM print_jobs ${w.length ? `WHERE ${w.join(' AND ')}` : ''} ORDER BY created_at DESC LIMIT 200`, p);
  }
  setJobStatus(id, status, extra = {}) {
    const sets = ['status = ?', ...Object.keys(extra).map((k) => `${k} = ?`)];
    return query(`UPDATE print_jobs SET ${sets.join(', ')} WHERE id = ?`, [status, ...Object.values(extra), id]);
  }
}

export const documentRepository = new DocumentRepository();
