import * as service from './service.js';
import { resolveHeader, resolveHeaderPreview } from './navigationService.js';
import { resolveHomepage, resolveHomepagePreview } from './homepageService.js';
import { resolvePage, resolveFaq, listPublishedPageSlugs, resolvePagePreview, resolveFaqPreview } from './pagesService.js';
import { resolveExperience } from './campaignService.js';
import { previewContext } from './previewService.js';
import { AppError } from '../../utils/errors.js';
import { z } from 'zod';

const ok = (res, data, status = 200) => res.status(status).json({ data });

// ---- public --------------------------------------------------------------

export async function siteMedia(_req, res, next) {
  try { ok(res, { siteMedia: await service.getSiteMedia() }); } catch (err) { next(err); }
}

// Global chrome — one layout-level fetch (§157). navigation / megaMenus /
// announcements are the published DEFAULT (campaign overlay is applied here
// from Phase 6). `version` is a cache key.
export async function header(req, res, next) {
  try {
    const pv = await previewContext(req, res, 'header');
    ok(res, pv ? await resolveHeaderPreview({ asOf: pv.asOf }) : await resolveHeader());
  } catch (err) { next(err); }
}

// Homepage composition — enabled sections in order, each a whitelisted
// section_type the storefront maps to an existing component.
export async function homepage(req, res, next) {
  try {
    const pv = await previewContext(req, res, 'homepage');
    ok(res, pv ? await resolveHomepagePreview(req.brandId) : await resolveHomepage(req.brandId));
  } catch (err) { next(err); }
}

// Published static pages. `/pages` lists the live slugs (storefront route
// registration / footer link checks); `/pages/:slug` is one resolved page.
export async function pagesIndex(_req, res, next) {
  try { ok(res, { pages: await listPublishedPageSlugs() }); } catch (err) { next(err); }
}
export async function page(req, res, next) {
  try {
    const pv = await previewContext(req, res, `page:${req.params.slug}`);
    const snap = pv ? await resolvePagePreview(req.params.slug) : await resolvePage(req.params.slug);
    if (!snap) throw new AppError('CONTENT_PAGE_NOT_FOUND', `No ${pv ? '' : 'published '}page "${req.params.slug}".`, 404);
    ok(res, snap);
  } catch (err) { next(err); }
}
export async function faq(req, res, next) {
  try {
    const pv = await previewContext(req, res, 'faq');
    ok(res, pv ? await resolveFaqPreview() : await resolveFaq());
  } catch (err) { next(err); }
}

// Resolved experience — theme tokens + active-campaign overlay, computed at
// request time from published campaign windows (no cron). `version` is a
// content fingerprint for cache-keying. With a valid preview token the
// campaigns resolve from their DRAFT definitions as of the token's `asOf`.
export async function experience(req, res, next) {
  try {
    const pv = await previewContext(req, res, 'experience');
    ok(res, pv ? await resolveExperience({ now: pv.asOf, includeDrafts: true }) : await resolveExperience());
  } catch (err) { next(err); }
}

// ---- admin ---------------------------------------------------------------

const setSchema = z.object({
  mediaId: z.string().uuid(),
  altText: z.string().trim().max(255).nullish(),
});

export async function adminListSiteMedia(req, res, next) {
  try { ok(res, await service.listSiteMedia(req.brandId)); } catch (err) { next(err); }
}

export async function adminSetSiteMedia(req, res, next) {
  try {
    const body = setSchema.parse(req.body);
    ok(res, await service.setSiteMedia(req.params.key, body.mediaId, {
      altText: body.altText ?? null,
      staffId: req.staff?.id || null,
      brandId: req.brandId,
    }));
  } catch (err) { next(err); }
}
