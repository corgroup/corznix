// Navigation + Mega Menu + Announcement content (Wave 8E).
//
// Three publishable scopes, all on the content engine (documentService):
//   NAVIGATION:primary   — content_nav_items  (draft)
//   MEGA_MENUS:default    — content_mega_menus (draft)
//   ANNOUNCEMENTS:default — content_announcements (draft)
//
// The snapshot builders produce the EXACT DTO shape the storefront's
// features/header contract already expects (headerContracts.js), so
// headerService.js swaps a fixture import for a fetch with no reshaping and
// Header.jsx / MegaMenu.jsx / AnnouncementBar.jsx stay byte-for-byte.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// every draft-editing (admin) function takes the caller's `brandId` and
// threads it into documentService + every content_nav_items/mega_menus/
// announcements query. The snapshot builders (`buildXxxSnapshot`) take an
// OPTIONAL `brandId` — the admin publish path always supplies it (so a
// publish snapshots the CORRECT company's draft, never whichever row an
// unscoped query happens to return first); the public preview path
// (resolveHeaderPreview) calls without one, deferred to Phase 4 same as
// every other public resolver here.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import {
  loadDocument, touchDraft, assertVersion, publish, rollback,
  listPublications, getPublishedSnapshot,
} from './documentService.js';
import { validateInternalTarget, assertSafeExternalUrl, assertSafeHref } from './linkSafety.js';
import { loadEntityIndex, resolveHeaderLinks, findEntity, attachEntityRefs, locateEntity } from './entityLinks.js';
import { toMysqlDateTime } from '../../utils/otpCrypto.js';

// Accept an ISO string / MySQL string / null and normalize to a MySQL
// DATETIME(3) string (UTC). Content schedules are persisted canonically.
function toDt(value) {
  if (value == null || value === '') return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new AppError('CONTENT_INVALID', `"${value}" is not a valid date/time.`, 422);
  return toMysqlDateTime(d);
}

const NAV = { docType: 'NAVIGATION', docKey: 'primary' };
const MEGA = { docType: 'MEGA_MENUS', docKey: 'default' };
const ANN = { docType: 'ANNOUNCEMENTS', docKey: 'default' };
const POSITION_OFFSET = 100000;

// Icon NAMES the storefront can draw (apps/corcotton/src/features/header/
// iconRegistry.js). Only a name ever crosses the API; an unknown name is
// refused here instead of rendering the storefront's fallback glyph.
export const ICON_NAMES = ['apps', 'shirt', 'pants', 'bag-handle', 'sparkles', 'calendar', 'trending-up',
  'instagram', 'facebook', 'pinterest', 'youtube', 'leaf', 'shield-check', 'refresh', 'truck', 'star'];
function assertIcon(name, where) {
  if (name == null || name === '') return;
  if (!ICON_NAMES.includes(name)) throw new AppError('CONTENT_INVALID', `${where}: unknown icon "${name}".`, 422);
}

