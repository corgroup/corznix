// Single source of truth for website links.
//
// A link to a category, collection or content page is a REFERENCE to that
// entity, never a copy of its name and URL. Every public content payload
// (header, dropdowns, mobile menu, footer, homepage) passes through here at
// request time, so:
//   * renaming the Tops category renames "Tops" in the header, every
//     dropdown, the mobile menu, the footer — everywhere, at once;
//   * changing its URL moves every link to the new URL;
//   * archiving it hides every link to it; deleting it removes them;
//   * a "view all" link reads "All <current name>".
// Links that are not entities (custom routes such as /track-order, external
// URLs) are left exactly as written.
//
// A link identifies its entity by `ref: { type, id }` (new content), else by
// the slug in its path — current slug first, then slug history (so a link
// written before a rename still finds the entity).
import { query } from '../../database/connection/pool.js';

const CATALOG = 'CATALOG';
const PAGE = 'PAGE';
export const ENTITY_TYPES = ['CATEGORY', 'COLLECTION', 'PAGE'];

const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** '/collections/tops?fit=x' -> { kind: 'CATALOG', slug: 'tops', suffix: '?fit=x' } */
export function parseEntityPath(path) {
  if (typeof path !== 'string') return null;
  const cut = path.search(/[?#]/);
  const pathname = cut === -1 ? path : path.slice(0, cut);
  const suffix = cut === -1 ? '' : path.slice(cut);
  let m = /^\/collections\/([^/]+)\/?$/.exec(pathname);
  if (m) return { kind: CATALOG, slug: safeDecode(m[1]), suffix };
  m = /^\/pages\/([^/]+)\/?$/.exec(pathname);
  if (m) return { kind: PAGE, slug: safeDecode(m[1]), suffix };
  return null;
}

export const kindOf = (type) => (type === 'PAGE' ? PAGE : CATALOG);
export const routeOf = (type, slug) => (type === 'PAGE' ? `/pages/${slug}` : `/collections/${slug}`);

/** Everything a link can point at, with its live name, URL and visibility. */
export async function loadEntityIndex() {
  const [categories, collections, pages, history] = await Promise.all([
    query('SELECT id, slug, name, status, parent_id FROM categories'),
    query('SELECT id, slug, name, status FROM collections'),
    query(`SELECT p.id, p.slug, p.title AS name, p.status, (d.published_publication_id IS NOT NULL) AS published
           FROM content_pages p JOIN content_documents d ON d.id = p.document_id`),
    query('SELECT entity_type, entity_id, slug FROM content_entity_slug_history ORDER BY recorded_at DESC'),
  ]);
  const byId = new Map();
  const catalogBySlug = new Map();
  const pageBySlug = new Map();
  const add = (type, r, live) => {
    const e = { type, id: r.id, slug: r.slug, name: r.name, live, route: routeOf(type, r.slug) };
    byId.set(`${type}:${r.id}`, e);
    return e;
  };
  // /collections/<slug> shows the collection when both exist, so it wins.
  // A category is live only when every category above it is active too: a
  // link to Headwear must go when Accessories is archived, exactly as the
  // storefront's collection lists drop it (collections/controller.js).
  const categoryById = new Map(categories.map((r) => [r.id, r]));
  const categoryLive = (r, depth = 0) => r.status === 'ACTIVE'
    && (!r.parent_id || (depth < 20 && Boolean(categoryById.get(r.parent_id)) && categoryLive(categoryById.get(r.parent_id), depth + 1)));
  for (const r of categories) catalogBySlug.set(r.slug, add('CATEGORY', r, categoryLive(r)));
  for (const r of collections) catalogBySlug.set(r.slug, add('COLLECTION', r, r.status === 'ACTIVE'));
  for (const r of pages) pageBySlug.set(r.slug, add('PAGE', r, r.status === 'ACTIVE' && Boolean(Number(r.published))));
  const historyBySlug = new Map();
  for (const h of history) {
    const key = `${kindOf(h.entity_type)}:${h.slug}`;
    if (!historyBySlug.has(key)) historyBySlug.set(key, { type: h.entity_type, id: h.entity_id });
  }
  return { byId, catalogBySlug, pageBySlug, historyBySlug };
}

/**
 * managed=false: not an entity link (custom route / external) — leave it.
 * managed=true, entity=null: the entity was deleted (or never existed for a
 * /collections/ URL, which could only 404) — drop the link.
 */
export function locateEntity(index, ref, path) {
  const parsed = parseEntityPath(path);
  if (ref && ref.type && ref.id) {
    return { entity: index.byId.get(`${ref.type}:${ref.id}`) || null, managed: true, suffix: parsed?.suffix || '' };
  }
  if (!parsed) return { entity: null, managed: false, suffix: '' };
  const current = parsed.kind === CATALOG ? index.catalogBySlug.get(parsed.slug) : index.pageBySlug.get(parsed.slug);
  if (current) return { entity: current, managed: true, suffix: parsed.suffix };
  const past = index.historyBySlug.get(`${parsed.kind}:${parsed.slug}`);
  if (past) return { entity: index.byId.get(`${past.type}:${past.id}`) || null, managed: true, suffix: parsed.suffix };
  // An unknown /pages/<slug> may be an app route with its own page (FAQs).
  return { entity: null, managed: parsed.kind === CATALOG, suffix: parsed.suffix };
}

/** A link with the entity's current URL (and name), or null when it must not show. */
export function resolveLink(link, index, { pathKey = 'path', withLabel = true } = {}) {
  if (!link || typeof link !== 'object') return link;
  const { entity, managed, suffix } = locateEntity(index, link.ref, link[pathKey]);
  if (!managed) return link;
  if (!entity || !entity.live) return null;
  // The reference is how content is stored, not part of the storefront
  // contract — the public payload keeps its { label, path } shape.
  const { ref, ...rest } = link;
  void ref;
  const out = { ...rest, [pathKey]: `${entity.route}${suffix || ''}` };
  if (withLabel) out.label = link.isViewAll ? `All ${entity.name}` : entity.name;
  return out;
}

/** Editing view: give links written as a URL the reference of the entity they point at. */
export function attachEntityRefs(list, index) {
  if (!Array.isArray(list)) return list;
  return list.map((l) => {
    if (!l || l.ref) return l;
    const { entity, managed } = locateEntity(index, null, l.path);
    return managed && entity ? { ...l, ref: { type: entity.type, id: entity.id } } : l;
  });
}

const resolveList = (list, index, opts) => (Array.isArray(list) ? list.map((l) => resolveLink(l, index, opts)).filter(Boolean) : list);

export function resolveFooterLinks(footer, index) {
  if (!footer || typeof footer !== 'object') return footer;
  const out = { ...footer };
  for (const key of ['shop', 'about', 'help', 'legal']) if (Array.isArray(out[key])) out[key] = resolveList(out[key], index);
  return out;
}

/** The whole GET /content/header payload, resolved. */
export function resolveHeaderLinks(header, index) {
  const megaMenus = {};
  for (const [key, entry] of Object.entries(header.megaMenus || {})) {
    let featured = entry.featured;
    if (featured?.ctaPath) {
      // The promo button keeps its own wording; only its URL follows the entity.
      const r = resolveLink({ path: featured.ctaPath }, index, { withLabel: false });
      if (r) featured = { ...featured, ctaPath: r.path };
    }
    const items = entry.categoryNav ? resolveList(entry.categoryNav.items, index) : null;
    // One menu everywhere: the mobile/tablet submenu and the category cards are
    // the dropdown's own category links (as apps/corcotton menuDerivation.js
    // renders them), never older separate copies that could disagree.
    const cardBg = new Map((entry.shopCards || []).map((c) => [c.path, c.background]));
    megaMenus[key] = {
      ...entry,
      ...(featured ? { featured } : {}),
      ...(items ? {
        categoryNav: { ...entry.categoryNav, items },
        mobileLinks: items.map((it) => ({ label: it.label, path: it.path })),
        ...(entry.shopCards || !entry.latestDrops ? {
          shopCards: items.filter((it) => !it.isViewAll).map((it) => ({
            label: it.label, path: it.path,
            ...((it.background || cardBg.get(it.path)) ? { background: it.background || cardBg.get(it.path) } : {}),
          })),
        } : {}),
      } : {
        ...(entry.mobileLinks ? { mobileLinks: resolveList(entry.mobileLinks, index) } : {}),
        ...(entry.shopCards ? { shopCards: resolveList(entry.shopCards, index) } : {}),
      }),
      // A fit's label is the fit ("Relaxed Fit"), not the collection's name.
      ...(entry.fits ? { fits: resolveList(entry.fits, index, { withLabel: false }) } : {}),
    };
  }
  return {
    ...header,
    navigation: resolveList(header.navigation, index, { pathKey: 'route' }),
    megaMenus,
    ...(header.mobileMenu ? { mobileMenu: { ...header.mobileMenu, links: resolveList(header.mobileMenu.links, index) } } : {}),
    footer: resolveFooterLinks(header.footer, index),
    ...(header.announcements ? { announcements: { ...header.announcements, slides: resolveAnnouncementSlides(header.announcements.slides, index) } } : {}),
  };
}

/**
 * An announcement's link follows its category / collection / page. When that
 * is switched off or gone the message stays and only its link is dropped —
 * the words are the editor's, not the entity's.
 */
function resolveAnnouncementSlides(slides, index) {
  if (!Array.isArray(slides)) return slides;
  return slides.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const { ref, ...slide } = s;
    if (!slide.link && !ref) return slide;
    const { entity, managed, suffix } = locateEntity(index, ref, slide.link);
    if (!managed) return slide;
    if (entity && entity.live) return { ...slide, link: `${entity.route}${suffix || ''}` };
    const { link, ...withoutLink } = slide;
    void link;
    return withoutLink;
  });
}

