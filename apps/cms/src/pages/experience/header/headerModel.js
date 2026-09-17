// Pure data helpers for the visual Header builder: API row <-> editor state,
// the storefront preview payload, client validation and Live/Draft diffing.
//
// ONE MENU EVERYWHERE: a dropdown has a single list of category links. The
// desktop dropdown, the tablet/mobile submenu and the "shop by category"
// cards are all built from it (the storefront does the same in
// apps/corcotton/src/features/header/menuDerivation.js), so an editor never
// maintains a second list that can drift.
//
// Everything that turns draft rows into what the storefront renders mirrors
// server/src/modules/content/navigationService.js (routeForLink, snapshot
// builders, withoutRetiredCatalogLinks), so the live preview shows what
// Publish will actually ship.
import { makeRowKey } from '../../../components/ui/rowHelpers.js';

// Icon names the storefront's iconRegistry resolves (and the server accepts).
export const NAV_ICONS = [
  ['shirt', 'Shirt'], ['pants', 'Pants'], ['bag-handle', 'Bag'], ['sparkles', 'Sparkles'],
  ['apps', 'Grid'], ['star', 'Star'], ['calendar', 'Calendar'], ['trending-up', 'Trending'],
  ['leaf', 'Leaf'], ['shield-check', 'Shield'], ['refresh', 'Returns'], ['truck', 'Delivery'],
];

export const LINK_TYPES = [
  ['COLLECTION', 'Collection or category'], ['CATEGORY', 'Category'], ['CONTENT_PAGE', 'Content page'],
  ['PRODUCT', 'Product'], ['CUSTOM_INTERNAL', 'Internal path'], ['HOME', 'Homepage'],
  ['SEARCH', 'Search page'], ['EXTERNAL', 'External URL'],
];
export const NO_TARGET_LINKS = new Set(['HOME', 'SEARCH']);
export const PICKER_LINKS = new Set(['COLLECTION', 'CATEGORY', 'CONTENT_PAGE', 'PRODUCT']);

// Promo panel / card colours already used by the storefront, plus neutrals.
export const BACKGROUND_PRESETS = [
  ['Charcoal', 'linear-gradient(160deg, #2c2c2c, #050505)'],
  ['Graphite', 'linear-gradient(160deg, #3a3a3a, #0a0a0a)'],
  ['Stone', 'linear-gradient(to bottom, #ECE9E4, #D8D3CB)'],
  ['Sand', 'linear-gradient(to bottom, #DEDAD2, #C2BCAF)'],
  ['Mist', 'linear-gradient(to bottom, #EFEEEC, #DAD7D1)'],
  ['Ink', 'linear-gradient(to bottom, #2b2b2b, #0d0d0d)'],
];

export const LIMITS = {
  navLabel: 120, heading: 60, tagline: 160, ctaLabel: 40, itemLabel: 60, itemDesc: 120,
  fitLabel: 40, infoTitle: 60, infoDesc: 160, mobileTagline: 80,
  categoryItems: 20, fits: 12, infoCards: 6, settingsLinks: 12,
};

// ---- small utils ----------------------------------------------------------

export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}
export const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const t = (v) => (typeof v === 'string' ? v.trim() : '');

export function routeForLink(linkType, target, externalUrl) {
  switch (linkType) {
    case 'HOME': return '/';
    case 'SEARCH': return '/search';
    case 'ACCOUNT': return '/account';
    case 'COLLECTION': return `/collections/${target}`;
    case 'CATEGORY': return `/collections/${target}`;
    case 'PRODUCT': return `/products/${target}`;
    case 'CONTENT_PAGE': return `/pages/${target}`;
    case 'EXTERNAL': return externalUrl;
    case 'CUSTOM_INTERNAL':
    default: return target || '/';
  }
}

