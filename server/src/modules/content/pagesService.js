// Content pages + FAQ (Wave 8E, Phase 5). Both ride the content engine
// (documentService): every page is a CONTENT_PAGE document keyed by slug,
// the FAQ set is one FAQ document.
//
// A page BODY is an ordered list of whitelisted, TYPED blocks — never raw
// HTML/CSS/JS. Inline links inside PARAGRAPH text (`[label](href)`) and
// CONTACT row hrefs are parsed + safety-checked here; the published
// snapshot carries only a resolved, safe DTO (paragraph "runs", absolute
// media URLs). The storefront maps each block type to a plain component.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// draft-editing functions take the caller's `brandId`. A page's `slug` is
// also its `content_documents.doc_key`, and that key is now scoped
// `(brand_id, doc_type, doc_key)` — so Corcotton and Corznix can each have
// their own "/pages/contact". `content_page_blocks` stays unscoped (§4.2,
// transitively via `page_id`).
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import {
  loadDocument, touchDraft, assertVersion, publish, rollback,
  listPublications, getPublishedSnapshot,
} from './documentService.js';
import { assertSafeHref } from './linkSafety.js';
import { StaffAuditRepository } from '../staff/repositories.js';

const FAQ = { docType: 'FAQ', docKey: 'default' };
const POSITION_OFFSET = 100000;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const KEY_RE = /^[a-z][a-z0-9_]*$/;

const auditRepo = new StaffAuditRepository();
const audit = (actor, action, rt, rid, meta) => auditRepo.log({
  staffUserId: actor?.id || null, actorEmail: actor?.email || null, ipAddress: actor?.ip || null,
  requestId: actor?.requestId || null, action, resourceType: rt, resourceId: String(rid), metadata: meta,
}).catch(() => {});
const parseJson = (v) => (v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v));
const docMeta = (d) => ({ docType: d.docType, docKey: d.docKey, workingVersion: d.workingVersion, publishedVersion: d.publishedVersion, draftDirty: d.draftDirty });

// ---- block model ---------------------------------------------------------

export const BLOCK_TYPES = ['HEADING', 'PARAGRAPH', 'LIST', 'IMAGE', 'CONTACT', 'DIVIDER', 'CALLOUT'];
const str = (v, min, max) => typeof v === 'string' && v.trim().length >= min && v.length <= max;

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const EMPHASIS_RE = /\*\*([^*]+)\*\*|\*([^*]+)\*/g;

