import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { internalChatRepository, InternalChatRepository } from './repository.js';
import { StaffUserRepository, StaffWarehouseAssignmentRepository } from '../staff/repositories.js';
import { staffNotificationService } from '../staffNotifications/service.js';

const staffRepo = new StaffUserRepository();
const assignmentRepo = new StaffWarehouseAssignmentRepository();

const fullName = (r) => [r.first_name, r.last_name].filter(Boolean).join(' ').trim() || r.email;
const preview = (body) => String(body || '').replace(/\s+/g, ' ').trim().slice(0, 140);

/**
 * Internal staff-to-staff conversations (Phase B). A separate lightweight
 * messaging domain — it never touches support_tickets (customer-facing) or
 * order / warehouse authority. Every message to another participant raises a
 * per-staff notification (staff_notifications.staff_id); an @mention raises a
 * second MENTION-category one that feeds the Mentions tab.
 */
export class InternalChatService {
  constructor({ repository = internalChatRepository, notifications = staffNotificationService } = {}) {
    this.repository = repository;
    this.notifications = notifications;
  }

  #conversationDto(c, participants, meId) {
    const others = participants.filter((p) => p.staff_id !== meId);
    const title = c.subject
      || (c.kind === 'DIRECT'
        ? (others[0] ? fullName(others[0]) : 'Direct message')
        : others.map((p) => (p.first_name || p.email)).join(', ') || 'Group conversation');
    return {
      id: c.id,
      kind: c.kind,
      subject: c.subject ?? null,
      title,
      orderId: c.order_id ?? null,
      warehouseId: c.warehouse_id ?? null,
      createdBy: c.created_by,
      lastMessageAt: c.last_message_at ?? null,
      createdAt: c.created_at,
      participants: participants.map((p) => ({
        staffId: p.staff_id,
        name: fullName(p),
        email: p.email,
        role: p.staff_role,
        conversationRole: p.role,
        status: p.status,
      })),
    };
  }

  async listForStaff(staffId) {
    const rows = await this.repository.listForStaff(staffId);
    const conversations = rows.map((c) => ({
      id: c.id,
      kind: c.kind,
      subject: c.subject ?? null,
      title: c.subject || c.other_names || (c.kind === 'DIRECT' ? 'Direct message' : 'Group conversation'),
      participantCount: Number(c.participant_count || 0),
      orderId: c.order_id ?? null,
      warehouseId: c.warehouse_id ?? null,
      lastMessageAt: c.last_message_at ?? null,
      createdAt: c.created_at,
      unreadCount: Number(c.unread_count || 0),
      lastMessage: c.last_body
        ? { preview: preview(c.last_body), at: c.last_at, fromMe: c.last_sender_id === staffId }
        : null,
    }));
    return { conversations };
  }

  async unreadTotal(staffId) {
    return { count: await this.repository.unreadTotal(staffId) };
  }

  /** Staff directory for starting a conversation — minimal fields, ACTIVE only. */
  async directory({ excludeStaffId = null } = {}) {
    const all = await staffRepo.list();
    const staff = await Promise.all(all
      .filter((s) => s.status === 'ACTIVE' && s.id !== excludeStaffId)
      .map(async (s) => ({
        id: s.id,
        name: [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || s.email,
        email: s.email,
        role: s.role,
        warehouses: (await assignmentRepo.listForStaff(s.id)).map((w) => ({ id: w.warehouse_id, name: w.name, code: w.code })),
      })));
    return { staff };
  }

  /** Open (or reuse) a 1:1 conversation with another staff member. */
  async openDirect({ brandId, meId, otherStaffId, orderId = null, warehouseId = null }) {
    if (!otherStaffId || otherStaffId === meId) {
      throw new AppError('VALIDATION_ERROR', 'Choose another staff member to message.', 400);
    }
    const other = await staffRepo.findById(otherStaffId);
    if (!other || other.status !== 'ACTIVE') throw new AppError('STAFF_NOT_FOUND', 'That staff member was not found.', 404);
    const directKey = InternalChatRepository.directKey(meId, otherStaffId);

    const conversationId = await withTransaction(async (tx) => {
      const existing = await this.repository.directByKey(tx, directKey, brandId);
      if (existing) {
        // Attach an order reference if the caller supplied one and the thread has none yet.
        if (orderId && !existing.order_id) {
          await tx.execute('UPDATE internal_conversations SET order_id = ?, warehouse_id = COALESCE(warehouse_id, ?) WHERE id = ?', [orderId, warehouseId, existing.id]);
        }
        return existing.id;
      }
      const id = await this.repository.insertConversation(tx, {
        brandId, kind: 'DIRECT', subject: null, directKey, createdBy: meId, orderId, warehouseId,
      });
      await this.repository.addParticipant(tx, id, meId, 'OWNER');
      await this.repository.addParticipant(tx, id, otherStaffId, 'MEMBER');
      return id;
    });
    return this.getConversation({ meId, conversationId });
  }

  /** Create a group conversation. */
  async createGroup({ brandId, meId, subject, participantIds, orderId = null, warehouseId = null }) {
    const clean = [...new Set((participantIds || []).filter((x) => typeof x === 'string' && x && x !== meId))];
    if (clean.length < 1) throw new AppError('VALIDATION_ERROR', 'Add at least one other participant.', 400);
    if (clean.length > 20) throw new AppError('VALIDATION_ERROR', 'A group can have at most 20 other participants.', 400);
    const found = await Promise.all(clean.map((id) => staffRepo.findById(id)));
    if (found.some((s) => !s || s.status !== 'ACTIVE')) throw new AppError('STAFF_NOT_FOUND', 'One of the selected staff members was not found.', 404);

    const conversationId = await withTransaction(async (tx) => {
      const id = await this.repository.insertConversation(tx, {
        brandId, kind: 'GROUP', subject: (subject || '').trim() || null, directKey: null, createdBy: meId, orderId, warehouseId,
      });
      await this.repository.addParticipant(tx, id, meId, 'OWNER');
      for (const sid of clean) {
        // eslint-disable-next-line no-await-in-loop
        await this.repository.addParticipant(tx, id, sid, 'MEMBER');
      }
      return id;
    });
    return this.getConversation({ meId, conversationId });
  }

  async getConversation({ meId, conversationId }) {
    const conversation = await this.repository.conversationById(null, conversationId);
    if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
    if (!(await this.repository.isParticipant(null, conversationId, meId))) {
      throw new AppError('CONVERSATION_ACCESS_DENIED', 'You are not a participant in this conversation.', 403);
    }
    const [participants, messages] = await Promise.all([
      this.repository.participants(conversationId),
      this.repository.messages(conversationId),
    ]);
    const nameById = new Map(participants.map((p) => [p.staff_id, fullName(p)]));
    return {
      ...this.#conversationDto(conversation, participants, meId),
      messages: messages.map((m) => ({
        id: m.id,
        senderStaffId: m.sender_staff_id,
        senderName: [m.first_name, m.last_name].filter(Boolean).join(' ').trim() || m.email,
        fromMe: m.sender_staff_id === meId,
        body: m.body,
        mentions: (typeof m.mentions_json === 'string' ? JSON.parse(m.mentions_json) : m.mentions_json || [])
          .map((sid) => ({ staffId: sid, name: nameById.get(sid) || 'Someone' })),
        at: m.created_at,
      })),
    };
  }

  /** Post a message. `mentions` = explicit staff ids the sender @-tagged (must be participants). */
  async postMessage({ meId, conversationId, body, mentions = [] }) {
    const text = String(body || '').trim();
    if (!text) throw new AppError('VALIDATION_ERROR', 'A message is required.', 400);
    if (text.length > 5000) throw new AppError('VALIDATION_ERROR', 'Message is too long (5000 characters max).', 400);

    const result = await withTransaction(async (tx) => {
      const conversation = await this.repository.conversationById(tx, conversationId, { lock: true });
      if (!conversation) throw new AppError('CONVERSATION_NOT_FOUND', 'Conversation not found.', 404);
      const participants = await this.repository.participants(conversationId);
      const participantIds = new Set(participants.map((p) => p.staff_id));
      if (!participantIds.has(meId)) throw new AppError('CONVERSATION_ACCESS_DENIED', 'You are not a participant in this conversation.', 403);

      const cleanMentions = [...new Set((mentions || []).filter((x) => typeof x === 'string' && participantIds.has(x) && x !== meId))];
      const messageId = await this.repository.insertMessage(tx, { conversationId, senderStaffId: meId, body: text, mentions: cleanMentions });
      // The sender has, by definition, read their own message.
      await this.repository.setReadCursor(tx, conversationId, meId, messageId);
      return { conversation, participants, messageId, cleanMentions };
    });

    // Notifications (outside the txn — fire-and-forget, never block the send).
    const me = await staffRepo.findById(meId);
    const senderName = me ? ([me.first_name, me.last_name].filter(Boolean).join(' ').trim() || me.email) : 'A colleague';
    const link = `/communications?ic=${result.conversation.id}`;
    const others = result.participants.filter((p) => p.staff_id !== meId);
    const mentionSet = new Set(result.cleanMentions);

    await Promise.all(others.map((p) => this.notifications.record({
      category: mentionSet.has(p.staff_id) ? 'MENTION' : 'MESSAGE',
      eventKey: mentionSet.has(p.staff_id) ? 'INTERNAL_MENTION' : 'INTERNAL_MESSAGE',
      severity: 'INFO',
      title: mentionSet.has(p.staff_id)
        ? `${senderName} mentioned you`
        : `New message from ${senderName}`,
      body: preview(text),
      link,
      entityType: 'internal_conversation',
      entityId: result.conversation.id,
      staffId: p.staff_id,
      dedupeKey: `internal_msg:${result.messageId}:${p.staff_id}`,
    }).catch(() => {})));

    return this.getConversation({ meId, conversationId });
  }

  async markRead({ meId, conversationId, lastMessageId }) {
    if (!(await this.repository.isParticipant(null, conversationId, meId))) {
      throw new AppError('CONVERSATION_ACCESS_DENIED', 'You are not a participant in this conversation.', 403);
    }
    await withTransaction((tx) => this.repository.setReadCursor(tx, conversationId, meId, lastMessageId || null));
    return { ok: true };
  }
}

export const internalChatService = new InternalChatService();
