// Wave 8C-5 — document rendering, private storage, authenticated artefacts,
// tax-configuration gating, and immutability.
//
//   npm run verify:document-rendering
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.INVOICE_ITEM_IMAGES = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { warehouseService } = await import('../src/modules/warehouses/service.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { orderConfirmationService } = await import('../src/modules/orderOps/service.js');
const { documentService, invoiceService } = await import('../src/modules/documents/service.js');
const { documentStorage } = await import('../src/modules/documents/storage.js');
const { documentRepository } = await import('../src/modules/documents/repository.js');
const { printService } = await import('../src/modules/documents/printService.js');
const { taxProfileService, taxResolutionService } = await import('../src/modules/tax/service.js');

let net = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { net += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [], warehouses: [], taxProfiles: [], products: new Set() };
const [SUPER_BRAND] = await query("SELECT id FROM brands WHERE slug='corcotton'");
const SUPER = { id: (await query("SELECT id FROM staff_users WHERE role='SUPER_ADMIN' AND status='ACTIVE' LIMIT 1"))[0]?.id, role: 'SUPER_ADMIN', brandId: SUPER_BRAND.id };

async function buildConfirmedOrder(productSku, { warehouseId, place = null } = {}) {
  const customerId = randomUUID();
  created.customers.push(customerId);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),'RenderTest','T','ACTIVE',NOW(3))", [customerId]);
  const cartId = randomUUID();
  await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']);
  const rid = randomUUID();
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [rid, customerId, `r:${randomUUID()}`, '0'.repeat(64)]);
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,1)', [randomUUID(), rid, warehouseId, productSku.id]);
  const checkoutId = randomUUID();
  const subtotal = Number(productSku.price_minor || 50000);
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
               VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, rid, `co:${randomUUID()}`, 'f'.repeat(64), subtotal, subtotal]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const addr = { firstName: 'Render', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'Uttar Pradesh', postalCode: '226001', country: 'IN' };
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source${place ? ',placed_at' : ''})
               VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,?,?, 'RENDER_TEST'${place ? ',?' : ''})`,
    [orderId, `COR-RND-${tag}-${created.orders.length}`, checkoutId, customerId, rid, subtotal, subtotal, subtotal, JSON.stringify(addr), JSON.stringify({ serviceLevel: 'STANDARD' }), ...(place ? [place] : [])]);
  await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
               VALUES (?,?,?,?,?,?,?,1,?,?)`, [randomUUID(), orderId, productSku.product_id, productSku.variant_id, productSku.id, productSku.name, productSku.sku, subtotal, subtotal]);
  created.products.add(productSku.product_id);
  await fulfillmentService.ensureForOrder(orderId);
  await orderConfirmationService.confirm({ orderId });
  return { orderId, customerId };
}

async function mkProfile(hsn, bps, from = '2020-01-01', to = null) {
  const [corcotton] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const p = await taxProfileService.create({ name: `RND ${tag} ${hsn}`, hsnSac: hsn, taxability: 'TAXABLE', gstRateBps: bps, effectiveFrom: from, effectiveTo: to || undefined, brandId: corcotton.id });
  created.taxProfiles.push(p.id);
  return p;
}

