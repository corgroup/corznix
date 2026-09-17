import { z } from 'zod';
import { StaffAuditRepository } from '../staff/repositories.js';
import { taxProfileService } from './service.js';

const audit = new StaffAuditRepository();
const ok = (res, data, status = 200) => res.status(status).json({ data });

// One price band: GST rate up to a per-piece taxable value (paise). The last
// band has no upper limit (null). Order and limits are checked in rateBands.js.
const rateBand = z.object({
  maxUnitTaxableMinor: z.union([z.null(), z.coerce.number().int().positive()]),
  gstRateBps: z.coerce.number().int().min(0).max(5000),
});
const profileFields = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(255).optional(),
  hsnSac: z.string().trim().regex(/^\d{4,8}$/, 'HSN/SAC must be 4–8 digits.'),
  taxability: z.enum(['TAXABLE', 'EXEMPT', 'NIL_RATED', 'ZERO_RATED']).optional(),
  // A single rate, or price bands (e.g. up to ₹2,500 per piece 5%, above 18%).
  gstRateBps: z.coerce.number().int().min(0).max(5000).optional(),
  rateBands: z.array(rateBand).max(6).optional(),
  // Optional — defaults to today. The GST rate applies to orders placed on or
  // after this date.
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
const createBody = profileFields.refine(
  (b) => b.gstRateBps !== undefined || (b.rateBands?.length ?? 0) >= 2,
  { message: 'Enter a GST rate, or at least two price bands.', path: ['gstRateBps'] },
);
const patchBody = profileFields.partial().extend({ status: z.enum(['ACTIVE', 'DISABLED']).optional() });
const assignBody = z.object({ productId: z.string().uuid(), taxProfileId: z.string().uuid() });

export async function listProfiles(req, res, next) {
  try { ok(res, { taxProfiles: await taxProfileService.list(req.brandId) }); } catch (e) { next(e); }
}
export async function getProfile(req, res, next) {
  try { ok(res, await taxProfileService.get(req.params.id, req.brandId)); } catch (e) { next(e); }
}
export async function createProfile(req, res, next) {
  try {
    const parsed = createBody.parse(req.body);
    const effectiveFrom = parsed.effectiveFrom || new Date().toISOString().slice(0, 10);
    const p = await taxProfileService.create({ ...parsed, effectiveFrom, createdByStaffId: req.staff.id, brandId: req.brandId });
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'TAX_PROFILE_CREATED', resourceType: 'tax_profile', resourceId: p.id, metadata: { hsn: p.hsn_sac, rateBps: p.gst_rate_bps, rateBands: p.rateBands }, ipAddress: req.ip });
    ok(res, p, 201);
  } catch (e) { next(e); }
}
export async function patchProfile(req, res, next) {
  try {
    const body = patchBody.parse(req.body);
    const p = await taxProfileService.update(req.params.id, body);
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'TAX_PROFILE_UPDATED', resourceType: 'tax_profile', resourceId: req.params.id, metadata: { fields: Object.keys(body), rateBands: p?.rateBands }, ipAddress: req.ip });
    ok(res, p);
  } catch (e) { next(e); }
}
export async function assignProduct(req, res, next) {
  try {
    const { productId, taxProfileId } = assignBody.parse(req.body);
    await taxProfileService.assignProduct(productId, taxProfileId, req.staff.id);
    await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'TAX_PROFILE_ASSIGNED', resourceType: 'product', resourceId: productId, metadata: { taxProfileId }, ipAddress: req.ip });
    ok(res, { productId, taxProfileId });
  } catch (e) { next(e); }
}
export async function unassignProduct(req, res, next) {
  try { await taxProfileService.unassignProduct(req.params.productId); ok(res, { productId: req.params.productId }); } catch (e) { next(e); }
}
export async function configurationGaps(req, res, next) {
  try { ok(res, { gaps: await taxProfileService.configurationGaps(req.brandId) }); } catch (e) { next(e); }
}
