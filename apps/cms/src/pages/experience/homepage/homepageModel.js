// Homepage builder model: what a section is in the editor, how it is saved,
// how it is checked, and what the live preview is sent.
//
// The server (content/homepageService.js) is the authority on what may be
// saved and content/entityLinks.js on what the public homepage shows; the
// checks and preview resolution here mirror them so an editor sees a problem
// — or a hidden section — while typing, not after saving.
import { same, entityOf, entityRoute, catalogSlugOf, isValidPath } from '../header/headerModel.js';
import { makeRowKey } from '../../../components/ui/rowHelpers.js';

export const LIMITS = {
  eyebrow: 40, heading: 80, description: 160, body: 600, ctaLabel: 40,
  phrase: 40, phrases: 8, trustTitle: 40, trustSub: 60, trustItems: 4, igPicks: 24,
};

export const DEFAULT_AUTOPLAY = 6;
export const AUTOPLAY_CHOICES = [4, 6, 8, 10];

// The Instagram section shows posts synced from the store's own account
// (Providers -> Instagram): the newest few, or the ones an editor picks.
// Mirrors server/src/modules/content/instagram.js.
export const IG_LIMIT_CHOICES = [4, 6, 8, 12];
export const DEFAULT_IG_LIMIT = 8;
const igLimit = (config) => Math.min(Math.max(Number(config.limit) || DEFAULT_IG_LIMIT, 3), 12);

/**
 * The posts the website shows for this section, from the synced posts the CMS
 * loaded (newest first) — the same choice and public shape as the server:
 * only live posts with a copied picture.
 */
export function instagramPreviewPosts(s, posts = []) {
  const usable = new Map(posts.filter((p) => p.status === 'ACTIVE' && p.coverUrl).map((p) => [p.igMediaId, p]));
  const chosen = s.config.mode === 'PICKED'
    ? s.picks.filter((p) => p.enabled).map((p) => usable.get(p.igMediaId)).filter(Boolean)
    : [...usable.values()].slice(0, igLimit(s.config));
  return chosen.map((p) => ({
    id: p.igMediaId,
    kind: p.kind,
    permalink: p.permalink,
    embedUrl: p.shortcode ? `https://www.instagram.com/p/${p.shortcode}/embed/` : null,
    coverUrl: p.coverUrl,
    caption: p.caption ? p.caption.trim().slice(0, 140) : null,
  }));
}

// Icon names the storefront can draw (features/header/iconRegistry.js) —
// the server accepts exactly these.
export const ICONS = [
  ['leaf', 'Leaf'], ['shield-check', 'Shield'], ['refresh', 'Returns arrows'], ['truck', 'Delivery truck'],
  ['star', 'Star'], ['sparkles', 'Sparkles'], ['calendar', 'Calendar'], ['bag-handle', 'Shopping bag'],
  ['shirt', 'Shirt'], ['pants', 'Trousers'], ['trending-up', 'Trending'], ['apps', 'Grid'],
];

export const TYPE_INFO = {
  HERO: { name: 'Hero slides', blurb: 'full-width slides at the top', single: true },
  BRAND_STRIP: { name: 'Brand strip', blurb: 'scrolling brand phrases', single: true },
  PRODUCT_CAROUSEL: { name: 'Product carousel', blurb: 'products from a collection, in a sliding row' },
  COLLECTION_GRID: { name: 'Product grid', blurb: 'products from a collection, in a grid' },
  CATEGORY_SECTION: { name: 'Shop by collection', blurb: 'your collection cards', single: true },
  EDITORIAL_BANNER: { name: 'Story banner', blurb: 'heading, text and a button on black, an image or a video' },
  REVIEWS: { name: 'Customer reviews', blurb: 'real published reviews', single: true },
  TRUST_STRIP: { name: 'Trust strip', blurb: 'promises with icons', single: true },
  INSTAGRAM_VIDEOS: { name: 'Instagram posts', blurb: 'your real Instagram reels and posts, in a moving carousel', single: true },
  PROMO_BANNER: { name: 'Promo banner' },
  IMAGE_TEXT: { name: 'Image and text' },
  CONTENT_BLOCK: { name: 'Content block' },
};