// A link inside a menu is a plain path (or an http(s) URL): no scheme tricks,
// no protocol-relative "//host".
function assertMenuPath(path, where) {
  if (typeof path !== 'string' || !path.trim()) throw new AppError('CONTENT_INVALID', `${where}: a link is required.`, 422);
  const p = path.trim();
  if (!p.startsWith('/') && !/^https?:\/\//i.test(p)) throw new AppError('CONTENT_LINK_INVALID', `${where}: "${p}" must start with "/" or https://.`, 422);
  assertSafeHref(p);
}
function assertText(value, max, where, required = false) {
  if (value == null || value === '') {
    if (required) throw new AppError('CONTENT_INVALID', `${where} is required.`, 422);
    return;
  }
  if (typeof value !== 'string' || value.length > max) throw new AppError('CONTENT_INVALID', `${where} must be text of at most ${max} characters.`, 422);
}
const visible = (list) => (Array.isArray(list) ? list.filter((x) => x && x.hidden !== true) : list);

// ---- link resolution (snapshot time) ----------------------------------
function routeForLink(linkType, target, externalUrl) {
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

// ---- NAVIGATION ------------------------------------------------------

export async function getNavigationDraft(brandId) {
  const doc = await loadDocument(NAV.docType, NAV.docKey, brandId);
  const rows = await query('SELECT * FROM content_nav_items WHERE document_id = ? ORDER BY parent_id IS NOT NULL, position ASC', [doc.id]);
  const byId = new Map(rows.map((r) => [r.id, { ...navItemDto(r), children: [] }]));
  const roots = [];
  for (const r of rows) {
    const node = byId.get(r.id);
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).children.push(node);
    else roots.push(node);
  }
  const settings = await getNavSettings(doc.id);
  // Links still written as a URL are shown to the editor as references to
  // their entity; saving stores the reference.
  const index = await loadEntityIndex();
  return { document: docMeta(doc), items: roots, settings: { ...settings, mobileLinks: attachEntityRefs(settings.mobileLinks, index) } };
}

// ---- mobile menu settings (draft, part of the NAVIGATION document) -------
const EMPTY_NAV_SETTINGS = { mobileLinks: [], mobileTagline: '' };

async function getNavSettings(documentId) {
  const [row] = await query('SELECT settings_json FROM content_nav_settings WHERE document_id = ?', [documentId]);
  if (!row) return { ...EMPTY_NAV_SETTINGS, exists: false };
  const s = typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : row.settings_json;
  return { mobileLinks: Array.isArray(s?.mobileLinks) ? s.mobileLinks : [], mobileTagline: s?.mobileTagline || '', exists: true };
}

function validateNavSettings(settings) {
  const links = settings?.mobileLinks;
  if (!Array.isArray(links)) throw new AppError('CONTENT_INVALID', 'mobileLinks must be a list.', 422);
  if (links.length > 12) throw new AppError('CONTENT_INVALID', 'At most 12 mobile menu links.', 422);
  links.forEach((l, i) => {
    assertText(l?.label, 60, `Mobile link ${i + 1} label`, true);
    assertMenuPath(l?.path, `Mobile link "${l?.label}"`);
  });
  assertText(settings.mobileTagline, 80, 'Mobile menu tagline');
}

export async function setNavigationSettings(settings, expectedVersion, actor, brandId) {
  const doc = await loadDocument(NAV.docType, NAV.docKey, brandId);
  assertVersion(doc, expectedVersion);
  validateNavSettings(settings);
  await assertRefsExist(settings.mobileLinks);
  const clean = {
    mobileLinks: settings.mobileLinks.map((l) => ({
      label: l.label.trim(), path: l.path.trim(),
      ...(l.ref ? { ref: { type: l.ref.type, id: l.ref.id } } : {}),
      ...(l.hidden === true ? { hidden: true } : {}),
    })),
    mobileTagline: (settings.mobileTagline || '').trim(),
  };
  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT INTO content_nav_settings (document_id, brand_id, settings_json) VALUES (?, ?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)`,
      [doc.id, brandId, JSON.stringify(clean)],
    );
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'NAVIGATION_UPDATED', 'content_navigation', doc.id, { settings: true });
  return getNavigationDraft(brandId);
}

function navItemDto(r) {
  return {
    id: r.id, itemKey: r.item_key, label: r.label, linkType: r.link_type,
    linkTarget: r.link_target, externalUrl: r.external_url, megaMenuKey: r.mega_menu_key,
    icon: r.icon || null, position: r.position, status: r.status, parentId: r.parent_id,
    linkRefType: r.link_ref_type || null, linkRefId: r.link_ref_id || null,
  };
}
const docMeta = (d) => ({ docType: d.docType, docKey: d.docKey, workingVersion: d.workingVersion, publishedVersion: d.publishedVersion, draftDirty: d.draftDirty });

async function validateNavInput(input, brandId) {
  if (!input.label || !input.label.trim()) throw new AppError('CONTENT_INVALID', 'Nav item label is required.', 422);
  assertIcon(input.icon, 'Nav item');
  if (input.linkRefId) {
    // A link to a category / collection / page is a reference: the entity is
    // the authority for its URL (and, on the website, its name).
    const entity = await findEntity(input.linkRefType, input.linkRefId);
    if (!entity) throw new AppError('CONTENT_LINK_INVALID', 'The linked category, collection or page no longer exists.', 422);
    input.linkType = entity.type === 'PAGE' ? 'CONTENT_PAGE' : 'COLLECTION';
    input.linkTarget = entity.slug;
    input.externalUrl = null;
  } else {
    input.linkRefType = null;
  }
  if (input.linkType === 'EXTERNAL') assertSafeExternalUrl(input.externalUrl);
  else await validateInternalTarget(input.linkType, input.linkTarget);
  if (input.megaMenuKey) {
    const mm = await query('SELECT 1 FROM content_mega_menus WHERE menu_key = ? AND brand_id = ? LIMIT 1', [input.megaMenuKey, brandId]);
    if (!mm[0]) throw new AppError('CONTENT_INVALID', `Mega menu "${input.megaMenuKey}" does not exist.`, 422);
  }
}

export async function upsertNavItem(input, expectedVersion, actor, brandId) {
  const doc = await loadDocument(NAV.docType, NAV.docKey, brandId);
  assertVersion(doc, expectedVersion);
  await validateNavInput(input, brandId);

  await withTransaction(async (conn) => {
    if (input.id) {
      await conn.execute(
        `UPDATE content_nav_items SET label = ?, link_type = ?, link_target = ?, external_url = ?, link_ref_type = ?, link_ref_id = ?, mega_menu_key = ?, icon = ?, status = ?, updated_at = NOW(3)
         WHERE id = ? AND document_id = ?`,
        [input.label.trim(), input.linkType, input.linkTarget ?? null, input.externalUrl ?? null, input.linkRefType || null, input.linkRefId || null, input.megaMenuKey ?? null, input.icon || null, input.status || 'ACTIVE', input.id, doc.id],
      );
    } else {
      const [siblings] = await conn.execute(
        `SELECT COALESCE(MAX(position), -1) + 1 AS p FROM content_nav_items WHERE document_id = ? AND ${input.parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`,
        input.parentId ? [doc.id, input.parentId] : [doc.id],
      );
      await conn.execute(
        `INSERT INTO content_nav_items (id, document_id, brand_id, item_key, parent_id, label, link_type, link_target, external_url, link_ref_type, link_ref_id, mega_menu_key, icon, position, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
        [randomUUID(), doc.id, brandId, input.itemKey || `nav_${Date.now()}`, input.parentId ?? null, input.label.trim(),
          input.linkType, input.linkTarget ?? null, input.externalUrl ?? null, input.linkRefType || null, input.linkRefId || null, input.megaMenuKey ?? null, input.icon || null,
          Number(siblings[0].p), input.status || 'ACTIVE'],
      );
    }
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'NAVIGATION_UPDATED', 'content_navigation', doc.id, { itemKey: input.itemKey, action: input.id ? 'update' : 'create' });
  return getNavigationDraft(brandId);
}

