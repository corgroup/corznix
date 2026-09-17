import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { codPolicyRepository } from './codPolicyRepository.js';
import { paymentMonitorService } from './paymentMonitorService.js';

// COD policy control + payment monitoring. Mounted under /api/v1/admin, so the
// staff session and cmsOriginGuard are already applied.
//
// Every route is `payments.manage`, which only SUPER_ADMIN holds. Turning COD
// on, or blocking it for a PIN, decides whether money is collected at the door.
//
// Nothing here evaluates eligibility. `paymentEligibility/evaluator.js` remains
// the only place that decides whether an order may pay cash; this surface only
// edits the inputs it reads, which previously had no interface at all.
const router = Router();
const audit = new StaffAuditRepository();
const ok = (res, data) => res.status(200).json({ data });
const gate = requireStaffPermission(PERMISSIONS.PAYMENTS_MANAGE);

const logCod = (req, action, resourceId, metadata) => audit.log({
  staffUserId: req.staff?.id || null, actorEmail: req.staff?.email || null, ipAddress: req.ip, requestId: req.id,
  action, resourceType: 'cod_policy', resourceId: resourceId || null, metadata: metadata || null,
});

// ---- COD policy ---------------------------------------------------------

router.get('/payments/cod-policy', gate, async (req, res, next) => {
  try {
    const [settings, valueRules, riskRules, pins, readiness] = await Promise.all([
      codPolicyRepository.settings(req.brandId),
      codPolicyRepository.valueRules(req.brandId),
      codPolicyRepository.riskRules(req.brandId),
      codPolicyRepository.pins(req.brandId, { search: req.query.pin || '', limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0 }),
      codPolicyRepository.readiness(req.brandId),
    ]);
    ok(res, { settings, valueRules: valueRules.rules, valueRuleOverlaps: valueRules.overlaps, riskRules, pins, readiness });
  } catch (err) { next(err); }
});

router.put('/payments/cod-policy/settings', gate, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    if (body.codEnabled === undefined && body.partialCodEnabled === undefined && body.advanceNonRefundableEnabled === undefined) {
      return res.status(422).json({ error: { code: 'VALIDATION_ERROR', message: 'Nothing to change.' } });
    }
    const before = await codPolicyRepository.settings(req.brandId);
    const settings = await codPolicyRepository.setSettings(req.brandId, {
      codEnabled: body.codEnabled === undefined ? undefined : Boolean(body.codEnabled),
      partialCodEnabled: body.partialCodEnabled === undefined ? undefined : Boolean(body.partialCodEnabled),
      advanceNonRefundableEnabled: body.advanceNonRefundableEnabled === undefined ? undefined : Boolean(body.advanceNonRefundableEnabled),
    });
    await logCod(req, settings.codEnabled ? 'COD_ENABLED' : 'COD_DISABLED', null, { before, after: settings });
    return ok(res, { settings, readiness: await codPolicyRepository.readiness(req.brandId) });
  } catch (err) { return next(err); }
});

router.put('/payments/cod-policy/pins/:postalCode', gate, async (req, res, next) => {
  try {
    const body = req.body ?? {};
    const pin = await codPolicyRepository.setPin(req.brandId, req.params.postalCode, {
      deliveryBlocked: body.deliveryBlocked === undefined ? undefined : Boolean(body.deliveryBlocked),
      codBlocked: body.codBlocked === undefined ? undefined : Boolean(body.codBlocked),
      partialCodBlocked: body.partialCodBlocked === undefined ? undefined : Boolean(body.partialCodBlocked),
      riskLevel: body.riskLevel,
    });
    await logCod(req, 'COD_PIN_RESTRICTION_SET', pin.postalCode, pin);
    ok(res, pin);
  } catch (err) { next(err); }
});

router.delete('/payments/cod-policy/pins/:postalCode', gate, async (req, res, next) => {
  try {
    const result = await codPolicyRepository.removePin(req.brandId, req.params.postalCode);
    await logCod(req, 'COD_PIN_RESTRICTION_CLEARED', req.params.postalCode, null);
    ok(res, result);
  } catch (err) { next(err); }
});

// ---- COD order-value bands ----------------------------------------------
// The evaluator applies a band only when EXACTLY ONE active band matches the
// order total, so an overlap disables COD for the overlapping amounts rather
// than one band winning. The read endpoint reports overlaps; these writes do
// not refuse them, because the fix is a business decision about which band
// should shrink, not something to guess at.

router.put('/payments/cod-policy/value-rules/:id', gate, async (req, res, next) => {
  try {
    const rule = await codPolicyRepository.upsertValueRule(req.brandId, { ...(req.body ?? {}), id: req.params.id });
    await logCod(req, 'COD_VALUE_RULE_SAVED', rule.id, rule);
    ok(res, rule);
  } catch (err) { next(err); }
});

router.post('/payments/cod-policy/value-rules', gate, async (req, res, next) => {
  try {
    const rule = await codPolicyRepository.upsertValueRule(req.brandId, req.body ?? {});
    await logCod(req, 'COD_VALUE_RULE_SAVED', rule.id, rule);
    res.status(201).json({ data: rule });
  } catch (err) { next(err); }
});

// Archived, never deleted: a band that priced real orders stays readable.
router.delete('/payments/cod-policy/value-rules/:id', gate, async (req, res, next) => {
  try {
    const result = await codPolicyRepository.archiveValueRule(req.brandId, req.params.id);
    await logCod(req, 'COD_VALUE_RULE_ARCHIVED', req.params.id, null);
    ok(res, result);
  } catch (err) { next(err); }
});

// ---- RTO risk rules ------------------------------------------------------

router.put('/payments/cod-policy/risk-rules/:riskLevel', gate, async (req, res, next) => {
  try {
    const rule = await codPolicyRepository.setRiskRule(req.brandId, req.params.riskLevel, req.body ?? {});
    await logCod(req, 'COD_RISK_RULE_SAVED', rule.riskLevel, rule);
    ok(res, rule);
  } catch (err) { next(err); }
});

// ---- payment monitoring -------------------------------------------------

router.get('/payments/monitor', gate, async (req, res, next) => {
  try { ok(res, await paymentMonitorService.monitor(req.query, req.brandId)); } catch (err) { next(err); }
});

export default router;
