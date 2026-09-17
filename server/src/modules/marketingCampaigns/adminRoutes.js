import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { marketingCampaignService } from './service.js';
import { MAX_AUDIENCE_ROWS } from './audienceFile.js';
import { logger } from '../../utils/logger.js';

const log = logger('marketing-campaigns');

// CMS → Marketing → Campaigns.
//
// Reading and editing a campaign is MARKETING_MANAGE. Actually putting a
// message in front of customers — the test send and the launch — is
// MARKETING_SEND, a separate permission, because those two are different
// mistakes: one costs a draft, the other reaches real people.
const audit = new StaffAuditRepository();
// Same shape the other marketing routes use: who did it, from where, to what.
const trail = (req, action, resourceType, resourceId, metadata = null) => audit.log({
  staffUserId: req.staff?.id, actorEmail: req.staff?.email, action,
  resourceType, resourceId, metadata, ipAddress: req.ip,
// The action itself has already happened, so a failed audit write must not
// fail the request — but it must not vanish either.
}).catch((error) => log.error('audit_write_failed', { action, resourceId, error: error.message }));
const router = Router();
const read = requireStaffPermission(PERMISSIONS.MARKETING_READ);
const manage = requireStaffPermission(PERMISSIONS.MARKETING_MANAGE);
const send = requireStaffPermission(PERMISSIONS.MARKETING_SEND);

// In memory: a contact list is read once, validated, and written to the
// database. 12 MB comfortably holds the row limit as .xlsx.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });

const sourceSchema = z.object({
  type: z.enum(['REGISTERED_USERS', 'SEGMENT', 'EMAIL_SUBSCRIBERS', 'WHATSAPP_SUBSCRIBERS', 'LIST']),
  filter: z.enum(['ALL', 'NEW_USERS', 'HAS_ORDERED', 'NEVER_ORDERED']).optional(),
  listId: z.string().max(36).optional(),
  segmentId: z.string().max(36).optional(),
});

// Validated in depth by the service (types and triggers are data / registry);
// the route only bounds shapes and sizes.
const channelSchema = z.object({
  channel: z.enum(['EMAIL', 'WHATSAPP']),
  templateKey: z.string().min(1).max(80),
  providerTemplateRef: z.string().max(120).nullable().optional(),
});
const triggerSchema = z.object({
  key: z.string().min(1).max(60),
  scheduledAt: z.string().datetime().nullable().optional(),
  config: z.record(z.string(), z.any()).nullable().optional(),
});

const campaignBody = z.object({
  name: z.string().min(2).max(160),
  campaignType: z.string().min(2).max(40).optional(),
  channels: z.array(channelSchema).max(2).optional(),
  trigger: triggerSchema.optional(),
  audienceSources: z.array(sourceSchema).max(20).optional(),
  offerName: z.string().max(160).nullable().optional(),
  offerDetails: z.string().max(500).nullable().optional(),
  collectionSlug: z.string().max(160).nullable().optional(),
  imageUrl: z.string().max(1024).nullable().optional(),
  ctaLabel: z.string().max(40).nullable().optional(),
  ctaUrl: z.string().max(1024).nullable().optional(),
  emailSubject: z.string().max(240).nullable().optional(),
  batchSize: z.number().int().min(1).max(100000).optional(),
}).strict();
const patchBody = campaignBody.partial();

const ok = (res, data, status = 200) => res.status(status).json({ data });

// ---- audience lists (reusable across campaigns) --------------------
router.get('/marketing/audience-lists', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.listAudienceLists(req.brandId)); } catch (e) { next(e); }
});

router.post('/marketing/audience-lists', manage, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: { code: 'FILE_REQUIRED', message: 'Attach a .csv or .xlsx file.' } });
    const preview = await marketingCampaignService.uploadList(req.brandId, {
      buffer: req.file.buffer,
      filename: req.file.originalname,
      name: req.body?.name,
      staffId: req.staff?.id,
    });
    // The upload itself is auditable: who added which contacts, and when.
    await trail(req, 'MARKETING_AUDIENCE_IMPORTED', 'marketing_audience_list', preview.listId,
      { filename: preview.filename, counts: preview.counts });
    return ok(res, preview, 201);
  } catch (e) { return next(e); }
});

router.get('/marketing/audience-lists/:listId', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.listPreview(req.params.listId, req.brandId)); } catch (e) { next(e); }
});

router.post('/marketing/audience-lists/:listId/confirm', manage, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.confirmList(req.params.listId, req.brandId)); } catch (e) { next(e); }
});

router.delete('/marketing/audience-lists/:listId', manage, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.discardList(req.params.listId, req.brandId)); } catch (e) { next(e); }
});

// ---- campaigns -----------------------------------------------------
// What the builder offers: campaign types and the triggers available today.
router.get('/marketing/campaign-options', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.options()); } catch (e) { next(e); }
});

router.get('/marketing/campaigns', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.list(req.brandId)); } catch (e) { next(e); }
});

router.get('/marketing/campaigns/:id', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.get(req.params.id, req.brandId)); } catch (e) { next(e); }
});