const COLLECTION_SECTIONS = new Set(['PRODUCT_CAROUSEL', 'COLLECTION_GRID']);
// Sections with a button (the "Built on Purpose" story banner and friends).
const BUTTON_SECTIONS = new Set(['EDITORIAL_BANNER', 'IMAGE_TEXT', 'CONTENT_BLOCK', 'PROMO_BANNER']);

/**
 * Homepage sections follow what they point at. A product section follows its
 * collection — a gone collection's section is not shown. A section's button
 * follows its page or collection — when that is gone the button is dropped
 * and the section stays. References are how content is stored, never part of
 * the public payload.
 */
export function resolveHomepageSections(sections, index) {
  return (sections || []).map((s) => {
    const { collectionRef, ctaRef, ...config } = s.config || {};
    if (COLLECTION_SECTIONS.has(s.type) && (config.collectionSlug || collectionRef)) {
      const { entity, managed } = locateEntity(index, collectionRef, config.collectionSlug ? `/collections/${config.collectionSlug}` : null);
      if (managed) {
        if (!entity || !entity.live) return null;
        config.collectionSlug = entity.slug;
      }
    }
    if (BUTTON_SECTIONS.has(s.type) && (config.ctaPath || ctaRef)) {
      const { entity, managed, suffix } = locateEntity(index, ctaRef, config.ctaPath);
      if (managed) {
        if (entity && entity.live) config.ctaPath = `${entity.route}${suffix}`;
        else { delete config.ctaPath; delete config.ctaLabel; }
      }
    }
    return { ...s, config };
  }).filter(Boolean);
}

