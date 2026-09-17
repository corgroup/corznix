import { z } from 'zod';
import { heroBannerRepository, HERO_DEFAULTS } from './repository.js';
import { findMediaById } from '../media/service.js';
import { AppError } from '../../utils/errors.js';

// Homepage hero slides. Each slide: a desktop picture or video and an optional
// phone one, the copy and button, where the copy sits (separately for phones),
// white or dark text on a shade of chosen strength, how long a picture slide
// stays, and an optional schedule. A switched-on slide is live as soon as it is
// saved. Field limits mirror the CMS builder (apps/cms .../heroModel.js), so a
// value the builder accepts is never rejected here, and vice versa.

export const HERO_POSITIONS = Object.freeze([
  'TOP_LEFT', 'TOP_CENTER', 'TOP_RIGHT',
  'MIDDLE_LEFT', 'MIDDLE_CENTER', 'MIDDLE_RIGHT',
  'BOTTOM_LEFT', 'BOTTOM_CENTER', 'BOTTOM_RIGHT',
]);

const optionalText = (max) => z.string().trim().max(max).optional().nullable()
  .transform((v) => (v === '' ? null : v ?? null));
const optionalMedia = z.string().uuid().optional().nullable().transform((v) => v || null);

const bannerSchema = z.object({
  mediaId: optionalMedia,
  mobileMediaId: optionalMedia,
  title: optionalText(100),
  subtitle: optionalText(200),
  ctaLabel: optionalText(60),
  ctaHref: optionalText(500),
  altText: optionalText(255),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  displayOrder: z.coerce.number().int().min(0).optional(),
  startsAt: z.coerce.date().optional().nullable().transform((v) => v ?? null),
  endsAt: z.coerce.date().optional().nullable().transform((v) => v ?? null),
  textPosition: z.enum(HERO_POSITIONS).optional(),
  mobileTextPosition: z.enum(HERO_POSITIONS).optional(),
  textTheme: z.enum(['LIGHT', 'DARK']).optional(),
  overlay: z.number().int().min(0).max(90).optional(),
  durationSeconds: z.number().int().min(3).max(20).optional(),
});

const FIELD = {
  mediaId: 'The desktop picture', mobileMediaId: 'The phone picture', title: 'The title', subtitle: 'The line under the title',
  ctaLabel: 'The button text', ctaHref: 'The button link', altText: 'The picture description', status: 'On/off',
  displayOrder: 'The position', startsAt: 'The start date', endsAt: 'The end date', textPosition: 'The desktop text position',
  mobileTextPosition: 'The phone text position', textTheme: 'The text colour', overlay: 'The shade (0–90)',
  durationSeconds: 'How long the slide shows (3–20 seconds)',
};

/** One readable refusal instead of a raw validation dump. */
function parse(schema, body) {
  const result = schema.safeParse(body ?? {});
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new AppError('HERO_BANNER_INVALID', `${FIELD[issue.path[0]] || 'A field'} is not valid.`, 422);
}

// A page on this site, or a full https address. Never "//host", "javascript:"
// or plain http.
const linkOk = (href) => /^\/(?!\/)\S*$/.test(href) || /^https:\/\/\S+$/i.test(href);

/** What a slide must be, checked on the RESULT of a create or an edit. */
function assertSlide(banner) {
  const label = banner.ctaLabel ?? null;
  const href = banner.ctaHref ?? null;
  // A button with no destination is a dead control; a link with no button is invisible.
  if (label && !href) throw new AppError('HERO_BANNER_CTA_INCOMPLETE', 'Button text is set but the button link is empty.', 422);
  if (href && !label) throw new AppError('HERO_BANNER_CTA_INCOMPLETE', 'The button link is set but the button has no text.', 422);
  if (href && !linkOk(href)) {
    throw new AppError('HERO_BANNER_LINK_INVALID', 'The button link must be a page on this website (starting with "/") or a full https:// address.', 422);
  }
  if (banner.status === 'ACTIVE' && !banner.mediaId) {
    throw new AppError('HERO_BANNER_IMAGE_REQUIRED', 'A slide needs a desktop picture or video before it can be switched on.', 422);
  }
  if (banner.startsAt && banner.endsAt && new Date(banner.startsAt) > new Date(banner.endsAt)) {
    throw new AppError('HERO_BANNER_SCHEDULE_INVALID', 'End date must be after the start date.', 422);
  }
}