router.post('/marketing/campaigns', manage, async (req, res, next) => {
  try {
    const campaign = await marketingCampaignService.create(req.brandId, campaignBody.parse(req.body), req.staff?.id);
    await trail(req, 'MARKETING_CAMPAIGN_CREATED', 'marketing_campaign', campaign.id, { name: campaign.name, type: campaign.campaign_type });
    ok(res, campaign, 201);
  } catch (e) { next(e); }
});

router.patch('/marketing/campaigns/:id', manage, async (req, res, next) => {
  try {
    const campaign = await marketingCampaignService.update(req.params.id, req.brandId, patchBody.parse(req.body));
    await trail(req, 'MARKETING_CAMPAIGN_UPDATED', 'marketing_campaign', campaign.id, null);
    ok(res, campaign);
  } catch (e) { next(e); }
});

// A new DRAFT copy — the way a recurring launch is prepared.
router.post('/marketing/campaigns/:id/duplicate', manage, async (req, res, next) => {
  try {
    const copy = await marketingCampaignService.duplicate(req.params.id, req.brandId, req.staff?.id);
    await trail(req, 'MARKETING_CAMPAIGN_DUPLICATED', 'marketing_campaign', copy.id, { from: req.params.id });
    ok(res, copy, 201);
  } catch (e) { next(e); }
});

router.delete('/marketing/campaigns/:id', manage, async (req, res, next) => {
  try {
    const result = await marketingCampaignService.remove(req.params.id, req.brandId);
    await trail(req, 'MARKETING_CAMPAIGN_DELETED', 'marketing_campaign', req.params.id, null);
    ok(res, result);
  } catch (e) { next(e); }
});

// ---- recipient-level tracking ---------------------------------------
const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
  channel: z.enum(['EMAIL', 'WHATSAPP']).optional(),
  campaignId: z.string().max(36).optional(),
});

router.get('/marketing/campaigns/:id/recipients', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.recipients(req.params.id, req.brandId, pageQuery.parse(req.query))); } catch (e) { next(e); }
});

router.get('/marketing/cart-recovery/reminders', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.cartReminderLog(req.brandId, pageQuery.parse(req.query))); } catch (e) { next(e); }
});

// ---- pre-flight ----------------------------------------------------
router.get('/marketing/campaigns/:id/readiness', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.readiness(req.params.id, req.brandId)); } catch (e) { next(e); }
});

// The real consent lookups, not an estimate — this is what the confirmation
// screen shows before anyone presses send.
router.get('/marketing/campaigns/:id/audience-preview', read, async (req, res, next) => {
  try { ok(res, await marketingCampaignService.audiencePreview(req.params.id, req.brandId)); } catch (e) { next(e); }
});

// ---- sending -------------------------------------------------------
router.post('/marketing/campaigns/:id/test', send, async (req, res, next) => {
  try {
    const body = z.object({
      email: z.string().email().nullable().optional(),
      phone: z.string().max(20).nullable().optional(),
      // Per-customer campaigns (abandoned cart): the customer's email or phone.
      contact: z.string().min(3).max(320).nullable().optional(),
    }).parse(req.body || {});
    const result = await marketingCampaignService.sendTest(req.params.id, req.brandId, body);
    await trail(req, 'MARKETING_CAMPAIGN_TEST_SENT', 'marketing_campaign', req.params.id, { results: result.results });
    ok(res, result);
  } catch (e) { next(e); }
});

// Activate a draft: Send now starts its run, Schedule waits for the time,
// an event campaign waits for its event.
for (const path of ['activate', 'launch']) {
  router.post(`/marketing/campaigns/:id/${path}`, send, async (req, res, next) => {
    try {
      const result = await marketingCampaignService.activate(req.params.id, req.brandId);
      await trail(req, 'MARKETING_CAMPAIGN_ACTIVATED', 'marketing_campaign', req.params.id, result);
      ok(res, result);
    } catch (e) { next(e); }
  });
}

for (const [path, method, action] of [
  ['pause', 'pause', 'MARKETING_CAMPAIGN_PAUSED'],
  ['resume', 'resume', 'MARKETING_CAMPAIGN_RESUMED'],
  ['cancel', 'cancel', 'MARKETING_CAMPAIGN_CANCELLED'],
]) {
  router.post(`/marketing/campaigns/:id/${path}`, send, async (req, res, next) => {
    try {
      const result = await marketingCampaignService[method](req.params.id, req.brandId);
      await trail(req, action, 'marketing_campaign', req.params.id, result);
      ok(res, result);
    } catch (e) { next(e); }
  });
}

// Manual tick, for an operator who does not want to wait for the workers:
// sends due campaign batches and runs one abandoned-cart scan.
router.post('/marketing/campaigns/run', send, async (req, res, next) => {
  try {
    const { abandonedCartService } = await import('../abandonedCart/service.js');
    const [campaigns, abandonedCarts] = await Promise.all([marketingCampaignService.runDue({}), abandonedCartService.runOnce()]);
    await trail(req, 'MARKETING_CAMPAIGNS_RUN', 'marketing_campaign', null, { queued: campaigns.queued, reminded: abandonedCarts.reminded });
    ok(res, { campaigns, abandonedCarts });
  } catch (e) { next(e); }
});

router.get('/marketing/campaigns-limits', read, (req, res) => {
  res.json({ data: { maxAudienceRows: MAX_AUDIENCE_ROWS } });
});

export default router;