try {
  const skus = await query(`SELECT s.id,s.sku,s.price_minor,v.id variant_id,p.id product_id,p.name FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 3`);
  const [skuA, skuB, skuC] = skus;
  const def = await warehouseService.getDefault();

  // ---- 1. Tax gate: missing config BLOCKS invoice, never zero tax ----
  const o1 = await buildConfirmedOrder(skuA, { warehouseId: def.id });
  assert.equal((await query('SELECT order_status FROM orders WHERE id=?', [o1.orderId]))[0].order_status, 'CONFIRMED', 'order still CONFIRMED without tax config');
  const inv1 = await invoiceService.getForOrder(o1.orderId);
  assert.equal(inv1.blocked, true);
  assert.equal(inv1.taxStatus, 'INCOMPLETE');
  assert.equal((await query('SELECT COUNT(*) n FROM invoices WHERE order_id=?', [o1.orderId]))[0].n, 0, 'no invoice row / number burned when blocked');
  results.taxGateIncomplete = 'PASS (CONFIRMED, invoice blocked, no zero-tax invoice)';

  // ---- 2. Tax retry -> issued once, snapshot frozen ----
  const pA = await mkProfile('61091000', 500);
  await taxProfileService.assignProduct(skuA.product_id, pA.id, null);
  const issued = await invoiceService.issueForOrder(o1.orderId);
  assert.ok(/^COR-INV-\d{4}-\d{6}$/.test(issued.invoice_number));
  const again = await invoiceService.issueForOrder(o1.orderId);
  assert.equal(again.invoice_number, issued.invoice_number, 'idempotent — same number');
  assert.equal((await query('SELECT COUNT(*) n FROM invoices WHERE order_id=?', [o1.orderId]))[0].n, 1);
  const it1 = (await query('SELECT gst_rate_bps, tax_minor FROM invoice_items WHERE invoice_id=?', [issued.id]))[0];
  assert.equal(Number(it1.gst_rate_bps), 500);
  results.taxRetry = 'PASS (issued once, per-line rate frozen)';

  // ---- 3. Real PDF artefact + private storage + integrity ----
  await documentService.renderPending(o1.orderId);
  const invDocId = (await query('SELECT document_id FROM invoices WHERE order_id=?', [o1.orderId]))[0].document_id;
  const invDoc = await documentService.get(invDocId);
  assert.equal(invDoc.status, 'READY');
  assert.ok(invDoc.storage_key && !/^https?:|\.\.|^\//.test(invDoc.storage_key), 'opaque private storage key');
  const s1 = await documentService.stream(invDocId);
  assert.ok(s1.bytes.length > 200 && s1.bytes.slice(0, 5).toString() === '%PDF-', 'valid non-empty PDF');
  assert.equal(s1.contentType, 'application/pdf');
  const s2 = await documentService.stream(invDocId);
  assert.ok(s1.bytes.equals(s2.bytes), 'download returns identical bytes');
  results.pdfArtefact = 'PASS (valid PDF, private key, integrity verified)';

  // ---- 4. Integrity failure detected ----
  const badBytes = Buffer.concat([s1.bytes, Buffer.from('TAMPER')]);
  await documentStorage.put(invDoc.storage_key, badBytes);
  await assert.rejects(() => documentService.stream(invDocId), (e) => e.code === 'DOCUMENT_INTEGRITY_FAILED');
  await documentStorage.put(invDoc.storage_key, s1.bytes); // restore
  results.integrityFailure = 'PASS (tampered artefact rejected)';

  // ---- 5. Render retry (failure -> FAILED -> retry -> READY, identity stable) ----
  const o5 = await buildConfirmedOrder(skuA, { warehouseId: def.id });
  await invoiceService.issueForOrder(o5.orderId);
  const d5 = (await query('SELECT document_id FROM invoices WHERE order_id=?', [o5.orderId]))[0].document_id;
  // orderConfirmationService.confirm() now renders the invoice itself, so the
  // document arrives here READY and render() would return it unchanged. Put it
  // back to PENDING_RENDER to exercise the retry path this section is about.
  await query("UPDATE documents SET snapshot_json = JSON_SET(snapshot_json, '$.__forceRenderFailure', true), status='PENDING_RENDER' WHERE id=?", [d5]);
  await assert.rejects(() => documentService.render(d5), (e) => e.code === 'DOCUMENT_RENDER_FAILED');
  assert.equal((await documentService.get(d5)).status, 'FAILED');
  const invNo5 = (await query('SELECT invoice_number FROM invoices WHERE order_id=?', [o5.orderId]))[0].invoice_number;
  await query("UPDATE documents SET snapshot_json = JSON_REMOVE(snapshot_json, '$.__forceRenderFailure') WHERE id=?", [d5]);
  const r5 = await documentService.render(d5);
  assert.equal(r5.status, 'READY');
  assert.equal(r5.id, d5, 'same document identity across retry');
  assert.equal((await query('SELECT invoice_number FROM invoices WHERE order_id=?', [o5.orderId]))[0].invoice_number, invNo5, 'invoice number unchanged');
  assert.equal((await query('SELECT COUNT(*) n FROM documents WHERE order_id=? AND document_type=\"INVOICE\"', [o5.orderId]))[0].n, 1);
  results.renderRetry = 'PASS';

  // ---- 6. Storage retry ----
  const o6 = await buildConfirmedOrder(skuA, { warehouseId: def.id });
  await invoiceService.issueForOrder(o6.orderId);
  const d6 = (await query('SELECT document_id FROM invoices WHERE order_id=?', [o6.orderId]))[0].document_id;
  // Same: confirm() already rendered it, so reset before injecting the failure.
  await query("UPDATE documents SET status='PENDING_RENDER' WHERE id=?", [d6]);
  const realPut = documentStorage.put.bind(documentStorage);
  documentStorage.put = async () => { throw Object.assign(new Error('injected storage failure'), { code: 'DOCUMENT_STORAGE_FAILED' }); };
  try {
    await assert.rejects(() => documentService.render(d6), (e) => e.code === 'DOCUMENT_STORAGE_FAILED');
  } finally { documentStorage.put = realPut; }
  assert.equal((await documentService.get(d6)).status, 'FAILED');
  assert.equal((await documentService.render(d6)).status, 'READY');
  assert.equal((await query('SELECT COUNT(*) n FROM documents WHERE order_id=? AND document_type=\"INVOICE\"', [o6.orderId]))[0].n, 1);
  results.storageRetry = 'PASS';

  // ---- 7. Print real artefact + reprint ----
  const st = await printService.createStation(SUPER, { warehouseId: def.id, name: `RND Desk ${tag}` });
  const a4 = await printService.createPrinter(SUPER, { printStationId: st.id, name: 'A4', printerType: 'A4_PDF' });
  const job1 = await printService.queueJob(SUPER, { documentId: invDocId, printerId: a4.id });
  assert.equal(job1.status, 'PRINTED');
  assert.ok(job1.artefactBytes > 200, 'print consumed real artefact bytes');
  const job2 = await printService.queueJob(SUPER, { documentId: invDocId, printerId: a4.id });
  assert.notEqual(job2.id, job1.id, 'reprint is a new job');
  assert.equal((await query('SELECT COUNT(*) n FROM documents WHERE id=?', [invDocId]))[0].n, 1, 'reprint reuses the same document');
  results.printArtefact = 'PASS (real bytes, reprint reuses canonical document)';

  // ---- 8. Ambiguity gate ----
  const dupA = await mkProfile('99999999', 500);
  const dupB = await mkProfile('99999999', 1200);
  void dupB;
  await taxProfileService.assignProduct(skuB.product_id, dupA.id, null);
  const o8 = await buildConfirmedOrder(skuB, { warehouseId: def.id });
  const res8 = await taxResolutionService.resolveForOrder(null, o8.orderId);
  assert.equal(res8.status, 'AMBIGUOUS');
  assert.equal((await invoiceService.issueForOrder(o8.orderId)).blocked, true);
  results.taxAmbiguity = 'PASS (conflicting same-HSN config => AMBIGUOUS, no guessed invoice)';

  // ---- 9. Effective dating + historical tax immutability ----
  const futureProfile = await mkProfile('61091000', 1200, '2099-01-01');
  await taxProfileService.assignProduct(skuA.product_id, futureProfile.id, null); // remap A's product to a NOT-yet-effective profile
  const it1b = (await query('SELECT gst_rate_bps FROM invoice_items WHERE invoice_id=?', [issued.id]))[0];
  assert.equal(Number(it1b.gst_rate_bps), 500, 'historical invoice keeps its original 5% after remap');
  await taxProfileService.assignProduct(skuA.product_id, pA.id, null); // restore
  results.effectiveDating = 'PASS (issued invoice tax snapshot immutable)';

  // ---- 10. Company + product immutability ----
  const before = (await documentService.stream(invDocId)).bytes;
  const beforeHash = (await documentService.get(invDocId)).sha256;
  await query("UPDATE products SET name = CONCAT(name, ' X') WHERE id=?", [skuA.product_id]);
  await query('UPDATE company_profiles SET trade_name = ? WHERE brand_id = ?', ['CHANGED', SUPER_BRAND.id]);
  const after = (await documentService.stream(invDocId)).bytes;
  assert.ok(before.equals(after) && beforeHash === (await documentService.get(invDocId)).sha256, 'invoice artefact unchanged after product/company edits');
  await query('UPDATE company_profiles SET trade_name = ? WHERE brand_id = ?', ['M/S CORCOTTON', SUPER_BRAND.id]);
  await query("UPDATE products SET name = TRIM(TRAILING ' X' FROM name) WHERE id=?", [skuA.product_id]);
  results.immutability = 'PASS';

  // ---- 11. Invoice thumbnails: best-effort, Cloudinary only, never fatal ----
  {
    const { loadInvoiceImages, invoiceThumbnailUrl } = await import('../src/modules/documents/invoiceImages.js');
    const { buildInvoicePdf } = await import('../src/modules/documents/invoicePdf.js');
    const [row] = await query('SELECT snapshot_json FROM documents WHERE id=?', [invDocId]);
    const snap = typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) : row.snapshot_json;
    assert.equal(snap.amounts.pricesIncludeTax, true, 'snapshot records GST-inclusive prices');
    assert.deepEqual(snap.placeOfSupply, { state: 'Uttar Pradesh', code: '09' }, 'snapshot records the place of supply');

    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');
    const photo = 'https://res.cloudinary.com/demo/image/upload/v1/products/tee.png';
    const requested = [];
    const fetchImpl = async (url) => { requested.push(url); return { ok: true, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => PNG }; };
    // Seeded catalogue media can be a CSS gradient, not a URL: it must be skipped.
    const withPhoto = { ...snap, items: [{ ...snap.items[0], imageUrl: photo }, { ...snap.items[0], sku: 'GRADIENT', imageUrl: 'linear-gradient(to bottom, #000, #fff)' }] };

    const images = await loadInvoiceImages(withPhoto, { fetchImpl, enabled: true });
    assert.deepEqual(requested, [invoiceThumbnailUrl(photo)], 'only the Cloudinary photo is fetched');
    assert.ok(requested[0].includes('/image/upload/c_fill,w_120,h_120,f_jpg,q_80/'), 'fetched as a small thumbnail');
    assert.equal(images.get(photo)?.length, PNG.length);
    assert.equal((await loadInvoiceImages(withPhoto, { fetchImpl, enabled: false })).size, 0, 'INVOICE_ITEM_IMAGES=false loads nothing');
    const offline = await loadInvoiceImages(withPhoto, { fetchImpl: async () => { throw new Error('offline'); }, enabled: true });
    assert.equal(offline.size, 0, 'an unreachable image is skipped, not fatal');

    const pdfWith = await buildInvoicePdf(withPhoto, { images });
    const pdfWithout = await buildInvoicePdf(withPhoto, { images: new Map() });
    assert.equal(pdfWith.subarray(0, 5).toString(), '%PDF-');
    assert.ok(/\/Subtype \/Image/.test(pdfWith.toString('latin1')), 'thumbnail embedded in the PDF');
    assert.ok(!/\/Subtype \/Image/.test(pdfWithout.toString('latin1')), 'no image embedded without a thumbnail');
    results.invoiceThumbnails = 'PASS (Cloudinary thumbnail only, gradient skipped, failure non-fatal)';
  }

  assert.equal(net, 0);
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nDOCUMENT_RENDERING_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nDOCUMENT_RENDERING_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('UPDATE company_profiles SET trade_name = ? WHERE brand_id = ?', ['M/S CORCOTTON', SUPER_BRAND.id]));
  for (const orderId of created.orders) {
    for (const k of await query('SELECT storage_key FROM documents WHERE order_id=? AND storage_key IS NOT NULL', [orderId])) {
      await documentStorage.remove(k.storage_key).catch(() => {});
    }
    await safe(() => query('DELETE FROM print_jobs WHERE document_id IN (SELECT id FROM documents WHERE order_id=?)', [orderId]));
    await safe(() => query('DELETE ii FROM invoice_items ii JOIN invoices i ON i.id=ii.invoice_id WHERE i.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM credit_notes WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM invoices WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM documents WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE se FROM shipment_events se JOIN shipments s ON s.id=se.shipment_id JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM order_items WHERE order_id=?', [orderId]));
    const chk = (await query('SELECT checkout_id, inventory_reservation_id FROM orders WHERE id=?', [orderId]))[0];
    await safe(() => query('DELETE FROM orders WHERE id=?', [orderId]));
    if (chk) {
      await safe(() => query('DELETE FROM checkout_sessions WHERE id=?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [chk.inventory_reservation_id]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [chk.inventory_reservation_id]));
    }
  }
  for (const cid of created.customers) { await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid])); await safe(() => query('DELETE FROM customers WHERE id=?', [cid])); }
  for (const pid of created.products) await safe(() => query('DELETE FROM product_tax_profiles WHERE product_id=?', [pid]));
  for (const tp of created.taxProfiles) await safe(() => query('DELETE FROM tax_profiles WHERE id=?', [tp]));
  await safe(() => query("DELETE p FROM printers p JOIN print_stations st ON st.id=p.print_station_id WHERE st.name LIKE ?", [`RND Desk ${tag}`]));
  await safe(() => query("DELETE FROM print_stations WHERE name LIKE ?", [`RND Desk ${tag}`]));
  await safe(() => query("DELETE FROM document_counters WHERE name IN ('INVOICE','CREDIT_NOTE') AND value=0"));
  await pool.end();
}
