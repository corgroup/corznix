import { Router } from 'express';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { companyService } from './service.js';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

// Settings > Company Profile (DESIGN.md §6, Phase 6). Reads/writes the
// CURRENT company's legal identity — brand_id always comes from req.brandId
// (resolveBrandContext), never the client. Owner / default-warehouse stay
// on their own dedicated flows (staff bootstrap, warehouse default) — this
// is legal-identity fields only.
const router = Router();
const read = requireStaffPermission(PERMISSIONS.SETTINGS_READ);
const manage = requireStaffPermission(PERMISSIONS.SETTINGS_MANAGE);

const ok = (res, data) => res.status(200).json({ data });

router.get('/company-profile', read, async (req, res, next) => {
  try { ok(res, await companyService.getProfile(req.brandId)); } catch (err) { next(err); }
});

const addressSchema = z.object({
  addressLine1: z.string().trim().max(255).nullable().optional(),
  addressLine2: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(120).nullable().optional(),
  postalCode: z.string().trim().max(12).nullable().optional(),
  country: z.string().trim().length(2).nullable().optional(),
});

const updateSchema = z.object({
  legalName: z.string().trim().max(200).nullable().optional(),
  tradeName: z.string().trim().max(200).nullable().optional(),
  constitution: z.string().trim().max(40).nullable().optional(),
  gstin: z.string().trim().max(20).nullable().optional(),
  gstRegistrationType: z.string().trim().max(20).nullable().optional(),
  gstStateCode: z.string().trim().max(2).nullable().optional(),
  gstEffectiveFrom: z.string().trim().max(40).nullable().optional(),
  principalAddress: addressSchema.optional(),
});

router.patch('/company-profile', manage, async (req, res, next) => {
  try {
    const patch = updateSchema.parse(req.body ?? {});
    ok(res, await companyService.updateProfile(req.brandId, patch));
  } catch (err) { next(err); }
});

// Brand appearance. `brands.logo_media_id` has existed since the multi-company
// work but nothing could ever set it — no endpoint, no screen. It is company
// identity rather than legal identity, so it sits beside the company profile
// under the same settings permissions.
const appearanceSchema = z.object({
  logoMediaId: z.string().uuid().nullable().optional(),
});

router.get('/brand-appearance', read, async (req, res, next) => {
  try {
    const [row] = await query(
      `SELECT b.id, b.name, b.display_name, b.logo_media_id, m.url AS logo_url
         FROM brands b
         LEFT JOIN media m ON m.id = b.logo_media_id
        WHERE b.id = ? LIMIT 1`, [req.brandId]);
    if (!row) throw new AppError('BRAND_NOT_FOUND', 'Company not found.', 404);
    ok(res, {
      brandId: row.id,
      name: row.display_name || row.name,
      logoMediaId: row.logo_media_id,
      logoUrl: row.logo_url || null,
    });
  } catch (err) { next(err); }
});

router.patch('/brand-appearance', manage, async (req, res, next) => {
  try {
    const patch = appearanceSchema.parse(req.body ?? {});
    if (patch.logoMediaId) {
      // Refuse to record a logo the media registry does not actually hold.
      const [asset] = await query("SELECT 1 AS ok FROM media WHERE id = ? AND status = 'ACTIVE' LIMIT 1", [patch.logoMediaId]);
      if (!asset) throw new AppError('MEDIA_NOT_FOUND', 'That image is no longer available.', 404);
    }
    if (patch.logoMediaId !== undefined) {
      await query('UPDATE brands SET logo_media_id = ? WHERE id = ?', [patch.logoMediaId, req.brandId]);
    }
    const [row] = await query(
      `SELECT b.logo_media_id, m.url AS logo_url FROM brands b
         LEFT JOIN media m ON m.id = b.logo_media_id WHERE b.id = ? LIMIT 1`, [req.brandId]);
    ok(res, { logoMediaId: row?.logo_media_id ?? null, logoUrl: row?.logo_url ?? null });
  } catch (err) { next(err); }
});

export default router;