// The homepage testimonials slot is the Instagram section now. Product
// reviews are not affected: customers review delivered products and those
// reviews show on the product page.
export const ADDABLE = ['PRODUCT_CAROUSEL', 'COLLECTION_GRID', 'EDITORIAL_BANNER', 'INSTAGRAM_VIDEOS', 'TRUST_STRIP', 'BRAND_STRIP', 'CATEGORY_SECTION', 'HERO'];
// Types the server stores but the storefront has no design for: never offered,
// and an existing one is flagged instead of silently doing nothing.
export const UNSUPPORTED = new Set(['PROMO_BANNER', 'IMAGE_TEXT', 'CONTENT_BLOCK']);
// These two carousels choose their own products.
export const AUTOMATIC_PRODUCTS = { latest_drop: 'Newest arrivals, chosen automatically', best_sellers: 'Best sellers, chosen automatically' };

const COLLECTION_TYPES = new Set(['PRODUCT_CAROUSEL', 'COLLECTION_GRID']);
const TEXT_KEYS = ['eyebrow', 'heading', 'description', 'body', 'ctaLabel', 'ctaPath'];
const t = (v) => (typeof v === 'string' ? v.trim() : '');

export const DEFAULT_OVERLAY = 55;
export const guessMediaType = (url) => (/\/video\/upload\/|\.(mp4|webm|mov)(\?|$)/i.test(url || '') ? 'video' : 'image');

export function hydrateSection(s) {
  const config = JSON.parse(JSON.stringify(s.config || {}));
  return {
    _k: s.id,
    id: s.id,
    sectionKey: s.sectionKey,
    type: s.type,
    enabled: Boolean(s.enabled),
    mediaId: s.mediaId || null,
    mediaUrl: s.mediaUrl || null,
    mediaType: s.mediaType || null,
    config,
    phrases: (Array.isArray(config.phrases) ? config.phrases : []).map((text) => ({ _k: makeRowKey(), text: String(text) })),
    items: (Array.isArray(config.items) ? config.items : []).map((it) => ({
      _k: makeRowKey(), icon: it?.icon || 'leaf', title: it?.title || '', sub: it?.sub || '',
    })),
    picks: (Array.isArray(config.picks) ? config.picks : []).map((p) => ({
      _k: makeRowKey(), igMediaId: String(p?.igMediaId || ''), enabled: p?.enabled !== false,
    })),
  };
}

export function serializeSection(s) {
  const config = { ...s.config };
  for (const k of TEXT_KEYS) {
    if (!(k in config)) continue;
    const v = t(config[k]);
    if (v) config[k] = v; else delete config[k];
  }
  if (!config.collectionRef) delete config.collectionRef;
  if (!config.ctaRef) delete config.ctaRef;
  if (s.type === 'BRAND_STRIP') config.phrases = s.phrases.map((p) => t(p.text)).filter(Boolean);
  if (s.type === 'TRUST_STRIP') {
    config.items = s.items.map((it) => ({ icon: it.icon, title: t(it.title), ...(t(it.sub) ? { sub: t(it.sub) } : {}) }));
  }
  if (s.type === 'INSTAGRAM_VIDEOS') {
    delete config.videos;
    config.mode = config.mode === 'PICKED' ? 'PICKED' : 'LATEST';
    config.limit = Number.isInteger(config.limit) ? config.limit : DEFAULT_IG_LIMIT;
    config.picks = s.picks.map((p) => ({ igMediaId: p.igMediaId, enabled: Boolean(p.enabled) }));
  }
  if (!s.mediaId) delete config.overlay;
  return { id: s.id, sectionKey: s.sectionKey, type: s.type, enabled: s.enabled, config, mediaId: s.mediaId || null };
}

