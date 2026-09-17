import { randomUUID } from 'node:crypto';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { documentStorage } from '../documents/storage.js';
import { orderRepository } from '../orders/repository.js';
import { returnsRepository } from '../returns/repository.js';
import { supportRepository } from './repository.js';
import { SUPPORT_CATEGORIES } from './stateMachine.js';
import { staffNotificationService } from '../staffNotifications/service.js';

const stamp = () => new Date().toISOString().slice(0, 10).replaceAll('-', '');
const parse = (v) => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : v);

/**
 * Customer-facing support (§56). A customer only ever sees their own tickets
 * and only the CUSTOMER-visible messages (§52). Support references orders /
 * returns but never mutates them (§48/§58).
 */
// What a customer may attach to a ticket. Deliberately narrow: a photo of a
// damaged parcel or a PDF invoice covers what support actually needs, and
// every other type is a file we would be storing without a reason to.
//
// Checked on BOTH the declared content type and the extension. A browser
// will happily label anything, and the storage layer keys files by
// extension, so the two have to agree before any bytes are written.
export const SUPPORT_ATTACHMENT_TYPES = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
};
export const SUPPORT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const SUPPORT_ATTACHMENT_MAX_COUNT = 5;

const EXT_ALIASES = { jpeg: "jpg" };

export class SupportService {
  constructor({ repository = supportRepository, transaction = withTransaction } = {}) {
    this.repository = repository;
    this.transaction = transaction;
  }

