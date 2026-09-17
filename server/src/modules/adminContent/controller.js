import { z } from 'zod';
import * as nav from '../content/navigationService.js';
import * as home from '../content/homepageService.js';
import * as pages from '../content/pagesService.js';
import * as camp from '../content/campaignService.js';
import * as preview from '../content/previewService.js';
import { getPublishedSnapshotForBrand } from '../content/documentService.js';
import { findEntityReferences, ENTITY_TYPES } from '../content/entityLinks.js';
import { AppError } from '../../utils/errors.js';

const ok = (res, data, status = 200) => res.status(status).json({ data });
const actorOf = (req) => ({ id: req.staff?.id, email: req.staff?.email, ip: req.ip, requestId: req.id });

const LINK_TYPES = ['HOME', 'PRODUCT', 'COLLECTION', 'CATEGORY', 'CONTENT_PAGE', 'SEARCH', 'ACCOUNT', 'CUSTOM_INTERNAL', 'EXTERNAL'];
const version = z.coerce.number().int().min(1);

const navItemSchema = z.object({
  id: z.string().uuid().optional(),
  itemKey: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80).optional(),
  parentId: z.string().uuid().nullish(),
  label: z.string().trim().min(1).max(120),
  linkType: z.enum(LINK_TYPES),
  linkTarget: z.string().trim().max(180).nullish(),
  externalUrl: z.string().trim().max(500).nullish(),
  megaMenuKey: z.string().trim().max(80).nullish(),
  icon: z.string().trim().max(40).nullish(),
  linkRefType: z.enum(ENTITY_TYPES).nullish(),
  linkRefId: z.string().uuid().nullish(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  expectedVersion: version,
});

const navSettingsSchema = z.object({
  settings: z.object({
    mobileLinks: z.array(z.object({
      label: z.string().trim().max(60),
      path: z.string().trim().max(300),
      ref: z.object({ type: z.enum(ENTITY_TYPES), id: z.string().uuid() }).nullish(),
      hidden: z.boolean().optional(),
    })).max(12).default([]),
    mobileTagline: z.string().trim().max(80).default(''),
  }),
  expectedVersion: version,
});

const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).min(1).max(60),
  parentId: z.string().uuid().nullish(),
  expectedVersion: version,
});

const megaMenuSchema = z.object({
  menuKey: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80),
  name: z.string().trim().min(1).max(120),
  promoMediaId: z.string().uuid().nullish(),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  payload: z.object({}).passthrough(),
  expectedVersion: version,
});

const announcementSchema = z.object({
  id: z.string().uuid().optional(),
  announcementKey: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80).optional(),
  text: z.string().trim().min(1).max(300),
  linkType: z.enum(LINK_TYPES.filter((t) => t !== 'ACCOUNT')).nullish(),
  linkTarget: z.string().trim().max(180).nullish(),
  externalUrl: z.string().trim().max(500).nullish(),
  linkRefType: z.enum(ENTITY_TYPES).nullish(),
  linkRefId: z.string().uuid().nullish(),
  startsAt: z.string().datetime({ offset: true }).nullish().or(z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/).nullish()),
  expiresAt: z.string().datetime({ offset: true }).nullish().or(z.string().regex(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/).nullish()),
  status: z.enum(['ACTIVE', 'DISABLED']).optional(),
  expectedVersion: version,
});

