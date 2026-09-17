import { AppError } from '../../utils/errors.js';
import {
  CustomerRepository, CustomerContactRepository, CustomerIdentityRepository,
  CustomerNoteRepository, CustomerStatusChangeRepository, AuthSessionRepository,
} from './repositories.js';
import { AddressRepository } from '../addresses/repositories.js';
import { orderRepository } from '../orders/repository.js';
import { returnsRepository } from '../returns/repository.js';
import { storeCreditService } from '../storeCredit/service.js';
import { consentService } from '../consent/service.js';
import { newsletterService } from '../newsletter/service.js';
import { supportRepository } from '../support/repository.js';
import { reviewRepository } from '../reviews/repository.js';
import { segmentService } from '../segments/service.js';

const customers = new CustomerRepository();
const contacts = new CustomerContactRepository();
const identities = new CustomerIdentityRepository();
const notes = new CustomerNoteRepository();
const statusChanges = new CustomerStatusChangeRepository();
const sessions = new AuthSessionRepository();
const addresses = new AddressRepository();

const maskEmail = (v) => {
  if (!v) return null;
  const [user, domain] = String(v).split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
};
const maskPhone = (v) => (v ? `${String(v).slice(0, 3)}*****${String(v).slice(-2)}` : null);

/**
 * CMS customer operations. This is an AGGREGATION READ MODEL over the single
 * customer identity authority + the order / return / store-credit domains —
 * it never creates a second customer store (§8/§18/§19). Verified email/phone
 * are read-only here; changing them requires AuthService re-verification (§20).
 */
export class CustomerAdminService {
  async list({ search = null, status = null, limit = 50, offset = 0, brandId = null } = {}) {
    const rows = await customers.adminList({ search, status, limit, offset, brandId });
    // PII masked in the broad list context (§24).
    return rows.map((c) => ({
      id: c.id,
      name: [c.first_name, c.last_name].filter(Boolean).join(' ') || null,
      status: c.status,
      createdAt: c.created_at,
      email: maskEmail(c.verified_email),
      phone: maskPhone(c.verified_phone),
      orderCount: Number(c.order_count),
    }));
  }

  async detail(customerId) {
    const customer = await customers.findById(customerId);
    if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);

    const [contactRows, identityRows, addressRows, orderRows, returnRows, storeCredit, noteRows, statusRows, activeSessions, consentStates, subscriber] = await Promise.all([
      contacts.findForCustomer(customerId),
      identities.findByCustomer(customerId),
      addresses.findForCustomer(customerId).catch(() => []),
      orderRepository.listOwned(customerId),
      returnsRepository.listByCustomer(customerId),
      storeCreditService.getSummary(customerId).catch(() => ({ balanceMinor: 0, entries: [] })),
      notes.forCustomer(customerId),
      statusChanges.forCustomer(customerId),
      sessions.activeForCustomer(customerId),
      consentService.forCustomer(customerId).catch(() => []),
      newsletterService.forCustomer(customerId).catch(() => null),
    ]);
    const supportTickets = await supportRepository.listByCustomer(customerId).catch(() => []);
    const reviewRows = await reviewRepository.listByCustomer(customerId).catch(() => []);
    const segmentMatches = await segmentService.segmentsForCustomer(customerId).catch(() => []);

