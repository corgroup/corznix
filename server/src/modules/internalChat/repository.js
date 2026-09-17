import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

const exec = async (connection, sql, params = []) =>
  (connection ? (await connection.execute(sql, params))[0] : query(sql, params));

// Data access for internal staff-to-staff conversations (migration 070).
export class InternalChatRepository {
  /** Canonical dedupe key for a DIRECT thread between two staff ids. */
  static directKey(a, b) {
    return [String(a), String(b)].sort().join(':');
  }

  conversationById(connection, id, { lock = false } = {}) {
    return exec(connection,
      `SELECT * FROM internal_conversations WHERE id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [id])
      .then((r) => r[0] || null);
  }

  directByKey(connection, directKey, brandId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to look up a conversation.', 500);
    return exec(connection,
      'SELECT * FROM internal_conversations WHERE direct_key = ? AND brand_id = ? LIMIT 1', [directKey, brandId])
      .then((r) => r[0] || null);
  }

  // Multi-company (DESIGN.md §4.1) — Phase 4. brandId required — the
  // ADMIN's own resolved company context (resolveBrandContext, Phase 2), so
  // the same two staff members get a SEPARATE thread per company.
  async insertConversation(connection, { brandId, kind, subject, directKey, createdBy, orderId, warehouseId }) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to create a conversation.', 500);
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO internal_conversations (id, brand_id, kind, subject, direct_key, created_by, order_id, warehouse_id, last_message_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [id, brandId, kind, subject ?? null, directKey ?? null, createdBy, orderId ?? null, warehouseId ?? null]);
    return id;
  }

  async addParticipant(connection, conversationId, staffId, role = 'MEMBER') {
    await exec(connection,
      `INSERT IGNORE INTO internal_conversation_participants (conversation_id, staff_id, role)
       VALUES (?, ?, ?)`,
      [conversationId, staffId, role]);
  }

  isParticipant(connection, conversationId, staffId) {
    return exec(connection,
      'SELECT 1 FROM internal_conversation_participants WHERE conversation_id = ? AND staff_id = ? LIMIT 1',
      [conversationId, staffId]).then((r) => r.length > 0);
  }

  participants(conversationId) {
    return query(
      `SELECT p.staff_id, p.role, p.last_read_message_id, p.added_at,
              s.first_name, s.last_name, s.email, s.role AS staff_role, s.status
         FROM internal_conversation_participants p
         JOIN staff_users s ON s.id = p.staff_id
        WHERE p.conversation_id = ?
        ORDER BY p.added_at, s.first_name`,
      [conversationId]);
  }

  async insertMessage(connection, { conversationId, senderStaffId, body, mentions }) {
    const id = randomUUID();
    await exec(connection,
      `INSERT INTO internal_messages (id, conversation_id, sender_staff_id, body, mentions_json)
       VALUES (?, ?, ?, ?, ?)`,
      [id, conversationId, senderStaffId, body, mentions?.length ? JSON.stringify(mentions) : null]);
    await exec(connection,
      'UPDATE internal_conversations SET last_message_at = NOW(3), updated_at = NOW(3) WHERE id = ?',
      [conversationId]);
    return id;
  }

  messages(conversationId, { connection = null } = {}) {
    return exec(connection,
      `SELECT m.id, m.sender_staff_id, m.body, m.mentions_json, m.created_at,
              s.first_name, s.last_name, s.email
         FROM internal_messages m
         JOIN staff_users s ON s.id = m.sender_staff_id
        WHERE m.conversation_id = ?
        ORDER BY m.created_at, m.id`,
      [conversationId]);
  }

  setReadCursor(connection, conversationId, staffId, messageId) {
    return exec(connection,
      `UPDATE internal_conversation_participants
          SET last_read_message_id = ?
        WHERE conversation_id = ? AND staff_id = ?`,
      [messageId, conversationId, staffId]);
  }

  /**
   * Conversation list for one staff member, newest activity first, with a
   * per-conversation unread count and a last-message preview. One query, no
   * N+1.
   */
  listForStaff(staffId, { limit = 100 } = {}) {
    const safe = Math.min(Math.max(Number(limit) || 100, 1), 200);
    return query(
      `SELECT c.id, c.kind, c.subject, c.order_id, c.warehouse_id,
              c.created_by, c.last_message_at, c.created_at,
              me.last_read_message_id,
              (
                SELECT GROUP_CONCAT(
                  NULLIF(TRIM(CONCAT_WS(' ', os.first_name, os.last_name)), '')
                  ORDER BY os.first_name SEPARATOR ', ')
                  FROM internal_conversation_participants op
                  JOIN staff_users os ON os.id = op.staff_id
                 WHERE op.conversation_id = c.id AND op.staff_id <> ?
              ) AS other_names,
              (SELECT COUNT(*) FROM internal_conversation_participants ap WHERE ap.conversation_id = c.id) AS participant_count,
              lm.body AS last_body, lm.created_at AS last_at, lm.sender_staff_id AS last_sender_id,
              (
                SELECT COUNT(*) FROM internal_messages um
                 WHERE um.conversation_id = c.id
                   AND um.sender_staff_id <> ?
                   AND (
                     me.last_read_message_id IS NULL
                     OR um.created_at > (
                       SELECT rm.created_at FROM internal_messages rm WHERE rm.id = me.last_read_message_id
                     )
                   )
              ) AS unread_count
         FROM internal_conversation_participants me
         JOIN internal_conversations c ON c.id = me.conversation_id
         LEFT JOIN internal_messages lm ON lm.id = (
           SELECT im.id FROM internal_messages im
            WHERE im.conversation_id = c.id
            ORDER BY im.created_at DESC, im.id DESC LIMIT 1
         )
        WHERE me.staff_id = ?
        ORDER BY (c.last_message_at IS NULL) ASC, c.last_message_at DESC, c.created_at DESC
        LIMIT ${safe}`,
      [staffId, staffId, staffId]);
  }

  /** Total unread internal messages across every conversation this staff is in. */
  async unreadTotal(staffId) {
    const rows = await query(
      `SELECT COUNT(*) AS n
         FROM internal_conversation_participants me
         JOIN internal_messages um ON um.conversation_id = me.conversation_id
        WHERE me.staff_id = ?
          AND um.sender_staff_id <> ?
          AND (
            me.last_read_message_id IS NULL
            OR um.created_at > (SELECT rm.created_at FROM internal_messages rm WHERE rm.id = me.last_read_message_id)
          )`,
      [staffId, staffId]);
    return Number(rows[0]?.n || 0);
  }
}

export const internalChatRepository = new InternalChatRepository();