// ---- navigation ------------------------------------------------------
export async function getNavigation(req, res, next) {
  try { ok(res, await nav.getNavigationDraft(req.brandId)); } catch (e) { next(e); }
}
export async function upsertNavItem(req, res, next) {
  try {
    const { expectedVersion, ...body } = navItemSchema.parse(req.body);
    ok(res, await nav.upsertNavItem(body, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function deleteNavItem(req, res, next) {
  try {
    const { expectedVersion } = z.object({ expectedVersion: version }).parse(req.query);
    ok(res, await nav.deleteNavItem(req.params.id, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
// What customers currently see for a scope — the visual builders diff their
// draft against it to label items Live / Draft / Changed.
const PUBLISHED_SCOPES = {
  navigation: ['NAVIGATION', 'primary'],
  'mega-menus': ['MEGA_MENUS', 'default'],
  announcements: ['ANNOUNCEMENTS', 'default'],
  homepage: ['HOMEPAGE', 'home'],
  footer: ['FOOTER', 'main'],
};
// Every place on the website that links to a category / collection / page.
export async function entityReferences(req, res, next) {
  try {
    const { type, id } = z.object({ type: z.enum(ENTITY_TYPES), id: z.string().uuid() }).parse(req.query);
    ok(res, await findEntityReferences(type, id, req.brandId));
  } catch (e) { next(e); }
}

export async function publishedSnapshot(req, res, next) {
  try {
    const target = PUBLISHED_SCOPES[req.params.scope];
    if (!target) throw new AppError('CONTENT_INVALID', `Unknown content scope "${req.params.scope}".`, 422);
    ok(res, { published: await getPublishedSnapshotForBrand(target[0], target[1], req.brandId) });
  } catch (e) { next(e); }
}

export async function setNavigationSettings(req, res, next) {
  try {
    const { settings, expectedVersion } = navSettingsSchema.parse(req.body);
    ok(res, await nav.setNavigationSettings(settings, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function reorderNav(req, res, next) {
  try {
    const { orderedIds, parentId, expectedVersion } = reorderSchema.parse(req.body);
    ok(res, await nav.reorderNav(orderedIds, parentId ?? null, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}

// ---- mega menus ---------------------------------------------------
export async function getMegaMenus(req, res, next) {
  try { ok(res, await nav.getMegaMenusDraft(req.brandId)); } catch (e) { next(e); }
}
export async function upsertMegaMenu(req, res, next) {
  try {
    const { expectedVersion, ...body } = megaMenuSchema.parse(req.body);
    ok(res, await nav.upsertMegaMenu(body, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}

// ---- announcements ----------------------------------------------
export async function getAnnouncements(req, res, next) {
  try { ok(res, await nav.getAnnouncementsDraft(req.brandId)); } catch (e) { next(e); }
}
export async function upsertAnnouncement(req, res, next) {
  try {
    const { expectedVersion, ...body } = announcementSchema.parse(req.body);
    ok(res, await nav.upsertAnnouncement(body, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function deleteAnnouncement(req, res, next) {
  try {
    const { expectedVersion } = z.object({ expectedVersion: version }).parse(req.query);
    ok(res, await nav.deleteAnnouncement(req.params.id, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
const announcementSettingsSchema = z.object({
  settings: z.object({
    autoplaySeconds: z.number().int().min(3).max(15),
    showClock: z.boolean(),
    dismissible: z.boolean(),
    dismissVersion: z.string().trim().regex(/^v[a-z0-9-]{1,31}$/),
  }),
  expectedVersion: version,
});
export async function setAnnouncementSettings(req, res, next) {
  try {
    const { settings, expectedVersion } = announcementSettingsSchema.parse(req.body);
    ok(res, await nav.setAnnouncementSettings(settings, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function reorderAnnouncements(req, res, next) {
  try {
    const { orderedIds, expectedVersion } = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(60), expectedVersion: version }).parse(req.body);
    ok(res, await nav.reorderAnnouncements(orderedIds, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}

// ---- homepage -------------------------------------------------
const homeSectionSchema = z.object({
  id: z.string().uuid().optional(),
  sectionKey: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80).optional(),
  type: z.string().trim().max(32),
  enabled: z.boolean().optional(),
  config: z.object({}).passthrough().default({}),
  mediaId: z.string().uuid().nullish(),
  expectedVersion: version,
});
export async function getHomepage(req, res, next) {
  try { ok(res, await home.getHomepageDraft(req.brandId)); } catch (e) { next(e); }
}
export async function upsertHomeSection(req, res, next) {
  try {
    const { expectedVersion, ...body } = homeSectionSchema.parse(req.body);
    ok(res, await home.upsertHomeSection(body, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function deleteHomeSection(req, res, next) {
  try {
    const { expectedVersion } = z.object({ expectedVersion: version }).parse(req.query);
    ok(res, await home.deleteHomeSection(req.params.id, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function reorderHomeSections(req, res, next) {
  try {
    const { orderedIds, expectedVersion } = z.object({ orderedIds: z.array(z.string().uuid()).min(1).max(40), expectedVersion: version }).parse(req.body);
    ok(res, await home.reorderHomeSections(orderedIds, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}

// ---- footer --------------------------------------------------
const footerLinkSchema = z.object({
  label: z.string().trim().min(1).max(120),
  linkRefType: z.enum(ENTITY_TYPES).nullish(),
  linkRefId: z.string().uuid().nullish(),
  linkType: z.enum(LINK_TYPES).optional(),
  linkTarget: z.string().trim().max(180).nullish(),
  externalUrl: z.string().trim().max(500).nullish(),
});
export async function getFooter(req, res, next) {
  try { ok(res, await home.getFooterDraft(req.brandId)); } catch (e) { next(e); }
}
export async function setFooterGroupLinks(req, res, next) {
  try {
    const { links, expectedVersion } = z.object({ links: z.array(footerLinkSchema).max(30), expectedVersion: version }).parse(req.body);
    ok(res, await home.setFooterGroupLinks(req.params.groupKey, links, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function setFooterMeta(req, res, next) {
  try {
    const { meta, expectedVersion } = z.object({
      meta: z.object({
        contact: z.object({ email: z.string().trim().max(160).optional(), phone: z.string().trim().max(40).optional(), phoneHref: z.string().trim().max(60).optional(), location: z.string().trim().max(120).optional() }).partial().default({}),
        socials: z.array(z.object({ label: z.string().trim().max(40), href: z.string().trim().max(300), icon: z.string().trim().max(40) })).max(10).default([]),
      }),
      expectedVersion: version,
    }).parse(req.body);
    ok(res, await home.setFooterMeta(meta, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}

// ---- content pages -------------------------------------------
const blockSchema = z.object({
  type: z.enum(['HEADING', 'PARAGRAPH', 'LIST', 'IMAGE', 'CONTACT', 'DIVIDER', 'CALLOUT']),
  data: z.object({}).passthrough().default({}),
  mediaId: z.string().uuid().nullish(),
});
const pageCreateSchema = z.object({
  pageKey: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(140),
  title: z.string().trim().min(1).max(160),
  navLabel: z.string().trim().max(120).nullish(),
  seoTitle: z.string().trim().max(180).nullish(),
  seoDescription: z.string().trim().max(320).nullish(),
});
const pagePatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  navLabel: z.string().trim().max(120).nullish(),
  seoTitle: z.string().trim().max(180).nullish(),
  seoDescription: z.string().trim().max(320).nullish(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  expectedVersion: version,
});
const faqItemSchema = z.object({
  itemKey: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80).optional(),
  category: z.string().trim().max(120).optional(),
  question: z.string().trim().min(1).max(300),
  answer: z.union([z.string(), z.array(z.string())]),
});

export async function listPages(req, res, next) {
  try { ok(res, await pages.listPages(req.brandId)); } catch (e) { next(e); }
}
export async function getPage(req, res, next) {
  try { ok(res, await pages.getPageDraft(req.params.slug, req.brandId)); } catch (e) { next(e); }
}
export async function createPage(req, res, next) {
  try { ok(res, await pages.createPage(pageCreateSchema.parse(req.body), actorOf(req), req.brandId), 201); } catch (e) { next(e); }
}
export async function updatePage(req, res, next) {
  try {
    const { expectedVersion, ...patch } = pagePatchSchema.parse(req.body);
    ok(res, await pages.updatePage(req.params.slug, patch, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function setPageBlocks(req, res, next) {
  try {
    const { blocks, expectedVersion } = z.object({ blocks: z.array(blockSchema).max(200), expectedVersion: version }).parse(req.body);
    ok(res, await pages.setPageBlocks(req.params.slug, blocks, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function pageHistory(req, res, next) {
  try { ok(res, await pages.pageHistory(req.params.slug, req.brandId)); } catch (e) { next(e); }
}
export async function publishPage(req, res, next) {
  try {
    const { expectedVersion } = z.object({ expectedVersion: version.optional() }).parse(req.body || {});
    ok(res, await pages.publishPage(req.params.slug, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function rollbackPage(req, res, next) {
  try {
    const { targetPublicationId } = z.object({ targetPublicationId: z.string().uuid() }).parse(req.body);
    ok(res, await pages.rollbackPage(req.params.slug, targetPublicationId, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function getFaq(req, res, next) {
  try { ok(res, await pages.getFaqDraft(req.brandId)); } catch (e) { next(e); }
}
export async function setFaqItems(req, res, next) {
  try {
    const { items, expectedVersion } = z.object({ items: z.array(faqItemSchema).max(300), expectedVersion: version }).parse(req.body);
    ok(res, await pages.setFaqItems(items, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function faqHistory(req, res, next) {
  try { ok(res, await pages.faqHistory(req.brandId)); } catch (e) { next(e); }
}
export async function publishFaq(req, res, next) {
  try {
    const { expectedVersion } = z.object({ expectedVersion: version.optional() }).parse(req.body || {});
    ok(res, await pages.publishFaq(expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function rollbackFaq(req, res, next) {
  try {
    const { targetPublicationId } = z.object({ targetPublicationId: z.string().uuid() }).parse(req.body);
    ok(res, await pages.rollbackFaq(targetPublicationId, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}

// ---- themes ---------------------------------------------------
const themeCreateSchema = z.object({
  themeKey: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80),
  name: z.string().trim().min(1).max(120),
  tokens: z.record(z.string()).default({}),
});
const themePatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  tokens: z.record(z.string()).optional(),
  isDefault: z.literal(true).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  expectedVersion: version,
});
export async function listThemes(req, res, next) {
  try { ok(res, await camp.listThemes(req.brandId)); } catch (e) { next(e); }
}
export async function getTheme(req, res, next) {
  try { ok(res, await camp.getThemeDraft(req.params.key, req.brandId)); } catch (e) { next(e); }
}
export async function createTheme(req, res, next) {
  try { ok(res, await camp.createTheme(themeCreateSchema.parse(req.body), actorOf(req), req.brandId), 201); } catch (e) { next(e); }
}
export async function updateTheme(req, res, next) {
  try {
    const { expectedVersion, ...patch } = themePatchSchema.parse(req.body);
    ok(res, await camp.updateTheme(req.params.key, patch, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function themeHistory(req, res, next) {
  try { ok(res, await camp.themeHistory(req.params.key, req.brandId)); } catch (e) { next(e); }
}
export async function publishTheme(req, res, next) {
  try {
    const { expectedVersion } = z.object({ expectedVersion: version.optional() }).parse(req.body || {});
    ok(res, await camp.publishTheme(req.params.key, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function rollbackTheme(req, res, next) {
  try {
    const { targetPublicationId } = z.object({ targetPublicationId: z.string().uuid() }).parse(req.body);
    ok(res, await camp.rollbackTheme(req.params.key, targetPublicationId, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}

// ---- campaigns ----------------------------------------------
const campPayloadSchema = z.object({
  announcementMode: z.enum(['prepend', 'replace']).optional(),
  announcements: z.array(z.object({ text: z.string().trim().min(1).max(300), link: z.string().trim().max(180).nullish() })).max(10).optional(),
  banner: z.object({
    text: z.string().trim().min(1).max(200),
    ctaLabel: z.string().trim().max(60).nullish(),
    ctaPath: z.string().trim().max(180).nullish(),
  }).nullish(),
}).passthrough();
const campCreateSchema = z.object({
  campaignKey: z.string().trim().regex(/^[a-z][a-z0-9_]*$/).max(80),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(140),
  name: z.string().trim().min(1).max(160),
  priority: z.number().int().min(0).max(1000).optional(),
  startsAt: z.string().min(1),
  endsAt: z.string().min(1),
  themeKey: z.string().trim().max(80).nullish(),
  payload: campPayloadSchema.optional(),
});
const campPatchSchema = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  priority: z.number().int().min(0).max(1000).optional(),
  startsAt: z.string().min(1).optional(),
  endsAt: z.string().min(1).optional(),
  themeKey: z.string().trim().max(80).nullish(),
  payload: campPayloadSchema.optional(),
  status: z.enum(['DRAFT', 'SCHEDULED', 'ARCHIVED']).optional(),
  expectedVersion: version,
});
export async function listCampaigns(req, res, next) {
  try { ok(res, await camp.listCampaigns(req.brandId)); } catch (e) { next(e); }
}
export async function getCampaign(req, res, next) {
  try { ok(res, await camp.getCampaignDraft(req.params.slug, req.brandId)); } catch (e) { next(e); }
}
export async function createCampaign(req, res, next) {
  try { ok(res, await camp.createCampaign(campCreateSchema.parse(req.body), actorOf(req), req.brandId), 201); } catch (e) { next(e); }
}
export async function updateCampaign(req, res, next) {
  try {
    const { expectedVersion, ...patch } = campPatchSchema.parse(req.body);
    ok(res, await camp.updateCampaign(req.params.slug, patch, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function campaignHistory(req, res, next) {
  try { ok(res, await camp.campaignHistory(req.params.slug, req.brandId)); } catch (e) { next(e); }
}
export async function publishCampaign(req, res, next) {
  try {
    const { expectedVersion } = z.object({ expectedVersion: version.optional() }).parse(req.body || {});
    ok(res, await camp.publishCampaign(req.params.slug, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function rollbackCampaign(req, res, next) {
  try {
    const { targetPublicationId } = z.object({ targetPublicationId: z.string().uuid() }).parse(req.body);
    ok(res, await camp.rollbackCampaign(req.params.slug, targetPublicationId, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function setCampaignDisabled(req, res, next) {
  try {
    const { disabled, reason } = z.object({ disabled: z.boolean(), reason: z.string().trim().max(300).optional() }).parse(req.body);
    ok(res, await camp.setCampaignDisabled(req.params.slug, disabled, reason, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}

// ---- preview tokens ------------------------------------------
// content_preview_tokens is not in DESIGN.md §4.1's table list — left
// unscoped (global to the CMS install, same as before Phase 3).
const previewTokenSchema = z.object({
  scope: z.string().trim().max(80).default('all'),
  asOf: z.string().trim().max(40).nullish(),
  ttlSeconds: z.coerce.number().int().min(60).max(3600).optional(),
  label: z.string().trim().max(160).nullish(),
});
export async function createPreviewToken(req, res, next) {
  try {
    const body = previewTokenSchema.parse(req.body || {});
    ok(res, await preview.createPreviewToken({ ...body, staffId: req.staff?.id || null, actor: actorOf(req) }), 201);
  } catch (e) { next(e); }
}
export async function listPreviewTokens(req, res, next) {
  try { ok(res, await preview.listPreviewTokens(req.staff?.id || null)); } catch (e) { next(e); }
}
export async function revokePreviewToken(req, res, next) {
  try { ok(res, await preview.revokePreviewToken(req.params.id, actorOf(req))); } catch (e) { next(e); }
}

// ---- publish / history / rollback ------------------------------
const SCOPES = ['navigation', 'mega-menus', 'announcements', 'homepage', 'footer'];
const HOME_FOOTER = new Set(['homepage', 'footer']);
const publisher = (scope) => (HOME_FOOTER.has(scope) ? home : nav);
export async function history(req, res, next) {
  try {
    if (!SCOPES.includes(req.params.scope)) return res.status(422).json({ error: { code: 'CONTENT_INVALID', message: 'Unknown scope.' } });
    ok(res, await publisher(req.params.scope).scopeHistory(req.params.scope, req.brandId));
  } catch (e) { next(e); }
}
export async function publish(req, res, next) {
  try {
    if (!SCOPES.includes(req.params.scope)) return res.status(422).json({ error: { code: 'CONTENT_INVALID', message: 'Unknown scope.' } });
    const { expectedVersion } = z.object({ expectedVersion: version.optional() }).parse(req.body || {});
    ok(res, await publisher(req.params.scope).publishScope(req.params.scope, expectedVersion, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
export async function rollback(req, res, next) {
  try {
    if (!SCOPES.includes(req.params.scope)) return res.status(422).json({ error: { code: 'CONTENT_INVALID', message: 'Unknown scope.' } });
    const { targetPublicationId } = z.object({ targetPublicationId: z.string().uuid() }).parse(req.body);
    ok(res, await publisher(req.params.scope).rollbackScope(req.params.scope, targetPublicationId, actorOf(req), req.brandId));
  } catch (e) { next(e); }
}