export const collectionEntity = (config, entities) => entityOf(
  { ref: config.collectionRef || null, path: config.collectionSlug ? `/collections/${config.collectionSlug}` : '' },
  entities,
);

/** `instagram` is the loaded synced posts ({ posts, status }) or null while loading. */
export function validateSection(s, entities, instagram = null) {
  const errors = [];
  const warnings = [];
  const c = s.config;
  const over = (key, max, label) => {
    if (typeof c[key] === 'string' && c[key].length > max) errors.push(`${label} is longer than ${max} characters.`);
  };
  switch (s.type) {
    case 'BRAND_STRIP':
      if (!s.phrases.some((p) => t(p.text))) errors.push('Add at least one phrase.');
      else if (s.phrases.some((p) => !t(p.text))) errors.push('Fill in or remove the empty phrase.');
      if (s.phrases.length > LIMITS.phrases) errors.push(`At most ${LIMITS.phrases} phrases.`);
      if (s.phrases.some((p) => p.text.length > LIMITS.phrase)) errors.push(`A phrase can be at most ${LIMITS.phrase} characters.`);
      break;
    case 'TRUST_STRIP':
      if (!s.items.length) errors.push('Add at least one promise.');
      if (s.items.some((it) => !t(it.title))) errors.push('Every promise needs a title.');
      if (s.items.length > LIMITS.trustItems) errors.push(`At most ${LIMITS.trustItems} promises.`);
      if (s.items.some((it) => it.title.length > LIMITS.trustTitle || it.sub.length > LIMITS.trustSub)) errors.push('A promise is longer than allowed.');
      break;
    case 'PRODUCT_CAROUSEL':
    case 'COLLECTION_GRID':
      over('eyebrow', LIMITS.eyebrow, 'The small line');
      over('heading', LIMITS.heading, 'The heading');
      over('description', LIMITS.description, 'The line under the heading');
      if (!AUTOMATIC_PRODUCTS[s.sectionKey]) {
        if (!t(c.collectionSlug)) errors.push('Choose which collection the products come from.');
        else if (entities) {
          const e = collectionEntity(c, entities);
          if (!e) errors.push('That collection no longer exists — choose another.');
          else if (!e.active) warnings.push(`“${e.name}” is switched off in the catalog, so this section is hidden until it is switched back on.`);
        }
      }
      break;
    case 'CATEGORY_SECTION':
      over('heading', LIMITS.heading, 'The heading');
      break;
    case 'REVIEWS':
      over('eyebrow', LIMITS.eyebrow, 'The small line');
      over('heading', LIMITS.heading, 'The heading');
      break;
    case 'INSTAGRAM_VIDEOS': {
      over('eyebrow', LIMITS.eyebrow, 'The small line');
      over('heading', LIMITS.heading, 'The heading');
      over('description', LIMITS.description, 'The line under the heading');
      if (s.picks.length > LIMITS.igPicks) errors.push(`Pick at most ${LIMITS.igPicks} posts.`);
      const ids = s.picks.map((p) => p.igMediaId);
      if (new Set(ids).size !== ids.length) errors.push('The same post is picked twice.');
      if (instagram && instagramPreviewPosts(s, instagram.posts).length === 0) {
        if (!instagram.status?.connected && instagram.posts.length === 0) {
          warnings.push('Instagram is not connected yet, so this section is hidden. Connect the account in Providers → Instagram.');
        } else if (c.mode === 'PICKED') {
          warnings.push(s.picks.some((p) => p.enabled)
            ? 'None of the posts you picked can be shown (deleted on Instagram, or no picture yet), so this section is hidden.'
            : 'No picked post is switched on, so this section is hidden.');
        } else {
          warnings.push('No Instagram posts with a picture have been synced yet, so this section is hidden.');
        }
      }
      break;
    }
    case 'EDITORIAL_BANNER': {
      over('eyebrow', LIMITS.eyebrow, 'The small line');
      over('heading', LIMITS.heading, 'The heading');
      over('body', LIMITS.body, 'The text');
      over('ctaLabel', LIMITS.ctaLabel, 'The button text');
      if (!t(c.heading) && !t(c.body)) errors.push('Add a heading or some text.');
      const hasLink = Boolean(t(c.ctaPath) || c.ctaRef);
      if (t(c.ctaLabel) && !hasLink) errors.push('The button needs a link — or clear the button text.');
      if (!t(c.ctaLabel) && hasLink) errors.push('The button needs text — or clear its link.');
      if (t(c.ctaPath) && !c.ctaRef) {
        if (/^https?:/i.test(t(c.ctaPath))) errors.push('The button must open a page on this website (start with "/").');
        else if (!isValidPath(c.ctaPath)) errors.push('The button link must start with "/".');
      }
      if (hasLink && entities) {
        const e = entityOf({ ref: c.ctaRef || null, path: c.ctaPath }, entities);
        if (e && !e.active) warnings.push(`“${e.name}” is switched off, so the button is hidden until it is back on.`);
      }
      break;
    }
    default:
      break;
  }
  return { errors, warnings };
}

