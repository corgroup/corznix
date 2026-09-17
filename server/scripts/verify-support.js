// Wave 8G-3 — support / customer service.
//
// Tickets reference (never own) orders/returns; customer-visible messages vs
// INTERNAL notes (never leak to the customer API); named status transitions;
// compare-and-set assignment (concurrency safe); cross-customer denial;
// idempotent create; communication intent seam with no real send; RBAC.
// No provider / network calls.
//
//   npm run verify:support
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { roleHasPermission } = await import('../src/modules/staff/permissions.js');
const { supportService } = await import('../src/modules/support/service.js');
const { supportAdminService } = await import('../src/modules/support/adminService.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { customers: [], staff: [], orders: [] };

async function customer(name = 'S') {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'T','ACTIVE',NOW(3))", [id, name]);
  return id;
}
async function staff(role = 'SUPPORT') {
  const id = randomUUID();
  created.staff.push(id);
  await query("INSERT INTO staff_users (id,email,email_normalized,password_hash,first_name,last_name,role,status) VALUES (?,?,?,?,?,?,?,'ACTIVE')",
    [id, `sup-${id.slice(0, 8)}@x.test`, `sup-${id.slice(0, 8)}@x.test`, 'scrypt$1$1$1$x$x', 'S', role, role]);
  return id;
}
async function order(customerId) {
  const orderId = randomUUID();
  created.orders.push(orderId);
  const reservationId = randomUUID();
  await query("INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3),INTERVAL 1 DAY))", [reservationId, customerId, `sup:${randomUUID()}`, '0'.repeat(64)]);
  const cartId = randomUUID();
  await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']);
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', 50000,0,50000, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [checkoutId, customerId, cartId, reservationId, `sup:co:${randomUUID()}`, 'f'.repeat(64)]);
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', 50000,0,50000,50000,0,'{}','{}', 'SUP_TEST')`, [orderId, `COR-SUP-O-${tag}`, checkoutId, customerId, reservationId]);
  return { orderId, orderNumber: `COR-SUP-O-${tag}`, checkoutId, reservationId, cartId };
}

const mk = (customerId, over = {}) => supportService.createTicket({
  customerId, category: 'GENERAL', subject: 'Need help with something', body: 'Here is my problem.',
  idempotencyKey: `sup-${randomUUID().slice(0, 12)}`, ...over,
});