export async function deleteNavItem(itemId, expectedVersion, actor, brandId) {
  const doc = await loadDocument(NAV.docType, NAV.docKey, brandId);
  assertVersion(doc, expectedVersion);
  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM content_nav_items WHERE id = ? AND document_id = ?', [itemId, doc.id]);
    await resequence(conn, doc.id, null);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'NAVIGATION_UPDATED', 'content_navigation', doc.id, { deleted: itemId });
  return getNavigationDraft(brandId);
}

export async function reorderNav(orderedIds, parentId, expectedVersion, actor, brandId) {
  const doc = await loadDocument(NAV.docType, NAV.docKey, brandId);
  assertVersion(doc, expectedVersion);
  await withTransaction(async (conn) => {
    const [current] = await conn.execute(
      `SELECT id FROM content_nav_items WHERE document_id = ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'}`,
      parentId ? [doc.id, parentId] : [doc.id],
    );
    const ids = new Set(current.map((r) => r.id));
    if (orderedIds.length !== ids.size || !orderedIds.every((id) => ids.has(id))) {
      throw new AppError('CONTENT_INVALID', 'Reorder list must be exactly the current items in this level.', 422);
    }
    for (let i = 0; i < orderedIds.length; i += 1) await conn.execute('UPDATE content_nav_items SET position = ? WHERE id = ?', [POSITION_OFFSET + i, orderedIds[i]]);
    for (let i = 0; i < orderedIds.length; i += 1) await conn.execute('UPDATE content_nav_items SET position = ? WHERE id = ?', [i, orderedIds[i]]);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'NAVIGATION_REORDERED', 'content_navigation', doc.id, { parentId, count: orderedIds.length });
  return getNavigationDraft(brandId);
}

async function resequence(conn, docId, parentId) {
  const [rows] = await conn.execute(
    `SELECT id FROM content_nav_items WHERE document_id = ? AND ${parentId ? 'parent_id = ?' : 'parent_id IS NULL'} ORDER BY position ASC`,
    parentId ? [docId, parentId] : [docId],
  );
  for (let i = 0; i < rows.length; i += 1) await conn.execute('UPDATE content_nav_items SET position = ? WHERE id = ?', [i, rows[i].id]);
}

async function buildNavigationSnapshot(brandId = null) {
  const doc = await loadDocument(NAV.docType, NAV.docKey, brandId);
  const rows = await query(
    "SELECT * FROM content_nav_items WHERE document_id = ? AND status = 'ACTIVE' ORDER BY parent_id IS NOT NULL, position ASC",
    [doc.id],
  );
  const top = rows.filter((r) => !r.parent_id);
  const settings = await getNavSettings(doc.id);
  return {
    menuKey: 'primary',
    items: top.map((r) => ({
      id: r.item_key,
      label: r.label,
      route: routeForLink(r.link_type, r.link_target, r.external_url),
      megaMenuId: r.mega_menu_key || null,
      ...(r.icon ? { icon: r.icon } : {}),
      ...(r.link_ref_id ? { ref: { type: r.link_ref_type, id: r.link_ref_id } } : {}),
    })),
    // Absent until a settings row exists, so a brand without one keeps the
    // storefront's own fallback instead of an empty drawer.
    ...(settings.exists ? {
      mobileMenu: {
        links: visible(settings.mobileLinks).map((l) => ({ label: l.label, path: l.path })),
        tagline: settings.mobileTagline,
      },
    } : {}),
  };
}

export const SNAPSHOT_BUILDERS = {
  navigation: buildNavigationSnapshot,
  'mega-menus': buildMegaMenusSnapshot,
  announcements: buildAnnouncementsSnapshot,
};

// ---- MEGA MENUS ----------------------------------------------------

export async function getMegaMenusDraft(brandId) {
  const doc = await loadDocument(MEGA.docType, MEGA.docKey, brandId);
  const rows = await query('SELECT * FROM content_mega_menus WHERE brand_id = ? ORDER BY menu_key ASC', [brandId]);
  const index = await loadEntityIndex();
  // Resolve the promo asset's URL so the CMS can show the image rather than
  // making an editor recognise a uuid.
  const ids = [...new Set(rows.map((r) => r.promo_media_id).filter(Boolean))];
  const urls = new Map();
  if (ids.length) {
    const media = await query(`SELECT id, url FROM media WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const m of media) urls.set(m.id, m.url);
  }
  return {
    document: docMeta(doc),
    megaMenus: rows.map((r) => ({
      id: r.id, menuKey: r.menu_key, name: r.name, status: r.status,
      promoMediaId: r.promo_media_id,
      promoMediaUrl: r.promo_media_id ? (urls.get(r.promo_media_id) || null) : null,
      payload: withRefs(parseJson(r.payload_json), index),
    })),
  };
}

const parseJson = (v) => (v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v));
const withRefs = (p, index) => (p ? {
  ...p,
  ...(p.categoryNav ? { categoryNav: { ...p.categoryNav, items: attachEntityRefs(p.categoryNav.items, index) } } : {}),
  ...(p.mobileLinks ? { mobileLinks: attachEntityRefs(p.mobileLinks, index) } : {}),
  ...(p.shopCards ? { shopCards: attachEntityRefs(p.shopCards, index) } : {}),
  ...(p.fits ? { fits: attachEntityRefs(p.fits, index) } : {}),
} : p);

export async function upsertMegaMenu(input, expectedVersion, actor, brandId) {
  const doc = await loadDocument(MEGA.docType, MEGA.docKey, brandId);
  assertVersion(doc, expectedVersion);
  if (!input.menuKey || !input.name) throw new AppError('CONTENT_INVALID', 'menuKey and name are required.', 422);
  validateMegaPayload(input.payload);
  await assertRefsExist([...(input.payload.categoryNav?.items || []), ...(input.payload.fits || []), ...(input.payload.mobileLinks || [])]);
  if (input.promoMediaId) {
    const m = await query("SELECT 1 FROM media WHERE id = ? AND status = 'ACTIVE' LIMIT 1", [input.promoMediaId]);
    if (!m[0]) throw new AppError('MEDIA_NOT_FOUND', 'Promo media asset not found.', 404);
  }
  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT INTO content_mega_menus (id, brand_id, menu_key, name, promo_media_id, payload_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE name = VALUES(name), promo_media_id = VALUES(promo_media_id),
         payload_json = VALUES(payload_json), status = VALUES(status), updated_at = NOW(3)`,
      [randomUUID(), brandId, input.menuKey, input.name, input.promoMediaId ?? null, JSON.stringify(input.payload || {}), input.status || 'ACTIVE'],
    );
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'MEGA_MENU_UPDATED', 'content_mega_menu', input.menuKey, { name: input.name });
  return getMegaMenusDraft(brandId);
}

// A saved reference must point at something that exists.
async function assertRefsExist(list) {
  for (const l of list || []) {
    if (!l?.ref) continue;
    if (!(await findEntity(l.ref.type, l.ref.id))) {
      throw new AppError('CONTENT_LINK_INVALID', `"${l.label || 'A link'}" points at a category, collection or page that no longer exists.`, 422);
    }
  }
}

function validateMegaPayload(p) {
  if (!p || typeof p !== 'object') throw new AppError('CONTENT_INVALID', 'Mega menu payload required.', 422);
  if (!p.featured || !p.featured.heading || !p.featured.ctaPath) throw new AppError('CONTENT_INVALID', 'Mega menu needs featured.heading + featured.ctaPath.', 422);
  if (!p.categoryNav || !Array.isArray(p.categoryNav.items) || p.categoryNav.items.length === 0) throw new AppError('CONTENT_INVALID', 'Mega menu needs categoryNav.items.', 422);
  if (!Array.isArray(p.mobileLinks) || p.mobileLinks.length === 0) throw new AppError('CONTENT_INVALID', 'Mega menu needs mobileLinks (MobileMenu contract).', 422);
  // Hiding every item is the same as having none: the customer sees an empty list.
  if (visible(p.categoryNav.items).length === 0) throw new AppError('CONTENT_INVALID', 'At least one category link must be shown.', 422);
  if (visible(p.mobileLinks).length === 0) throw new AppError('CONTENT_INVALID', 'At least one mobile link must be shown.', 422);

  const f = p.featured;
  assertText(f.heading, 60, 'Featured heading', true);
  assertText(f.tagline, 160, 'Featured tagline');
  assertText(f.ctaLabel, 40, 'Featured button text');
  assertMenuPath(f.ctaPath, 'Featured button link');
  assertIcon(p.categoryNav.icon, 'Category icon');

  const lists = [
    ['categoryNav.items', p.categoryNav.items, 20, (it, w) => { assertText(it.label, 60, `${w} label`, true); assertText(it.desc, 120, `${w} description`); assertMenuPath(it.path, w); }],
    ['mobileLinks', p.mobileLinks, 20, (it, w) => { assertText(it.label, 60, `${w} label`, true); assertMenuPath(it.path, w); }],
    ['shopCards', p.shopCards, 12, (it, w) => { assertText(it.label, 60, `${w} label`, true); assertMenuPath(it.path, w); }],
    ['fits', p.fits, 12, (it, w) => { assertText(it.label, 40, `${w} label`, true); assertMenuPath(it.path, w); }],
    ['infoCards', p.infoCards, 6, (it, w) => { assertText(it.title, 60, `${w} title`, true); assertText(it.desc, 160, `${w} description`); assertIcon(it.icon, w); }],
  ];
  for (const [name, list, max, check] of lists) {
    if (list == null) continue;
    if (!Array.isArray(list)) throw new AppError('CONTENT_INVALID', `${name} must be a list.`, 422);
    if (list.length > max) throw new AppError('CONTENT_INVALID', `${name}: at most ${max} entries.`, 422);
    list.forEach((it, i) => check(it || {}, `${name} #${i + 1}`));
  }
  assertText(p.shopTitle, 60, 'Shop section title');
  if (p.fitsViewAllPath) assertMenuPath(p.fitsViewAllPath, 'Fits view-all link');
  assertText(p.fitsViewAllLabel, 40, 'Fits view-all text');
  if (p.mobileExpand != null && typeof p.mobileExpand !== 'boolean') throw new AppError('CONTENT_INVALID', 'mobileExpand must be true or false.', 422);
  if (p.mobilePromo != null) {
    const mp = p.mobilePromo;
    if (typeof mp !== 'object') throw new AppError('CONTENT_INVALID', 'mobilePromo must be an object.', 422);
    assertText(mp.title, 80, 'Mobile promo title', true);
    assertText(mp.ctaLabel, 40, 'Mobile promo button text', true);
    assertMenuPath(mp.ctaPath, 'Mobile promo button link');
  }
  // background is a gradient/colour placeholder or resolved media url — never arbitrary CSS with url()/expression()
  const bg = p.featured.background || '';
  if (/url\(|expression\(|javascript:/i.test(bg)) throw new AppError('CONTENT_INVALID', 'featured.background must not contain url()/expression().', 422);
}

async function buildMegaMenusSnapshot(brandId = null) {
  const rows = brandId
    ? await query("SELECT * FROM content_mega_menus WHERE status = 'ACTIVE' AND brand_id = ? ORDER BY menu_key ASC", [brandId])
    : await query("SELECT * FROM content_mega_menus WHERE status = 'ACTIVE' ORDER BY menu_key ASC");
  const mediaIds = rows.map((r) => r.promo_media_id).filter(Boolean);
  const mediaUrl = new Map();
  if (mediaIds.length) {
    const media = await query(`SELECT id, url FROM media WHERE id IN (${mediaIds.map(() => '?').join(',')})`, mediaIds);
    for (const m of media) mediaUrl.set(m.id, m.url);
  }
  const out = {};
  for (const r of rows) {
    const p = parseJson(r.payload_json) || {};
    // Hidden items stay in the draft (so they can be switched back on) but
    // never reach the customer.
    if (p.categoryNav?.items) p.categoryNav = { ...p.categoryNav, items: visible(p.categoryNav.items) };
    for (const k of ['mobileLinks', 'shopCards', 'fits', 'infoCards']) if (Array.isArray(p[k])) p[k] = visible(p[k]);
    // resolve promo media into the `featured.background` the component reads
    if (r.promo_media_id && mediaUrl.has(r.promo_media_id)) {
      p.featured = { ...p.featured, background: `center / cover no-repeat url(${JSON.stringify(mediaUrl.get(r.promo_media_id))})` };
      p.featured.mediaUrl = mediaUrl.get(r.promo_media_id);
    }
    out[r.menu_key] = { id: r.menu_key, ...p };
  }
  return { entries: out };
}

// ---- ANNOUNCEMENTS -----------------------------------------------

// Bar-wide settings: draft state of the ANNOUNCEMENTS document (migration
// 111), published inside the announcements snapshot.
export const DEFAULT_ANNOUNCEMENT_SETTINGS = Object.freeze({ autoplaySeconds: 4, showClock: true, dismissible: true, dismissVersion: 'v1' });
const pickAnnouncementSettings = (s) => Object.fromEntries(
  Object.keys(DEFAULT_ANNOUNCEMENT_SETTINGS).filter((k) => s && s[k] !== undefined).map((k) => [k, s[k]]),
);
/** What the storefront gets: everything but the dismiss version, which travels beside the slides. */
export function publicAnnouncementSettings(s) {
  const { dismissVersion, ...rest } = { ...DEFAULT_ANNOUNCEMENT_SETTINGS, ...pickAnnouncementSettings(s || {}) };
  void dismissVersion;
  return rest;
}

async function getAnnouncementSettings(documentId) {
  const [row] = await query('SELECT settings_json FROM content_announcement_settings WHERE document_id = ?', [documentId]);
  const s = row ? (typeof row.settings_json === 'string' ? JSON.parse(row.settings_json) : row.settings_json) : {};
  return { ...DEFAULT_ANNOUNCEMENT_SETTINGS, ...pickAnnouncementSettings(s) };
}

function validateAnnouncementSettings(s) {
  if (!Number.isInteger(s.autoplaySeconds) || s.autoplaySeconds < 3 || s.autoplaySeconds > 15) {
    throw new AppError('CONTENT_INVALID', 'The bar moves to the next message every 3 to 15 seconds.', 422);
  }
  if (typeof s.showClock !== 'boolean') throw new AppError('CONTENT_INVALID', 'The clock is either shown or hidden.', 422);
  if (typeof s.dismissible !== 'boolean') throw new AppError('CONTENT_INVALID', 'Closing the bar is either allowed or not.', 422);
  if (typeof s.dismissVersion !== 'string' || !/^v[a-z0-9-]{1,31}$/.test(s.dismissVersion)) {
    throw new AppError('CONTENT_INVALID', 'The dismiss version must look like "v1".', 422);
  }
}

export async function getAnnouncementsDraft(brandId) {
  const doc = await loadDocument(ANN.docType, ANN.docKey, brandId);
  const [rows, settings, index] = await Promise.all([
    query('SELECT * FROM content_announcements WHERE brand_id = ? ORDER BY position ASC', [brandId]),
    getAnnouncementSettings(doc.id),
    loadEntityIndex(),
  ]);
  return {
    document: docMeta(doc),
    dismissVersion: settings.dismissVersion,
    settings,
    announcements: rows.map((r) => {
      // A link still written as a slug is shown to the editor as a reference
      // to its entity; saving stores the reference.
      let ref = r.link_ref_id ? { type: r.link_ref_type, id: r.link_ref_id } : null;
      if (!ref && r.link_type && r.link_type !== 'EXTERNAL') {
        const { entity, managed } = locateEntity(index, null, routeForLink(r.link_type, r.link_target, r.external_url));
        if (managed && entity) ref = { type: entity.type, id: entity.id };
      }
      return {
        id: r.id, announcementKey: r.announcement_key, text: r.text,
        linkType: r.link_type, linkTarget: r.link_target, externalUrl: r.external_url,
        linkRefType: ref?.type ?? null, linkRefId: ref?.id ?? null,
        startsAt: r.starts_at, expiresAt: r.expires_at, position: r.position, status: r.status,
      };
    }),
  };
}

export async function upsertAnnouncement(input, expectedVersion, actor, brandId) {
  const doc = await loadDocument(ANN.docType, ANN.docKey, brandId);
  assertVersion(doc, expectedVersion);
  if (!input.text || !input.text.trim()) throw new AppError('CONTENT_INVALID', 'Announcement text is required.', 422);
  if (input.linkRefId) {
    // A link to a category / collection / page is a reference: the entity is
    // the authority for its URL.
    const entity = await findEntity(input.linkRefType, input.linkRefId);
    if (!entity) throw new AppError('CONTENT_LINK_INVALID', 'The linked category, collection or page no longer exists.', 422);
    input.linkType = entity.type === 'PAGE' ? 'CONTENT_PAGE' : 'COLLECTION';
    input.linkTarget = entity.slug;
    input.externalUrl = null;
  } else {
    input.linkRefType = null;
  }
  if (input.linkType === 'EXTERNAL') assertSafeExternalUrl(input.externalUrl);
  else if (input.linkType) await validateInternalTarget(input.linkType, input.linkTarget);
  const startsAt = toDt(input.startsAt);
  const expiresAt = toDt(input.expiresAt);
  if (startsAt && expiresAt && expiresAt <= startsAt) throw new AppError('CONTENT_INVALID', 'The message must end after it starts.', 422);
  if (!input.id && input.announcementKey) {
    const [taken] = await query('SELECT 1 FROM content_announcements WHERE brand_id = ? AND announcement_key = ? LIMIT 1', [brandId, input.announcementKey]);
    if (taken) throw new AppError('CONTENT_CONFLICT', `A message with the key "${input.announcementKey}" already exists.`, 409);
  }
  await withTransaction(async (conn) => {
    if (input.id) {
      await conn.execute(
        `UPDATE content_announcements SET text = ?, link_type = ?, link_target = ?, external_url = ?, link_ref_type = ?, link_ref_id = ?, starts_at = ?, expires_at = ?, status = ?, updated_at = NOW(3)
         WHERE id = ? AND brand_id = ?`,
        [input.text.trim(), input.linkType ?? null, input.linkTarget ?? null, input.externalUrl ?? null, input.linkRefType || null, input.linkRefId || null,
          startsAt, expiresAt, input.status || 'ACTIVE', input.id, brandId],
      );
    } else {
      const [s] = await conn.execute('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM content_announcements WHERE brand_id = ?', [brandId]);
      await conn.execute(
        `INSERT INTO content_announcements (id, brand_id, announcement_key, text, link_type, link_target, external_url, link_ref_type, link_ref_id, starts_at, expires_at, position, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
        [randomUUID(), brandId, input.announcementKey || `ann_${Date.now()}`, input.text.trim(), input.linkType ?? null, input.linkTarget ?? null, input.externalUrl ?? null,
          input.linkRefType || null, input.linkRefId || null, startsAt, expiresAt, Number(s[0].p), input.status || 'ACTIVE'],
      );
    }
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'ANNOUNCEMENT_UPDATED', 'content_announcement', input.announcementKey, {});
  return getAnnouncementsDraft(brandId);
}

export async function deleteAnnouncement(id, expectedVersion, actor, brandId) {
  const doc = await loadDocument(ANN.docType, ANN.docKey, brandId);
  assertVersion(doc, expectedVersion);
  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM content_announcements WHERE id = ? AND brand_id = ?', [id, brandId]);
    const [rows] = await conn.execute('SELECT id FROM content_announcements WHERE brand_id = ? ORDER BY position ASC', [brandId]);
    for (let i = 0; i < rows.length; i += 1) await conn.execute('UPDATE content_announcements SET position = ? WHERE id = ?', [i, rows[i].id]);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'ANNOUNCEMENT_UPDATED', 'content_announcement', id, { deleted: true });
  return getAnnouncementsDraft(brandId);
}

export async function reorderAnnouncements(orderedIds, expectedVersion, actor, brandId) {
  const doc = await loadDocument(ANN.docType, ANN.docKey, brandId);
  assertVersion(doc, expectedVersion);
  await withTransaction(async (conn) => {
    const [current] = await conn.execute('SELECT id FROM content_announcements WHERE brand_id = ?', [brandId]);
    const ids = new Set(current.map((r) => r.id));
    if (orderedIds.length !== ids.size || !orderedIds.every((id) => ids.has(id))) throw new AppError('CONTENT_INVALID', 'Reorder list mismatch.', 422);
    for (let i = 0; i < orderedIds.length; i += 1) await conn.execute('UPDATE content_announcements SET position = ? WHERE id = ?', [POSITION_OFFSET + i, orderedIds[i]]);
    for (let i = 0; i < orderedIds.length; i += 1) await conn.execute('UPDATE content_announcements SET position = ? WHERE id = ?', [i, orderedIds[i]]);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'ANNOUNCEMENT_UPDATED', 'content_announcement', doc.id, { reordered: orderedIds.length });
  return getAnnouncementsDraft(brandId);
}

export async function setAnnouncementSettings(settings, expectedVersion, actor, brandId) {
  const doc = await loadDocument(ANN.docType, ANN.docKey, brandId);
  assertVersion(doc, expectedVersion);
  const clean = { ...DEFAULT_ANNOUNCEMENT_SETTINGS, ...pickAnnouncementSettings(settings) };
  validateAnnouncementSettings(clean);
  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT INTO content_announcement_settings (document_id, brand_id, settings_json) VALUES (?, ?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)`,
      [doc.id, brandId, JSON.stringify(clean)],
    );
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'ANNOUNCEMENT_UPDATED', 'content_announcement', doc.id, { settings: true });
  return getAnnouncementsDraft(brandId);
}

async function buildAnnouncementsSnapshot(brandId = null) {
  const doc = await loadDocument(ANN.docType, ANN.docKey, brandId);
  const rows = brandId
    ? await query("SELECT * FROM content_announcements WHERE status = 'ACTIVE' AND brand_id = ? ORDER BY position ASC", [brandId])
    : await query("SELECT * FROM content_announcements WHERE status = 'ACTIVE' ORDER BY position ASC");
  const { dismissVersion, ...settings } = await getAnnouncementSettings(doc.id);
  return {
    dismissVersion,
    settings,
    slides: rows.map((r) => {
      const slide = { id: r.announcement_key, text: r.text };
      const link = routeForLink(r.link_type, r.link_target, r.external_url);
      if (r.link_type) slide.link = link;
      // Resolved to the entity's current URL (or dropped) at request time.
      if (r.link_ref_id) slide.ref = { type: r.link_ref_type, id: r.link_ref_id };
      if (r.starts_at) slide.startsAt = new Date(r.starts_at).toISOString();
      if (r.expires_at) slide.expiresAt = new Date(r.expires_at).toISOString();
      return slide;
    }),
  };
}

// ---- publish / rollback / history -------------------------------

const SCOPES = {
  navigation: { ...NAV, build: buildNavigationSnapshot, restore: restoreNavigationDraft },
  'mega-menus': { ...MEGA, build: buildMegaMenusSnapshot, restore: restoreMegaMenusDraft },
  announcements: { ...ANN, build: buildAnnouncementsSnapshot, restore: restoreAnnouncementsDraft },
};

export async function publishScope(scope, expectedVersion, actor, brandId) {
  const s = SCOPES[scope];
  if (!s) throw new AppError('CONTENT_INVALID', `Unknown content scope "${scope}".`, 422);
  const res = await publish({
    docType: s.docType, docKey: s.docKey, expectedVersion, staffId: actor?.id || null, brandId,
    buildSnapshot: () => s.build(brandId),
    changeSummary: `Published ${scope}`,
  });
  await audit(actor, `${scope.toUpperCase().replace('-', '_')}_PUBLISHED`, 'content', scope, { version: res.version });
  return res;
}

export async function rollbackScope(scope, targetPublicationId, actor, brandId) {
  const s = SCOPES[scope];
  if (!s) throw new AppError('CONTENT_INVALID', `Unknown content scope "${scope}".`, 422);
  const res = await rollback({
    docType: s.docType, docKey: s.docKey, targetPublicationId, staffId: actor?.id || null, brandId,
    restoreDraft: (conn, snapshot, doc) => s.restore(conn, snapshot, doc, brandId),
  });
  await audit(actor, `${scope.toUpperCase().replace('-', '_')}_ROLLED_BACK`, 'content', scope, res);
  return res;
}

export function scopeHistory(scope, brandId) {
  const s = SCOPES[scope];
  if (!s) throw new AppError('CONTENT_INVALID', `Unknown content scope "${scope}".`, 422);
  return listPublications(s.docType, s.docKey, brandId);
}

// ---- draft restore (rollback) -----------------------------------

async function restoreNavigationDraft(conn, snapshot, doc, brandId) {
  await conn.execute('DELETE FROM content_nav_items WHERE document_id = ?', [doc.id]);
  for (let i = 0; i < (snapshot.items || []).length; i += 1) {
    const it = snapshot.items[i];
    const { linkType, target, externalUrl } = deriveLink(it.route);
    await conn.execute(
      `INSERT INTO content_nav_items (id, document_id, brand_id, item_key, label, link_type, link_target, external_url, link_ref_type, link_ref_id, mega_menu_key, icon, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))`,
      [randomUUID(), doc.id, brandId || doc.brand_id, it.id, it.label, linkType, target, externalUrl, it.ref?.type ?? null, it.ref?.id ?? null, it.megaMenuId ?? null, it.icon ?? null, i],
    );
  }
  // Older snapshots predate mobile menu settings; leave the draft's own then.
  if (snapshot.mobileMenu) {
    await conn.execute(
      `INSERT INTO content_nav_settings (document_id, brand_id, settings_json) VALUES (?, ?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)`,
      [doc.id, brandId || doc.brand_id, JSON.stringify({ mobileLinks: snapshot.mobileMenu.links || [], mobileTagline: snapshot.mobileMenu.tagline || '' })],
    );
  }
}
async function restoreMegaMenusDraft(conn, snapshot, doc, brandId) {
  const entries = snapshot.entries || {};
  for (const [key, entry] of Object.entries(entries)) {
    const { id, mediaUrl, ...payload } = entry;
    void id; void mediaUrl;
    await conn.execute(
      `INSERT INTO content_mega_menus (id, brand_id, menu_key, name, payload_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), 'ACTIVE', NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE name = VALUES(name), payload_json = VALUES(payload_json), status = 'ACTIVE', updated_at = NOW(3)`,
      [randomUUID(), brandId || doc.brand_id, key, payload.featured?.heading || key, JSON.stringify(payload)],
    );
  }
}
async function restoreAnnouncementsDraft(conn, snapshot, doc, brandId) {
  const brand = brandId || doc.brand_id;
  await conn.execute('DELETE FROM content_announcements WHERE brand_id = ?', [brand]);
  for (let i = 0; i < (snapshot.slides || []).length; i += 1) {
    const s = snapshot.slides[i];
    const link = s.link ? deriveLink(s.link) : { linkType: null, target: null, externalUrl: null };
    await conn.execute(
      `INSERT INTO content_announcements (id, brand_id, announcement_key, text, link_type, link_target, external_url, link_ref_type, link_ref_id, starts_at, expires_at, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))`,
      [randomUUID(), brand, s.id, s.text, link.linkType, link.target, link.externalUrl, s.ref?.type ?? null, s.ref?.id ?? null, toDt(s.startsAt), toDt(s.expiresAt), i],
    );
  }
  // Older snapshots predate bar settings; leave the draft's own then.
  if (snapshot.settings) {
    await conn.execute(
      `INSERT INTO content_announcement_settings (document_id, brand_id, settings_json) VALUES (?, ?, CAST(? AS JSON))
       ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)`,
      [doc.id, brand, JSON.stringify({
        ...DEFAULT_ANNOUNCEMENT_SETTINGS, ...pickAnnouncementSettings(snapshot.settings), dismissVersion: snapshot.dismissVersion || DEFAULT_ANNOUNCEMENT_SETTINGS.dismissVersion,
      })],
    );
  }
}

function deriveLink(route) {
  if (!route) return { linkType: 'CUSTOM_INTERNAL', target: '/', externalUrl: null };
  if (/^https?:\/\//i.test(route)) return { linkType: 'EXTERNAL', target: null, externalUrl: route };
  const m = route.match(/^\/collections\/([^/?]+)/);
  if (m) return { linkType: 'COLLECTION', target: m[1], externalUrl: null };
  const p = route.match(/^\/pages\/([^/?]+)/);
  if (p) return { linkType: 'CONTENT_PAGE', target: p[1], externalUrl: null };
  return { linkType: 'CUSTOM_INTERNAL', target: route, externalUrl: null };
}

// ---- public resolvers ------------------------------------------

export async function resolveHeader() {
  const { resolveFooter } = await import('./homepageService.js');
  const { resolveExperience } = await import('./campaignService.js');
  const [nav, mega, ann, footer, experience] = await Promise.all([
    getPublishedSnapshot(NAV.docType, NAV.docKey),
    getPublishedSnapshot(MEGA.docType, MEGA.docKey),
    getPublishedSnapshot(ANN.docType, ANN.docKey),
    resolveFooter(),
    resolveExperience(),
  ]);

  // Campaign overlay (Phase 6): the resolved experience prepends/replaces
  // the published announcement slides and carries the resolved theme
  // tokens. Default (no active campaign) => base slides + base tokens =
  // no visible change.
  const baseSlides = ann ? ann.slides : [];
  let slides = baseSlides;
  if (experience.announcementOverlay) {
    const campSlides = experience.announcementOverlay.slides.map((s, i) => ({
      id: `campaign_${experience.campaign?.key || 'x'}_${i}`, text: s.text, link: s.link || null, source: 'campaign',
    }));
    slides = experience.announcementOverlay.mode === 'replace' ? campSlides : [...campSlides, ...baseSlides];
  }

  return resolveHeaderLinks({
    version: [nav?.version, mega?.version, ann?.version].filter((x) => x != null).join('.').concat(`~${experience.version}`) || '0',
    navigation: nav ? nav.items : [],
    mobileMenu: nav?.mobileMenu || null,
    megaMenus: mega ? mega.entries : {},
    announcements: { dismissVersion: ann?.dismissVersion || DEFAULT_ANNOUNCEMENT_SETTINGS.dismissVersion, settings: publicAnnouncementSettings(ann?.settings), slides },
    footer: footer || null,
    theme: experience.theme,
    campaign: experience.campaign,
    banner: experience.banner,
  }, await loadEntityIndex());
}

// Preview (Phase 7): the same shape as resolveHeader, but built from the
// DRAFT tables (unpublished edits) and resolving campaigns from their draft
// definitions as of `asOf` (or now). Only reachable with a valid preview
// token — see previewService.
export async function resolveHeaderPreview({ asOf = null } = {}) {
  const { HOMEPAGE_FOOTER_BUILDERS } = await import('./homepageService.js');
  const { resolveExperience } = await import('./campaignService.js');
  const [navSnap, megaSnap, annSnap, footerSnap, experience] = await Promise.all([
    buildNavigationSnapshot(),
    buildMegaMenusSnapshot(),
    buildAnnouncementsSnapshot(),
    HOMEPAGE_FOOTER_BUILDERS.footer(),
    resolveExperience({ now: asOf, includeDrafts: true }),
  ]);

  let slides = annSnap.slides;
  if (experience.announcementOverlay) {
    const campSlides = experience.announcementOverlay.slides.map((s, i) => ({
      id: `campaign_${experience.campaign?.key || 'x'}_${i}`, text: s.text, link: s.link || null, source: 'campaign',
    }));
    slides = experience.announcementOverlay.mode === 'replace' ? campSlides : [...campSlides, ...annSnap.slides];
  }

  return resolveHeaderLinks({
    version: `preview~${experience.version}`,
    preview: true,
    navigation: navSnap.items,
    mobileMenu: navSnap.mobileMenu || null,
    megaMenus: megaSnap.entries,
    announcements: { dismissVersion: annSnap.dismissVersion, settings: publicAnnouncementSettings(annSnap.settings), slides },
    footer: footerSnap,
    theme: experience.theme,
    campaign: experience.campaign,
    banner: experience.banner,
  }, await loadEntityIndex());
}

// ---- audit ---------------------------------------------------

import { StaffAuditRepository } from '../staff/repositories.js';
const auditRepo = new StaffAuditRepository();
function audit(actor, action, resourceType, resourceId, metadata) {
  return auditRepo.log({
    staffUserId: actor?.id || null, actorEmail: actor?.email || null,
    ipAddress: actor?.ip || null, requestId: actor?.requestId || null,
    action, resourceType, resourceId: String(resourceId), metadata,
  }).catch(() => {});
}
