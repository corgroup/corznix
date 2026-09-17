// Backfills the DEFAULT storefront chrome (navigation, mega menus,
// announcements) from database/seeds/content-default.json into the content
// domain, then publishes v1 of each scope. Deterministic + idempotent
// (§115): the draft tables are rebuilt from the JSON every run; a scope is
// (re)published only when its resulting snapshot differs from what is
// currently live.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// this reference JSON is CORCOTTON's default content — every row seeded
// here is scoped to the Cor-Cotton brand. Cor-Znix gets none of this
// (decision 4 — starts empty; its own default content is Phase 7's job).
//
//   npm run seed:content
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { getOrCreateDocument, getPublishedSnapshot, publish } from '../src/modules/content/documentService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF = path.join(__dirname, '..', 'database', 'seeds', 'content-default.json');

// MySQL JSON columns normalize object key order, so snapshot comparison
// must be key-order-independent.
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}
const stableJson = (v) => JSON.stringify(stable(v));

const linkFromPath = (route) => {
  if (!route) return { linkType: 'CUSTOM_INTERNAL', target: '/', externalUrl: null };
  if (/^https?:\/\//i.test(route)) return { linkType: 'EXTERNAL', target: null, externalUrl: route };
  const c = route.match(/^\/collections\/([^/?]+)/);
  if (c) return { linkType: 'COLLECTION', target: c[1], externalUrl: null };
  const p = route.match(/^\/pages\/([^/?]+)/);
  if (p) return { linkType: 'CONTENT_PAGE', target: p[1], externalUrl: null };
  return { linkType: 'CUSTOM_INTERNAL', target: route, externalUrl: null };
};

async function main() {
  const ref = JSON.parse(await readFile(REF, 'utf8'));
  const report = {};

  const [cotton] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  if (!cotton) throw new Error('corcotton brand row not found — run migrations first.');
  const brandId = cotton.id;

  // ---- mega menus (draft) ------------------------------------------
  const megaDoc = await getOrCreateDocument('MEGA_MENUS', 'default', null, brandId);
  await query('DELETE FROM content_mega_menus WHERE brand_id = ?', [brandId]);
  for (const m of ref.megaMenus) {
    const { key, ...payload } = m;
    await query(
      `INSERT INTO content_mega_menus (id, brand_id, menu_key, name, payload_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, CAST(? AS JSON), 'ACTIVE', NOW(3), NOW(3))`,
      [randomUUID(), brandId, key, payload.featured.heading, JSON.stringify(payload)],
    );
  }

  // ---- navigation (draft) -----------------------------------------
  const navDoc = await getOrCreateDocument('NAVIGATION', 'primary', null, brandId);
  await query('DELETE FROM content_nav_items WHERE document_id = ?', [navDoc.id]);
  for (const it of ref.navigation.items) {
    await query(
      `INSERT INTO content_nav_items (id, document_id, brand_id, item_key, label, link_type, link_target, external_url, mega_menu_key, icon, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))`,
      [randomUUID(), navDoc.id, brandId, it.key, it.label, it.linkType, it.target ?? null, null, it.megaMenuKey ?? null, it.icon ?? null, it.position],
    );
  }
  await query(
    `INSERT INTO content_nav_settings (document_id, brand_id, settings_json) VALUES (?, ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)`,
    [navDoc.id, brandId, JSON.stringify(ref.navigation.mobileMenu)],
  );

  // ---- announcements (draft) ------------------------------------
  const annDoc = await getOrCreateDocument('ANNOUNCEMENTS', 'default', null, brandId);
  await query('DELETE FROM content_announcements WHERE brand_id = ?', [brandId]);
  for (let i = 0; i < ref.announcements.slides.length; i += 1) {
    const s = ref.announcements.slides[i];
    const link = s.link ? linkFromPath(s.link) : { linkType: null, target: null, externalUrl: null };
    await query(
      `INSERT INTO content_announcements (id, brand_id, announcement_key, text, link_type, link_target, external_url, starts_at, expires_at, position, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))`,
      [randomUUID(), brandId, s.key, s.text, link.linkType, link.target, link.externalUrl,
        s.startsAt ? s.startsAt.replace('T', ' ') : null, s.expiresAt ? s.expiresAt.replace('T', ' ') : null, i],
    );
  }
  await query(
    `INSERT INTO content_announcement_settings (document_id, brand_id, settings_json) VALUES (?, ?, CAST(? AS JSON))
     ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json)`,
    [annDoc.id, brandId, JSON.stringify({ ...ref.announcements.settings, dismissVersion: ref.announcements.dismissVersion })],
  );

  // ---- homepage sections (draft) -------------------------------
  const homeDoc = await getOrCreateDocument('HOMEPAGE', 'home', null, brandId);
  await query('DELETE FROM content_home_sections WHERE document_id = ?', [homeDoc.id]);
  for (let i = 0; i < ref.homepage.sections.length; i += 1) {
    const s = ref.homepage.sections[i];
    await query(
      `INSERT INTO content_home_sections (id, document_id, brand_id, section_key, section_type, position, enabled, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), NOW(3), NOW(3))`,
      [randomUUID(), homeDoc.id, brandId, s.key, s.type, s.position, s.enabled ? 1 : 0, JSON.stringify(s.config || {})],
    );
  }

  // ---- footer (draft) ----------------------------------------
  const footerDoc = await getOrCreateDocument('FOOTER', 'main', null, brandId);
  await query('DELETE FROM content_footer_links WHERE group_id IN (SELECT id FROM content_footer_groups WHERE document_id = ?)', [footerDoc.id]);
  await query('DELETE FROM content_footer_groups WHERE document_id = ?', [footerDoc.id]);
  const groupKeys = Object.keys(ref.footer.groups);
  for (let gi = 0; gi < groupKeys.length; gi += 1) {
    const gk = groupKeys[gi];
    const gid = randomUUID();
    await query(
      `INSERT INTO content_footer_groups (id, document_id, brand_id, group_key, label, position, status) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [gid, footerDoc.id, brandId, gk, gk[0].toUpperCase() + gk.slice(1), gi],
    );
    const links = ref.footer.groups[gk];
    for (let li = 0; li < links.length; li += 1) {
      const l = links[li];
      const link = linkFromPath(l.path);
      await query(
        `INSERT INTO content_footer_links (id, group_id, label, link_type, link_target, external_url, position, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
        [randomUUID(), gid, l.label, link.linkType, link.target, link.externalUrl, li],
      );
    }
  }
  await query(
    `INSERT INTO content_footer_meta (document_id, meta_json, updated_at) VALUES (?, CAST(? AS JSON), NOW(3))
     ON DUPLICATE KEY UPDATE meta_json = VALUES(meta_json), updated_at = NOW(3)`,
    [footerDoc.id, JSON.stringify({ contact: ref.footer.contact, socials: ref.footer.socials })],
  );

  // ---- entity references (single source of truth) ------------------
  // Links to categories / collections / pages are stored as references, so
  // the website shows the entity's live name and URL (see entityLinks.js).
  for (const [table, scope] of [['content_nav_items', 'i.brand_id'], ['content_footer_links', '(SELECT g.brand_id FROM content_footer_groups g WHERE g.id = i.group_id)']]) {
    for (const [refType, source, linkTypes] of [
      ['COLLECTION', 'collections', "('COLLECTION','CATEGORY')"],
      ['CATEGORY', 'categories', "('COLLECTION','CATEGORY')"],
      ['PAGE', 'content_pages', "('CONTENT_PAGE')"],
    ]) {
      await query(
        `UPDATE ${table} i JOIN ${source} e ON e.slug COLLATE utf8mb4_unicode_ci = i.link_target COLLATE utf8mb4_unicode_ci
           AND e.brand_id COLLATE utf8mb4_unicode_ci = ${scope} COLLATE utf8mb4_unicode_ci
         SET i.link_ref_type = ?, i.link_ref_id = e.id
         WHERE i.link_type IN ${linkTypes} AND i.link_ref_id IS NULL`,
        [refType],
      );
    }
  }

  // ---- publish v1 of each scope if the snapshot changed --------
  const nav = await import('../src/modules/content/navigationService.js');
  const home = await import('../src/modules/content/homepageService.js');
  const builders = { ...nav.SNAPSHOT_BUILDERS, ...home.HOMEPAGE_FOOTER_BUILDERS };
  const scopes = [
    ['NAVIGATION', 'primary', 'navigation'],
    ['MEGA_MENUS', 'default', 'mega-menus'],
    ['ANNOUNCEMENTS', 'default', 'announcements'],
    ['HOMEPAGE', 'home', 'homepage'],
    ['FOOTER', 'main', 'footer'],
  ];
  for (const [docType, docKey, scopeName] of scopes) {
    const current = await getPublishedSnapshot(docType, docKey);
    const built = await builders[scopeName](brandId);
    if (current) {
      const c = { ...current }; delete c.version;
      if (stableJson(c) === stableJson(built)) {
        // The draft was just re-seeded to exactly what is live, so nothing is
        // waiting to be published. Without this the CMS kept saying "saved
        // draft — not published" for content identical to the website.
        await query('UPDATE content_documents SET draft_dirty = 0 WHERE doc_type = ? AND doc_key = ? AND brand_id <=> ?', [docType, docKey, brandId]);
        report[scopeName] = `unchanged (v${current.version})`;
        continue;
      }
    }
    const res = await publish({
      docType, docKey, expectedVersion: null, brandId,
      buildSnapshot: () => built,
      changeSummary: current ? 'Re-seeded default content' : 'Seeded default content',
    });
    report[scopeName] = `published v${res.version}`;
  }

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