/** The chosen picture exists, is live and belongs to this company. */
async function assertMedia(mediaId, brandId, which) {
  if (!mediaId) return;
  const asset = await findMediaById(mediaId);
  if (!asset || asset.status !== 'ACTIVE' || asset.brandId !== brandId) {
    throw new AppError('MEDIA_NOT_FOUND', `${which} is no longer available in the Media Library.`, 404);
  }
}

const look = (row) => ({
  textPosition: row.text_position,
  mobileTextPosition: row.mobile_text_position,
  textTheme: row.text_theme,
  overlay: Number(row.overlay),
  durationSeconds: Number(row.duration_seconds),
});

const toDto = (row) => (row ? {
  id: row.id,
  mediaId: row.media_id,
  mediaUrl: row.media_url || null,
  mediaType: row.media_type || null,
  mobileMediaId: row.mobile_media_id,
  mobileMediaUrl: row.mobile_media_url || null,
  mobileMediaType: row.mobile_media_type || null,
  title: row.title,
  subtitle: row.subtitle,
  ctaLabel: row.cta_label,
  ctaHref: row.cta_href,
  altText: row.alt_text || row.media_alt_text || null,
  status: row.status,
  displayOrder: Number(row.display_order),
  startsAt: row.starts_at,
  endsAt: row.ends_at,
  ...look(row),
  updatedAt: row.updated_at,
} : null);

/** What the storefront renders for one slide, and nothing else. */
const toPublic = (row) => ({
  id: row.id,
  mediaUrl: row.media_url,
  mediaType: row.media_type,
  mobileMediaUrl: row.mobile_media_url || null,
  mobileMediaType: row.mobile_media_url ? row.mobile_media_type : null,
  title: row.title,
  subtitle: row.subtitle,
  ctaLabel: row.cta_label,
  ctaHref: row.cta_href,
  altText: row.alt_text || row.media_alt_text || null,
  ...look(row),
});

// The hero the storefront shows before a store has any slides
// (apps/corcotton .../HeroSection.jsx LEGACY_HERO). "Start from the current
// hero" turns exactly that into editable slides.
const LEGACY_HERO = [
  { mediaKey: 'home_hero_1', title: 'Comfort is not a compromise. It is a choice.', subtitle: 'Gentle on skin, gentle on the earth. Always.', ctaLabel: 'Explore Collection', ctaHref: '/collections' },
  { mediaKey: 'home_hero_2', title: 'Natural fabrics. Timeless design. Everyday luxury.', subtitle: 'Responsibly sourced cotton, crafted for the way you live.', ctaLabel: 'Shop Tshirt', ctaHref: '/collections' },
];