try {
  const A = await customer('CustA');
  const B = await customer('CustB');
  const s1 = await staff('SUPPORT');
  const s2 = await staff('SUPPORT');

  // ============ 1. create + conversation ============
  const t1 = await mk(A);
  assert.equal(t1.status, 'OPEN');
  assert.equal(t1.messages.length, 1);
  assert.equal(t1.messages[0].author, 'YOU');
  const ev1 = await query("SELECT event_type FROM support_events WHERE ticket_id=?", [t1.id]);
  assert.ok(ev1.some((e) => e.event_type === 'TICKET_CREATED'));
  assert.ok(ev1.some((e) => e.event_type === 'COMM_INTENT'), 'communication intent seam recorded (no real send)');
  results.supportTickets = 'PASS';

  // ============ 2. order-linked + ownership ============
  const o = await order(A);
  const t2 = await mk(A, { category: 'ORDER', orderId: o.orderId });
  assert.equal(t2.orderId, o.orderId);
  assert.equal(t2.context.orderNumber, o.orderNumber);
  await assert.rejects(() => mk(B, { category: 'ORDER', orderId: o.orderId }), (e) => e.code === 'ORDER_NOT_FOUND');
  results.orderLinked = 'PASS';

  // ============ 3. idempotent create ============
  const key = `sup-idem-${tag}`;
  const i1 = await mk(A, { idempotencyKey: key });
  const i2 = await mk(A, { idempotencyKey: key });
  assert.equal(i1.id, i2.id);
  assert.equal((await query("SELECT COUNT(*) c FROM support_tickets WHERE idempotency_key=?", [`sup:${A}:${key}`]))[0].c, 1);
  results.idempotentCreate = 'PASS';

  // ============ 4-6. replies + internal note isolation ============
  await supportAdminService.reply({ ticketIdOrNumber: t1.id, body: 'Thanks, looking into it.', visibility: 'CUSTOMER', actorStaffId: s1 });
  let adminT1 = await supportAdminService.detail(t1.id);
  assert.equal(adminT1.status, 'WAITING_CUSTOMER');
  assert.ok(adminT1.firstResponseAt, 'first_response_at set on first staff customer reply');

  await supportAdminService.reply({ ticketIdOrNumber: t1.id, body: 'SECRET internal context — escalate to L2', visibility: 'INTERNAL', actorStaffId: s1 });
  const custView = await supportService.getTicket(A, t1.id);
  assert.ok(!custView.messages.some((m) => /SECRET internal/.test(m.body)), 'INTERNAL_NOTE_CUSTOMER_LEAK = 0');
  assert.ok(custView.messages.some((m) => /looking into it/.test(m.body)), 'customer sees the staff CUSTOMER reply');
  assert.equal(custView.assignedStaffId, undefined, 'customer view does not expose assignment');

  const replied = await supportService.reply({ customerId: A, idOrNumber: t1.id, body: 'Here is more info.' });
  assert.equal(replied.status, 'IN_PROGRESS', 'customer reply reopens WAITING_CUSTOMER');
  results.customerConversation = 'PASS';
  results.internalNotes = 'PASS';
  results.internalNoteLeak = 0;

  // ============ 7-8. assignment + concurrency ============
  adminT1 = await supportAdminService.detail(t1.id);
  const v0 = adminT1.assignmentVersion;
  const a1 = await supportAdminService.assign({ ticketIdOrNumber: t1.id, staffId: s1, expectedVersion: v0, actorStaffId: s1 });
  assert.equal(a1.assignedStaffId, s1);
  assert.equal(a1.assignmentVersion, v0 + 1);

  const race = await Promise.allSettled([
    supportAdminService.assign({ ticketIdOrNumber: t1.id, staffId: s1, expectedVersion: v0 + 1, actorStaffId: s1 }),
    supportAdminService.assign({ ticketIdOrNumber: t1.id, staffId: s2, expectedVersion: v0 + 1, actorStaffId: s2 }),
  ]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one concurrent assignment wins');
  assert.equal(race.find((r) => r.status === 'rejected').reason.code, 'SUPPORT_ASSIGNMENT_CONFLICT');
  results.assignment = 'PASS';
  results.assignmentConcurrency = 'PASS';

  // ============ 9-10. priority + status transitions ============
  await supportAdminService.setPriority({ ticketIdOrNumber: t1.id, priority: 'HIGH', actorStaffId: s1 });
  assert.equal((await supportAdminService.detail(t1.id)).priority, 'HIGH');

  await supportAdminService.transition({ ticketIdOrNumber: t1.id, toStatus: 'IN_PROGRESS', actorStaffId: s1 });
  await supportAdminService.transition({ ticketIdOrNumber: t1.id, toStatus: 'RESOLVED', actorStaffId: s1 });
  let d = await supportAdminService.detail(t1.id);
  assert.ok(d.resolvedAt);
  assert.ok(d.events.some((e) => e.eventType === 'COMM_INTENT' && e.detail?.intent === 'TICKET_RESOLVED'));
  await assert.rejects(() => supportAdminService.transition({ ticketIdOrNumber: t1.id, toStatus: 'WAITING_CUSTOMER', actorStaffId: s1 }), (e) => e.code === 'INVALID_SUPPORT_TRANSITION');
  await supportAdminService.transition({ ticketIdOrNumber: t1.id, toStatus: 'CLOSED', actorStaffId: s1 });
  await supportAdminService.transition({ ticketIdOrNumber: t1.id, toStatus: 'IN_PROGRESS', actorStaffId: s1 }); // reopen
  d = await supportAdminService.detail(t1.id);
  assert.equal(d.status, 'IN_PROGRESS');
  assert.equal(d.resolvedAt, null, 'reopen clears resolved_at');
  results.statusTransitions = 'PASS (named, validated, reopen)';

  // ============ 11. cross-customer denial ============
  await assert.rejects(() => supportService.getTicket(B, t1.id), (e) => e.code === 'SUPPORT_TICKET_NOT_FOUND');
  await assert.rejects(() => supportService.reply({ customerId: B, idOrNumber: t1.id, body: 'hi' }), (e) => e.code === 'SUPPORT_TICKET_NOT_FOUND');
  results.crossCustomerAccess = 'DENIED';

  // ============ 12. support does not mutate order/return ============
  assert.equal((await query('SELECT order_status FROM orders WHERE id=?', [o.orderId]))[0].order_status, 'PLACED', 'support never mutated the linked order');
  results.noOrderMutation = 'PASS';

  // ============ 13. RBAC + audit wiring ============
  assert.equal(roleHasPermission('SUPPORT', 'support.manage'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'support.manage'), true);
  assert.equal(roleHasPermission('CATALOG_MANAGER', 'support.read'), false);
  assert.equal(roleHasPermission('VIEWER', 'support.manage'), false);
  assert.equal(roleHasPermission('VIEWER', 'support.read'), true);
  const adminRoutesSrc = readFileSync(new URL('../src/modules/support/adminRoutes.js', import.meta.url), 'utf8');
  assert.ok(/audit\.log/.test(adminRoutesSrc) && /SUPPORT_TICKET_ASSIGNED/.test(adminRoutesSrc), 'admin support actions are audited');
  const supportAdminSrc = readFileSync(new URL('../src/modules/support/adminService.js', import.meta.url), 'utf8');
  assert.ok(!/from '\.\.\/(orders|returns|payments)\//.test(supportAdminSrc), 'support admin service does not import order/return/payment authorities (§59)');
  assert.ok(!/UPDATE\s+(orders|return_requests|refund_attempts)/i.test(supportAdminSrc), 'support admin service issues no order/return/refund writes (§59)');
  results.supportRbac = 'PASS';
  results.supportAudit = 'PASS';

  assert.equal(networkCalls, 0);
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nSUPPORT_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nSUPPORT_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const id of created.customers) {
    await safe(() => query('DELETE se FROM support_events se JOIN support_tickets t ON t.id=se.ticket_id WHERE t.customer_id=?', [id]));
    await safe(() => query('DELETE sm FROM support_messages sm JOIN support_tickets t ON t.id=sm.ticket_id WHERE t.customer_id=?', [id]));
    await safe(() => query('DELETE FROM support_tickets WHERE customer_id=?', [id]));
  }
  for (const orderId of created.orders) {
    const chk = (await query('SELECT checkout_id, inventory_reservation_id FROM orders WHERE id=?', [orderId]))[0];
    await safe(() => query('DELETE FROM orders WHERE id=?', [orderId]));
    if (chk) {
      await safe(() => query('DELETE FROM checkout_sessions WHERE id=?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [chk.inventory_reservation_id]));
    }
  }
  for (const id of created.customers) {
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [id]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [id]));
  }
  for (const id of created.staff) await safe(() => query('DELETE FROM staff_users WHERE id=?', [id]));
  await pool.end();
}
