import { Router } from 'express';
import { AppError } from '../../utils/errors.js';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { providerConfigService } from './providerConfigService.js';
import { providerHealthService } from './providerHealthService.js';
import { webhookInboxService } from './webhookInboxService.js';
import { outboxService } from './outboxService.js';
import { platformRepository as R } from './repository.js';
import { providerDescriptor } from './capabilities.js';

// Wave 8I-6 — the CMS provider-operations control plane. Read surface on
// `providers.read`; non-secret config on `providers.manage`; webhook replay
// and outbox retry on their own narrower gates. No route ever returns or
// accepts a provider secret or endpoint.

const audit = new StaffAuditRepository();
const router = Router();
const read = requireStaffPermission(PERMISSIONS.PROVIDERS_READ);
const manage = requireStaffPermission(PERMISSIONS.PROVIDERS_MANAGE);
const replayGate = requireStaffPermission(PERMISSIONS.PROVIDER_WEBHOOKS_REPLAY);
const retryGate = requireStaffPermission(PERMISSIONS.PROVIDER_OPERATIONS_RETRY);

const send = (res, data) => res.json({ data });
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

function requireKnownProvider(req, _res, next) {
  if (!providerDescriptor(req.params.capability, req.params.providerKey)) {
    return next(new AppError('PROVIDER_NOT_FOUND', 'Unknown provider.', 404));
  }
  return next();
}

// ---- provider overview / config / health ----------------------
router.get('/providers', read, wrap(async (req, res) => send(res, await providerHealthService.overview())));

router.post('/providers/health/recompute', manage, wrap(async (req, res) => {
  const result = await providerHealthService.recomputeAll();
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'PROVIDER_HEALTH_RECOMPUTED', resourceType: 'provider', resourceId: null, metadata: { providers: result.length }, ipAddress: req.ip });
  send(res, result);
}));

router.get('/providers/:capability/:providerKey', read, requireKnownProvider, wrap(async (req, res) => {
  send(res, await providerConfigService.detail(req.params.capability, req.params.providerKey));
}));

router.get('/providers/:capability/:providerKey/health', read, requireKnownProvider, wrap(async (req, res) => {
  send(res, await providerHealthService.detail(req.params.capability, req.params.providerKey));
}));

router.patch('/providers/:capability/:providerKey', manage, requireKnownProvider, wrap(async (req, res) => {
  const { capability, providerKey } = req.params;
  const { enabled, priority, config, note } = req.body ?? {};
  const before = await providerConfigService.detail(capability, providerKey);
  const result = await providerConfigService.update({ capability, providerKey, enabled, priority, config, note, staffId: req.staff.id });
  const action = (enabled !== undefined && enabled !== before.enabled)
    ? (enabled ? 'PROVIDER_ENABLED' : 'PROVIDER_DISABLED')
    : (priority !== undefined && priority !== before.priority ? 'PROVIDER_PRIORITY_CHANGED' : 'PROVIDER_CONFIG_UPDATED');
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action, resourceType: 'provider_configuration', resourceId: `${capability}:${providerKey}`, metadata: { fromVersion: before.version, toVersion: result.version }, ipAddress: req.ip });
  send(res, result);
}));

router.post('/providers/:capability/:providerKey/rollback', manage, requireKnownProvider, wrap(async (req, res) => {
  const { capability, providerKey } = req.params;
  const toVersion = Number(req.body?.toVersion);
  const result = await providerConfigService.rollback({ capability, providerKey, toVersion, staffId: req.staff.id });
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'PROVIDER_CONFIG_UPDATED', resourceType: 'provider_configuration', resourceId: `${capability}:${providerKey}`, metadata: { rollbackTo: toVersion, newVersion: result.version }, ipAddress: req.ip });
  send(res, result);
}));

// ---- webhook inbox -------------------------------------------
router.get('/provider-webhooks', read, wrap(async (req, res) => send(res, { events: await webhookInboxService.list(req.query) })));
router.get('/provider-webhooks/:id', read, wrap(async (req, res) => send(res, await webhookInboxService.detail(req.params.id))));

router.post('/provider-webhooks/:id/replay', replayGate, wrap(async (req, res) => {
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'WEBHOOK_REPLAY_REQUESTED', resourceType: 'provider_webhook_inbox', resourceId: req.params.id, metadata: {}, ipAddress: req.ip });
  send(res, await webhookInboxService.replay(req.params.id));
}));

// ---- outbox --------------------------------------------------
router.get('/provider-outbox', read, wrap(async (req, res) => send(res, { events: await outboxService.list(req.query) })));

router.post('/provider-outbox/:id/retry', retryGate, wrap(async (req, res) => {
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'OUTBOX_RETRY_REQUESTED', resourceType: 'platform_outbox', resourceId: req.params.id, metadata: {}, ipAddress: req.ip });
  send(res, await outboxService.retry(req.params.id));
}));

router.post('/provider-outbox/:id/cancel', retryGate, wrap(async (req, res) => {
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'OUTBOX_CANCELLED', resourceType: 'platform_outbox', resourceId: req.params.id, metadata: {}, ipAddress: req.ip });
  send(res, await outboxService.cancel(req.params.id));
}));

// ---- provider attempts (observability, read-only) -----------
router.get('/provider-attempts', read, wrap(async (req, res) => {
  const rows = await R.listAttempts({
    capability: req.query.capability || null, providerKey: req.query.providerKey || null,
    outcome: req.query.outcome || null,
    offset: Math.max(0, Number(req.query.offset) || 0), limit: Math.min(200, Number(req.query.limit) || 50),
  });
  send(res, { attempts: rows });
}));

export default router;