// Emphasis inside a stretch of text: `**bold**` and `*italic*`.
//
// Editors asked for formatting, and this is as far as it goes on purpose —
// the block model has no raw-HTML path anywhere, so what an editor types can
// never become markup. Bold and italic are carried as flags on a run, not as
// tags, and the storefront decides how to draw them.
function emphasise(text, base = {}) {
  const out = [];
  let last = 0;
  let m;
  EMPHASIS_RE.lastIndex = 0;
  while ((m = EMPHASIS_RE.exec(text)) !== null) {
    if (m.index > last) out.push({ ...base, text: text.slice(last, m.index) });
    out.push(m[1] !== undefined
      ? { ...base, text: m[1], bold: true }
      : { ...base, text: m[2], italic: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ ...base, text: text.slice(last) });
  return out;
}

// "text with [a link](/x) and **bold** inside" -> runs. Emphasis is parsed
// both between links and inside a link's own label, so a link can be bold.
function toRuns(text) {
  const runs = [];
  let last = 0;
  let m;
  LINK_RE.lastIndex = 0;
  while ((m = LINK_RE.exec(text)) !== null) {
    if (m.index > last) runs.push(...emphasise(text.slice(last, m.index)));
    assertSafeHref(m[2]);
    runs.push(...emphasise(m[1], { href: m[2].trim() }));
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push(...emphasise(text.slice(last)));
  return runs.length ? runs : [{ text }];
}

async function validateBlock(b) {
  if (!b || typeof b !== 'object') throw new AppError('CONTENT_INVALID', 'Each block must be an object.', 422);
  if (!BLOCK_TYPES.includes(b.type)) throw new AppError('CONTENT_INVALID', `Unknown block type "${b.type}".`, 422);
  const d = b.data || {};
  switch (b.type) {
    case 'HEADING':
      if (![2, 3].includes(Number(d.level))) throw new AppError('CONTENT_INVALID', 'HEADING.level must be 2 or 3.', 422);
      if (!str(d.text, 1, 160)) throw new AppError('CONTENT_INVALID', 'HEADING.text 1–160 chars.', 422);
      break;
    case 'PARAGRAPH':
      if (!str(d.text, 1, 4000)) throw new AppError('CONTENT_INVALID', 'PARAGRAPH.text 1–4000 chars.', 422);
      toRuns(d.text); // throws on an unsafe inline href
      break;
    case 'LIST':
      if (!Array.isArray(d.items) || d.items.length < 1 || d.items.length > 60) throw new AppError('CONTENT_INVALID', 'LIST.items 1–60 entries.', 422);
      for (const it of d.items) {
        if (!str(it, 1, 800)) throw new AppError('CONTENT_INVALID', 'Each LIST item 1–800 chars.', 422);
        toRuns(it);
      }
      break;
    case 'IMAGE': {
      if (!b.mediaId) throw new AppError('CONTENT_INVALID', 'IMAGE block needs a media asset.', 422);
      const [m] = await query("SELECT 1 FROM media WHERE id = ? AND status = 'ACTIVE' LIMIT 1", [b.mediaId]);
      if (!m) throw new AppError('MEDIA_NOT_FOUND', 'IMAGE block media asset not found.', 404);
      if (d.alt != null && !str(d.alt, 0, 200)) throw new AppError('CONTENT_INVALID', 'IMAGE.alt too long.', 422);
      if (d.caption != null && !str(d.caption, 0, 300)) throw new AppError('CONTENT_INVALID', 'IMAGE.caption too long.', 422);
      break;
    }
    case 'CONTACT':
      if (!Array.isArray(d.rows) || d.rows.length < 1 || d.rows.length > 30) throw new AppError('CONTENT_INVALID', 'CONTACT.rows 1–30 entries.', 422);
      for (const r of d.rows) {
        if (!str(r.label, 1, 60) || !str(r.value, 1, 200)) throw new AppError('CONTENT_INVALID', 'Each CONTACT row needs a label + value.', 422);
        if (r.href != null && r.href !== '') assertSafeHref(r.href);
      }
      break;
    case 'CALLOUT':
      if (!str(d.text, 1, 1000)) throw new AppError('CONTENT_INVALID', 'CALLOUT.text 1–1000 chars.', 422);
      if (d.tone != null && !['info', 'warn'].includes(d.tone)) throw new AppError('CONTENT_INVALID', 'CALLOUT.tone must be info|warn.', 422);
      break;
    case 'DIVIDER':
      break;
    default:
      throw new AppError('CONTENT_INVALID', `Unknown block type "${b.type}".`, 422);
  }
}

function resolveBlock(row, mediaUrl) {
  const type = row.block_type;
  const d = parseJson(row.data_json) || {};
  switch (type) {
    case 'HEADING': return { type, level: Number(d.level), text: d.text };
    case 'PARAGRAPH': return { type, runs: toRuns(d.text) };
    case 'LIST': return { type, ordered: Boolean(d.ordered), items: d.items.map((it) => toRuns(it)) };
    case 'IMAGE': return { type, url: row.media_id ? (mediaUrl.get(row.media_id) || null) : null, alt: d.alt || '', caption: d.caption || null };
    case 'CONTACT': return { type, rows: d.rows.map((r) => ({ label: r.label, value: r.value, href: r.href || null })) };
    case 'CALLOUT': return { type, text: d.text, tone: d.tone || 'info' };
    case 'DIVIDER': return { type };
    default: return { type };
  }
}

// ---- pages ------------------------------------------------------------

function pageScope(slug) {
  if (!SLUG_RE.test(slug || '')) throw new AppError('CONTENT_INVALID', `Invalid page slug "${slug}".`, 422);
  return { docType: 'CONTENT_PAGE', docKey: slug };
}

export async function listPages(brandId) {
  const rows = await query(
    `SELECT p.*, d.working_version, d.published_version, d.draft_dirty
     FROM content_pages p JOIN content_documents d ON d.id = p.document_id
     WHERE p.brand_id = ?
     ORDER BY p.title ASC`,
    [brandId],
  );
  return {
    pages: rows.map((p) => ({
      id: p.id, pageKey: p.page_key, slug: p.slug, title: p.title, navLabel: p.nav_label,
      status: p.status, workingVersion: p.working_version, publishedVersion: p.published_version,
      draftDirty: Boolean(p.draft_dirty), updatedAt: p.updated_at,
    })),
  };
}

async function pageRow(slug, brandId) {
  const rows = brandId
    ? await query('SELECT * FROM content_pages WHERE slug = ? AND brand_id = ? LIMIT 1', [slug, brandId])
    : await query('SELECT * FROM content_pages WHERE slug = ? LIMIT 1', [slug]);
  const p = rows[0];
  if (!p) throw new AppError('CONTENT_PAGE_NOT_FOUND', `No content page "${slug}".`, 404);
  return p;
}

export async function getPageDraft(slug, brandId) {
  const p = await pageRow(slug, brandId);
  const doc = await loadDocument('CONTENT_PAGE', slug, brandId);
  const blocks = await query('SELECT * FROM content_page_blocks WHERE page_id = ? ORDER BY position ASC', [p.id]);
  return {
    document: docMeta(doc),
    blockTypes: BLOCK_TYPES,
    page: {
      id: p.id, pageKey: p.page_key, slug: p.slug, title: p.title, navLabel: p.nav_label,
      seoTitle: p.seo_title, seoDescription: p.seo_description, status: p.status,
    },
    blocks: blocks.map((b) => ({ id: b.id, position: b.position, type: b.block_type, data: parseJson(b.data_json), mediaId: b.media_id })),
  };
}

export async function createPage(input, actor, brandId) {
  if (!KEY_RE.test(input.pageKey || '')) throw new AppError('CONTENT_INVALID', 'pageKey must be lower_snake_case.', 422);
  if (!SLUG_RE.test(input.slug || '')) throw new AppError('CONTENT_INVALID', 'slug must be kebab-case.', 422);
  if (!str(input.title, 1, 160)) throw new AppError('CONTENT_INVALID', 'title 1–160 chars.', 422);
  const [dupe] = await query('SELECT 1 FROM content_pages WHERE (page_key = ? OR slug = ?) AND brand_id = ? LIMIT 1', [input.pageKey, input.slug, brandId]);
  if (dupe) throw new AppError('CONTENT_INVALID', 'A page with that key or slug already exists.', 409);

  const id = await withTransaction(async (conn) => {
    const [docRows] = await conn.execute('SELECT id FROM content_documents WHERE doc_type = ? AND doc_key = ? AND brand_id = ? LIMIT 1', ['CONTENT_PAGE', input.slug, brandId]);
    let docId = docRows[0]?.id;
    if (!docId) {
      docId = randomUUID();
      await conn.execute(
        `INSERT INTO content_documents (id, brand_id, doc_type, doc_key, working_version, created_at, updated_at) VALUES (?, ?, 'CONTENT_PAGE', ?, 1, NOW(3), NOW(3))`,
        [docId, brandId, input.slug],
      );
    }
    const pageId = randomUUID();
    await conn.execute(
      `INSERT INTO content_pages (id, document_id, brand_id, page_key, slug, title, nav_label, seo_title, seo_description, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))`,
      [pageId, docId, brandId, input.pageKey, input.slug, input.title.trim(), input.navLabel ?? null, input.seoTitle ?? null, input.seoDescription ?? null],
    );
    await conn.execute('UPDATE content_documents SET draft_dirty = 1 WHERE id = ?', [docId]);
    return pageId;
  });
  await audit(actor, 'CONTENT_PAGE_CREATED', 'content_page', input.slug, { pageKey: input.pageKey });
  return getPageDraft(input.slug, brandId);
}

export async function updatePage(slug, patch, expectedVersion, actor, brandId) {
  const p = await pageRow(slug, brandId);
  const doc = await loadDocument('CONTENT_PAGE', slug, brandId);
  assertVersion(doc, expectedVersion);
  const fields = [];
  const vals = [];
  if (patch.title != null) { if (!str(patch.title, 1, 160)) throw new AppError('CONTENT_INVALID', 'title 1–160 chars.', 422); fields.push('title = ?'); vals.push(patch.title.trim()); }
  if (patch.navLabel !== undefined) { fields.push('nav_label = ?'); vals.push(patch.navLabel || null); }
  if (patch.seoTitle !== undefined) { fields.push('seo_title = ?'); vals.push(patch.seoTitle || null); }
  if (patch.seoDescription !== undefined) { fields.push('seo_description = ?'); vals.push(patch.seoDescription || null); }
  if (patch.status != null) { if (!['ACTIVE', 'ARCHIVED'].includes(patch.status)) throw new AppError('CONTENT_INVALID', 'status must be ACTIVE|ARCHIVED.', 422); fields.push('status = ?'); vals.push(patch.status); }
  if (!fields.length) return getPageDraft(slug, brandId);
  await withTransaction(async (conn) => {
    await conn.execute(`UPDATE content_pages SET ${fields.join(', ')}, updated_at = NOW(3) WHERE id = ?`, [...vals, p.id]);
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'CONTENT_PAGE_UPDATED', 'content_page', slug, { fields: fields.map((f) => f.split(' ')[0]) });
  return getPageDraft(slug, brandId);
}

export async function setPageBlocks(slug, blocks, expectedVersion, actor, brandId) {
  const p = await pageRow(slug, brandId);
  const doc = await loadDocument('CONTENT_PAGE', slug, brandId);
  assertVersion(doc, expectedVersion);
  if (!Array.isArray(blocks) || blocks.length > 200) throw new AppError('CONTENT_INVALID', 'blocks must be an array (≤200).', 422);
  for (const b of blocks) await validateBlock(b);

  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM content_page_blocks WHERE page_id = ?', [p.id]);
    for (let i = 0; i < blocks.length; i += 1) {
      const b = blocks[i];
      await conn.execute(
        `INSERT INTO content_page_blocks (id, page_id, position, block_type, data_json, media_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, NOW(3), NOW(3))`,
        [randomUUID(), p.id, i, b.type, JSON.stringify(b.data || {}), b.mediaId ?? null],
      );
    }
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'CONTENT_PAGE_UPDATED', 'content_page', slug, { blocks: blocks.length });
  return getPageDraft(slug, brandId);
}

async function buildPageSnapshot(slug, brandId = null) {
  const p = await pageRow(slug, brandId);
  const blocks = await query('SELECT * FROM content_page_blocks WHERE page_id = ? ORDER BY position ASC', [p.id]);
  const mediaIds = blocks.map((b) => b.media_id).filter(Boolean);
  const mediaUrl = new Map();
  if (mediaIds.length) {
    const rows = await query(`SELECT id, url FROM media WHERE id IN (${mediaIds.map(() => '?').join(',')})`, mediaIds);
    for (const m of rows) mediaUrl.set(m.id, m.url);
  }
  return {
    slug: p.slug,
    pageKey: p.page_key,
    title: p.title,
    navLabel: p.nav_label || null,
    seo: { title: p.seo_title || p.title, description: p.seo_description || null },
    blocks: blocks.map((b) => resolveBlock(b, mediaUrl)),
  };
}

async function restorePageDraft(conn, snapshot, doc) {
  const [pRows] = await conn.execute('SELECT id FROM content_pages WHERE document_id = ? LIMIT 1', [doc.id]);
  const pageId = pRows[0]?.id;
  if (!pageId) return;
  await conn.execute(
    'UPDATE content_pages SET title = ?, nav_label = ?, seo_title = ?, seo_description = ?, updated_at = NOW(3) WHERE id = ?',
    [snapshot.title, snapshot.navLabel || null, snapshot.seo?.title || null, snapshot.seo?.description || null, pageId],
  );
  await conn.execute('DELETE FROM content_page_blocks WHERE page_id = ?', [pageId]);
  const blocks = snapshot.blocks || [];
  for (let i = 0; i < blocks.length; i += 1) {
    const s = blocks[i];
    const data = deflateBlock(s);
    await conn.execute(
      `INSERT INTO content_page_blocks (id, page_id, position, block_type, data_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), NOW(3), NOW(3))`,
      [randomUUID(), pageId, i, s.type, JSON.stringify(data)],
    );
  }
}

// snapshot block DTO -> the draft data_json shape (rollback restore only)
function deflateBlock(s) {
  // The exact inverse of toRuns, so a rollback restores the text an editor
  // originally typed rather than a re-spelling of it.
  const emphasised = (r) => {
    if (r.bold) return `**${r.text}**`;
    if (r.italic) return `*${r.text}*`;
    return r.text;
  };
  const runsToText = (runs) => {
    const list = runs || [];
    const out = [];
    let i = 0;
    while (i < list.length) {
      const { href } = list[i];
      if (!href) { out.push(emphasised(list[i])); i += 1; continue; }
      // A link whose label contains emphasis parses into several runs that
      // all share one href. Re-emitting them one by one would turn a single
      // "[a **bold link**](/x)" into two adjacent links — same rendering,
      // but not what the editor wrote, and worse every time it round-trips.
      let label = '';
      while (i < list.length && list[i].href === href) { label += emphasised(list[i]); i += 1; }
      out.push(`[${label}](${href})`);
    }
    return out.join('');
  };
  switch (s.type) {
    case 'HEADING': return { level: s.level, text: s.text };
    case 'PARAGRAPH': return { text: runsToText(s.runs) };
    case 'LIST': return { ordered: Boolean(s.ordered), items: (s.items || []).map(runsToText) };
    case 'IMAGE': return { alt: s.alt || '', caption: s.caption || null };
    case 'CONTACT': return { rows: s.rows || [] };
    case 'CALLOUT': return { text: s.text, tone: s.tone || 'info' };
    default: return {};
  }
}

// ---- FAQ ------------------------------------------------------------

const answerToParas = (answer) => {
  if (Array.isArray(answer)) return answer;
  if (typeof answer === 'string') return answer.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  return [];
};

export async function getFaqDraft(brandId) {
  const doc = await loadDocument(FAQ.docType, FAQ.docKey, brandId);
  const rows = await query('SELECT * FROM content_faq_items WHERE document_id = ? ORDER BY position ASC', [doc.id]);
  return {
    document: docMeta(doc),
    items: rows.map((r) => ({
      id: r.id, itemKey: r.item_key, category: r.category, question: r.question,
      answer: parseJson(r.answer), position: r.position, status: r.status,
    })),
  };
}

export async function setFaqItems(items, expectedVersion, actor, brandId) {
  const doc = await loadDocument(FAQ.docType, FAQ.docKey, brandId);
  assertVersion(doc, expectedVersion);
  if (!Array.isArray(items) || items.length > 300) throw new AppError('CONTENT_INVALID', 'items must be an array (≤300).', 422);
  const seenKeys = new Set();
  const norm = items.map((it, i) => {
    const key = it.itemKey && KEY_RE.test(it.itemKey) ? it.itemKey : `faq_${i + 1}`;
    if (seenKeys.has(key)) throw new AppError('CONTENT_INVALID', `Duplicate FAQ key "${key}".`, 422);
    seenKeys.add(key);
    if (!str(it.question, 1, 300)) throw new AppError('CONTENT_INVALID', 'Each FAQ needs a question (1–300 chars).', 422);
    const paras = answerToParas(it.answer);
    if (!paras.length || paras.some((p) => !str(p, 1, 4000))) throw new AppError('CONTENT_INVALID', `FAQ "${it.question}" needs a non-empty answer.`, 422);
    paras.forEach((p) => toRuns(p));
    return { key, category: str(it.category, 1, 120) ? it.category.trim() : 'General', question: it.question.trim(), answer: paras };
  });

  await withTransaction(async (conn) => {
    await conn.execute('DELETE FROM content_faq_items WHERE document_id = ?', [doc.id]);
    for (let i = 0; i < norm.length; i += 1) {
      const n = norm[i];
      await conn.execute(
        `INSERT INTO content_faq_items (id, document_id, brand_id, item_key, category, question, answer, position, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, 'ACTIVE', NOW(3), NOW(3))`,
        [randomUUID(), doc.id, brandId, n.key, n.category, n.question, JSON.stringify(n.answer), i],
      );
    }
    await touchDraft(doc.id, conn);
  });
  await audit(actor, 'FAQ_UPDATED', 'content_faq', 'default', { items: norm.length });
  return getFaqDraft(brandId);
}

async function buildFaqSnapshot(brandId = null) {
  const doc = await loadDocument(FAQ.docType, FAQ.docKey, brandId);
  const rows = await query("SELECT * FROM content_faq_items WHERE document_id = ? AND status = 'ACTIVE' ORDER BY position ASC", [doc.id]);
  const cats = [];
  const byCat = new Map();
  for (const r of rows) {
    if (!byCat.has(r.category)) { byCat.set(r.category, []); cats.push(r.category); }
    byCat.get(r.category).push({ question: r.question, answer: parseJson(r.answer) });
  }
  return { categories: cats.map((c) => ({ title: c, items: byCat.get(c) })) };
}

async function restoreFaqDraft(conn, snapshot, doc, brandId) {
  await conn.execute('DELETE FROM content_faq_items WHERE document_id = ?', [doc.id]);
  let pos = 0;
  for (const cat of snapshot.categories || []) {
    for (const it of cat.items || []) {
      await conn.execute(
        `INSERT INTO content_faq_items (id, document_id, brand_id, item_key, category, question, answer, position, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, 'ACTIVE', NOW(3), NOW(3))`,
        [randomUUID(), doc.id, brandId || doc.brand_id, `faq_${pos + 1}`, cat.title, it.question, JSON.stringify(it.answer), pos],
      );
      pos += 1;
    }
  }
}

// ---- publish / history / rollback -----------------------------------

export async function publishPage(slug, expectedVersion, actor, brandId) {
  const { docType, docKey } = pageScope(slug);
  await pageRow(slug, brandId);
  const res = await publish({ docType, docKey, expectedVersion, staffId: actor?.id || null, brandId, buildSnapshot: () => buildPageSnapshot(slug, brandId), changeSummary: `Published page ${slug}` });
  await audit(actor, 'CONTENT_PAGE_PUBLISHED', 'content_page', slug, { version: res.version });
  return res;
}
export async function pageHistory(slug, brandId) {
  const { docType, docKey } = pageScope(slug);
  return listPublications(docType, docKey, brandId);
}
export async function rollbackPage(slug, targetPublicationId, actor, brandId) {
  const { docType, docKey } = pageScope(slug);
  const res = await rollback({ docType, docKey, targetPublicationId, staffId: actor?.id || null, brandId, restoreDraft: restorePageDraft });
  await audit(actor, 'CONTENT_PAGE_ROLLED_BACK', 'content_page', slug, res);
  return res;
}

export async function publishFaq(expectedVersion, actor, brandId) {
  const res = await publish({ ...FAQ, expectedVersion, staffId: actor?.id || null, brandId, buildSnapshot: () => buildFaqSnapshot(brandId), changeSummary: 'Published FAQ' });
  await audit(actor, 'FAQ_PUBLISHED', 'content_faq', 'default', { version: res.version });
  return res;
}
export function faqHistory(brandId) { return listPublications(FAQ.docType, FAQ.docKey, brandId); }
export async function rollbackFaq(targetPublicationId, actor, brandId) {
  const res = await rollback({ ...FAQ, targetPublicationId, staffId: actor?.id || null, brandId, restoreDraft: restoreFaqDraft });
  await audit(actor, 'FAQ_ROLLED_BACK', 'content_faq', 'default', res);
  return res;
}

// builders exposed for the idempotent seed (§115)
export const PAGE_SNAPSHOT_BUILDER = buildPageSnapshot;
export const FAQ_SNAPSHOT_BUILDER = buildFaqSnapshot;

// ---- public resolvers ---------------------------------------------

export async function resolvePage(slug) {
  if (!SLUG_RE.test(slug || '')) return null;
  const snap = await getPublishedSnapshot('CONTENT_PAGE', slug);
  if (!snap) return null;
  const [row] = await query("SELECT status FROM content_pages WHERE slug = ? LIMIT 1", [slug]);
  if (row && row.status === 'ARCHIVED') return null;
  return snap;
}

export async function resolveFaq() {
  const snap = await getPublishedSnapshot(FAQ.docType, FAQ.docKey);
  if (!snap) return { version: '0', categories: [] };
  return snap;
}

// Preview (Phase 7) — built from the draft blocks (ignores publish state,
// but still respects ARCHIVED so a hidden page stays hidden).
export async function resolvePagePreview(slug) {
  if (!SLUG_RE.test(slug || '')) return null;
  const [row] = await query('SELECT status FROM content_pages WHERE slug = ? LIMIT 1', [slug]);
  if (!row || row.status === 'ARCHIVED') return null;
  return { preview: true, ...(await buildPageSnapshot(slug)) };
}
export async function resolveFaqPreview() {
  return { version: 'preview', preview: true, ...(await buildFaqSnapshot()) };
}

export async function listPublishedPageSlugs() {
  const rows = await query(
    `SELECT p.slug, p.title, p.nav_label
     FROM content_pages p
     JOIN content_documents d ON d.id = p.document_id
     WHERE p.status = 'ACTIVE' AND d.published_publication_id IS NOT NULL
     ORDER BY p.title ASC`,
  );
  return rows.map((r) => ({ slug: r.slug, title: r.title, navLabel: r.nav_label || r.title }));
}
