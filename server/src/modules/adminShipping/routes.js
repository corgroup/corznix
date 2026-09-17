import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { shippingPricingPolicyRepository, SURFACE_MODES } from '../shipping/pricingPolicy.js';
import { ownerDeliveryRepository } from '../shipping/ownerDelivery.js';
import { StaffAuditRepository } from '../staff/repositories.js';

// Phase 2 · Slice 6 — shipping PRICING POLICY administration + Owner Delivery.
// Mounted under /api/v1/admin (staff session + cmsOriginGuard already applied).
const router = Router();
const audit = new StaffAuditRepository();
const ok = (res, data) => res.status(200).json({ data });
const readGate = requireStaffPermission(PERMISSIONS.SETTINGS_READ);
const manageGate = requireStaffPermission(PERMISSIONS.SETTINGS_MANAGE);

router.get('/shipping/pricing-policy', requireStaffPermission(PERMISSIONS.SETTINGS_READ), async (_req, res, next) => {
  try { ok(res, await shippingPricingPolicyRepository.get()); } catch (err) { next(err); }
});

router.put('/shipping/pricing-policy', requireStaffPermission(PERMISSIONS.SETTINGS_MANAGE), async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const patch = {};
    if (b.surfaceCustomerChargeMode !== undefined) {
      if (!SURFACE_MODES.includes(b.surfaceCustomerChargeMode)) {
        return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: `surfaceCustomerChargeMode must be one of ${SURFACE_MODES.join(', ')}.` } });
      }
      patch.surfaceCustomerChargeMode = b.surfaceCustomerChargeMode;
    }
    for (const k of ['surfaceFlatChargeMinor', 'expressAdditionalChargeMinor']) {
      if (b[k] !== undefined) {
        const n = Number(b[k]);
        if (!Number.isInteger(n) || n < 0 || n > 100_000_000) {
          return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: `${k} must be a non-negative integer (minor units).` } });
        }
        patch[k] = n;
      }
    }
    const updated = await shippingPricingPolicyRepository.update(patch);
    await audit.log({
      staffUserId: req.staff?.id || null, actorEmail: req.staff?.email || null, ipAddress: req.ip, requestId: req.id,
      action: 'SHIPPING_PRICING_POLICY_UPDATED', resourceType: 'shipping_settings', resourceId: '1',
      metadata: patch,
    });
    ok(res, updated);
  } catch (err) { next(err); }
});

// ---- Owner Delivery (migration 071) --------------------------------------

const auditOD = (req, action, resourceId, metadata) => audit.log({
  staffUserId: req.staff?.id || null, actorEmail: req.staff?.email || null, ipAddress: req.ip, requestId: req.id,
  action, resourceType: 'owner_delivery', resourceId: resourceId || null, metadata: metadata || null,
});

// `req` is used for the brand scope — the parameter was named `_req`, so this
// route threw ReferenceError on every call and the CMS Owner Delivery panel
// could never load.
router.get('/shipping/owner-delivery', readGate, async (req, res, next) => {
  try {
    ok(res, {
      settings: await ownerDeliveryRepository.settings(),
      zones: await ownerDeliveryRepository.listZones(req.brandId),
    });
  } catch (err) { next(err); }
});

router.put('/shipping/owner-delivery/settings', manageGate, async (req, res, next) => {
  try {
    const enabled = Boolean(req.body?.enabled);
    const result = await ownerDeliveryRepository.setMasterEnabled(enabled);
    await auditOD(req, enabled ? 'OWNER_DELIVERY_ENABLED' : 'OWNER_DELIVERY_DISABLED', null, null);
    ok(res, result);
  } catch (err) { next(err); }
});

router.post('/shipping/owner-delivery/zones', manageGate, async (req, res, next) => {
  try {
    const b = req.body ?? {};
    const zone = await ownerDeliveryRepository.createZone({
      name: b.name, pincode: b.pincode, chargeMinor: b.chargeMinor, enabled: b.enabled ?? true, notes: b.notes ?? null,
      staffId: req.staff?.id || null, brandId: req.brandId,
    });
    await auditOD(req, 'OWNER_DELIVERY_ZONE_CREATED', zone.id, { pincode: zone.pincode, chargeMinor: zone.chargeMinor });
    res.status(201).json({ data: zone });
  } catch (err) { next(err); }
});

router.put('/shipping/owner-delivery/zones/:id', manageGate, async (req, res, next) => {
  try {
    const zone = await ownerDeliveryRepository.updateZone(req.params.id, req.brandId, req.body ?? {});
    await auditOD(req, 'OWNER_DELIVERY_ZONE_UPDATED', zone.id, req.body ?? {});
    ok(res, zone);
  } catch (err) { next(err); }
});

router.delete('/shipping/owner-delivery/zones/:id', manageGate, async (req, res, next) => {
  try {
    const result = await ownerDeliveryRepository.deleteZone(req.params.id, req.brandId);
    await auditOD(req, 'OWNER_DELIVERY_ZONE_DELETED', req.params.id, null);
    ok(res, result);
  } catch (err) { next(err); }
});

export default router;
