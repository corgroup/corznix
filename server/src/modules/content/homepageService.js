// Homepage + Footer content (Wave 8E). Both publishable scopes on the
// content engine.
//   HOMEPAGE:home — content_home_sections (whitelisted section_type -> an
//                   existing storefront component; §12/§32). CMS controls
//                   enable/disable, order, per-type config, section media.
//   FOOTER:main   — content_footer_groups / _links / _meta.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// draft-editing functions take the caller's `brandId`; the snapshot
// builders take an OPTIONAL `brandId` (admin publish path supplies it,
// public/preview path doesn't — same pattern as navigationService.js).
// `content_footer_links` / `content_footer_meta` are NOT directly scoped
// (§4.2, transitively via `group_id`/`document_id`) — no brand_id column
// on either, nothing to change there.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { loadDocument, touchDraft, assertVersion, publish, rollback, listPublications, getPublishedSnapshot } from './documentService.js';
import { validateInternalTarget, assertSafeExternalUrl } from './linkSafety.js';
import { loadEntityIndex, resolveHomepageSections, findEntity } from './entityLinks.js';
import { ICON_NAMES } from './navigationService.js';
import { resolveInstagramSections, INSTAGRAM_LIMITS, INSTAGRAM_MODES } from './instagram.js';
import { StaffAuditRepository } from '../staff/repositories.js';

const HOME = { docType: 'HOMEPAGE', docKey: 'home' };
const FOOTER = { docType: 'FOOTER', docKey: 'main' };
const POSITION_OFFSET = 100000;
const auditRepo = new StaffAuditRepository();
const audit = (actor, action, rt, rid, meta) => auditRepo.log({
  staffUserId: actor?.id || null, actorEmail: actor?.email || null, ipAddress: actor?.ip || null,
  requestId: actor?.requestId || null, action, resourceType: rt, resourceId: String(rid), metadata: meta,
}).catch(() => {});
const parseJson = (v) => (v == null ? {} : (typeof v === 'string' ? JSON.parse(v) : v));
const docMeta = (d) => ({ docType: d.docType, docKey: d.docKey, workingVersion: d.workingVersion, publishedVersion: d.publishedVersion, draftDirty: d.draftDirty });

// ---- homepage section config validation -----------------------------
const SECTION_TYPES = ['HERO', 'BRAND_STRIP', 'PRODUCT_CAROUSEL', 'CATEGORY_SECTION', 'COLLECTION_GRID', 'EDITORIAL_BANNER', 'PROMO_BANNER', 'IMAGE_TEXT', 'REVIEWS', 'TRUST_STRIP', 'CONTENT_BLOCK', 'INSTAGRAM_VIDEOS'];