    return {
      id: customer.id,
      name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || null,
      firstName: customer.first_name,
      lastName: customer.last_name,
      status: customer.status,
      createdAt: customer.created_at,
      // Full (unmasked) contacts in the authorized detail view (§24).
      contacts: contactRows.map((c) => ({
        type: c.contact_type, value: c.value, verified: Boolean(c.is_verified),
        verifiedAt: c.verified_at, source: c.source,
      })),
      identities: identityRows.map((i) => ({ provider: i.provider, verifiedAt: i.verified_at })),
      addresses: addressRows.map((a) => ({
        type: a.type, name: [a.first_name, a.last_name].filter(Boolean).join(' '),
        line1: a.address_line1, line2: a.address_line2, city: a.city, district: a.district ?? null, state: a.state,
        postalCode: a.postal_code, country: a.country, isDefault: Boolean(a.is_default),
      })),
      activeSessionCount: activeSessions.length,
      orders: orderRows.map((o) => ({
        id: o.id, orderNumber: o.order_number, status: o.order_status,
        paymentStatus: o.payment_status, totalMinor: Number(o.total_minor), placedAt: o.placed_at,
        isExchangeOrder: Boolean(o.is_exchange_order),
      })),
      returns: returnRows.map((r) => ({
        id: r.id, requestNumber: r.request_number, orderId: r.order_id,
        requestType: r.request_type, status: r.status, qcResult: r.qc_result, requestedAt: r.requested_at,
      })),
      storeCredit: { balanceMinor: storeCredit.balanceMinor, recentEntries: (storeCredit.entries || []).slice(0, 10) },
      notes: noteRows.map((n) => ({ body: n.body, authorEmail: n.author_email, at: n.created_at })),
      statusHistory: statusRows.map((s) => ({ from: s.from_status, to: s.to_status, reason: s.reason, by: s.changed_by_email, at: s.created_at })),
      consent: consentStates.map((s) => ({ channel: s.channel, purpose: s.purpose, granted: s.granted, updatedAt: s.updatedAt ?? null })),
      subscriber: subscriber ? { email: subscriber.email, status: subscriber.status, source: subscriber.source } : null,
      support: supportTickets.map((t) => ({ id: t.id, ticketNumber: t.ticket_number, category: t.category, status: t.status, subject: t.subject, createdAt: t.created_at })),
      reviews: reviewRows.map((r) => ({
        id: r.id, productId: r.product_id, rating: Number(r.rating),
        title: r.title ?? null, status: r.status, createdAt: r.created_at, publishedAt: r.published_at ?? null,
      })),
      segments: segmentMatches.map((s) => ({ id: s.id, key: s.key, name: s.name })),
    };
  }

  async addNote({ customerId, staffId, body }) {
    const trimmed = String(body || '').trim();
    if (trimmed.length < 1 || trimmed.length > 2000) {
      throw new AppError('VALIDATION_ERROR', 'A note body of 1-2000 characters is required.', 400);
    }
    const customer = await customers.findById(customerId);
    if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);
    await notes.add({ customerId, authorStaffId: staffId, body: trimmed });
    return { ok: true };
  }

  /** Edit ONLY safe operational profile fields. Never contacts / status / identity (§20). */
  async updateProfile({ customerId, firstName, lastName }) {
    const customer = await customers.findById(customerId);
    if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);
    const updates = {};
    if (firstName !== undefined) updates.first_name = String(firstName).trim().slice(0, 120) || null;
    if (lastName !== undefined) updates.last_name = String(lastName).trim().slice(0, 120) || null;
    if (!Object.keys(updates).length) throw new AppError('VALIDATION_ERROR', 'Nothing to update.', 400);
    await customers.update(customerId, updates);
    return this.detail(customerId);
  }

  /**
   * ACTIVE <-> SUSPENDED with an explicit reason. SUSPENDED revokes every
   * active session immediately (§21). The customer row is never deleted.
   */
  async setStatus({ customerId, status, reason, staffId }) {
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) {
      throw new AppError('VALIDATION_ERROR', 'Status must be ACTIVE or SUSPENDED.', 400);
    }
    if (!reason || String(reason).trim().length < 3) {
      throw new AppError('VALIDATION_ERROR', 'A reason is required for a customer status change.', 400);
    }
    const customer = await customers.findById(customerId);
    if (!customer) throw new AppError('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);
    if (customer.status === status) return { status, revokedSessions: 0, unchanged: true };
    if (customer.status === 'PENDING_PROFILE' && status === 'ACTIVE') {
      throw new AppError('CUSTOMER_PROFILE_INCOMPLETE', 'Activation requires the customer to complete their profile.', 409);
    }
    await customers.update(customerId, { status });
    let revoked = 0;
    if (status === 'SUSPENDED') revoked = await sessions.revokeAllForCustomer(customerId);
    await statusChanges.add({
      customerId, fromStatus: customer.status, toStatus: status,
      reason: String(reason).trim().slice(0, 255), changedByStaffId: staffId,
    });
    return { status, revokedSessions: revoked, fromStatus: customer.status };
  }
}

export const customerAdminService = new CustomerAdminService();
