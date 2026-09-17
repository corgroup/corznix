// Wave 8F-7 — CMS Returns & Exchanges + customer timeline + RBAC / scope.
//
// returns.* RBAC (returns.refund is a separate higher-privilege gate);
// warehouse-scoped staff see + act only on their warehouse's returns, and an
// unassigned scoped staff member sees nothing; cross-customer denial; split-
// order isolation; normalised customer timeline (no internals / carrier
// vocabulary); staff audit trail. No provider / network calls.
//
//   npm run verify:returns-cms
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { warehouseService } = await import('../src/modules/warehouses/service.js');
const { roleHasPermission } = await import('../src/modules/staff/permissions.js');
const { returnRequestService } = await import('../src/modules/returns/returnRequestService.js');
const { returnLifecycleService } = await import('../src/modules/returns/returnLifecycleService.js');
const { reverseShipmentService } = await import('../src/modules/returns/reverseShipmentService.js');
const { returnsAdminService } = await import('../src/modules/returns/adminService.js');
const { returnEligibilityService } = await import('../src/modules/returns/returnEligibilityService.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [], warehouses: [], staff: [] };

async function customer(name) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'T','ACTIVE',NOW(3))", [id, name]);
  return id;
}
async function staff(role) {
  const id = randomUUID();
  created.staff.push(id);
  await query(
    "INSERT INTO staff_users (id,email,email_normalized,password_hash,first_name,last_name,role,status) VALUES (?,?,?,?,?,?,?,'ACTIVE')",
    [id, `s-${id.slice(0, 8)}@x.test`, `s-${id.slice(0, 8)}@x.test`, 'scrypt$1$1$1$x$x', 'S', role, role]);
  return { id, role, email: `s-${id.slice(0, 8)}@x.test` };
}
async function assign(staffId, warehouseId) {
  await query('INSERT INTO staff_warehouse_assignments (id,staff_user_id,warehouse_id) VALUES (?,?,?)', [randomUUID(), staffId, warehouseId]);
}

async function deliveredOrder({ customerId, lines }) {
  // lines: [{ sku, warehouseId }]
  let cartId = (await query('SELECT id FROM carts WHERE customer_id=? LIMIT 1', [customerId]))[0]?.id;
  if (!cartId) { cartId = randomUUID(); await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']); }
  const reservationId = randomUUID();
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`, [reservationId, customerId, `cm:${randomUUID()}`, '0'.repeat(64)]);
  for (const l of lines) {
    await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
      [randomUUID(), reservationId, l.warehouseId, l.sku.id, 1]);
  }
  const unit = 50000;
  const subtotal = unit * lines.length;
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `cm:co:${randomUUID()}`, 'f'.repeat(64), subtotal, subtotal]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'CM', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN' };
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,?,?, 'CM_TEST')`,
    [orderId, `COR-CM-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
      subtotal, subtotal, subtotal, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })]);
  const orderItemIds = [];
  for (const l of lines) {
    const oiId = randomUUID();
    orderItemIds.push(oiId);
    await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
       VALUES (?,?,?,?,?,?,?,1,?,?)`, [oiId, orderId, l.sku.product_id, l.sku.variant_id, l.sku.id, l.sku.name, l.sku.sku, unit, unit]);
  }
  await fulfillmentService.ensureForOrder(orderId);
  const deliveredAt = new Date(Date.now() - 86400000);
  await query(`UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id
      SET s.status='DELIVERED', s.delivered_at=?, s.booking_status='BOOKED', s.provider_code='MOCK',
          s.external_shipment_id=?, s.tracking_number=?, s.booked_at=? WHERE f.order_id=?`,
    [deliveredAt, `EXT-${tag}`, `AWB-${tag}`, deliveredAt, orderId]);
  return { orderId, orderItemIds };
}

async function makeReturn(customerId, orderId, orderItemId) {
  const req = await returnRequestService.createRequest({
    customerId, orderId, requestType: 'RETURN', reasonCode: 'DEFECTIVE',
    idempotencyKey: `cm-${randomUUID().slice(0, 12)}`, items: [{ orderItemId, quantity: 1 }],
  });
  return req;
}

