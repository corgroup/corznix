import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

export class SupportRepository {
  ticketByIdempotencyKey(connection, key) {
    return exec(connection, 'SELECT * FROM support_tickets WHERE idempotency_key = ? LIMIT 1', [key]).then((r) => r[0] || null);
  }

  ownedTicket(customerId, idOrNumber) {
    return query('SELECT * FROM support_tickets WHERE customer_id = ? AND (id = ? OR ticket_number = ?) LIMIT 1',
      [customerId, idOrNumber, idOrNumber]).then((r) => r[0] || null);
  }

  ticketById(connection, id, { lock = false } = {}) {
    return exec(connection, `SELECT * FROM support_tickets WHERE id = ? OR ticket_number = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
      [id, id]).then((r) => r[0] || null);
  }

  async insertTicket(connection, t) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO support_tickets
        (id, brand_id, ticket_number, customer_id, category, priority, status, subject, order_id, return_request_id, warehouse_id,
         context_snapshot_json, idempotency_key)
       VALUES (?, (SELECT brand_id FROM customers WHERE id = ?), ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, ?)`,
      [id, t.customerId, t.ticketNumber, t.customerId, t.category, t.priority || 'NORMAL', t.subject,
        t.orderId || null, t.returnRequestId || null, t.warehouseId || null,
        t.contextSnapshot ? JSON.stringify(t.contextSnapshot) : null, t.idempotencyKey || null]);
    return exec(connection, 'SELECT * FROM support_tickets WHERE id = ?', [id]).then((r) => r[0]);
  }

  /**
   * The single warehouse an order is being fulfilled from, or null if it is
   * split across warehouses / not yet allocated. Used to scope a support
   * ticket to the responsible warehouse on open (migration 070).
   */
  async warehouseForOrder(connection, orderId) {
    const rows = await exec(connection,
      `SELECT warehouse_id FROM fulfillments
        WHERE order_id = ? AND warehouse_id IS NOT NULL
        GROUP BY warehouse_id`,
      [orderId]);
    return rows.length === 1 ? rows[0].warehouse_id : null;
  }

