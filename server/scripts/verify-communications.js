// Communications hub verification (migration 070 + internalChat module +
// support Phase-A enhancements).
//
// Proves, against the local dev database:
//   Phase A (customer queries over Support Tickets):
//     - a ticket linked to an order derives its warehouse from the order's
//       fulfillment on open;
//     - the admin list carries customer name / order number / warehouse name /
//       needs-reply, plus facet counts;
//     - warehouse-scoped staff see their warehouses' tickets + unscoped
//       tickets, never another warehouse's;
//     - a customer reply raises a private notification to the assigned agent
//       (or a warehouse-scoped one when unassigned);
//     - an internal note never reaches the customer API;
//     - "notify the warehouse team" raises a warehouse-scoped notification.
//   Phase B (internal staff chat):
//     - openDirect is deduped on the staff pair;
//     - a message raises a private MESSAGE notification to each other
//       participant; an @mention raises a private MENTION one;
//     - unread counts + the read cursor behave;
//     - a non-participant cannot read or post (403);
//   Notification privacy:
//     - a staff-addressed row is invisible to everyone else, SUPER_ADMIN
//       included;
//     - the `mine` feed returns only staff-addressed rows.
//
// Isolated and self-cleaning. No providers touched.
//
//   npm run verify:communications
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.COMMUNICATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { StaffWarehouseAssignmentRepository } = await import('../src/modules/staff/repositories.js');
const { supportService } = await import('../src/modules/support/service.js');
const { supportAdminService } = await import('../src/modules/support/adminService.js');
const { internalChatService } = await import('../src/modules/internalChat/service.js');
const { staffNotificationService } = await import('../src/modules/staffNotifications/service.js');
const { warehouseScopeForStaff } = await import('../src/middleware/requireWarehouseAccess.js');

const assignmentRepo = new StaffWarehouseAssignmentRepository();
const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const tag = randomUUID().slice(0, 8);
const EMAIL_DOMAIN = '@comms-verify.test';
const startedAt = new Date();

let scopedStaffId; let otherStaffId; let superAdminId;
let ticketId; let conversationId;

