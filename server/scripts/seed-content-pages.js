// Backfills the DEFAULT content pages + FAQ from
// database/seeds/content-pages.json into the content domain, then publishes
// v1 of each. Deterministic + idempotent (§115): the draft tables are
// rebuilt from the JSON every run; a page/FAQ is (re)published only when its
// resulting snapshot differs from what is currently live.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// this reference JSON is Cor-Cotton's default content.
//
//   npm run seed:content:pages
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { getPublishedSnapshot, publish } from '../src/modules/content/documentService.js';
import {
  PAGE_SNAPSHOT_BUILDER, FAQ_SNAPSHOT_BUILDER,
} from '../src/modules/content/pagesService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(__dirname, '..', 'database', 'seeds', 'content-pages.json');

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}
const stableJson = (v) => JSON.stringify(stable(v));

async function ensureDocument(docType, docKey, brandId) {
  const [row] = await query('SELECT id FROM content_documents WHERE doc_type = ? AND doc_key = ? AND brand_id = ? LIMIT 1', [docType, docKey, brandId]);
  if (row) return row.id;
  const id = randomUUID();
  await query(
    `INSERT INTO content_documents (id, brand_id, doc_type, doc_key, working_version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, NOW(3), NOW(3))`,
    [id, brandId, docType, docKey],
  );
  return id;
}

async function main() {
  const ref = JSON.parse(await readFile(REF, 'utf8'));
  const report = {};

  const [cotton] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  const brandId = cotton.id;

  // ---- content pages (draft) --------------------------------------
  for (const p of ref.pages) {
    const docId = await ensureDocument('CONTENT_PAGE', p.slug, brandId);
    const [existing] = await query('SELECT id FROM content_pages WHERE slug = ? AND brand_id = ? LIMIT 1', [p.slug, brandId]);
    const pageId = existing?.id || randomUUID();
    if (existing) {
      await query(
        'UPDATE content_pages SET document_id = ?, page_key = ?, title = ?, nav_label = ?, seo_title = ?, seo_description = ?, status = \'ACTIVE\', updated_at = NOW(3) WHERE id = ?',
        [docId, p.pageKey, p.title, p.navLabel ?? null, p.seoTitle ?? null, p.seoDescription ?? null, pageId],
      );
    } else {
      await query(
        `INSERT INTO content_pages (id, document_id, brand_id, page_key, slug, title, nav_label, seo_title, seo_description, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))`,
        [pageId, docId, brandId, p.pageKey, p.slug, p.title, p.navLabel ?? null, p.seoTitle ?? null, p.seoDescription ?? null],
      );
    }
    await query('DELETE FROM content_page_blocks WHERE page_id = ?', [pageId]);
    for (let i = 0; i < p.blocks.length; i += 1) {
      const b = p.blocks[i];
      await query(
        `INSERT INTO content_page_blocks (id, page_id, position, block_type, data_json, media_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, CAST(? AS JSON), ?, NOW(3), NOW(3))`,
        [randomUUID(), pageId, i, b.type, JSON.stringify(b.data || {}), b.mediaId ?? null],
      );
    }
  }

  // ---- FAQ (draft) ----------------------------------------------
  const faqDocId = await ensureDocument('FAQ', 'default', brandId);
  await query('DELETE FROM content_faq_items WHERE document_id = ?', [faqDocId]);
  const faqItems = ref.faq?.items || [];
  for (let i = 0; i < faqItems.length; i += 1) {
    const it = faqItems[i];
    const answer = Array.isArray(it.answer) ? it.answer : String(it.answer).split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    await query(
      `INSERT INTO content_faq_items (id, document_id, brand_id, item_key, category, question, answer, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, 'ACTIVE', NOW(3), NOW(3))`,
      [randomUUID(), faqDocId, brandId, it.itemKey || `faq_${i + 1}`, it.category || 'General', it.question, JSON.stringify(answer), i],
    );
  }

  // ---- publish if the snapshot changed --------------------------
  for (const p of ref.pages) {
    const current = await getPublishedSnapshot('CONTENT_PAGE', p.slug);
    const built = await PAGE_SNAPSHOT_BUILDER(p.slug, brandId);
    if (current) { const c = { ...current }; delete c.version; if (stableJson(c) === stableJson(built)) { report[p.slug] = `unchanged (v${current.version})`; continue; } }
    const res = await publish({ docType: 'CONTENT_PAGE', docKey: p.slug, expectedVersion: null, brandId, buildSnapshot: () => built, changeSummary: current ? 'Re-seeded default page' : 'Seeded default page' });
    report[p.slug] = `published v${res.version}`;
  }
  {
    const current = await getPublishedSnapshot('FAQ', 'default');
    const built = await FAQ_SNAPSHOT_BUILDER(brandId);
    if (current) { const c = { ...current }; delete c.version; if (stableJson(c) === stableJson(built)) { report.faq = `unchanged (v${current.version})`; } else { const res = await publish({ docType: 'FAQ', docKey: 'default', expectedVersion: null, brandId, buildSnapshot: () => built, changeSummary: 'Re-seeded FAQ' }); report.faq = `published v${res.version}`; } }
    else { const res = await publish({ docType: 'FAQ', docKey: 'default', expectedVersion: null, brandId, buildSnapshot: () => built, changeSummary: 'Seeded FAQ' }); report.faq = `published v${res.version}`; }
  }

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