  #ticketDto(ticket, messages, { includeAssignment = false, attachments = [] } = {}) {
    return {
      id: ticket.id,
      ticketNumber: ticket.ticket_number,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      subject: ticket.subject,
      orderId: ticket.order_id ?? null,
      returnRequestId: ticket.return_request_id ?? null,
      context: parse(ticket.context_snapshot_json),
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
      resolvedAt: ticket.resolved_at ?? null,
      ...(includeAssignment ? { assignedStaffId: ticket.assigned_staff_id ?? null } : {}),
      messages: (messages || []).map((m) => ({
        // Author identity is normalised for the customer — "you" vs "Support".
        author: m.author_type === 'CUSTOMER' ? 'YOU' : m.author_type === 'STAFF' ? 'SUPPORT' : 'SYSTEM',
        body: m.body,
        at: m.created_at,
        // Never a URL: the id goes back through an ownership-checked route.
        attachments: (attachments || [])
          .filter((a) => a.message_id === m.id)
          .map((a) => ({ id: a.id, fileName: a.file_name, contentType: a.content_type, byteSize: a.byte_size })),
      })),
    };
  }

  // Rejects the whole batch rather than silently dropping one file — a
  // customer who attached three photographs and got a ticket with two would
  // have no way to tell.
  static assertAttachments(files) {
    const list = files || [];
    if (!list.length) return list;
    if (list.length > SUPPORT_ATTACHMENT_MAX_COUNT) {
      throw new AppError('VALIDATION_ERROR', `You can attach at most ${SUPPORT_ATTACHMENT_MAX_COUNT} files.`, 400);
    }
    for (const f of list) {
      const ext = SUPPORT_ATTACHMENT_TYPES[f.mimetype];
      if (!ext) {
        throw new AppError('VALIDATION_ERROR', `"${f.originalname || 'That file'}" is not a PNG, JPG or PDF.`, 400);
      }
      const named = String(f.originalname || '').split('.').pop().toLowerCase();
      if ((EXT_ALIASES[named] || named) !== ext) {
        throw new AppError('VALIDATION_ERROR', `"${f.originalname}" does not match its file type.`, 400);
      }
      if (!f.buffer?.length) {
        throw new AppError('VALIDATION_ERROR', `"${f.originalname}" is empty.`, 400);
      }
      if (f.buffer.length > SUPPORT_ATTACHMENT_MAX_BYTES) {
        throw new AppError('VALIDATION_ERROR', `"${f.originalname}" is larger than 10 MB.`, 400);
      }
    }
    return list;
  }

  // Bytes go to the private document boundary; only the opaque key is kept.
  async #storeAttachments(tx, { ticketId, messageId, files }) {
    for (const f of files || []) {
      const stored = await documentStorage.put(
        documentStorage.newKey(SUPPORT_ATTACHMENT_TYPES[f.mimetype]), f.buffer,
      );
      await this.repository.insertAttachment(tx, {
        ticketId, messageId, storageKey: stored.key, sha256: stored.sha256, byteSize: stored.byteSize,
        fileName: String(f.originalname || 'attachment').slice(0, 255), contentType: f.mimetype,
      });
    }
  }

  /** One attachment, readable only through a ticket the customer owns. */
  async attachment(customerId, attachmentId) {
    const row = await this.repository.ownedAttachment(customerId, attachmentId);
    if (!row) throw new AppError('SUPPORT_ATTACHMENT_NOT_FOUND', 'Attachment not found.', 404);
    return { ...row, bytes: await documentStorage.get(row.storage_key) };
  }

  async createTicket({ customerId, category, subject, body, orderId = null, returnRequestId = null, idempotencyKey, attachments = [] }) {
    if (!SUPPORT_CATEGORIES.includes(category)) throw new AppError('VALIDATION_ERROR', `Unknown support category "${category}".`, 400);
    if (!subject || subject.trim().length < 3) throw new AppError('VALIDATION_ERROR', 'A subject is required.', 400);
    if (!body || body.trim().length < 3) throw new AppError('VALIDATION_ERROR', 'A message is required.', 400);
    if (!idempotencyKey || String(idempotencyKey).length < 8) throw new AppError('VALIDATION_ERROR', 'A valid idempotency key is required.', 400);

    const scopedKey = `sup:${customerId}:${idempotencyKey}`;

    return this.transaction(async (tx) => {
      const replay = await this.repository.ticketByIdempotencyKey(tx, scopedKey);
      if (replay) return this.#ticketDto(replay, await this.repository.messages(replay.id, { visibility: 'CUSTOMER', connection: tx }));

      // Ownership-checked links + a small frozen context (§57) — never a
      // mutable copy of order data.
      let contextSnapshot = null;
      let linkedOrderId = null;
      let linkedReturnId = null;
      let warehouseId = null;
      if (orderId) {
        const order = await orderRepository.findOwned(customerId, orderId);
        if (!order) throw new AppError('ORDER_NOT_FOUND', 'That order was not found.', 404);
        linkedOrderId = order.id;
        contextSnapshot = { orderNumber: order.order_number, orderStatusAtOpen: order.order_status };
        // Scope the ticket to the warehouse the order is being fulfilled from
        // (migration 070) — a reference only, never a copy of order data.
        warehouseId = await supportRepository.warehouseForOrder(tx, order.id).catch(() => null);
      }
      if (returnRequestId) {
        const rr = await returnsRepository.ownedRequest(customerId, returnRequestId);
        if (!rr) throw new AppError('RETURN_REQUEST_NOT_FOUND', 'That return request was not found.', 404);
        linkedReturnId = rr.id;
        contextSnapshot = { ...(contextSnapshot || {}), returnNumber: rr.request_number, returnStatusAtOpen: rr.status };
      }

      // Multi-company (DESIGN.md §4.1) — Phase 4. Prefix comes from the
      // customer's own brand (migration 081's brands.order_prefix), same
      // fix as orders/repository.js's order_number — a Cor-Znix ticket
      // should never read "COR-SUP-...".
      const [customerBrand] = await tx.execute('SELECT b.order_prefix FROM customers c JOIN brands b ON b.id = c.brand_id WHERE c.id = ?', [customerId]).then((r) => r[0]);
      const ticketPrefix = customerBrand?.order_prefix || 'ORD';
      const ticketNumber = `${ticketPrefix}-SUP-${stamp()}-${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
      let ticket;
      try {
        ticket = await this.repository.insertTicket(tx, {
          ticketNumber, customerId, category, priority: 'NORMAL', subject: subject.trim(),
          orderId: linkedOrderId, returnRequestId: linkedReturnId, warehouseId, contextSnapshot, idempotencyKey: scopedKey,
        });
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
          const raced = await this.repository.ticketByIdempotencyKey(tx, scopedKey);
          if (raced) return this.#ticketDto(raced, await this.repository.messages(raced.id, { visibility: 'CUSTOMER', connection: tx }));
        }
        throw err;
      }
      const messageId = await this.repository.insertMessage(tx, { ticketId: ticket.id, authorType: 'CUSTOMER', authorId: customerId, visibility: 'CUSTOMER', body: body.trim() });
      await this.#storeAttachments(tx, { ticketId: ticket.id, messageId, files: attachments });
      await this.repository.recordEvent(tx, ticket.id, { eventType: 'TICKET_CREATED', toStatus: 'OPEN', actorType: 'CUSTOMER', actorId: customerId });
      // Communication intent seam (§60) — no real send here.
      await this.repository.recordEvent(tx, ticket.id, { eventType: 'COMM_INTENT', actorType: 'SYSTEM', detail: { intent: 'TICKET_CREATED' } });

      // Surface the new query to staff (Communications inbox bell). Warehouse
      // -scoped when the linked order is allocated, else company-wide. Never
      // blocks ticket creation.
      await staffNotificationService.record({
        category: 'SUPPORT', eventKey: 'SUPPORT_TICKET_CREATED', severity: 'INFO',
        title: `New ${category === 'GENERAL' ? 'support' : category.toLowerCase()} query — ${ticket.ticket_number}`,
        body: subject.trim(),
        link: `/communications?c=${ticket.id}`,
        entityType: 'support_ticket', entityId: ticket.id,
        warehouseId: warehouseId || null,
        dedupeKey: `support_created:${ticket.id}`,
      }).catch(() => {});

      return this.#ticketDto(
        ticket,
        await this.repository.messages(ticket.id, { visibility: 'CUSTOMER', connection: tx }),
        { attachments: await this.repository.attachmentsForTicket(ticket.id, { connection: tx }) },
      );
    });
  }

  async getTicket(customerId, idOrNumber) {
    const ticket = await this.repository.ownedTicket(customerId, idOrNumber);
    if (!ticket) throw new AppError('SUPPORT_TICKET_NOT_FOUND', 'Support ticket not found.', 404);
    return this.#ticketDto(
      ticket,
      await this.repository.messages(ticket.id, { visibility: 'CUSTOMER' }),
      { attachments: await this.repository.attachmentsForTicket(ticket.id) },
    );
  }

  async listTickets(customerId) {
    return (await this.repository.listOwned(customerId)).map((t) => ({
      id: t.id, ticketNumber: t.ticket_number, category: t.category, priority: t.priority,
      status: t.status, subject: t.subject, updatedAt: t.updated_at,
    }));
  }

  /** Customer reply. A reply to a WAITING_CUSTOMER ticket re-opens it. */
  async reply({ customerId, idOrNumber, body, attachments = [] }) {
    if (!body || body.trim().length < 1) throw new AppError('VALIDATION_ERROR', 'A message is required.', 400);
    const owned = await this.repository.ownedTicket(customerId, idOrNumber);
    if (!owned) throw new AppError('SUPPORT_TICKET_NOT_FOUND', 'Support ticket not found.', 404);

    return this.transaction(async (tx) => {
      const ticket = await this.repository.ticketById(tx, owned.id, { lock: true });
      if (ticket.status === 'CLOSED') throw new AppError('SUPPORT_TICKET_CLOSED', 'This ticket is closed. Open a new one if you still need help.', 409);
      const messageId = await this.repository.insertMessage(tx, { ticketId: ticket.id, authorType: 'CUSTOMER', authorId: customerId, visibility: 'CUSTOMER', body: body.trim() });
      await this.#storeAttachments(tx, { ticketId: ticket.id, messageId, files: attachments });
      const next = ['WAITING_CUSTOMER', 'RESOLVED'].includes(ticket.status) ? 'IN_PROGRESS' : ticket.status;
      if (next !== ticket.status) {
        await this.repository.updateTicket(tx, ticket.id, { status: next });
        await this.repository.recordEvent(tx, ticket.id, { eventType: 'STATUS_TRANSITION', fromStatus: ticket.status, toStatus: next, actorType: 'CUSTOMER', actorId: customerId });
      }
      await this.repository.recordEvent(tx, ticket.id, { eventType: 'CUSTOMER_REPLIED', actorType: 'CUSTOMER', actorId: customerId });
      await this.repository.recordEvent(tx, ticket.id, { eventType: 'COMM_INTENT', actorType: 'SYSTEM', detail: { intent: 'CUSTOMER_REPLIED' } });

      // Notify the assigned agent (private) that the customer replied — or the
      // warehouse team / everyone if the ticket is unassigned.
      await staffNotificationService.record({
        category: 'SUPPORT', eventKey: 'SUPPORT_CUSTOMER_REPLIED', severity: 'INFO',
        title: `Customer replied — ${ticket.ticket_number}`,
        body: body.trim(),
        link: `/communications?c=${ticket.id}`,
        entityType: 'support_ticket', entityId: ticket.id,
        staffId: ticket.assigned_staff_id || null,
        warehouseId: ticket.assigned_staff_id ? null : (ticket.warehouse_id || null),
        dedupeKey: `support_customer_reply:${ticket.id}:${Date.now()}`,
      }).catch(() => {});

      return this.#ticketDto({ ...ticket, status: next }, await this.repository.messages(ticket.id, { visibility: 'CUSTOMER', connection: tx }));
    });
  }
}

export const supportService = new SupportService();