/** An entity a link may be saved against: must exist. Returns its row. */
export async function findEntity(type, id) {
  if (!ENTITY_TYPES.includes(type)) return null;
  const table = type === 'CATEGORY' ? 'categories' : type === 'COLLECTION' ? 'collections' : 'content_pages';
  const nameCol = type === 'PAGE' ? 'title' : 'name';
  const [row] = await query(`SELECT id, slug, ${nameCol} AS name, status FROM ${table} WHERE id = ? LIMIT 1`, [id]);
  return row ? { type, ...row } : null;
}

/** Remember an old slug so links written with it keep resolving (or vanish once the entity is deleted). */
export async function recordSlugHistory(type, id, slug, brandId = null, conn = null) {
  if (!slug) return;
  const sql = 'INSERT IGNORE INTO content_entity_slug_history (entity_type, entity_id, slug, brand_id) VALUES (?, ?, ?, ?)';
  if (conn) await conn.execute(sql, [type, id, slug, brandId]);
  else await query(sql, [type, id, slug, brandId]);
}

// ---- where is an entity used? ----------------------------------------------------

const parseJson = (v) => (v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v));

/**
 * Every place on the website that links to the entity — drafts (what editors
 * see) and the live published content. Used by the CMS before a delete and
 * by the delete guard itself.
 */
