import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { supportRepository } from './repository.js';
import { assertSupportTransition, SUPPORT_PRIORITIES } from './stateMachine.js';
import { CustomerContactRepository, CustomerRepository } from '../customers/repositories.js';
import { StaffUserRepository, StaffWarehouseAssignmentRepository } from '../staff/repositories.js';
import { communicationService } from '../communications/service.js';
import { staffNotificationService } from '../staffNotifications/service.js';

const contactRepo = new CustomerContactRepository();
const customerRepo = new CustomerRepository();
const staffRepo = new StaffUserRepository();
const assignmentRepo = new StaffWarehouseAssignmentRepository();

const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);
const maskEmail = (e) => {
  if (!e || !e.includes('@')) return e || null;
  const [local, domain] = e.split('@');
  const head = local.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
};
const staffName = (s) => (s ? ([s.first_name, s.last_name].filter(Boolean).join(' ').trim() || s.email) : null);

/**
 * Staff support operations (§59). Assign / reply / internal note / priority /
 * status only — no refund or order mutation ever flows through here (§59).
 */
export class SupportAdminService {
  constructor({ repository = supportRepository, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.transaction = transaction;
  }

  async list(filters = {}) {
    const [rows, total] = await Promise.all([
      this.repository.adminList(filters),
      this.repository.adminCount(filters),
    ]);
    return {
      total,
      tickets: rows.map((t) => ({
        id: t.id,
        ticketNumber: t.ticket_number,
        customerId: t.customer_id,
        customerName: t.customer_name?.trim() || null,
        category: t.category,
        priority: t.priority,
        status: t.status,
        subject: t.subject,
        orderId: t.order_id ?? null,
        orderNumber: t.order_number ?? null,
        returnRequestId: t.return_request_id ?? null,
        warehouseId: t.warehouse_id ?? null,
        warehouseName: t.warehouse_name ?? null,
        assignedStaffId: t.assigned_staff_id ?? null,
        assignedEmail: t.assigned_email ?? null,
        assignedName: t.assigned_name?.trim() || null,
        messageCount: Number(t.message_count || 0),
        lastMessagePreview: t.last_body ? String(t.last_body).replace(/\s+/g, ' ').trim().slice(0, 140) : null,
        lastMessageAuthor: t.last_author ?? null,
        lastMessageAt: t.last_at ?? null,
        needsReply: Boolean(Number(t.needs_reply || 0)),
        firstResponseAt: t.first_response_at ?? null,
        createdAt: t.created_at,
        updatedAt: t.updated_at,
      })),
    };
  }

  facets(warehouseScope) {
    return this.repository.adminFacets(warehouseScope);
  }

  async detail(idOrNumber) {
    const ticket = await this.repository.ticketById(null, idOrNumber);
    if (!ticket) throw new AppError('SUPPORT_TICKET_NOT_FOUND', 'Support ticket not found.', 404);
    const [messages, events, customer, contacts, assignedStaff, warehouseStaff, attachments] = await Promise.all([
      this.repository.messages(ticket.id),
      this.repository.events(ticket.id),
      customerRepo.findById(ticket.customer_id).catch(() => null),
      contactRepo.findForCustomer(ticket.customer_id).catch(() => []),
      ticket.assigned_staff_id ? staffRepo.findById(ticket.assigned_staff_id).catch(() => null) : null,
      ticket.warehouse_id ? assignmentRepo.staffForWarehouse(ticket.warehouse_id).catch(() => []) : [],
      this.repository.attachmentsForTicket(ticket.id).catch(() => []),
    ]);
    const email = (contacts || []).find((c) => c.contact_type === 'EMAIL');
    const phone = (contacts || []).find((c) => c.contact_type === 'PHONE');
    return {
      id: ticket.id,
      ticketNumber: ticket.ticket_number,
      customerId: ticket.customer_id,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      subject: ticket.subject,
      orderId: ticket.order_id ?? null,
      returnRequestId: ticket.return_request_id ?? null,
      warehouseId: ticket.warehouse_id ?? null,
      context: parse(ticket.context_snapshot_json),
      assignedStaffId: ticket.assigned_staff_id ?? null,
      assignedStaffName: staffName(assignedStaff),
      assignmentVersion: Number(ticket.assignment_version),
      firstResponseAt: ticket.first_response_at ?? null,
      resolvedAt: ticket.resolved_at ?? null,
      closedAt: ticket.closed_at ?? null,
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      customer: customer ? {
        id: customer.id,
        name: [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim() || 'Customer',
        status: customer.status,
        emailMasked: maskEmail(email?.normalized_value),
        emailVerified: Boolean(email?.is_verified),
        phoneMasked: phone ? `••••${String(phone.normalized_value).slice(-4)}` : null,
        phoneVerified: Boolean(phone?.is_verified),
      } : null,
      warehouseStaff: (warehouseStaff || []).map((s) => ({
        id: s.id, name: staffName(s), email: s.email, role: s.role,
      })),
      // A customer who photographs a torn seam is sending evidence; an agent
      // who cannot see it has to ask them to email it somewhere else. The id
      // goes back through a permission-checked download route, never a URL.
      messages: messages.map((m) => ({
        authorType: m.author_type, authorId: m.author_id ?? null,
        visibility: m.visibility, body: m.body, at: m.created_at,
        attachments: (attachments || [])
          .filter((a) => a.message_id === m.id)
          .map((a) => ({ id: a.id, fileName: a.file_name, contentType: a.content_type, byteSize: a.byte_size })),
      })),
      events: events.map((e) => ({
        eventType: e.event_type, fromStatus: e.from_status ?? null, toStatus: e.to_status ?? null,
        actorType: e.actor_type, detail: parse(e.detail_json), at: e.created_at,
      })),
    };
  }

  /** Compare-and-set assignment (§55) — the caller passes the version it read. */
  async assign({ ticketIdOrNumber, staffId, expectedVersion, actorStaffId }) {
    return this.transaction(async (tx) => {
      const ticket = await this.repository.ticketById(tx, ticketIdOrNumber, { lock: true });
      if (!ticket) throw new AppError('SUPPORT_TICKET_NOT_FOUND', 'Support ticket not found.', 404);
      if (Number(ticket.assignment_version) !== Number(expectedVersion)) {
        throw new AppError('SUPPORT_ASSIGNMENT_CONFLICT', 'This ticket was reassigned by someone else. Refresh and try again.', 409);
      }
      const won = await this.repository.assign(tx, ticket.id, { staffId, expectedVersion });
      if (!won) throw new AppError('SUPPORT_ASSIGNMENT_CONFLICT', 'This ticket was reassigned by someone else. Refresh and try again.', 409);
      await this.repository.recordEvent(tx, ticket.id, {
        eventType: 'ASSIGNED', actorType: 'STAFF', actorId: actorStaffId,
        detail: { from: ticket.assigned_staff_id, to: staffId },
      });
      if (staffId && staffId !== actorStaffId) {
        await staffNotificationService.record({
          category: 'SUPPORT', eventKey: 'SUPPORT_TICKET_ASSIGNED', severity: 'INFO',
          title: `Assigned to you — ${ticket.ticket_number}`,
          body: ticket.subject,
          link: `/communications?c=${ticket.id}`,
          entityType: 'support_ticket', entityId: ticket.id,
          staffId,
          dedupeKey: `support_assigned:${ticket.id}:${staffId}:${Date.now()}`,
        }).catch(() => {});
      }
      return { assignedStaffId: staffId, assignmentVersion: Number(ticket.assignment_version) + 1 };
    });
  }

  async setPriority({ ticketIdOrNumber, priority, actorStaffId }) {
    if (!SUPPORT_PRIORITIES.includes(priority)) throw new AppError('VALIDATION_ERROR', 'Unknown priority.', 400);
    return this.transaction(async (tx) => {
      const ticket = await this.repository.ticketById(tx, ticketIdOrNumber, { lock: true });
      if (!ticket) throw new AppError('SUPPORT_TICKET_NOT_FOUND', 'Support ticket not found.', 404);
      if (ticket.priority === priority) return { priority };
      await this.repository.updateTicket(tx, ticket.id, { priority });
      await this.repository.recordEvent(tx, ticket.id, { eventType: 'PRIORITY_CHANGED', actorType: 'STAFF', actorId: actorStaffId, detail: { from: ticket.priority, to: priority } });
      return { priority };
    });
  }

  async reply({ ticketIdOrNumber, body, visibility, actorStaffId, notifyWarehouse = false }) {
    if (!['CUSTOMER', 'INTERNAL'].includes(visibility)) throw new AppError('VALIDATION_ERROR', 'visibility must be CUSTOMER or INTERNAL.', 400);
    if (!body || body.trim().length < 1) throw new AppError('VALIDATION_ERROR', 'A message is required.', 400);
    const result = await this.transaction(async (tx) => {
      const ticket = await this.repository.ticketById(tx, ticketIdOrNumber, { lock: true });
      if (!ticket) throw new AppError('SUPPORT_TICKET_NOT_FOUND', 'Support ticket not found.', 404);
      const messageId = await this.repository.insertMessage(tx, { ticketId: ticket.id, authorType: 'STAFF', authorId: actorStaffId, visibility, body: body.trim() });
      await this.repository.recordEvent(tx, ticket.id, { eventType: visibility === 'CUSTOMER' ? 'STAFF_REPLIED' : 'INTERNAL_NOTE_ADDED', actorType: 'STAFF', actorId: actorStaffId });

      const fields = {};
      if (visibility === 'CUSTOMER') {
        if (!ticket.first_response_at) fields.first_response_at = new Date();
        if (['OPEN', 'IN_PROGRESS', 'WAITING_INTERNAL'].includes(ticket.status)) {
          fields.status = 'WAITING_CUSTOMER';
        }
        await this.repository.recordEvent(tx, ticket.id, { eventType: 'COMM_INTENT', actorType: 'SYSTEM', detail: { intent: 'STAFF_REPLIED' } });
        // Wave 8G-7: enqueue the transactional "support replied" notification
        // in the SAME transaction as the reply (outbox atomicity, §130). Never
        // blocks the reply — a missing template / unverified email is silent.
        await this.#notifySupportReply(tx, ticket, messageId).catch(() => {});
      }
      if (fields.status && fields.status !== ticket.status) {
        await this.repository.recordEvent(tx, ticket.id, { eventType: 'STATUS_TRANSITION', fromStatus: ticket.status, toStatus: fields.status, actorType: 'STAFF', actorId: actorStaffId });
      }
      if (Object.keys(fields).length) await this.repository.updateTicket(tx, ticket.id, fields);
      return this.detail(ticket.id);
    });

    // "Notify the warehouse team" — an internal note the operator explicitly
    // flags for the responsible warehouse. Warehouse-scoped staff notification,
    // never leaves the CMS. No-op if the ticket has no warehouse.
    if (notifyWarehouse && visibility === 'INTERNAL' && result.warehouseId) {
      await staffNotificationService.record({
        category: 'SUPPORT', eventKey: 'SUPPORT_WAREHOUSE_MENTIONED', severity: 'WARNING',
        title: `Support needs your help — ${result.ticketNumber}`,
        body: body.trim(),
        link: `/communications?c=${result.id}`,
        entityType: 'support_ticket', entityId: result.id,
        warehouseId: result.warehouseId,
        dedupeKey: `support_wh_mention:${result.id}:${Date.now()}`,
      }).catch(() => {});
    }
    return result;
  }

  async #notifySupportReply(tx, ticket, messageId) {
    const contacts = await contactRepo.findForCustomer(ticket.customer_id);
    const email = contacts.find((c) => c.contact_type === 'EMAIL' && c.is_verified);
    if (!email) return;
    await communicationService.enqueue({
      businessEventId: `support_reply:${messageId}`,
      policyKey: 'support.reply',
      classification: 'TRANSACTIONAL',
      channel: 'EMAIL',
      templateKey: 'support.reply',
      recipient: { customerId: ticket.customer_id, contactKey: email.normalized_value },
      variables: { ticketNumber: ticket.ticket_number, subject: ticket.subject },
    }, tx);
  }

  /** Named status transition (§51) — validated against the state machine. */
  async transition({ ticketIdOrNumber, toStatus, actorStaffId }) {
    return this.transaction(async (tx) => {
      const ticket = await this.repository.ticketById(tx, ticketIdOrNumber, { lock: true });
      if (!ticket) throw new AppError('SUPPORT_TICKET_NOT_FOUND', 'Support ticket not found.', 404);
      if (ticket.status === toStatus) return { status: toStatus };
      assertSupportTransition(ticket.status, toStatus);
      const fields = { status: toStatus };
      if (toStatus === 'RESOLVED') fields.resolved_at = new Date();
      if (toStatus === 'CLOSED') fields.closed_at = new Date();
      if (toStatus === 'IN_PROGRESS' && ['RESOLVED', 'CLOSED'].includes(ticket.status)) { fields.resolved_at = null; fields.closed_at = null; }
      await this.repository.updateTicket(tx, ticket.id, fields);
      await this.repository.recordEvent(tx, ticket.id, { eventType: 'STATUS_TRANSITION', fromStatus: ticket.status, toStatus, actorType: 'STAFF', actorId: actorStaffId });
      if (toStatus === 'RESOLVED') {
        await this.repository.recordEvent(tx, ticket.id, { eventType: 'COMM_INTENT', actorType: 'SYSTEM', detail: { intent: 'TICKET_RESOLVED' } });
      }
      return { status: toStatus };
    });
  }
}

export const supportAdminService = new SupportAdminService();