async function validateSectionConfig(type, config, mediaId) {
  const c = config || {};
  const str = (v, max = 300) => v == null || (typeof v === 'string' && v.length <= max);
  const invalid = (message) => new AppError('CONTENT_INVALID', message, 422);
  // A saved reference must point at something that exists.
  const assertRef = async (ref, where) => {
    if (!ref || typeof ref !== 'object' || !ref.type || !ref.id) throw invalid(`${where}: incomplete link.`);
    if (!(await findEntity(ref.type, ref.id))) {
      throw new AppError('CONTENT_LINK_INVALID', `${where} points at something that no longer exists.`, 422);
    }
  };
  // A button needs both halves: text with nowhere to go is a dead control on
  // the homepage, and a link with no text is invisible.
  const assertButton = async () => {
    if (!str(c.ctaLabel, 60)) throw invalid('Button text is too long (60 characters max).');
    const label = typeof c.ctaLabel === 'string' ? c.ctaLabel.trim() : '';
    const path = typeof c.ctaPath === 'string' ? c.ctaPath.trim() : '';
    if (Boolean(label) !== Boolean(path || c.ctaRef)) throw invalid('A button needs both its text and its link.');
    if (c.ctaRef) await assertRef(c.ctaRef, 'Button link');
    else if (path) await validateInternalTarget('CUSTOM_INTERNAL', path);
  };
  switch (type) {
    case 'HERO':
      break; // slides are managed as hero banners
    case 'BRAND_STRIP':
      if (c.phrases != null) {
        if (!Array.isArray(c.phrases) || c.phrases.length < 1 || c.phrases.length > 8) throw invalid('The brand strip needs 1 to 8 phrases.');
        if (c.phrases.some((p) => typeof p !== 'string' || !p.trim() || p.length > 40)) throw invalid('Each brand strip phrase must be 1 to 40 characters.');
      }
      break;
    case 'CATEGORY_SECTION':
      if (!str(c.heading, 80)) throw invalid('Heading is too long (80 characters max).');
      break;
    case 'REVIEWS':
      if (!str(c.eyebrow, 40) || !str(c.heading, 80)) throw invalid('Reviews heading text is too long.');
      break;
    case 'TRUST_STRIP':
      if (c.items != null) {
        if (!Array.isArray(c.items) || c.items.length < 1 || c.items.length > 4) throw invalid('The trust strip needs 1 to 4 items.');
        for (const item of c.items) {
          if (!item || typeof item !== 'object') throw invalid('Each trust strip item needs an icon and a title.');
          if (!ICON_NAMES.includes(item.icon)) throw invalid(`Trust strip: unknown icon "${item.icon}".`);
          if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 40) throw invalid('Each trust strip title must be 1 to 40 characters.');
          if (!str(item.sub, 60)) throw invalid('Trust strip text under a title is too long (60 characters max).');
        }
      }
      break;
    case 'PRODUCT_CAROUSEL':
    case 'COLLECTION_GRID':
      if (!c.collectionSlug) throw new AppError('CONTENT_INVALID', `${type} needs config.collectionSlug.`, 422);
      if (c.collectionRef) await assertRef(c.collectionRef, 'Collection');
      await validateInternalTarget('COLLECTION', c.collectionSlug);
      if (!str(c.heading) || !str(c.eyebrow) || !str(c.description)) throw new AppError('CONTENT_INVALID', 'heading/eyebrow/description too long.', 422);
      break;
    case 'EDITORIAL_BANNER':
    case 'IMAGE_TEXT':
    case 'CONTENT_BLOCK':
      if (!str(c.heading) || !str(c.body, 2000) || !str(c.eyebrow)) throw new AppError('CONTENT_INVALID', 'text field too long.', 422);
      if (c.overlay != null && !(Number.isInteger(c.overlay) && c.overlay >= 0 && c.overlay <= 90)) {
        throw invalid('Image darkening must be a whole number from 0 to 90.');
      }
      await assertButton();
      break;
    case 'PROMO_BANNER':
      if (!str(c.heading) || !str(c.subheading)) throw new AppError('CONTENT_INVALID', 'text too long.', 422);
      await assertButton();
      break;
    case 'INSTAGRAM_VIDEOS': {
      if (!str(c.eyebrow, 40) || !str(c.heading, 80) || !str(c.description, 160)) throw invalid('Instagram section heading text is too long.');
      if (c.autoplaySeconds != null && !(Number.isInteger(c.autoplaySeconds)
        && c.autoplaySeconds >= INSTAGRAM_LIMITS.minSeconds && c.autoplaySeconds <= INSTAGRAM_LIMITS.maxSeconds)) {
        throw invalid(`Auto-scroll must wait ${INSTAGRAM_LIMITS.minSeconds} to ${INSTAGRAM_LIMITS.maxSeconds} seconds between posts.`);
      }
      if (c.mode != null && !INSTAGRAM_MODES.includes(c.mode)) throw invalid('Choose whether the section shows the latest posts or the posts you picked.');
      if (c.limit != null && !(Number.isInteger(c.limit) && c.limit >= INSTAGRAM_LIMITS.minShown && c.limit <= INSTAGRAM_LIMITS.maxShown)) {
        throw invalid(`Show between ${INSTAGRAM_LIMITS.minShown} and ${INSTAGRAM_LIMITS.maxShown} posts.`);
      }
      if (c.picks != null) {
        if (!Array.isArray(c.picks) || c.picks.length > INSTAGRAM_LIMITS.maxPicks) throw invalid(`Pick at most ${INSTAGRAM_LIMITS.maxPicks} posts.`);
        const seen = new Set();
        for (const p of c.picks) {
          if (!p || typeof p !== 'object' || typeof p.igMediaId !== 'string' || !/^[0-9]{1,64}$/.test(p.igMediaId)) throw invalid('A picked post is not an Instagram post.');
          if (p.enabled != null && typeof p.enabled !== 'boolean') throw invalid('A post is either shown or hidden.');
          if (seen.has(p.igMediaId)) throw invalid('The same Instagram post is picked twice.');
          seen.add(p.igMediaId);
        }
      }
      break;
    }
    default:
      throw new AppError('CONTENT_INVALID', `Unknown section type "${type}".`, 422);
  }
  if (mediaId) {
    const m = await query("SELECT 1 FROM media WHERE id = ? AND status = 'ACTIVE' LIMIT 1", [mediaId]);
    if (!m[0]) throw new AppError('MEDIA_NOT_FOUND', 'Section media asset not found.', 404);
  }
}