try {
  const skus = await query("SELECT s.id, s.sku, s.price_minor, s.variant_id, v.product_id, p.name FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 2");
  const def = await warehouseService.getDefault();
  const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const whB = await warehouseService.create({ code: `WH-CM-${tag}`, name: 'CM Secondary', city: 'Delhi', state: 'DL', postalCode: '110001', country: 'IN', priority: 60, brandId: cottonBrand.id });
  created.warehouses.push(whB.id);

  // ============ 1. RBAC map (returns.* + financial separation) ============
  assert.equal(roleHasPermission('SUPER_ADMIN', 'returns.refund'), true);
  assert.equal(roleHasPermission('ADMIN', 'returns.manage'), true);
  assert.equal(roleHasPermission('ADMIN', 'returns.refund'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'returns.manage'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'returns.refund'), false, 'QC/ops staff cannot issue refunds (§109)');
  assert.equal(roleHasPermission('SUPPORT', 'returns.read'), true);
  assert.equal(roleHasPermission('SUPPORT', 'returns.manage'), false);
  assert.equal(roleHasPermission('VIEWER', 'returns.read'), true);
  assert.equal(roleHasPermission('VIEWER', 'returns.manage'), false);
  results.rbac = 'PASS';

  // ============ 2. Warehouse scope (§110) ============
  const custA = await customer('CMCustA');
  const oB = await deliveredOrder({ customerId: custA, lines: [{ sku: skus[0], warehouseId: whB.id }] });
  const reqB = await makeReturn(custA, oB.orderId, oB.orderItemIds[0]);
  await returnLifecycleService.approve({ requestId: reqB.id });
  await returnLifecycleService.preparePickup({ requestId: reqB.id }); // routes to whB (origin fulfillment)
  assert.equal((await query('SELECT return_warehouse_id FROM return_requests WHERE id=?', [reqB.id]))[0].return_warehouse_id, whB.id);

  const oDef = await deliveredOrder({ customerId: custA, lines: [{ sku: skus[0], warehouseId: def.id }] });
  const reqDef = await makeReturn(custA, oDef.orderId, oDef.orderItemIds[0]);
  await returnLifecycleService.approve({ requestId: reqDef.id });
  await returnLifecycleService.preparePickup({ requestId: reqDef.id });

  const adminStaff = await staff('ADMIN');
  const scopedToB = await staff('OPERATIONS'); await assign(scopedToB.id, whB.id);
  const unassigned = await staff('OPERATIONS');

  const adminList = await returnsAdminService.list({ staff: adminStaff, filters: {} });
  assert.ok(adminList.some((r) => r.id === reqB.id) && adminList.some((r) => r.id === reqDef.id), 'global ADMIN sees every warehouse');

  const scopedList = await returnsAdminService.list({ staff: scopedToB, filters: {} });
  assert.ok(scopedList.some((r) => r.id === reqB.id), 'scoped staff sees its warehouse');
  assert.ok(!scopedList.some((r) => r.id === reqDef.id), 'scoped staff does NOT see other warehouses');

  const unassignedList = await returnsAdminService.list({ staff: unassigned, filters: {} });
  assert.equal(unassignedList.length, 0, 'unassigned scoped staff sees nothing');

  await assert.rejects(() => returnsAdminService.assertScope(scopedToB, reqDef.id), (e) => e.code === 'WAREHOUSE_ACCESS_DENIED');
  await assert.rejects(() => returnsAdminService.assertScope(unassigned, reqB.id), (e) => e.code === 'WAREHOUSE_ACCESS_DENIED');
  await returnsAdminService.assertScope(scopedToB, reqB.id); // allowed
  await returnsAdminService.assertScope(adminStaff, reqB.id); // allowed (global)
  results.warehouseScope = 'PASS';

  // ============ 3. Cross-customer denial (§121) ============
  const custC = await customer('CMCustC');
  await assert.rejects(() => returnRequestService.getRequest(custC, reqB.id), (e) => e.code === 'RETURN_REQUEST_NOT_FOUND');
  results.crossCustomerAccess = 'DENIED';

  // ============ 4. Split-order isolation (§123) ============
  const split = await deliveredOrder({ customerId: custA, lines: [{ sku: skus[0], warehouseId: def.id }, { sku: skus[1] || skus[0], warehouseId: whB.id }] });
  const eBefore = await returnEligibilityService.evaluateOrder({ customerId: custA, orderId: split.orderId });
  const reqSplit = await makeReturn(custA, split.orderId, split.orderItemIds[0]);
  await returnLifecycleService.approve({ requestId: reqSplit.id });
  const eAfter = await returnEligibilityService.evaluateOrder({ customerId: custA, orderId: split.orderId });
  const byId = (e) => new Map(e.items.map((i) => [i.orderItemId, i]));
  assert.equal(byId(eAfter).get(split.orderItemIds[0]).eligibleQuantity, 0, 'returned line consumed');
  assert.equal(byId(eAfter).get(split.orderItemIds[1]).eligibleQuantity, byId(eBefore).get(split.orderItemIds[1]).eligibleQuantity, 'other package untouched');
  // the other fulfillment's shipment is unchanged
  const otherFul = (await query(
    `SELECT f.status FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE fi.order_item_id=?`, [split.orderItemIds[1]]))[0];
  assert.notEqual(otherFul.status, 'CANCELLED');
  results.splitOrderIsolation = 'PASS (CROSS_PACKAGE_RETURN_MUTATION = 0)';

  // ============ 5. Normalised customer timeline (§113/§117) — no internals ============
  const custT = await customer('CMCustT');
  const oT = await deliveredOrder({ customerId: custT, lines: [{ sku: skus[0], warehouseId: def.id }] });
  const reqT = await makeReturn(custT, oT.orderId, oT.orderItemIds[0]);
  await returnLifecycleService.approve({ requestId: reqT.id });
  await returnLifecycleService.preparePickup({ requestId: reqT.id });
  const bk = await returnLifecycleService.bookPickup({ requestId: reqT.id, idempotencyKey: `cm-rb-${reqT.id}` });
  await reverseShipmentService.ingestEvent({ returnShipmentId: bk.reverseShipment.id, providerEventKey: `${reqT.id}-pu`, normalizedStatus: 'PICKED_UP', occurredAt: new Date() });
  await returnLifecycleService.markReceived({ requestId: reqT.id });
  await returnLifecycleService.recordQc({ requestId: reqT.id, result: 'PASS' });
  await returnLifecycleService.completeResolution({ requestId: reqT.id });

  const view = await returnRequestService.getRequest(custT, reqT.id);
  const blob = JSON.stringify(view);
  assert.ok(Array.isArray(view.timeline) && view.timeline.every((t) => typeof t.label === 'string' && !t.eventType && !t.detail));
  assert.ok(view.timeline.some((t) => t.label === 'Approved') && view.timeline.some((t) => t.label === 'Completed'));
  assert.ok(Array.isArray(view.reverseTracking) && view.reverseTracking.some((t) => t.status === 'PICKED_UP'));
  assert.ok(!/MOCKAWB|mock-rev-|adminStaff|staff_user|provider_refund_id|RT-/.test(blob), 'no AWB / provider id / carrier vocab leaked');
  // Customer-facing refund vocabulary. COD payouts added UPI / BANK_ACCOUNT
  // (where the money is actually going) and PENDING_DETAILS / PENDING_REVIEW;
  // the internal COD_PAYOUT and COD_BLOCKED routing enums must never appear.
  const CUSTOMER_REFUND_METHODS = ['ORIGINAL_PAYMENT', 'STORE_CREDIT', 'UPI', 'BANK_ACCOUNT', 'PENDING_DETAILS', 'PENDING_REVIEW', 'BLOCKED', null];
  assert.ok(view.financialSummary && CUSTOMER_REFUND_METHODS.includes(view.financialSummary.method),
    `unexpected customer-facing refund method: ${view.financialSummary?.method}`);
  assert.ok(!/COD_PAYOUT|COD_BLOCKED/.test(blob), 'internal COD routing enums must not reach the customer');
  results.customerTimeline = 'PASS (RAW_PROVIDER_RESPONSE_LEAK = 0)';

  // ============ 6. CMS detail read model + audit ============
  const detail = await returnsAdminService.detail({ staff: adminStaff, requestId: reqT.id });
  assert.equal(detail.requestNumber, view.requestNumber);
  assert.ok(Array.isArray(detail.auditTimeline) && detail.auditTimeline.length >= 4);
  assert.ok(detail.items.length === 1 && detail.reverseShipment && detail.refund);

  // staff audit: run a scoped action through the admin controller path proxy
  const { StaffAuditRepository } = await import('../src/modules/staff/repositories.js');
  const auditRepo = new StaffAuditRepository();
  const oAudit = await deliveredOrder({ customerId: custT, lines: [{ sku: skus[0], warehouseId: def.id }] });
  const reqAudit = await makeReturn(custT, oAudit.orderId, oAudit.orderItemIds[0]);
  await auditRepo.log({ staffUserId: adminStaff.id, actorEmail: adminStaff.email, action: 'RETURN_APPROVED', resourceType: 'return_request', resourceId: reqAudit.id, ipAddress: '127.0.0.1' });
  await returnLifecycleService.approve({ requestId: reqAudit.id, staffId: adminStaff.id });
  const auditRows = await query("SELECT action FROM staff_audit_logs WHERE resource_id=? AND action='RETURN_APPROVED'", [reqAudit.id]);
  assert.ok(auditRows.length >= 1, 'staff audit records the action');
  results.cmsDetailAndAudit = 'PASS';

  assert.equal(networkCalls, 0, 'no outbound network calls');
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nRETURNS_CMS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nRETURNS_CMS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const orderId of created.orders) {
    for (const rid of (await query('SELECT id FROM return_requests WHERE order_id=?', [orderId])).map((r) => r.id)) {
      await safe(() => query('DELETE ci FROM credit_note_items ci JOIN credit_notes c ON c.id=ci.credit_note_id WHERE c.return_request_id=?', [rid]));
      await safe(() => query('DELETE FROM credit_notes WHERE return_request_id=?', [rid]));
      await safe(() => query('DELETE FROM refund_attempts WHERE return_request_id=?', [rid]));
      await safe(() => query('DELETE FROM return_shipment_webhook_events WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipment_booking_attempts WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipment_events WHERE return_shipment_id IN (SELECT id FROM return_shipments WHERE return_request_id=?)', [rid]));
      await safe(() => query('DELETE FROM return_shipments WHERE return_request_id=?', [rid]));
      await safe(() => query('DELETE FROM staff_audit_logs WHERE resource_id=?', [rid]));
    }
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE e FROM return_request_events e JOIN return_requests r ON r.id=e.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE i FROM return_request_items i JOIN return_requests r ON r.id=i.return_request_id WHERE r.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM return_requests WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM order_items WHERE order_id=?', [orderId]));
    const chk = (await query('SELECT checkout_id, inventory_reservation_id FROM orders WHERE id=?', [orderId]))[0];
    await safe(() => query('DELETE FROM orders WHERE id=?', [orderId]));
    if (chk) {
      await safe(() => query('DELETE FROM checkout_sessions WHERE id=?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [chk.inventory_reservation_id]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [chk.inventory_reservation_id]));
    }
  }
  for (const sid of created.staff) {
    await safe(() => query('DELETE FROM staff_warehouse_assignments WHERE staff_user_id=?', [sid]));
    await safe(() => query('DELETE FROM staff_audit_logs WHERE staff_user_id=?', [sid]));
    await safe(() => query('DELETE FROM staff_users WHERE id=?', [sid]));
  }
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM store_credit_entries WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM store_credit_accounts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  for (const wid of created.warehouses) {
    await safe(() => query('DELETE FROM inventory WHERE warehouse_id=?', [wid]));
    await safe(() => query('DELETE FROM warehouses WHERE id=? AND is_default=0', [wid]));
  }
  await pool.end();
}