export async function findEntityReferences(type, id, brandId) {
  const entity = await findEntity(type, id);
  if (!entity) return { entity: null, references: [] };
  const past = await query('SELECT slug FROM content_entity_slug_history WHERE entity_type = ? AND entity_id = ?', [type, id]);
  const slugs = new Set([entity.slug, ...past.map((r) => r.slug)]);
  const kind = kindOf(type);
  const hits = (link, pathKey = 'path') => {
    if (!link) return false;
    if (link.ref?.id) return link.ref.id === id && link.ref.type === type;
    const p = parseEntityPath(link[pathKey]);
    return Boolean(p && p.kind === kind && slugs.has(p.slug));
  };
  const references = [];
  const push = (area, where, label, state = 'draft') => references.push({ area, where, label, state });
  // What the website shows for a link to this entity — never a stale typed copy.
  const shownAs = (link) => (link?.isViewAll ? `All ${entity.name}` : entity.name);

  const rowLinkTypes = type === 'PAGE' ? ['CONTENT_PAGE'] : ['COLLECTION', 'CATEGORY'];
  const rowHit = (r) => (r.link_ref_id ? r.link_ref_id === id && r.link_ref_type === type
    : rowLinkTypes.includes(r.link_type) && slugs.has(r.link_target));

  const navRows = await query('SELECT label, link_type, link_target, link_ref_type, link_ref_id, status FROM content_nav_items WHERE brand_id = ?', [brandId]);
  for (const r of navRows) if (rowHit(r)) push('Header', 'Header bar item', shownAs(r));

  const footerRows = await query(
    `SELECT l.label, l.link_type, l.link_target, l.link_ref_type, l.link_ref_id, g.group_key
     FROM content_footer_links l JOIN content_footer_groups g ON g.id = l.group_id WHERE g.brand_id = ?`, [brandId]);
  for (const r of footerRows) if (rowHit(r)) push('Footer', `Footer · ${r.group_key}`, shownAs(r));

  const menus = await query('SELECT menu_key, name, payload_json FROM content_mega_menus WHERE brand_id = ?', [brandId]);
  for (const m of menus) {
    const p = parseJson(m.payload_json) || {};
    const where = `${m.name} dropdown`;
    for (const l of p.categoryNav?.items || []) if (hits(l)) push('Header', `${where} · category link (desktop, tablet, mobile, cards)`, shownAs(l));
    for (const l of p.fits || []) if (hits(l)) push('Header', `${where} · fit`, l.label);
    if (p.featured?.ctaPath && hits({ path: p.featured.ctaPath })) push('Header', `${where} · promo button`, p.featured.ctaLabel || p.featured.heading);
  }

  const settings = await query('SELECT settings_json FROM content_nav_settings WHERE brand_id = ?', [brandId]);
  for (const s of settings) for (const l of parseJson(s.settings_json)?.mobileLinks || []) if (hits(l)) push('Mobile menu', 'Links under the mobile menu', shownAs(l));

  const sections = await query('SELECT section_key, section_type, config_json FROM content_home_sections WHERE brand_id = ?', [brandId]);
  for (const s of sections) {
    const c = parseJson(s.config_json) || {};
    if (COLLECTION_SECTIONS.has(s.section_type)
      && ((c.collectionRef && c.collectionRef.id === id) || (!c.collectionRef && c.collectionSlug && kind === CATALOG && slugs.has(c.collectionSlug)))) {
      push('Homepage', `Homepage section "${s.section_key}"`, c.heading || s.section_key);
    }
    if (BUTTON_SECTIONS.has(s.section_type) && hits({ ref: c.ctaRef, path: c.ctaPath })) {
      push('Homepage', `Homepage section "${s.section_key}" · button`, c.ctaLabel || c.heading || s.section_key);
    }
  }

  const annRows = await query('SELECT text, link_type, link_target, link_ref_type, link_ref_id FROM content_announcements WHERE brand_id = ?', [brandId]);
  for (const r of annRows) {
    const linked = r.link_ref_id ? r.link_ref_id === id : (rowLinkTypes.includes(r.link_type) && slugs.has(r.link_target));
    if (linked) push('Announcement bar', 'Announcement', r.text);
  }

  // Things that make a delete impossible (the catalog refuses it): shown up
  // front so an editor is never offered a delete that will fail.
  const blockers = [];
  if (type === 'CATEGORY') {
    // A product can be linked both ways (mapping row + its primary category
    // column) — count products, not links.
    const [p] = await query(
      `SELECT COUNT(*) AS n FROM (
         SELECT product_id AS pid FROM product_categories WHERE category_id = ?
         UNION
         SELECT id AS pid FROM products WHERE category_id = ? AND brand_id = ?
       ) linked`,
      [id, id, brandId]);
    const [c] = await query('SELECT COUNT(*) AS n FROM categories WHERE parent_id = ? AND brand_id = ?', [id, brandId]);
    if (Number(p.n) > 0) blockers.push(`It is still assigned to ${Number(p.n)} product${Number(p.n) === 1 ? '' : 's'}.`);
    if (Number(c.n) > 0) blockers.push(`It has ${Number(c.n)} sub-categor${Number(c.n) === 1 ? 'y' : 'ies'}.`);
  } else if (type === 'COLLECTION') {
    const [m] = await query('SELECT COUNT(*) AS n FROM product_collections WHERE collection_id = ?', [id]);
    if (Number(m.n) > 0) blockers.push(`It still has ${Number(m.n)} product${Number(m.n) === 1 ? '' : 's'}.`);
  }

  return { entity: { type, id, name: entity.name, slug: entity.slug, status: entity.status }, references, blockers };
}