export async function getHomepageDraft(brandId) {
  const doc = await loadDocument(HOME.docType, HOME.docKey, brandId);
  const rows = await query('SELECT * FROM content_home_sections WHERE document_id = ? ORDER BY position ASC', [doc.id]);
  // Resolve the URL alongside the id so the CMS can SHOW the chosen asset
  // rather than making an editor recognise a uuid.
  const ids = [...new Set(rows.map((r) => r.media_id).filter(Boolean))];
  const urls = new Map();
  if (ids.length) {
    const media = await query(`SELECT id, url, resource_type FROM media WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    for (const m of media) urls.set(m.id, { url: m.url, type: m.resource_type || null });
  }
  return {
    document: docMeta(doc),
    sectionTypes: SECTION_TYPES,
    sections: rows.map((r) => ({
      id: r.id, sectionKey: r.section_key, type: r.section_type, position: r.position,
      enabled: Boolean(r.enabled), config: parseJson(r.config_json), mediaId: r.media_id,
      mediaUrl: (r.media_id && urls.get(r.media_id)?.url) || null,
      mediaType: (r.media_id && urls.get(r.media_id)?.type) || null,
    })),
  };
}

export async function upsertHomeSection(input, expectedVersion, actor, brandId) {
  const doc = await loadDocument(HOME.docType, HOME.docKey, brandId);
  assertVersion(doc, expectedVersion);
  if (!SECTION_TYPES.includes(input.type)) throw new AppError('CONTENT_INVALID', `Unknown section type "${input.type}".`, 422);
  await validateSectionConfig(input.type, input.config, input.mediaId);

  await withTransaction(async (conn) => {
    if (input.id) {
      await conn.execute(
        `UPDATE content_home_sections SET section_type = ?, enabled = ?, config_json = CAST(? AS JSON), media_id = ?, updated_at = NOW(3)
         WHERE id = ? AND document_id = ?`,
        [input.type, input.enabled ? 1 : 0, JSON.stringify(input.config || {}), input.mediaId ?? null, input.id, doc.id],
      );
    } else {
      const [s] = await conn.execute('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM content_home_sections WHERE document_id = ?', [doc.id]);
      await conn.execute(
        `INSERT INTO content_home_sections (id, document_id, brand_id, section_key, section_type, position, enabled, config_json, media_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, NOW(3), NOW(3))`,
        [randomUUID(), doc.id, brandId, input.sectionKey || `section_${Date.now()}`, input.type, Number(s[0].p),
          input.enabled === false ? 0 : 1, JSON.stringify(input.config || {}), input.mediaId ?? null],
      );
    }
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'HOMEPAGE_UPDATED', 'content_homepage', doc.id, { sectionKey: input.sectionKey, type: input.type });
  return getHomepageDraft(brandId);
}

export async function deleteHomeSection(id, expectedVersion, actor, brandId) {
  const doc = await loadDocument(HOME.docType, HOME.docKey, brandId);
  assertVersion(doc, expectedVersion);
  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM content_home_sections WHERE id = ? AND document_id = ?', [id, doc.id]);
    const [rows] = await conn.execute('SELECT id FROM content_home_sections WHERE document_id = ? ORDER BY position ASC', [doc.id]);
    for (let i = 0; i < rows.length; i += 1) await conn.execute('UPDATE content_home_sections SET position = ? WHERE id = ?', [i, rows[i].id]);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'HOMEPAGE_UPDATED', 'content_homepage', doc.id, { deleted: id });
  return getHomepageDraft(brandId);
}

export async function reorderHomeSections(orderedIds, expectedVersion, actor, brandId) {
  const doc = await loadDocument(HOME.docType, HOME.docKey, brandId);
  assertVersion(doc, expectedVersion);
  await withTransaction(async (conn) => {
    const [current] = await conn.execute('SELECT id FROM content_home_sections WHERE document_id = ?', [doc.id]);
    const ids = new Set(current.map((r) => r.id));
    if (orderedIds.length !== ids.size || !orderedIds.every((id) => ids.has(id))) throw new AppError('CONTENT_INVALID', 'Reorder list mismatch.', 422);
    for (let i = 0; i < orderedIds.length; i += 1) await conn.execute('UPDATE content_home_sections SET position = ? WHERE id = ?', [POSITION_OFFSET + i, orderedIds[i]]);
    for (let i = 0; i < orderedIds.length; i += 1) await conn.execute('UPDATE content_home_sections SET position = ? WHERE id = ?', [i, orderedIds[i]]);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'HOMEPAGE_UPDATED', 'content_homepage', doc.id, { reordered: orderedIds.length });
  return getHomepageDraft(brandId);
}

async function buildHomepageSnapshot(brandId = null) {
  const doc = await loadDocument(HOME.docType, HOME.docKey, brandId);
  const rows = await query("SELECT * FROM content_home_sections WHERE document_id = ? AND enabled = 1 ORDER BY position ASC", [doc.id]);
  const mediaIds = rows.map((r) => r.media_id).filter(Boolean);
  const mediaUrl = new Map();
  if (mediaIds.length) {
    const media = await query(`SELECT id, url, resource_type FROM media WHERE id IN (${mediaIds.map(() => '?').join(',')})`, mediaIds);
    for (const m of media) mediaUrl.set(m.id, { url: m.url, type: m.resource_type || null });
  }
  return {
    sections: rows.map((r) => ({
      key: r.section_key,
      type: r.section_type,
      config: parseJson(r.config_json),
      mediaUrl: (r.media_id && mediaUrl.get(r.media_id)?.url) || null,
      mediaType: (r.media_id && mediaUrl.get(r.media_id)?.type) || null,
    })),
  };
}

// ---- FOOTER ------------------------------------------------------

const FOOTER_GROUP_KEYS = ['shop', 'about', 'help', 'legal'];

export async function getFooterDraft(brandId) {
  const doc = await loadDocument(FOOTER.docType, FOOTER.docKey, brandId);
  const groups = await query('SELECT * FROM content_footer_groups WHERE document_id = ? ORDER BY position ASC', [doc.id]);
  const links = groups.length
    ? await query(`SELECT * FROM content_footer_links WHERE group_id IN (${groups.map(() => '?').join(',')}) ORDER BY position ASC`, groups.map((g) => g.id))
    : [];
  const meta = (await query('SELECT meta_json FROM content_footer_meta WHERE document_id = ? LIMIT 1', [doc.id]))[0];
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  for (const l of links) byGroup.get(l.group_id)?.push(l);
  return {
    document: docMeta(doc),
    groups: groups.map((g) => ({
      id: g.id, groupKey: g.group_key, label: g.label, position: g.position, status: g.status,
      links: (byGroup.get(g.id) || []).map((l) => ({
        id: l.id, label: l.label, linkType: l.link_type, linkTarget: l.link_target, externalUrl: l.external_url, position: l.position, status: l.status,
        linkRefType: l.link_ref_type || null, linkRefId: l.link_ref_id || null,
      })),
    })),
    meta: meta ? parseJson(meta.meta_json) : { contact: {}, socials: [] },
  };
}

async function ensureFooterGroups(conn, docId, brandId) {
  for (let i = 0; i < FOOTER_GROUP_KEYS.length; i += 1) {
    await conn.execute(
      `INSERT IGNORE INTO content_footer_groups (id, document_id, brand_id, group_key, label, position, status)
       VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [randomUUID(), docId, brandId, FOOTER_GROUP_KEYS[i], FOOTER_GROUP_KEYS[i][0].toUpperCase() + FOOTER_GROUP_KEYS[i].slice(1), i],
    );
  }
}

