import { z } from 'zod';
import { StaffAuditRepository } from '../staff/repositories.js';
import { customerAdminService } from './adminService.js';

const audit = new StaffAuditRepository();
const ok = (res, data, status = 200) => res.status(status).json({ data });

const listQuery = z.object({
  search: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['PENDING_PROFILE', 'ACTIVE', 'SUSPENDED']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
}).default({});

const noteBody = z.object({ body: z.string().trim().min(1).max(2000) });
const profileBody = z.object({
  firstName: z.string().trim().max(120).optional(),
  lastName: z.string().trim().max(120).optional(),
});
const statusBody = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED']),
  reason: z.string().trim().min(3).max(255),
});
// Any attempt to change identity fields through the profile edit is rejected
// outright — verified email/phone go through AuthService re-verification (§20).
const IDENTITY_FIELDS = ['email', 'phone', 'contacts', 'contact', 'status', 'verified'];

export async function listCustomers(req, res, next) {
  try {
    ok(res, { customers: await customerAdminService.list({ ...listQuery.parse(req.query ?? {}), brandId: req.brandId }) });
  } catch (err) { next(err); }
}

export async function getCustomer(req, res, next) {
  try {
    ok(res, await customerAdminService.detail(req.params.id));
  } catch (err) { next(err); }
}

export async function updateCustomer(req, res, next) {
  try {
    if (IDENTITY_FIELDS.some((f) => f in (req.body ?? {}))) {
      return next(Object.assign(new Error('Verified identity fields cannot be changed here — use AuthService re-verification.'), {
        code: 'VERIFIED_IDENTITY_CHANGE_DENIED', status: 403,
      }));
    }
    const body = profileBody.parse(req.body ?? {});
    const result = await customerAdminService.updateProfile({ customerId: req.params.id, ...body });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'CUSTOMER_PROFILE_UPDATED', resourceType: 'customer', resourceId: req.params.id, ipAddress: req.ip });
    ok(res, result);
  } catch (err) { next(err); }
}

export async function addCustomerNote(req, res, next) {
  try {
    const { body } = noteBody.parse(req.body ?? {});
    await customerAdminService.addNote({ customerId: req.params.id, staffId: req.staff.id, body });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'CUSTOMER_NOTE_ADDED', resourceType: 'customer', resourceId: req.params.id, ipAddress: req.ip });
    ok(res, { ok: true }, 201);
  } catch (err) { next(err); }
}

export async function setCustomerStatus(req, res, next) {
  try {
    const { status, reason } = statusBody.parse(req.body ?? {});
    const result = await customerAdminService.setStatus({ customerId: req.params.id, status, reason, staffId: req.staff.id });
    await audit.log({
      staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'CUSTOMER_STATUS_CHANGED',
      resourceType: 'customer', resourceId: req.params.id,
      metadata: { to: status, revokedSessions: result.revokedSessions }, ipAddress: req.ip,
    });
    ok(res, result);
  } catch (err) { next(err); }
}