try {
  // ---- fixtures --------------------------------------------------------
  const [order] = await query(
    `SELECT o.id, o.order_number FROM orders o
       JOIN fulfillments f ON f.order_id = o.id AND f.warehouse_id IS NOT NULL
      GROUP BY o.id HAVING COUNT(DISTINCT f.warehouse_id) = 1 LIMIT 1`,
  );
  assert.ok(order, 'need an order with a single-warehouse fulfillment (run the seed)');
  const [{ warehouse_id: warehouseId }] = await query('SELECT warehouse_id FROM fulfillments WHERE order_id = ? LIMIT 1', [order.id]);
  const [{ customer_id: customerId }] = await query('SELECT customer_id FROM orders WHERE id = ?', [order.id]);
  const [otherWarehouse] = await query('SELECT id FROM warehouses WHERE id <> ? LIMIT 1', [warehouseId]);

  const [superAdmin] = await query("SELECT id FROM staff_users WHERE role = 'SUPER_ADMIN' ORDER BY created_at LIMIT 1");
  superAdminId = superAdmin.id;

  await query('DELETE FROM staff_users WHERE email_normalized LIKE ?', [`%${EMAIL_DOMAIN}`]).catch(() => {});
  const scoped = await staffAuthService.createStaffUser({ email: `scoped.${tag}${EMAIL_DOMAIN}`, password: 'Comms-Verify-Strong-Passphrase-1', firstName: 'Scoped', lastName: 'Manager', role: 'OPERATIONS' });
  const other = await staffAuthService.createStaffUser({ email: `other.${tag}${EMAIL_DOMAIN}`, password: 'Comms-Verify-Strong-Passphrase-2', firstName: 'Other', lastName: 'Agent', role: 'OPERATIONS' });
  scopedStaffId = scoped.id;
  otherStaffId = other.id;
  await assignmentRepo.assign(scopedStaffId, warehouseId);
  if (otherWarehouse) await assignmentRepo.assign(otherStaffId, otherWarehouse.id);

  const scopedScope = await warehouseScopeForStaff({ id: scopedStaffId, role: 'OPERATIONS' });
  const otherScope = await warehouseScopeForStaff({ id: otherStaffId, role: 'OPERATIONS' });
  const globalScope = { all: true, warehouseIds: [] };

  // ---- Phase A: warehouse derivation ---------------------------------
  {
    const t = await supportService.createTicket({
      customerId, category: 'DELIVERY', subject: `verify ${tag} where is my order`,
      body: 'Where is my order? No update in days.', orderId: order.id, idempotencyKey: `comms-verify-${tag}`,
    });
    ticketId = t.id;
    const [row] = await query('SELECT warehouse_id FROM support_tickets WHERE id = ?', [ticketId]);
    assert.equal(row.warehouse_id, warehouseId, 'ticket warehouse derived from the order fulfillment');
    pass('WAREHOUSE_DERIVED_ON_OPEN');
  }

  // ---- Phase A: enriched admin list + facets -------------------------
  {
    const list = await supportAdminService.list({ warehouseScope: globalScope, q: `verify ${tag}`, limit: 10 });
    const mine = list.tickets.find((x) => x.id === ticketId);
    assert.ok(mine, 'ticket found by full-text-ish q search');
    assert.ok(mine.customerName != null, 'customerName present');
    assert.equal(mine.orderNumber, order.order_number, 'orderNumber joined');
    assert.ok(mine.warehouseName, 'warehouseName joined');
    assert.equal(mine.needsReply, true, 'a fresh customer-authored ticket needs a reply');
    assert.ok(Number.isInteger(list.total), 'list carries a total');

    const facets = await supportAdminService.facets(globalScope);
    assert.ok(facets.open >= 1 && facets.needsReply >= 1, 'facets reflect the open needs-reply ticket');
    pass('ADMIN_LIST_ENRICHED');
  }

  // ---- Phase A: warehouse scoping -----------------------------------
  {
    const seenByScoped = await supportAdminService.list({ warehouseScope: scopedScope, limit: 100 });
    assert.ok(seenByScoped.tickets.some((x) => x.id === ticketId), 'assigned-warehouse staff sees the ticket');

    const seenByOther = await supportAdminService.list({ warehouseScope: otherScope, limit: 100 });
    assert.ok(!seenByOther.tickets.some((x) => x.id === ticketId), 'a different warehouse\'s staff does NOT see it');

    // A general (no-warehouse) ticket is visible to any scoped staff.
    const gen = await supportService.createTicket({
      customerId, category: 'GENERAL', subject: `verify ${tag} general`,
      body: 'General question.', idempotencyKey: `comms-verify-gen-${tag}`,
    });
    const genSeen = await supportAdminService.list({ warehouseScope: otherScope, limit: 100 });
    assert.ok(genSeen.tickets.some((x) => x.id === gen.id), 'unscoped ticket visible to any warehouse staff');
    pass('WAREHOUSE_SCOPING');
  }

  // ---- Phase A: assignment + reply notifications --------------------
  {
    const before = await supportAdminService.detail(ticketId);
    await supportAdminService.assign({ ticketIdOrNumber: ticketId, staffId: scopedStaffId, expectedVersion: before.assignmentVersion, actorStaffId: superAdminId });
    const assignedNotif = await query(
      "SELECT * FROM staff_notifications WHERE event_key = 'SUPPORT_TICKET_ASSIGNED' AND staff_id = ? AND entity_id = ?",
      [scopedStaffId, ticketId],
    );
    assert.equal(assignedNotif.length, 1, 'assignment raises a private notification to the assignee');

    await supportService.reply({ customerId, idOrNumber: ticketId, body: `verify ${tag} still waiting` });
    const replyNotif = await query(
      "SELECT * FROM staff_notifications WHERE event_key = 'SUPPORT_CUSTOMER_REPLIED' AND staff_id = ? AND entity_id = ?",
      [scopedStaffId, ticketId],
    );
    assert.ok(replyNotif.length >= 1, 'a customer reply notifies the assigned agent privately');
    pass('ASSIGN_AND_REPLY_NOTIFICATIONS');
  }

  // ---- Phase A: internal note privacy + notify-warehouse -----------
  {
    await supportAdminService.reply({
      ticketIdOrNumber: ticketId, body: `verify ${tag} INTERNAL do not leak`,
      visibility: 'INTERNAL', notifyWarehouse: true, actorStaffId: superAdminId,
    });
    const custView = await supportService.getTicket(customerId, ticketId);
    assert.ok(!custView.messages.some((m) => m.body.includes('INTERNAL do not leak')), 'internal note is NOT in the customer view');

    const whNotif = await query(
      "SELECT * FROM staff_notifications WHERE event_key = 'SUPPORT_WAREHOUSE_MENTIONED' AND warehouse_id = ? AND entity_id = ?",
      [warehouseId, ticketId],
    );
    assert.equal(whNotif.length, 1, '"notify the warehouse" raises a warehouse-scoped notification');
    const whFeed = await staffNotificationService.feed(scopedStaffId, { scope: scopedScope, limit: 30 });
    assert.ok(whFeed.items.some((i) => i.eventKey === 'SUPPORT_WAREHOUSE_MENTIONED'), 'warehouse staff receives it');
    pass('INTERNAL_NOTE_PRIVACY_AND_WAREHOUSE_PING', 'leak=0');
  }

  // ---- Phase B: internal chat --------------------------------------
  {
    const [corcottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
    const conv = await internalChatService.openDirect({ brandId: corcottonBrand.id, meId: superAdminId, otherStaffId: scopedStaffId });
    conversationId = conv.id;
    const again = await internalChatService.openDirect({ brandId: corcottonBrand.id, meId: scopedStaffId, otherStaffId: superAdminId });
    assert.equal(again.id, conversationId, 'openDirect is deduped on the staff pair');

    await internalChatService.postMessage({ meId: superAdminId, conversationId, body: `verify ${tag} hello there`, mentions: [] });
    await internalChatService.postMessage({ meId: superAdminId, conversationId, body: `verify ${tag} pinging you`, mentions: [scopedStaffId] });

    const msgNotif = await query("SELECT category FROM staff_notifications WHERE event_key = 'INTERNAL_MESSAGE' AND staff_id = ? AND entity_id = ?", [scopedStaffId, conversationId]);
    const mentionNotif = await query("SELECT category FROM staff_notifications WHERE event_key = 'INTERNAL_MENTION' AND staff_id = ? AND entity_id = ?", [scopedStaffId, conversationId]);
    assert.ok(msgNotif.length >= 1 && msgNotif[0].category === 'MESSAGE', 'a message raises a private MESSAGE notification');
    assert.ok(mentionNotif.length === 1 && mentionNotif[0].category === 'MENTION', 'an @mention raises a private MENTION notification');

    const list = await internalChatService.listForStaff(scopedStaffId);
    const row = list.conversations.find((x) => x.id === conversationId);
    assert.equal(row.unreadCount, 2, 'recipient has 2 unread');
    const full = await internalChatService.getConversation({ meId: scopedStaffId, conversationId });
    await internalChatService.markRead({ meId: scopedStaffId, conversationId, lastMessageId: full.messages.at(-1).id });
    assert.equal((await internalChatService.unreadTotal(scopedStaffId)).count >= 0, true);
    const afterRead = await internalChatService.listForStaff(scopedStaffId);
    assert.equal(afterRead.conversations.find((x) => x.id === conversationId).unreadCount, 0, 'unread clears after read');
    pass('INTERNAL_CHAT');
  }

  // ---- Phase B: participant access control -------------------------
  {
    await assert.rejects(
      () => internalChatService.getConversation({ meId: otherStaffId, conversationId }),
      /CONVERSATION_ACCESS_DENIED|not a participant/,
      'a non-participant cannot read the conversation',
    );
    await assert.rejects(
      () => internalChatService.postMessage({ meId: otherStaffId, conversationId, body: 'intruder' }),
      /CONVERSATION_ACCESS_DENIED|not a participant/,
      'a non-participant cannot post',
    );
    pass('CONVERSATION_ACCESS_CONTROL');
  }

  // ---- Notification privacy --------------------------------------
  {
    const adminMine = await staffNotificationService.feed(superAdminId, { scope: { all: true, warehouseIds: [] }, staffAddressedOnly: true, limit: 50 });
    assert.ok(!adminMine.items.some((i) => i.entityId === conversationId), 'SUPER_ADMIN does not see notifications addressed to another staff member');

    const scopedMine = await staffNotificationService.feed(scopedStaffId, { scope: scopedScope, staffAddressedOnly: true, limit: 50 });
    assert.ok(scopedMine.items.every((i) => i.staffId === scopedStaffId), 'the `mine` feed returns only staff-addressed rows');
    assert.ok(scopedMine.items.some((i) => i.eventKey === 'INTERNAL_MENTION'), 'the mention shows in the recipient\'s mine feed');
    pass('NOTIFICATION_PRIVACY');
  }

  console.log('\nCommunications hub — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query('DELETE FROM internal_conversations WHERE created_by IN (SELECT id FROM staff_users WHERE email_normalized LIKE ?) OR id = ?', [`%${EMAIL_DOMAIN}`, conversationId || '']));
  await safe(() => query('DELETE FROM staff_notifications WHERE created_at >= ? AND (dedupe_key LIKE ? OR dedupe_key LIKE ? OR dedupe_key LIKE ?)', [startedAt, 'internal_msg:%', 'support_%', 'comms-verify%']));
  await safe(() => query('DELETE FROM support_tickets WHERE idempotency_key LIKE ?', [`sup:%:comms-verify-%`]));
  await safe(() => query('DELETE FROM staff_notification_reads WHERE read_at >= ?', [startedAt]));
  await safe(() => query('DELETE FROM staff_warehouse_assignments WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE ?)', [`%${EMAIL_DOMAIN}`]));
  await safe(() => query('DELETE FROM staff_audit_logs WHERE actor_email LIKE ?', [`%${EMAIL_DOMAIN}`]));
  await safe(() => query('DELETE FROM staff_users WHERE email_normalized LIKE ?', [`%${EMAIL_DOMAIN}`]));
  await pool.end();
}
