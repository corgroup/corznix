// Documents, invoices, credit notes + printing verification.
//
// Invoice issued (immutable, unique number, survives cancel), packing slip +
// shipping label generated internally and never exposed to customers, print
// jobs queued against warehouse-scoped stations. No real carrier / storage.
//
//   npm run verify:documents
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.SHIPPING_PROVIDER_MODE = 'MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.INVOICE_ITEM_IMAGES = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { splitInclusive } = await import('../src/modules/tax/rateBands.js');
const { warehouseService } = await import('../src/modules/warehouses/service.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { orderConfirmationService, shipmentBookingService } = await import('../src/modules/orderOps/service.js');
const { documentService, invoiceService, CUSTOMER_DOCUMENT_TYPES } = await import('../src/modules/documents/service.js');
const { printService } = await import('../src/modules/documents/printService.js');
const { taxProfileService } = await import('../src/modules/tax/service.js');

let net = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { net += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [], warehouses: [], reservations: [] };
const [SUPER_BRAND] = await query("SELECT id FROM brands WHERE slug='corcotton'");
const SUPER = { id: (await query("SELECT id FROM staff_users WHERE role='SUPER_ADMIN' AND status='ACTIVE' LIMIT 1"))[0]?.id, role: 'SUPER_ADMIN', brandId: SUPER_BRAND.id };

async function buildOrder(warehouseIds, sku, { paymentMode = 'FULL_COD', state = 'UP', unitPriceMinor = null, discountMinor = 0 } = {}) {
  const customerId = randomUUID();
  created.customers.push(customerId);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),'DocTest','T','ACTIVE',NOW(3))", [customerId]);
  const cartId = randomUUID();
  await query("INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,?)", [cartId, customerId, 'INR']);
  const reservationId = randomUUID();
  // Recorded before the order exists: a fixture insert failing part-way used to
  // leave this reservation behind, because cleanup only found it through orders.
  created.reservations.push(reservationId);
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
               VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [reservationId, customerId, `doc:${randomUUID()}`, '0'.repeat(64)]);
  for (const w of warehouseIds) {
    await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,1)', [randomUUID(), reservationId, w, sku.id]);
  }
  const checkoutId = randomUUID();
  const unitPrice = unitPriceMinor ?? Number(sku.price_minor || 50000);
  const subtotal = unitPrice * warehouseIds.length;
  const total = subtotal - discountMinor;
  const cod = paymentMode === 'PREPAID' ? 0 : total;
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,subtotal_minor,discount_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
               VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,?,?,?,?, 'FINALIZED','INR', ?,?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `doc:co:${randomUUID()}`, 'f'.repeat(64), subtotal, discountMinor, total]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const city = state === 'Delhi' ? 'New Delhi' : 'Lucknow';
  const addr = { firstName: 'Doc', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city, state, postalCode: state === 'Delhi' ? '110001' : '226001', country: 'IN' };
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,subtotal_minor,discount_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
               VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),?,?,?,?,?,?, 'INR', ?,?,0,?,?,?,?,?, 'DOC_TEST')`,
    [orderId, `COR-DOC-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId, cod > 0 ? 'COD_DUE' : 'PAID', paymentMode, subtotal, discountMinor, total, total - cod, cod, JSON.stringify(addr), JSON.stringify({ serviceLevel: 'STANDARD' })]);
  await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
               VALUES (?,?,?,?,?,?,?,?,?,?)`, [randomUUID(), orderId, sku.product_id, sku.variant_id, sku.id, sku.name, sku.sku, warehouseIds.length, unitPrice, subtotal]);
  await fulfillmentService.ensureForOrder(orderId);
  await query(`UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id SET s.status='READY_TO_BOOK', s.booking_status='READY',
               s.package_snapshot_json=JSON_OBJECT('weightGrams',500) WHERE f.order_id=?`, [orderId]);
  return { orderId, customerId };
}

const shipmentsOf = (o) => query(`SELECT s.id, f.warehouse_id FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?`, [o]);
const fulfillmentsOf = (o) => query("SELECT id, warehouse_id FROM fulfillments WHERE order_id=? AND fulfillment_type='INITIAL'", [o]);

try {
  const sku = (await query(`SELECT s.id,s.sku,s.price_minor,v.id variant_id,p.id product_id,p.name FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 1`))[0];
  const def = await warehouseService.getDefault();
  const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const lko = await warehouseService.create({ code: `WH-DOC-${tag}`, name: 'Doc LKO', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN', priority: 5, brandId: cottonBrand.id });
  created.warehouses.push(lko.id);

  // Synthetic tax profile for the test SKU's product (torn down in finally).
  const [corcotton] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const taxProfile = await taxProfileService.create({ name: `DOC TEST ${tag}`, hsnSac: '61091000', taxability: 'TAXABLE', gstRateBps: 500, effectiveFrom: '2020-01-01', brandId: corcotton.id });
  created.taxProfileId = taxProfile.id;
  // The finally block used to DELETE this product's tax assignment outright, so a
  // run against a store wiped whatever profile the product really had. The prior
  // assignment is recorded and put back instead.
  const priorAssignment = async (productId) => (await query('SELECT tax_profile_id FROM product_tax_profiles WHERE product_id=?', [productId]))[0]?.tax_profile_id ?? null;
  created.restoreTaxAssignments = [{ productId: sku.product_id, priorTaxProfileId: await priorAssignment(sku.product_id) }];
  await taxProfileService.assignProduct(sku.product_id, taxProfile.id, null);
  created.productId = sku.product_id;

  // ---- 0. tax configuration gaps list live products, not only ordered ones ----
  // The CMS list used to read only products already inside a confirmed order, so
  // an ACTIVE product with no usable profile showed "No configuration gaps" until
  // its first invoice was blocked.
  {
    const [gapProduct] = await query("SELECT id FROM products WHERE brand_id=? AND status='ACTIVE' ORDER BY id LIMIT 1", [corcotton.id]);
    assert.ok(gapProduct, 'need an ACTIVE product (run the seed)');
    if (gapProduct.id !== sku.product_id) created.restoreTaxAssignments.push({ productId: gapProduct.id, priorTaxProfileId: await priorAssignment(gapProduct.id) });
    const productGap = async () => (await taxProfileService.configurationGaps(corcotton.id)).find((g) => g.product_id === gapProduct.id && !g.order_id);

    await taxProfileService.unassignProduct(gapProduct.id);
    assert.equal((await productGap())?.reason, 'NO_TAX_PROFILE', 'an ACTIVE product with no profile is listed before any order');
    await taxProfileService.assignProduct(gapProduct.id, taxProfile.id, null);
    assert.equal(await productGap(), undefined, 'an effective profile clears the gap');
    await query("UPDATE tax_profiles SET effective_to='2020-06-01' WHERE id=?", [taxProfile.id]);
    assert.equal((await productGap())?.reason, 'TAX_PROFILE_NOT_EFFECTIVE', 'a profile that has ended is listed');
    await query('UPDATE tax_profiles SET effective_to=NULL WHERE id=?', [taxProfile.id]);
    const [otherBrand] = await query("SELECT id FROM brands WHERE slug<>'corcotton' LIMIT 1");
    if (otherBrand) assert.ok(!(await taxProfileService.configurationGaps(otherBrand.id)).some((g) => g.product_id === gapProduct.id), 'gaps stay within the brand');
    // The invoice sections below need the test SKU's product on the synthetic profile.
    if (gapProduct.id === sku.product_id) await taxProfileService.assignProduct(gapProduct.id, taxProfile.id, null);
    results.taxConfigurationGaps = 'PASS';
  }

  // ---- 1. Confirm -> invoice + packing slips ----
  const o1 = await buildOrder([def.id, lko.id], sku);
  await orderConfirmationService.confirm({ orderId: o1.orderId });
  await documentService.renderPending(o1.orderId);
  const inv = await invoiceService.getForOrder(o1.orderId);
  assert.ok(inv && /^COR-INV-\d{4}-\d{6}$/.test(inv.invoice_number), `invoice number: ${inv?.invoice_number}`);
  assert.equal(inv.tax_status, 'READY');
  assert.equal(inv.items.length, 1);
  assert.equal(Number(inv.items[0].gst_rate_bps), 500, 'per-line GST rate snapshot');
  // Store prices include GST, so GST is taken out of what the customer paid.
  // It used to be added on top and the invoice total never matched the order.
  const tax = Number(inv.cgst_minor) + Number(inv.sgst_minor) + Number(inv.igst_minor);
  const inclusive = splitInclusive(Number(inv.subtotal_minor), 500);
  assert.equal(Number(inv.taxable_minor), inclusive.taxableMinor, 'taxable value taken out of the GST-inclusive price');
  assert.equal(tax, inclusive.taxMinor, '5% GST inside the price');
  assert.equal(Number(inv.taxable_minor) + tax, Number(inv.subtotal_minor), 'taxable value + GST = amount paid for the goods');
  assert.equal(Number(inv.grand_total_minor), Number(inv.subtotal_minor) + Number(inv.shipping_minor), 'invoice total = order total');
  assert.equal(Number(inv.igst_minor), 0, 'an Uttar Pradesh delivery from an Uttar Pradesh supplier is intra-state (CGST + SGST)');
  const docs = await documentService.listForOrder(o1.orderId);
  assert.equal(docs.filter((d) => d.type === 'INVOICE' && d.status === 'READY').length, 1, 'invoice PDF rendered');
  assert.equal(docs.filter((d) => d.type === 'PACKING_SLIP' && d.status === 'READY').length, 2, 'one rendered packing slip per fulfilment');
  results.invoiceAndPackingSlips = 'PASS';

  // ---- 1b. price bands, order discount and place of supply ----
  // A banded profile picks the rate from each piece's taxable value after its
  // share of the order discount. A Delhi delivery from Uttar Pradesh is IGST.
  {
    await taxProfileService.update(taxProfile.id, { rateBands: [{ maxUnitTaxableMinor: 250000, gstRateBps: 500 }, { maxUnitTaxableMinor: null, gstRateBps: 1800 }] });
    assert.equal((await taxProfileService.get(taxProfile.id)).rateBands.length, 2, 'bands saved on the profile');
    const issue = async (opts) => {
      const o = await buildOrder([def.id], sku, { paymentMode: 'PREPAID', ...opts });
      await orderConfirmationService.confirm({ orderId: o.orderId });
      const [invoice] = await query('SELECT * FROM invoices WHERE order_id=?', [o.orderId]);
      assert.ok(invoice, 'invoice issued on confirmation');
      const [item] = await query('SELECT gst_rate_bps, taxable_minor, tax_minor, total_minor FROM invoice_items WHERE invoice_id=?', [invoice.id]);
      const [doc] = await query('SELECT snapshot_json FROM documents WHERE id=?', [invoice.document_id]);
      const snap = typeof doc.snapshot_json === 'string' ? JSON.parse(doc.snapshot_json) : doc.snapshot_json;
      return { invoice, item, snap };
    };

    // Rs 3,000 a piece: taxable Rs 2,857 at 5% is above Rs 2,500, so 18% applies.
    const high = await issue({ state: 'Delhi', unitPriceMinor: 300000 });
    assert.equal(Number(high.item.gst_rate_bps), 1800, 'above the band limit -> 18%');
    assert.deepEqual({ taxable: Number(high.invoice.taxable_minor), igst: Number(high.invoice.igst_minor) }, { taxable: 254237, igst: 45763 }, '18% taken out of Rs 3,000');
    assert.equal(Number(high.invoice.cgst_minor) + Number(high.invoice.sgst_minor), 0, 'inter-state: no CGST/SGST');
    assert.equal(Number(high.invoice.grand_total_minor), 300000, 'invoice total = amount paid');
    assert.deepEqual(high.snap.placeOfSupply, { state: 'Delhi', code: '07' }, 'place of supply with GST state code');
    assert.equal(high.snap.amounts.pricesIncludeTax, true);

    // The same piece with a Rs 500 order discount costs Rs 2,500: back in the 5% band.
    const discounted = await issue({ state: 'Delhi', unitPriceMinor: 300000, discountMinor: 50000 });
    assert.equal(Number(discounted.item.gst_rate_bps), 500, 'the discount moves the piece into the 5% band');
    assert.deepEqual({ taxable: Number(discounted.invoice.taxable_minor), igst: Number(discounted.invoice.igst_minor) }, { taxable: 238095, igst: 11905 }, '5% taken out of Rs 2,500');
    assert.equal(Number(discounted.invoice.grand_total_minor), 250000, 'invoice total = subtotal - discount');
    assert.equal(discounted.snap.items[0].discountMinor, 50000, 'line carries its share of the discount');

    // Rs 2,625 at 5% is exactly Rs 2,500 taxable: the limit is inclusive. Uttar Pradesh splits CGST/SGST.
    const edge = await issue({ state: 'Uttar Pradesh', unitPriceMinor: 262500 });
    assert.equal(Number(edge.item.gst_rate_bps), 500, 'taxable value equal to the limit stays in the band');
    assert.deepEqual([Number(edge.invoice.cgst_minor), Number(edge.invoice.sgst_minor), Number(edge.invoice.igst_minor)], [6250, 6250, 0], 'intra-state CGST + SGST');
    assert.deepEqual(edge.snap.placeOfSupply, { state: 'Uttar Pradesh', code: '09' });

    await taxProfileService.update(taxProfile.id, { rateBands: [] });
    const cleared = await taxProfileService.get(taxProfile.id);
    assert.equal(cleared.rateBands.length, 0, 'bands removed');
    assert.equal(Number(cleared.gst_rate_bps), 500, 'single rate kept after removing bands');
    results.priceBandsAndPlaceOfSupply = 'PASS (18% above limit, discount moves band, limit inclusive, IGST vs CGST/SGST)';
  }

  // ---- 2. idempotency ----
  await orderConfirmationService.confirm({ orderId: o1.orderId });
  const f1 = (await fulfillmentsOf(o1.orderId))[0];
  await documentService.ensurePackingSlip(null, f1.id);
  const docs2 = await documentService.listForOrder(o1.orderId);
  assert.equal(docs2.length, docs.length, 'no duplicate documents on repeat');
  results.idempotentGeneration = 'PASS';

  // ---- 3. customer visibility ----
  const custDocs = await documentService.listForOrder(o1.orderId, { customerScope: true });
  assert.ok(custDocs.every((d) => CUSTOMER_DOCUMENT_TYPES.includes(d.type)), 'customer sees only invoice/credit-note');
  assert.equal(custDocs.filter((d) => d.type === 'PACKING_SLIP').length, 0);
  const slip = await documentService.get(docs.find((d) => d.type === 'PACKING_SLIP').id);
  assert.throws(() => documentService.assertCustomerAllowed(slip), (e) => e.code === 'DOCUMENT_ACCESS_DENIED');
  results.customerVisibility = 'PASS (packing slip / label never customer-visible)';

  // ---- 4. book -> shipping label ----
  await orderConfirmationService.startProcessing({ orderId: o1.orderId });
  const shp = (await shipmentsOf(o1.orderId)).find((s) => s.warehouse_id === def.id);
  await shipmentBookingService.book({ shipmentId: shp.id, idempotencyKey: `doc:book:${shp.id}` });
  await documentService.renderPending(o1.orderId);
  const afterBook = await documentService.listForOrder(o1.orderId);
  assert.equal(afterBook.filter((d) => d.type === 'SHIPPING_LABEL' && d.status === 'READY').length, 1, 'label generated + rendered on booking');
  results.shippingLabel = 'PASS';

  // ---- 5. printing ----
  const station = await printService.createStation(SUPER, { warehouseId: def.id, name: `Pack Desk ${tag}` });
  const printer = await printService.createPrinter(SUPER, { printStationId: station.id, name: 'Label 1', printerType: 'LABEL_4X6_PDF' });
  const a4 = await printService.createPrinter(SUPER, { printStationId: station.id, name: 'A4 1', printerType: 'A4_PDF' });
  const gzSlip = afterBook.find((d) => d.type === 'PACKING_SLIP' && d.warehouseId === def.id);
  const label = afterBook.find((d) => d.type === 'SHIPPING_LABEL');
  const job = await printService.queueJob(SUPER, { documentId: gzSlip.id, printerId: a4.id });
  assert.equal(job.status, 'PRINTED');
  await assert.rejects(() => printService.queueJob(SUPER, { documentId: label.id, printerId: a4.id }), (e) => e.code === 'PRINTER_FORMAT_MISMATCH');
  const okLabelJob = await printService.queueJob(SUPER, { documentId: label.id, printerId: printer.id });
  assert.equal(okLabelJob.status, 'PRINTED');
  // cross-warehouse: a printer at def can't print an LKO document
  const lkoSlip = afterBook.find((d) => d.type === 'PACKING_SLIP' && d.warehouseId === lko.id);
  await assert.rejects(() => printService.queueJob(SUPER, { documentId: lkoSlip.id, printerId: a4.id }), (e) => e.code === 'PRINT_WAREHOUSE_MISMATCH');
  results.printing = 'PASS (job PRINTED, format + cross-warehouse rejected)';

  // ---- 6. cancel -> credit note, invoice preserved ----
  const o2 = await buildOrder([def.id], sku);
  await orderConfirmationService.confirm({ orderId: o2.orderId });
  const inv2 = await invoiceService.getForOrder(o2.orderId);
  await query("UPDATE orders SET order_status='CANCELLED' WHERE id=?", [o2.orderId]);
  const cn = await invoiceService.issueCreditNoteForOrder(o2.orderId, { reason: 'customer cancelled' });
  assert.ok(/^COR-CN-\d{4}-\d{6}$/.test(cn.credit_note_number));
  const inv2after = await invoiceService.getForOrder(o2.orderId);
  assert.equal(inv2after.invoice_number, inv2.invoice_number, 'invoice number unchanged after cancel');
  assert.equal(inv2after.status, 'CANCELLED', 'invoice marked cancelled, not deleted');
  const again = await invoiceService.issueCreditNoteForOrder(o2.orderId, { reason: 'retry' });
  assert.equal(again.credit_note_number, cn.credit_note_number, 'credit note is idempotent');
  results.cancellationCreditNote = 'PASS (invoice preserved, one credit note)';

  assert.equal(net, 0, 'no outbound network calls');
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nDOCUMENTS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nDOCUMENTS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  const { documentStorage } = await import('../src/modules/documents/storage.js');
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
    await safe(() => query('DELETE ba FROM shipment_booking_attempts ba JOIN shipments s ON s.id=ba.shipment_id JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
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
  for (const rid of created.reservations) {
    await safe(() => query('DELETE FROM checkout_sessions WHERE inventory_reservation_id=?', [rid]));
    await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [rid]));
    await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [rid]));
  }
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  for (const wid of created.warehouses) {
    await safe(() => query('DELETE FROM print_jobs WHERE print_station_id IN (SELECT id FROM print_stations WHERE warehouse_id=?)', [wid]));
    await safe(() => query('DELETE FROM printers WHERE print_station_id IN (SELECT id FROM print_stations WHERE warehouse_id=?)', [wid]));
    await safe(() => query('DELETE FROM print_stations WHERE warehouse_id=?', [wid]));
    await safe(() => query('DELETE FROM inventory WHERE warehouse_id=?', [wid]));
    await safe(() => query('DELETE FROM warehouses WHERE id=? AND is_default=0', [wid]));
  }
  // print stations created on the default warehouse
  await safe(() => query("DELETE pj FROM print_jobs pj JOIN print_stations st ON st.id=pj.print_station_id WHERE st.name LIKE ?", [`Pack Desk ${tag}`]));
  await safe(() => query("DELETE p FROM printers p JOIN print_stations st ON st.id=p.print_station_id WHERE st.name LIKE ?", [`Pack Desk ${tag}`]));
  await safe(() => query("DELETE FROM print_stations WHERE name LIKE ?", [`Pack Desk ${tag}`]));
  await safe(() => query("DELETE FROM document_counters WHERE name IN ('INVOICE','CREDIT_NOTE') AND value=0"));
  for (const { productId, priorTaxProfileId } of created.restoreTaxAssignments || []) {
    await safe(() => (priorTaxProfileId
      ? query('INSERT INTO product_tax_profiles (product_id, tax_profile_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE tax_profile_id = VALUES(tax_profile_id)', [productId, priorTaxProfileId])
      : query('DELETE FROM product_tax_profiles WHERE product_id=?', [productId])));
  }
  if (created.taxProfileId) await safe(() => query('DELETE FROM tax_profiles WHERE id=?', [created.taxProfileId]));
  await pool.end();
}