/**
 * The sections the storefront would show for this draft — the same resolution
 * the server applies to the published homepage (entityLinks.resolveHomepageSections
 * and content/instagram.js): hidden and unsupported sections are left out, a
 * product section follows its collection (switched off -> not shown), a button
 * follows its page or collection (gone -> no button), the Instagram section
 * carries its posts. References and editing settings never leave the CMS.
 */
export function previewSections(sections, entities, instagram = null) {
  return sections
    .filter((s) => s.enabled && !UNSUPPORTED.has(s.type))
    .map((s) => {
      const { collectionRef, ctaRef, ...config } = serializeSection(s).config;
      if (COLLECTION_TYPES.has(s.type) && entities && (config.collectionSlug || collectionRef)) {
        const e = collectionEntity({ collectionRef, collectionSlug: config.collectionSlug }, entities);
        if (!e || !e.active) return null;
        config.collectionSlug = e.slug;
      }
      if (s.type === 'EDITORIAL_BANNER' && entities && (config.ctaPath || ctaRef)) {
        const e = entityOf({ ref: ctaRef || null, path: config.ctaPath || '' }, entities);
        const managed = Boolean(e || ctaRef || catalogSlugOf(config.ctaPath));
        if (managed) {
          if (e && e.active) config.ctaPath = entityRoute(e);
          else { delete config.ctaPath; delete config.ctaLabel; }
        }
      }
      if (s.type === 'INSTAGRAM_VIDEOS') {
        delete config.mode;
        delete config.limit;
        delete config.picks;
        config.posts = instagramPreviewPosts(s, instagram?.posts || []);
      }
      return { key: s.sectionKey, type: s.type, config, mediaUrl: s.mediaUrl || null, mediaType: s.mediaType || null };
    })
    .filter(Boolean);
}

/** live / changed / new / pending / off / going-off — against the published homepage. */
export function sectionState(s, published) {
  if (s.isNew) return 'new';
  const pub = (published?.sections || []).find((p) => p.key === s.sectionKey);
  if (!s.enabled) return pub ? 'going-off' : 'off';
  if (!pub) return 'pending';
  const mine = serializeSection(s);
  return same(
    { type: mine.type, config: mine.config, mediaUrl: s.mediaUrl || null },
    { type: pub.type, config: pub.config || {}, mediaUrl: pub.mediaUrl || null },
  ) ? 'live' : 'changed';
}

/** True when the saved order of visible sections differs from the live homepage. */
export function orderUnpublished(sections, published) {
  const live = (published?.sections || []).map((p) => p.key);
  const draft = sections.filter((s) => s.enabled && !s.isNew).map((s) => s.sectionKey);
  return !same(draft.filter((k) => live.includes(k)), live.filter((k) => draft.includes(k)));
}