  updateTicket(connection, id, fields) {
    const sets = ['updated_at = NOW(3)'];
    const params = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); params.push(v); }
    params.push(id);
    return exec(connection, `UPDATE support_tickets SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /** Compare-and-set assignment (§55). Returns true only if the version matched. */
  async assign(connection, id, { staffId, expectedVersion }) {
    const res = await exec(connection,
      `UPDATE support_tickets
          SET assigned_staff_id = ?, assignment_version = assignment_version + 1, updated_at = NOW(3)
        WHERE id = ? AND assignment_version = ?`,
      [staffId || null, id, expectedVersion]);
    return res.affectedRows === 1;
  }

  async insertMessage(connection, m) {
    const id = randomUUID();
    await exec(connection,
      'INSERT INTO support_messages (id, ticket_id, author_type, author_id, visibility, body) VALUES (?, ?, ?, ?, ?, ?)',
      [id, m.ticketId, m.authorType, m.authorId || null, m.visibility, m.body]);
    return id;
  }

  async insertAttachment(connection, a) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO support_message_attachments (id, message_id, ticket_id, storage_key, file_name, content_type, byte_size, sha256)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, a.messageId, a.ticketId, a.storageKey, a.fileName, a.contentType, a.byteSize, a.sha256]);
    return id;
  }

  // Everything attached to a ticket, keyed by message so the DTO can hang
  // each file off the reply it arrived with.
  attachmentsForTicket(ticketId, { connection = null } = {}) {
    return exec(connection,
      `SELECT id, message_id, file_name, content_type, byte_size, created_at
         FROM support_message_attachments WHERE ticket_id = ? ORDER BY created_at, id`, [ticketId]);
  }

  // Staff read: scoped to the ticket in the URL as well as the id, so an
  // attachment cannot be fetched through a ticket it does not belong to.
  // The ticket itself is matched by id or number, matching the other
  // admin :id routes.
  attachmentForTicket(ticketIdOrNumber, attachmentId) {
    return query(
      `SELECT a.id, a.storage_key, a.file_name, a.content_type, a.byte_size
         FROM support_message_attachments a
         JOIN support_tickets t ON t.id = a.ticket_id
        WHERE a.id = ? AND (t.id = ? OR t.ticket_number = ?) LIMIT 1`,
      [attachmentId, ticketIdOrNumber, ticketIdOrNumber]).then((r) => r[0] || null);
  }

  // Ownership is enforced in the join, not by the caller: an attachment is
  // only readable through a ticket that belongs to the asking customer.
  ownedAttachment(customerId, attachmentId) {
    return query(
      `SELECT a.id, a.storage_key, a.file_name, a.content_type, a.byte_size
         FROM support_message_attachments a
         JOIN support_tickets t ON t.id = a.ticket_id
        WHERE a.id = ? AND t.customer_id = ? LIMIT 1`,
      [attachmentId, customerId]).then((r) => r[0] || null);
  }

  messages(ticketId, { visibility = null, connection = null } = {}) {
    const params = [ticketId];
    let filter = '';
    if (visibility) { filter = ' AND visibility = ?'; params.push(visibility); }
    return exec(connection,
      `SELECT id, author_type, author_id, visibility, body, created_at
         FROM support_messages WHERE ticket_id = ?${filter} ORDER BY created_at, id`, params);
  }

  hasStaffCustomerReply(ticketId) {
    return query(
      "SELECT 1 FROM support_messages WHERE ticket_id = ? AND author_type = 'STAFF' AND visibility = 'CUSTOMER' LIMIT 1",
      [ticketId]).then((r) => r.length > 0);
  }

  async recordEvent(connection, ticketId, e) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO support_events (id, ticket_id, event_type, from_status, to_status, actor_type, actor_id, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ticketId, e.eventType, e.fromStatus || null, e.toStatus || null,
        e.actorType || 'SYSTEM', e.actorId || null, e.detail ? JSON.stringify(e.detail) : null]);
    return id;
  }

  events(ticketId) {
    return query(
      'SELECT event_type, from_status, to_status, actor_type, actor_id, detail_json, created_at FROM support_events WHERE ticket_id = ? ORDER BY created_at, id',
      [ticketId]);
  }

  listOwned(customerId) {
    return query(
      `SELECT id, ticket_number, category, priority, status, subject, order_id, return_request_id, created_at, updated_at
         FROM support_tickets WHERE customer_id = ? ORDER BY updated_at DESC`, [customerId]);
  }

  #adminWhere({ status, category, priority, assignedStaffId, unassigned, warehouseId, mineStaffId, q, warehouseScope }) {
    const where = [];
    const params = [];
    if (status) { where.push('t.status = ?'); params.push(status); }
    if (category) { where.push('t.category = ?'); params.push(category); }
    if (priority) { where.push('t.priority = ?'); params.push(priority); }
    if (assignedStaffId) { where.push('t.assigned_staff_id = ?'); params.push(assignedStaffId); }
    if (mineStaffId) { where.push('t.assigned_staff_id = ?'); params.push(mineStaffId); }
    if (unassigned) where.push('t.assigned_staff_id IS NULL');
    if (warehouseId) { where.push('t.warehouse_id = ?'); params.push(warehouseId); }
    // Warehouse-scoped staff: their assigned warehouses' tickets plus tickets
    // with no warehouse (general / not-yet-allocated queries anyone can pick up).
    if (warehouseScope && !warehouseScope.all) {
      if (warehouseScope.warehouseIds.length) {
        const ph = warehouseScope.warehouseIds.map(() => '?').join(',');
        where.push(`(t.warehouse_id IS NULL OR t.warehouse_id IN (${ph}))`);
        params.push(...warehouseScope.warehouseIds);
      } else {
        where.push('t.warehouse_id IS NULL');
      }
    }
    if (q) {
      const like = `%${String(q).toLowerCase()}%`;
      where.push(`(
        LOWER(t.subject) LIKE ? OR LOWER(t.ticket_number) LIKE ?
        OR LOWER(CONCAT_WS(' ', c.first_name, c.last_name)) LIKE ?
        OR LOWER(o.order_number) LIKE ?
        OR EXISTS (SELECT 1 FROM customer_contacts cc WHERE cc.customer_id = t.customer_id AND LOWER(cc.normalized_value) LIKE ?)
      )`);
      params.push(like, like, like, like, like);
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  adminList(filters = {}) {
    const { sql, params } = this.#adminWhere(filters);
    const safeLimit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
    const safeOffset = Math.max(Number(filters.offset) || 0, 0);
    return query(
      `SELECT t.id, t.ticket_number, t.customer_id, t.category, t.priority, t.status, t.subject,
              t.order_id, t.return_request_id, t.warehouse_id, t.assigned_staff_id,
              s.email AS assigned_email, CONCAT_WS(' ', s.first_name, s.last_name) AS assigned_name,
              CONCAT_WS(' ', c.first_name, c.last_name) AS customer_name,
              o.order_number AS order_number, w.name AS warehouse_name,
              t.first_response_at, t.created_at, t.updated_at,
              (SELECT COUNT(*) FROM support_messages m WHERE m.ticket_id = t.id) AS message_count,
              (SELECT sm.body FROM support_messages sm WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1) AS last_body,
              (SELECT sm.author_type FROM support_messages sm WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1) AS last_author,
              (SELECT sm.created_at FROM support_messages sm WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1) AS last_at,
              (t.status IN ('OPEN','IN_PROGRESS') AND (
                 SELECT sm.author_type FROM support_messages sm WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1
               ) = 'CUSTOMER') AS needs_reply
         FROM support_tickets t
         LEFT JOIN staff_users s ON s.id = t.assigned_staff_id
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN orders o ON o.id = t.order_id
         LEFT JOIN warehouses w ON w.id = t.warehouse_id
        ${sql}
        ORDER BY FIELD(t.priority,'URGENT','HIGH','NORMAL','LOW'), t.updated_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}`, params);
  }

  async adminCount(filters = {}) {
    const { sql, params } = this.#adminWhere(filters);
    const rows = await query(
      `SELECT COUNT(*) AS n
         FROM support_tickets t
         LEFT JOIN customers c ON c.id = t.customer_id
         LEFT JOIN orders o ON o.id = t.order_id
        ${sql}`, params);
    return Number(rows[0]?.n || 0);
  }

  /** Tab / facet counts for the Communications inbox. Honours warehouse scope. */
  async adminFacets(warehouseScope) {
    const base = this.#adminWhere({ warehouseScope });
    const rows = await query(
      `SELECT
         COUNT(*) AS total,
         SUM(t.status IN ('OPEN','IN_PROGRESS','WAITING_CUSTOMER','WAITING_INTERNAL')) AS open,
         SUM(t.assigned_staff_id IS NULL AND t.status <> 'CLOSED') AS unassigned,
         SUM(t.status IN ('RESOLVED','CLOSED')) AS closed,
         SUM(t.status IN ('OPEN','IN_PROGRESS') AND (
           SELECT sm.author_type FROM support_messages sm WHERE sm.ticket_id = t.id ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1
         ) = 'CUSTOMER') AS needs_reply
       FROM support_tickets t
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN orders o ON o.id = t.order_id
       ${base.sql}`, base.params);
    const r = rows[0] || {};
    return {
      total: Number(r.total || 0),
      open: Number(r.open || 0),
      unassigned: Number(r.unassigned || 0),
      closed: Number(r.closed || 0),
      needsReply: Number(r.needs_reply || 0),
    };
  }

  listByCustomer(customerId) {
    return query(
      "SELECT id, ticket_number, category, status, subject, created_at FROM support_tickets WHERE customer_id = ? ORDER BY created_at DESC",
      [customerId]);
  }
}

export const supportRepository = new SupportRepository();