const UNSAFE = /^\s*(javascript|data|vbscript|file):/i;
/** A menu link: "/path" (not "//host") or an http(s) URL. */
export function isValidPath(p) {
  const v = t(p);
  if (!v || UNSAFE.test(v)) return false;
  if (v.startsWith('/')) return !v.includes('//');
  return /^https?:\/\/[^\s/$.?#].[^\s]*$/i.test(v);
}

export const slugKey = (label, prefix, taken) => {
  const base = `${prefix}_${t(label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'item'}`.slice(0, 70);
  let key = base;
  for (let n = 2; taken.has(key); n += 1) key = `${base}_${n}`;
  return key;
};

// ---- catalog is the source of truth ------------------------------------------

export const catalogSlugOf = (path) => {
  const m = /^\/collections\/([^/?#]+)/.exec(t(path));
  return m ? decodeURIComponent(m[1]) : null;
};

/**
 * True when a link points at a collection/category that is not ACTIVE in the
 * catalog — the storefront hides such links everywhere. `activeSlugs` is null
 * while the catalog is still loading (nothing is flagged then).
 */
export function isRetiredLink(path, activeSlugs) {
  if (!activeSlugs) return false;
  const slug = catalogSlugOf(path);
  return Boolean(slug) && !activeSlugs.has(slug);
}

/**
 * Why a catalog link is not shown: 'archived' (switched off — comes back when
 * switched on) or 'deleted' (gone — the link should be removed). Null when shown.
 */
export function retiredKind(path, activeSlugs, archivedSlugs) {
  if (!isRetiredLink(path, activeSlugs)) return null;
  return archivedSlugs?.has(catalogSlugOf(path)) ? 'archived' : 'deleted';
}

// ---- entity names (what the website shows) -------------------------------------
//
// Links to categories / collections / pages show the entity's CURRENT name on
// the website (server entityLinks.js). The CMS preview and lists must show the
// same thing, never the label that was typed when the link was made.

/**
 * Index of every linkable entity — including switched-off ones, so a link to
 * an archived category still shows that category's real name (with its
 * "Category off" flag) instead of whatever was typed when the link was made.
 * Returns null until the catalog has loaded.
 */
export function buildEntityIndex({ collections, categories, pages }) {
  if (!collections || !categories) return null;
  const byId = new Map();
  const catalog = new Map();
  const pageMap = new Map();
  const add = (type, r, name) => {
    const e = { type, id: r.id, slug: r.slug, name, active: r.status === 'ACTIVE' };
    byId.set(`${type}:${r.id}`, e);
    return e;
  };
  // /collections/<slug> shows the collection when both exist.
  for (const c of categories) catalog.set(c.slug, add('CATEGORY', c, c.name));
  for (const c of collections) catalog.set(c.slug, add('COLLECTION', c, c.name));
  for (const p of pages || []) pageMap.set(p.slug, add('PAGE', p, p.title));
  return { byId, catalog, pages: pageMap };
}

export const entityRoute = (e) => (e.type === 'PAGE' ? `/pages/${e.slug}` : `/collections/${e.slug}`);

export function entityOf(link, index) {
  if (!index || !link) return null;
  if (link.ref?.id) return index.byId.get(`${link.ref.type}:${link.ref.id}`) || null;
  const slug = catalogSlugOf(link.path);
  if (slug) return index.catalog.get(slug) || null;
  const page = /^\/pages\/([^/?#]+)/.exec(t(link.path));
  return page ? index.pages.get(decodeURIComponent(page[1])) || null : null;
}

/** The label customers see for a link. */
export function shownLabel(link, index) {
  const e = entityOf(link, index);
  if (!e) return t(link?.label);
  return link.isViewAll ? `All ${e.name}` : e.name;
}

export const navLink = (it) => ({
  ref: it.linkRefId ? { type: it.linkRefType, id: it.linkRefId } : null,
  path: navRoute(it),
  label: it.label,
});

// ---- navigation items -------------------------------------------------------

export const hydrateNavItem = (it) => ({
  _k: it.id, id: it.id, itemKey: it.itemKey, isNew: false,
  label: it.label || '', linkType: it.linkType || 'COLLECTION',
  linkTarget: it.linkTarget || '', externalUrl: it.externalUrl || '',
  megaMenuKey: it.megaMenuKey || '', icon: it.icon || '', status: it.status || 'ACTIVE',
  linkRefType: it.linkRefType || null, linkRefId: it.linkRefId || null,
});

export const serializeNavItem = (it) => ({
  label: t(it.label),
  linkType: it.linkType,
  linkTarget: it.linkType === 'EXTERNAL' || NO_TARGET_LINKS.has(it.linkType) ? null : (t(it.linkTarget) || null),
  externalUrl: it.linkType === 'EXTERNAL' ? (t(it.externalUrl) || null) : null,
  megaMenuKey: it.megaMenuKey || null,
  icon: it.icon || null,
  status: it.status,
  // A reference to the category / collection / page: the website shows its
  // current name and URL.
  linkRefType: it.linkRefId ? it.linkRefType : null,
  linkRefId: it.linkRefId || null,
});

export const navRoute = (it) => routeForLink(it.linkType, t(it.linkTarget), t(it.externalUrl));

// ---- dropdowns (one list of category links) --------------------------------------

// Keys this editor owns. mobileLinks / shopCards are always rebuilt from the
// category links; the old separate mobile promo copy is dropped on save.
const KNOWN_KEYS = ['featured', 'categoryNav', 'mobileLinks', 'shopTitle', 'shopCards', 'infoCards', 'fits',
  'fitsViewAllPath', 'fitsViewAllLabel', 'latestDrops', 'mobileExpand', 'mobilePromo'];
const FEATURED_KEYS = ['heading', 'tagline', 'ctaLabel', 'ctaPath', 'background'];
const row = (extra) => ({ _k: makeRowKey(), hidden: false, ...extra });

export function hydrateMenu(m) {
  const p = m.payload || {};
  const featured = p.featured || {};
  const featRest = {};
  for (const [k, v] of Object.entries(featured)) if (!FEATURED_KEYS.includes(k) && k !== 'mediaUrl') featRest[k] = v;
  const rest = {};
  for (const [k, v] of Object.entries(p)) if (!KNOWN_KEYS.includes(k)) rest[k] = v;
  // A card's colour lived on the separate card list; carry it onto the link.
  const cardBg = new Map((p.shopCards || []).map((c) => [c.path, c.background]));
  return {
    menuKey: m.menuKey, name: m.name || m.menuKey, status: m.status || 'ACTIVE', isNew: false,
    promoMediaId: m.promoMediaId || null, promoMediaUrl: m.promoMediaUrl || null,
    featured: {
      heading: featured.heading || '', tagline: featured.tagline || '', ctaLabel: featured.ctaLabel || '',
      ctaPath: featured.ctaPath || '', background: featured.background || '',
    },
    _featRest: featRest,
    categoryIcon: p.categoryNav?.icon || '',
    categoryItems: (p.categoryNav?.items || []).map((it) => row({
      label: it.label || '', desc: it.desc || '', path: it.path || '', isViewAll: Boolean(it.isViewAll),
      background: it.background || cardBg.get(it.path) || '', hidden: it.hidden === true, ref: it.ref || null,
    })),
    panel: p.latestDrops === true ? 'drops' : 'shop',
    hadLatestDrops: p.latestDrops === true || p.latestDrops === false,
    hasShop: Array.isArray(p.shopCards) || Boolean(p.shopTitle),
    shopTitle: p.shopTitle || '',
    hasInfo: Array.isArray(p.infoCards),
    infoCards: (p.infoCards || []).map((it) => row({ title: it.title || '', desc: it.desc || '', icon: it.icon || '', hidden: it.hidden === true })),
    fitsEnabled: Array.isArray(p.fits),
    fits: (p.fits || []).map((it) => row({ label: it.label || '', path: it.path || '', hidden: it.hidden === true, ref: it.ref || null })),
    fitsViewAllLabel: p.fitsViewAllLabel || '',
    fitsViewAllPath: p.fitsViewAllPath || '',
    mobileExpand: typeof p.mobileExpand === 'boolean' ? p.mobileExpand : null,
    _rest: rest,
  };
}

const hiddenFlag = (r) => (r.hidden ? { hidden: true } : {});
const refOf = (r) => (r.ref && r.ref.id ? { ref: { type: r.ref.type, id: r.ref.id } } : {});

export function serializeMenu(m) {
  const featured = { ...m._featRest };
  for (const k of FEATURED_KEYS) {
    const v = t(m.featured[k]);
    if (v) featured[k] = v;
  }
  const items = m.categoryItems.map((r) => ({
    label: t(r.label), path: t(r.path),
    ...(t(r.desc) ? { desc: t(r.desc) } : {}),
    ...(r.isViewAll ? { isViewAll: true } : {}),
    ...(t(r.background) ? { background: t(r.background) } : {}),
    ...refOf(r),
    ...hiddenFlag(r),
  }));
  const out = {
    ...m._rest,
    featured,
    categoryNav: { ...(m.categoryIcon ? { icon: m.categoryIcon } : {}), items },
    // Same links on tablet and mobile.
    mobileLinks: items.map((it) => ({ label: it.label, path: it.path, ...(it.ref ? { ref: it.ref } : {}), ...(it.hidden ? { hidden: true } : {}) })),
  };
  if (m.hasShop || m.panel === 'shop') {
    if (t(m.shopTitle)) out.shopTitle = t(m.shopTitle);
    // Same links as cards (everything except "view all").
    out.shopCards = items.filter((it) => !it.isViewAll).map((it) => ({
      label: it.label, path: it.path, ...(it.background ? { background: it.background } : {}),
      ...(it.ref ? { ref: it.ref } : {}), ...(it.hidden ? { hidden: true } : {}),
    }));
  }
  if (m.hasInfo || m.panel === 'drops') {
    out.infoCards = m.infoCards.map((r) => ({ title: t(r.title), desc: t(r.desc), ...(r.icon ? { icon: r.icon } : {}), ...hiddenFlag(r) }));
  }
  if (m.fitsEnabled) {
    out.fits = m.fits.map((r) => ({ label: t(r.label), path: t(r.path), ...refOf(r), ...hiddenFlag(r) }));
    if (t(m.fitsViewAllPath)) out.fitsViewAllPath = t(m.fitsViewAllPath);
    if (t(m.fitsViewAllLabel)) out.fitsViewAllLabel = t(m.fitsViewAllLabel);
  }
  if (m.panel === 'drops') out.latestDrops = true;
  else if (m.hadLatestDrops) out.latestDrops = false;
  if (m.mobileExpand !== null) out.mobileExpand = m.mobileExpand;
  return out;
}

export function newMenu(menuKey, label, route, icon) {
  const heading = t(label).toUpperCase();
  const name = t(label);
  return {
    ...hydrateMenu({
      menuKey, name: heading || menuKey, status: 'ACTIVE',
      payload: {
        featured: { heading, tagline: '', ctaLabel: heading ? `SHOP ${heading}` : '', ctaPath: route || '/', background: BACKGROUND_PRESETS[0][1] },
        categoryNav: { icon: icon || 'apps', items: [{ label: name ? `All ${name}` : 'View all', desc: 'View all', path: route || '/', isViewAll: true }] },
        shopTitle: heading ? `SHOP ${heading}` : 'SHOP BY CATEGORY',
      },
    }),
    isNew: true,
  };
}

const visible = (list) => (Array.isArray(list) ? list.filter((x) => x && x.hidden !== true) : list);

/** The menu exactly as GET /content/header returns it after Publish. */
export function publicMenu(m, activeSlugs = null, entities = null) {
  const p = serializeMenu(m);
  const live = (x) => x && x.hidden !== true && !isRetiredLink(x.path, activeSlugs);
  // References are how content is stored; the storefront payload is
  // { label, path } with the entity's live name (when the index is known).
  const bare = ({ ref, ...rest }) => {
    const label = entities ? shownLabel({ ...rest, ref }, entities) : rest.label;
    return { ...rest, label };
  };
  if (p.categoryNav?.items) p.categoryNav = { ...p.categoryNav, items: p.categoryNav.items.filter(live).map(bare) };
  for (const k of ['mobileLinks', 'shopCards', 'fits']) if (Array.isArray(p[k])) p[k] = p[k].filter(live).map(bare);
  if (Array.isArray(p.infoCards)) p.infoCards = visible(p.infoCards);
  if (m.promoMediaId && m.promoMediaUrl) {
    p.featured = { ...p.featured, background: `center / cover no-repeat url(${JSON.stringify(m.promoMediaUrl)})`, mediaUrl: m.promoMediaUrl };
  }
  return { id: m.menuKey, ...p };
}

// ---- mobile menu settings ------------------------------------------------------

export const hydrateSettings = (s) => ({
  mobileLinks: (s?.mobileLinks || []).map((l) => row({ label: l.label || '', path: l.path || '', hidden: l.hidden === true, ref: l.ref || null })),
  mobileTagline: s?.mobileTagline || '',
});
export const serializeSettings = (s) => ({
  mobileLinks: s.mobileLinks.map((l) => ({ label: t(l.label), path: t(l.path), ...refOf(l), ...hiddenFlag(l) })),
  mobileTagline: t(s.mobileTagline),
});

// ---- announcements (read-only here; shown in the header preview) ---------------

export const announcementSlides = (rows) => (rows || [])
  .filter((a) => a.status === 'ACTIVE')
  .map((a) => ({
    id: a.announcementKey,
    text: a.text,
    ...(a.linkType ? { link: routeForLink(a.linkType, a.linkTarget, a.externalUrl) } : {}),
    ...(a.startsAt ? { startsAt: new Date(a.startsAt).toISOString() } : {}),
    ...(a.expiresAt ? { expiresAt: new Date(a.expiresAt).toISOString() } : {}),
  }));

// ---- preview payload -------------------------------------------------------------

export function buildPreviewHeader({ navItems, menus, settings, slides, activeSlugs = null, entities = null }) {
  const navigation = navItems
    .filter((it) => it.status === 'ACTIVE' && t(it.label) && !isRetiredLink(navRoute(it), activeSlugs))
    .map((it) => ({
      id: it.itemKey, label: shownLabel(navLink(it), entities), route: navRoute(it),
      megaMenuId: it.megaMenuKey && menus[it.megaMenuKey]?.status === 'ACTIVE' ? it.megaMenuKey : null,
      ...(it.icon ? { icon: it.icon } : {}),
    }));
  const megaMenus = {};
  for (const m of Object.values(menus)) if (m.status === 'ACTIVE') megaMenus[m.menuKey] = publicMenu(m, activeSlugs, entities);
  const s = serializeSettings(settings);
  return {
    navigation,
    megaMenus,
    mobileMenu: { links: visible(s.mobileLinks).filter((l) => !isRetiredLink(l.path, activeSlugs)).map((l) => ({ label: shownLabel(l, entities), path: l.path })), tagline: s.mobileTagline },
    announcements: { slides },
  };
}

// ---- validation (mirrors the server; blocks Save with a readable reason) -----------

const tooLong = (v, max) => t(v).length > max;

export function validateNavItem(it, menus) {
  const errors = [];
  if (!t(it.label)) errors.push('Menu name is required.');
  else if (tooLong(it.label, LIMITS.navLabel)) errors.push(`Menu name is longer than ${LIMITS.navLabel} characters.`);
  if (it.linkType === 'EXTERNAL') {
    if (!/^https?:\/\/\S+$/i.test(t(it.externalUrl))) errors.push('Link needs a full https:// address.');
  } else if (it.linkType === 'CUSTOM_INTERNAL') {
    if (!isValidPath(it.linkTarget) || !t(it.linkTarget).startsWith('/')) errors.push('Internal path must start with "/".');
  } else if (PICKER_LINKS.has(it.linkType) && !t(it.linkTarget)) {
    errors.push('Choose where this menu item links to.');
  }
  if (it.megaMenuKey && !menus[it.megaMenuKey]) errors.push('The attached dropdown no longer exists.');
  return errors;
}

function checkRows(errors, rows, name, max, fields) {
  if (rows.length > max) errors.push(`${name}: at most ${max} entries.`);
  rows.forEach((r, i) => {
    for (const [key, label, limit, kind] of fields) {
      const v = r[key];
      if (kind === 'path') { if (!isValidPath(v)) errors.push(`${name} #${i + 1}: ${label} must start with "/" or https://.`); continue; }
      if (kind === 'required' && !t(v)) errors.push(`${name} #${i + 1}: ${label} is required.`);
      if (limit && tooLong(v, limit)) errors.push(`${name} #${i + 1}: ${label} is longer than ${limit} characters.`);
    }
  });
}

export function validateMenu(m) {
  const errors = [];
  const f = m.featured;
  if (!t(f.heading)) errors.push('Promo panel heading is required.');
  if (tooLong(f.heading, LIMITS.heading)) errors.push(`Promo heading is longer than ${LIMITS.heading} characters.`);
  if (tooLong(f.tagline, LIMITS.tagline)) errors.push(`Promo text is longer than ${LIMITS.tagline} characters.`);
  if (tooLong(f.ctaLabel, LIMITS.ctaLabel)) errors.push(`Promo button text is longer than ${LIMITS.ctaLabel} characters.`);
  if (!isValidPath(f.ctaPath)) errors.push('Promo button link must start with "/" or https://.');
  if (/url\(|expression\(|javascript:/i.test(f.background || '')) errors.push('Promo background may only be a colour or gradient — use the image field for pictures.');
  checkRows(errors, m.categoryItems, 'Category link', LIMITS.categoryItems, [['label', 'name', LIMITS.itemLabel, 'required'], ['desc', 'description', LIMITS.itemDesc], ['path', 'link', 0, 'path']]);
  if (!m.categoryItems.some((r) => !r.hidden)) errors.push('At least one category link must be shown.');
  if (m.panel === 'drops') checkRows(errors, m.infoCards, 'Info card', LIMITS.infoCards, [['title', 'title', LIMITS.infoTitle, 'required'], ['desc', 'text', LIMITS.infoDesc]]);
  if (m.fitsEnabled) {
    checkRows(errors, m.fits, 'Fit', LIMITS.fits, [['label', 'name', LIMITS.fitLabel, 'required'], ['path', 'link', 0, 'path']]);
    if (t(m.fitsViewAllPath) && !isValidPath(m.fitsViewAllPath)) errors.push('Fits "view all" link must start with "/".');
  }
  return errors;
}

export function validateSettings(s) {
  const errors = [];
  checkRows(errors, s.mobileLinks, 'Mobile menu link', LIMITS.settingsLinks, [['label', 'name', LIMITS.itemLabel, 'required'], ['path', 'link', 0, 'path']]);
  if (tooLong(s.mobileTagline, LIMITS.mobileTagline)) errors.push(`Tagline is longer than ${LIMITS.mobileTagline} characters.`);
  return errors;
}

// ---- Live / Draft state against what is published --------------------------------

/**
 * live      — saved, published and identical to what customers see
 * changed   — published, but the draft differs
 * new       — added in this session, not on the live site
 * pending   — saved before but not on the live site yet (e.g. switched back on)
 * off / going-off — hidden (already / after Publish)
 */
export function navItemState(it, publishedNav) {
  const pub = publishedNav?.items?.find((p) => p.id === it.itemKey);
  if (it.status !== 'ACTIVE') return pub ? 'going-off' : 'off';
  if (it.isNew) return 'new';
  if (!pub) return 'pending';
  // Same shape the navigation snapshot publishes (server buildNavigationSnapshot),
  // including the entity reference — otherwise every linked item looks changed.
  const mine = {
    id: it.itemKey, label: t(it.label), route: navRoute(it), megaMenuId: it.megaMenuKey || null,
    ...(it.icon ? { icon: it.icon } : {}),
    ...(it.linkRefId ? { ref: { type: it.linkRefType, id: it.linkRefId } } : {}),
  };
  return same(mine, pub) ? 'live' : 'changed';
}

export function menuState(m, publishedMenus) {
  const pub = publishedMenus?.entries?.[m.menuKey];
  if (m.status !== 'ACTIVE') return pub ? 'going-off' : 'off';
  if (m.isNew || !pub) return 'new';
  // Compare what customers see: older snapshots carry separate mobile/card
  // lists the storefront no longer reads, so both sides go through the same
  // one-menu rebuild first.
  const { id, ...payload } = pub;
  void id;
  const published = hydrateMenu({
    menuKey: m.menuKey, name: m.name, status: 'ACTIVE',
    promoMediaId: pub.featured?.mediaUrl ? m.promoMediaId : null, promoMediaUrl: pub.featured?.mediaUrl || null,
    payload: { ...payload, featured: { ...payload.featured, ...(pub.featured?.mediaUrl ? { background: m.featured.background } : {}) } },
  });
  return same(publicMenu(m), publicMenu(published)) ? 'live' : 'changed';
}

export const STATE_LABELS = {
  live: 'Live', changed: 'Changed — not published', new: 'New — not published',
  pending: 'Shown after you publish',
  off: 'Off', 'going-off': 'Switched off — not published',
};