export const heroBannerService = {
  async list(brandId) {
    return (await heroBannerRepository.list(brandId)).map(toDto);
  },

  /** Storefront: the slides on the page right now, and whether the store has any slides at all. */
  async publicHero(brandId) {
    const [live, total] = await Promise.all([heroBannerRepository.listLive(brandId), heroBannerRepository.count(brandId)]);
    return { banners: live.map(toPublic), configured: total > 0 };
  },

  async create(brandId, body, staffId) {
    const input = parse(bannerSchema, body);
    assertSlide(input);
    await assertMedia(input.mediaId, brandId, 'The desktop picture');
    await assertMedia(input.mobileMediaId, brandId, 'The phone picture');
    return toDto(await heroBannerRepository.create(brandId, input, staffId));
  },

  async update(id, brandId, body, staffId) {
    const patch = parse(bannerSchema.partial(), body);
    const current = await heroBannerRepository.byId(id, brandId);
    if (!current) throw new AppError('HERO_BANNER_NOT_FOUND', 'Banner not found.', 404);
    // Validate the RESULT of the patch, not the patch alone — switching a
    // slide on must be checked against the picture it already has.
    assertSlide({ ...toDto(current), ...patch });
    if (patch.mediaId !== undefined) await assertMedia(patch.mediaId, brandId, 'The desktop picture');
    if (patch.mobileMediaId !== undefined) await assertMedia(patch.mobileMediaId, brandId, 'The phone picture');
    const updated = await heroBannerRepository.update(id, brandId, patch, staffId);
    if (!updated) throw new AppError('HERO_BANNER_NOT_FOUND', 'Banner not found.', 404);
    return toDto(updated);
  },

  async remove(id, brandId) {
    const ok = await heroBannerRepository.remove(id, brandId);
    if (!ok) throw new AppError('HERO_BANNER_NOT_FOUND', 'Banner not found.', 404);
    return { removed: true };
  },

  /** Copies land switched off so duplicating never publishes something by accident. */
  async duplicate(id, brandId, staffId) {
    const source = await heroBannerRepository.byId(id, brandId);
    if (!source) throw new AppError('HERO_BANNER_NOT_FOUND', 'Banner not found.', 404);
    const dto = toDto(source);
    return toDto(await heroBannerRepository.create(brandId, {
      mediaId: dto.mediaId,
      mobileMediaId: dto.mobileMediaId,
      title: dto.title ? `${dto.title} (copy)`.slice(0, 100) : null,
      subtitle: dto.subtitle,
      ctaLabel: dto.ctaLabel,
      ctaHref: dto.ctaHref,
      altText: source.alt_text,
      status: 'INACTIVE',
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      textPosition: dto.textPosition,
      mobileTextPosition: dto.mobileTextPosition,
      textTheme: dto.textTheme,
      overlay: dto.overlay,
      durationSeconds: dto.durationSeconds,
    }, staffId));
  },

  async reorder(brandId, orderedIds) {
    const ids = z.array(z.string().uuid()).safeParse(orderedIds ?? []);
    if (!ids.success) throw new AppError('HERO_BANNER_INVALID', 'The new order is not a list of slides.', 422);
    return (await heroBannerRepository.reorder(brandId, ids.data)).map(toDto);
  },

  /**
   * A store with no slides yet: turn the built-in hero (the two site-media
   * videos and their copy) into real, switched-on slides, so the homepage
   * looks exactly as before and every part of it is now editable.
   */
  async importCurrent(brandId, staffId) {
    if (await heroBannerRepository.count(brandId) > 0) {
      throw new AppError('HERO_BANNERS_EXIST', 'This store already has hero slides — edit them instead.', 409);
    }
    const media = new Map((await heroBannerRepository.legacyMedia(brandId, LEGACY_HERO.map((s) => s.mediaKey)))
      .map((row) => [row.media_key, row]));
    const legacy = LEGACY_HERO.filter((s) => media.has(s.mediaKey));
    if (!legacy.length) {
      throw new AppError('HERO_IMPORT_NOTHING', 'There is no built-in hero to start from. Add a slide instead.', 422);
    }
    for (const s of legacy) {
      const m = media.get(s.mediaKey);
      await heroBannerRepository.create(brandId, {
        ...HERO_DEFAULTS,
        mediaId: m.media_id,
        altText: m.alt_text || null,
        title: s.title,
        subtitle: s.subtitle,
        ctaLabel: s.ctaLabel,
        ctaHref: s.ctaHref,
        status: 'ACTIVE',
      }, staffId);
    }
    return { banners: await this.list(brandId) };
  },
};