export async function setFooterGroupLinks(groupKey, links, expectedVersion, actor, brandId) {
  if (!FOOTER_GROUP_KEYS.includes(groupKey)) throw new AppError('CONTENT_INVALID', `Unknown footer group "${groupKey}".`, 422);
  const doc = await loadDocument(FOOTER.docType, FOOTER.docKey, brandId);
  assertVersion(doc, expectedVersion);
  for (const l of links) {
    if (!l.label || !l.label.trim()) throw new AppError('CONTENT_INVALID', 'Footer link label required.', 422);
    if (l.linkRefId) {
      // A reference: the entity decides the URL (and the label on the website).
      const entity = await findEntity(l.linkRefType, l.linkRefId);
      if (!entity) throw new AppError('CONTENT_LINK_INVALID', `"${l.label}" links to a category, collection or page that no longer exists.`, 422);
      l.linkType = entity.type === 'PAGE' ? 'CONTENT_PAGE' : 'COLLECTION';
      l.linkTarget = entity.slug;
      l.externalUrl = null;
    } else {
      l.linkRefType = null;
    }
    if (l.linkType === 'EXTERNAL') assertSafeExternalUrl(l.externalUrl);
    else await validateInternalTarget(l.linkType || 'CUSTOM_INTERNAL', l.linkTarget);
  }
  await withTransaction(async (conn) => {
    await ensureFooterGroups(conn, doc.id, brandId);
    const [g] = await conn.execute('SELECT id FROM content_footer_groups WHERE document_id = ? AND group_key = ? LIMIT 1', [doc.id, groupKey]);
    const groupId = g[0].id;
    await conn.execute('DELETE FROM content_footer_links WHERE group_id = ?', [groupId]);
    for (let i = 0; i < links.length; i += 1) {
      const l = links[i];
      await conn.execute(
        `INSERT INTO content_footer_links (id, group_id, label, link_type, link_target, external_url, link_ref_type, link_ref_id, position, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [randomUUID(), groupId, l.label.trim(), l.linkType || 'CUSTOM_INTERNAL', l.linkTarget ?? null, l.externalUrl ?? null, l.linkRefType || null, l.linkRefId || null, i],
      );
    }
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'FOOTER_UPDATED', 'content_footer', groupKey, { links: links.length });
  return getFooterDraft(brandId);
}

export async function setFooterMeta(meta, expectedVersion, actor, brandId) {
  const doc = await loadDocument(FOOTER.docType, FOOTER.docKey, brandId);
  assertVersion(doc, expectedVersion);
  for (const s of meta.socials || []) assertSafeExternalUrl(s.href);
  await withTransaction(async (conn) => {
    await conn.execute(
      `INSERT INTO content_footer_meta (document_id, meta_json, updated_at) VALUES (?, CAST(? AS JSON), NOW(3))
       ON DUPLICATE KEY UPDATE meta_json = VALUES(meta_json), updated_at = NOW(3)`,
      [doc.id, JSON.stringify(meta)],
    );
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'FOOTER_UPDATED', 'content_footer', 'meta', {});
  return getFooterDraft(brandId);
}

function linkRoute(linkType, target, externalUrl) {
  switch (linkType) {
    case 'HOME': return '/';
    case 'SEARCH': return '/search';
    case 'COLLECTION': case 'CATEGORY': return `/collections/${target}`;
    case 'PRODUCT': return `/products/${target}`;
    case 'CONTENT_PAGE': return `/pages/${target}`;
    case 'EXTERNAL': return externalUrl;
    default: return target || '/';
  }
}

async function buildFooterSnapshot(brandId = null) {
  const doc = await loadDocument(FOOTER.docType, FOOTER.docKey, brandId);
  const groups = await query("SELECT * FROM content_footer_groups WHERE document_id = ? AND status = 'ACTIVE' ORDER BY position ASC", [doc.id]);
  const links = groups.length
    ? await query(`SELECT * FROM content_footer_links WHERE group_id IN (${groups.map(() => '?').join(',')}) AND status = 'ACTIVE' ORDER BY position ASC`, groups.map((g) => g.id))
    : [];
  const meta = (await query('SELECT meta_json FROM content_footer_meta WHERE document_id = ? LIMIT 1', [doc.id]))[0];
  const byGroup = new Map(groups.map((g) => [g.id, []]));
  for (const l of links) {
    byGroup.get(l.group_id)?.push({
      label: l.label, path: linkRoute(l.link_type, l.link_target, l.external_url),
      ...(l.link_ref_id ? { ref: { type: l.link_ref_type, id: l.link_ref_id } } : {}),
    });
  }
  const out = {};
  for (const g of groups) out[g.group_key] = byGroup.get(g.id) || [];
  const m = meta ? parseJson(meta.meta_json) : {};
  return {
    shop: out.shop || [], about: out.about || [], help: out.help || [], legal: out.legal || [],
    contact: m.contact || {},
    socials: m.socials || [],
  };
}

// ---- publish / history / rollback -------------------------------

const SCOPES = {
  homepage: { ...HOME, build: buildHomepageSnapshot, restore: restoreHomepageDraft },
  footer: { ...FOOTER, build: buildFooterSnapshot, restore: restoreFooterDraft },
};

export const HOMEPAGE_FOOTER_BUILDERS = { homepage: buildHomepageSnapshot, footer: buildFooterSnapshot };

export async function publishScope(scope, expectedVersion, actor, brandId) {
  const s = SCOPES[scope];
  if (!s) throw new AppError('CONTENT_INVALID', `Unknown scope "${scope}".`, 422);
  const res = await publish({ docType: s.docType, docKey: s.docKey, expectedVersion, staffId: actor?.id || null, brandId, buildSnapshot: () => s.build(brandId), changeSummary: `Published ${scope}` });
  await audit(actor, `${scope.toUpperCase()}_PUBLISHED`, 'content', scope, { version: res.version });
  return res;
}
export async function rollbackScope(scope, targetPublicationId, actor, brandId) {
  const s = SCOPES[scope];
  if (!s) throw new AppError('CONTENT_INVALID', `Unknown scope "${scope}".`, 422);
  const res = await rollback({ docType: s.docType, docKey: s.docKey, targetPublicationId, staffId: actor?.id || null, brandId, restoreDraft: (conn, snap, doc) => s.restore(conn, snap, doc, brandId) });
  await audit(actor, `${scope.toUpperCase()}_ROLLED_BACK`, 'content', scope, res);
  return res;
}
export function scopeHistory(scope, brandId) {
  const s = SCOPES[scope];
  if (!s) throw new AppError('CONTENT_INVALID', `Unknown scope "${scope}".`, 422);
  return listPublications(s.docType, s.docKey, brandId);
}

async function restoreHomepageDraft(conn, snapshot, doc, brandId) {
  await conn.execute('DELETE FROM content_home_sections WHERE document_id = ?', [doc.id]);
  for (let i = 0; i < (snapshot.sections || []).length; i += 1) {
    const s = snapshot.sections[i];
    await conn.execute(
      `INSERT INTO content_home_sections (id, document_id, brand_id, section_key, section_type, position, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, CAST(? AS JSON), NOW(3), NOW(3))`,
      [randomUUID(), doc.id, brandId || doc.brand_id, s.key, s.type, i, JSON.stringify(s.config || {})],
    );
  }
}
async function restoreFooterDraft(conn, snapshot, doc, brandId) {
  await ensureFooterGroups(conn, doc.id, brandId || doc.brand_id);
  const [groups] = await conn.execute('SELECT id, group_key FROM content_footer_groups WHERE document_id = ?', [doc.id]);
  for (const g of groups) {
    await conn.execute('DELETE FROM content_footer_links WHERE group_id = ?', [g.id]);
    const list = snapshot[g.group_key] || [];
    for (let i = 0; i < list.length; i += 1) {
      const l = list[i];
      const isExt = /^https?:\/\//i.test(l.path);
      const slug = l.ref ? (l.path.match(/^\/(?:collections|pages)\/([^/?#]+)/) || [])[1] : null;
      await conn.execute(
        `INSERT INTO content_footer_links (id, group_id, label, link_type, link_target, external_url, link_ref_type, link_ref_id, position, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [randomUUID(), g.id, l.label,
          l.ref && slug ? (l.ref.type === 'PAGE' ? 'CONTENT_PAGE' : 'COLLECTION') : (isExt ? 'EXTERNAL' : 'CUSTOM_INTERNAL'),
          l.ref && slug ? slug : (isExt ? null : l.path), isExt ? l.path : null,
          l.ref?.type ?? null, l.ref?.id ?? null, i],
      );
    }
  }
  await conn.execute(
    `INSERT INTO content_footer_meta (document_id, meta_json, updated_at) VALUES (?, CAST(? AS JSON), NOW(3))
     ON DUPLICATE KEY UPDATE meta_json = VALUES(meta_json), updated_at = NOW(3)`,
    [doc.id, JSON.stringify({ contact: snapshot.contact || {}, socials: snapshot.socials || [] })],
  );
}

// ---- public resolvers ---------------------------------------

export async function resolveHomepage(brandId = null) {
  const snap = await getPublishedSnapshot(HOME.docType, HOME.docKey);
  // Product sections follow their collection (renamed URL, archived -> hidden).
  return { version: snap?.version || '0', sections: snap ? await resolveInstagramSections(resolveHomepageSections(snap.sections, await loadEntityIndex()), { brandId }) : [] };
}
export async function resolveFooter() {
  const snap = await getPublishedSnapshot(FOOTER.docType, FOOTER.docKey);
  if (!snap) return null;
  const { version, ...footer } = snap;
  void version;
  return footer;
}

// Preview (Phase 7) — built from the draft tables.
export async function resolveHomepagePreview(brandId = null) {
  const snap = await buildHomepageSnapshot();
  return { version: 'preview', preview: true, sections: await resolveInstagramSections(resolveHomepageSections(snap.sections, await loadEntityIndex()), { brandId }) };
}
export async function resolveFooterPreview() {
  return { preview: true, ...(await buildFooterSnapshot()) };
}