export function sectionTitle(s) {
  if (s.type === 'BRAND_STRIP') return s.phrases.map((p) => t(p.text)).filter(Boolean).slice(0, 2).join(' · ') || TYPE_INFO.BRAND_STRIP.name;
  if (s.type === 'TRUST_STRIP') return s.items.map((i) => t(i.title)).filter(Boolean).slice(0, 2).join(' · ') || TYPE_INFO.TRUST_STRIP.name;
  return t(s.config.heading) || TYPE_INFO[s.type]?.name || s.type;
}

export function sectionSub(s, entities) {
  const name = TYPE_INFO[s.type]?.name || s.type;
  if (UNSUPPORTED.has(s.type)) return `${name} · not shown on the website`;
  if (COLLECTION_TYPES.has(s.type)) {
    if (AUTOMATIC_PRODUCTS[s.sectionKey]) return `${name} · ${AUTOMATIC_PRODUCTS[s.sectionKey].split(',')[0].toLowerCase()}`;
    const e = collectionEntity(s.config, entities);
    return `${name} · ${e ? e.name : 'no collection chosen'}`;
  }
  if (s.type === 'EDITORIAL_BANNER') return `${name}${s.mediaId ? (s.mediaType === 'video' ? ' · video' : ' · image') : ' · black'}`;
  if (s.type === 'BRAND_STRIP') return `${name} · ${s.phrases.length} phrase${s.phrases.length === 1 ? '' : 's'}`;
  if (s.type === 'TRUST_STRIP') return `${name} · ${s.items.length} promise${s.items.length === 1 ? '' : 's'}`;
  if (s.type === 'INSTAGRAM_VIDEOS') {
    if (s.config.mode !== 'PICKED') return `${name} · latest ${igLimit(s.config)}`;
    const on = s.picks.filter((p) => p.enabled).length;
    return `${name} · ${s.picks.length} picked${s.picks.length ? `, ${on} shown` : ''}`;
  }
  return name;
}

/** Why a switched-on section drew nothing in the preview. */
export function hiddenReason(s) {
  switch (s.type) {
    case 'HERO': return 'Not showing on the website: there are no active hero slides right now.';
    case 'REVIEWS': return 'Not showing on the website: there are no published customer reviews yet. It appears on its own when there are.';
    case 'INSTAGRAM_VIDEOS': return 'Not showing on the website: there are no Instagram posts to show yet.';
    default: return 'Not showing on the website right now: there is nothing to show in it yet.';
  }
}

export const canAdd = (type, sections) => !(TYPE_INFO[type]?.single && sections.some((s) => s.type === type));

const NEW_CONFIG = {
  PRODUCT_CAROUSEL: { heading: 'New products' },
  COLLECTION_GRID: { heading: 'New products' },
  EDITORIAL_BANNER: { heading: 'A new story' },
  CATEGORY_SECTION: { menuKey: 'primary', heading: 'Shop by Collection' },
  REVIEWS: { heading: 'What people say' },
  BRAND_STRIP: { phrases: ['CORCOTTON™'] },
  TRUST_STRIP: { items: [{ icon: 'leaf', title: 'Your promise' }] },
  INSTAGRAM_VIDEOS: {
    eyebrow: 'The CORCOTTON community', heading: 'Real People. Real Style.', description: 'See how our community wears CORCOTTON every day.',
    autoplaySeconds: DEFAULT_AUTOPLAY, mode: 'LATEST', limit: DEFAULT_IG_LIMIT, picks: [],
  },
  HERO: {},
};

export function newSection(type, sections) {
  const taken = new Set(sections.map((s) => s.sectionKey));
  const base = type.toLowerCase();
  let n = 1;
  while (taken.has(`${base}_${n}`)) n += 1;
  const sectionKey = `${base}_${n}`;
  return {
    ...hydrateSection({ id: `new-${sectionKey}`, sectionKey, type, enabled: true, config: NEW_CONFIG[type] || {} }),
    isNew: true,
  };
}
