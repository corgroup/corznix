// Single source of truth for website links.
//
// A link to a category / collection / content page is a reference, so the
// entity's current name, URL and status show everywhere it is used:
//   1. rename a sub-category   -> desktop dropdown, mobile submenu, cards
//   2. rename a top category   -> header bar, "All <name>", footer
//   3. change a URL (slug)     -> every link follows; old URL still resolves
//   4. archive                 -> hidden everywhere; restore brings it back
//   5. rename a content page   -> footer + mobile menu links
//   6. unknown app pages (/pages/faqs) are left alone
//   7. homepage product section follows its collection (archived -> hidden)
//  7b. homepage section button follows its page (new URL followed; switched
//      off -> button dropped, section kept; listed as a reference)
//   8. delete: references listed, refused until confirmed, then links gone
//
// Real HTTP (public header/homepage + admin references) against a throwaway
// listener; every change is reverted and the default content re-seeded.
//
//   npm run verify:content:entity-links
import assert from 'node:assert/strict';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';

const { createApp } = await import('../src/app.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { cmsAllowedOrigins } = await import('../src/config/index.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { categoryService } = await import('../src/modules/adminCatalog/categoryService.js');
const { collectionService } = await import('../src/modules/adminCatalog/collectionService.js');
const homeSvc = await import('../src/modules/content/homepageService.js');
const { findEntityReferences } = await import('../src/modules/content/entityLinks.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };
const TAG = `elink-${Date.now()}`;
const PW = 'Corcotton-EntityLinks-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const actor = { id: null, email: `qa.${TAG}@entity-links.test` };

let server; let BASE; let brandId;
const snapshot = {};
let tempCategoryId = null;

const header = async () => (await (await fetch(`${BASE}/api/v1/content/header`)).json()).data;
const homepage = async () => (await (await fetch(`${BASE}/api/v1/content/homepage`)).json()).data;
const everywhere = (h, menuKey) => {
  const m = h.megaMenus[menuKey];
  return { desktop: m.categoryNav.items, mobile: m.mobileLinks, cards: m.shopCards || [] };
};

try {
  [{ id: brandId }] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  for (const slug of ['polos', 'tops']) [snapshot[slug]] = await query('SELECT id, name, slug, status FROM categories WHERE slug = ? LIMIT 1', [slug]);
  [snapshot.bestsellers] = await query("SELECT id, name, slug, status FROM collections WHERE slug = 'bestsellers' LIMIT 1");
  [snapshot.shipping] = await query("SELECT id, title FROM content_pages WHERE slug = 'shipping' LIMIT 1");
  [snapshot.story] = await query("SELECT id, slug, status FROM content_pages WHERE slug = 'our-story' LIMIT 1");
  assert.ok(snapshot.polos && snapshot.tops && snapshot.bestsellers && snapshot.shipping && snapshot.story, 'fixture entities exist');
  // Every step below renames, re-URLs or archives a LIVE header link. A store
  // that had archived Polos (or Tops) failed step 1 with "renamed in desktop"
  // — no link to rename — so the fixtures start active whatever state the data
  // was in, and the finally block puts the recorded status back.
  await query("UPDATE categories SET status = 'ACTIVE' WHERE id IN (?, ?)", [snapshot.polos.id, snapshot.tops.id]);

  await staffAuthService.createStaffUser({ email: `admin.${TAG}@entity-links.test`, password: PW, firstName: 'QA', lastName: 'Links', role: 'ADMIN' });
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: `admin.${TAG}@entity-links.test`, password: PW }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

  // ---- 1. rename a sub-category ------------------------------------------------
  {
    await categoryService.update(snapshot.polos.id, { name: 'Polo Tees QA' }, actor, brandId);
    const e = everywhere(await header(), 'mega_tops');
    for (const [where, list] of Object.entries(e)) {
      assert.ok(list.some((l) => l.label === 'Polo Tees QA' && l.path === '/collections/polos'), `renamed in ${where}`);
      assert.ok(!list.some((l) => l.label === 'Polos' || l.label === snapshot.polos.name), `old name gone from ${where}`);
    }
    await categoryService.update(snapshot.polos.id, { name: snapshot.polos.name }, actor, brandId);
    pass('RENAME_SUBCATEGORY_EVERYWHERE');
  }

  // ---- 2. rename a top-level category -------------------------------------------
  {
    await categoryService.update(snapshot.tops.id, { name: 'Tops QA' }, actor, brandId);
    const h = await header();
    assert.equal(h.navigation.find((n) => n.id === 'nav_tops').label, 'Tops QA', 'header bar item');
    assert.ok(h.footer.shop.some((l) => l.label === 'Tops QA'), 'footer shop link');
    assert.ok(h.megaMenus.mega_tops.categoryNav.items.some((l) => l.isViewAll && l.label === 'All Tops QA'), '"All <name>" view-all link');
    // One menu: mobile submenu + cards are the dropdown's own links, same labels.
    const tops = h.megaMenus.mega_tops;
    assert.deepEqual(tops.mobileLinks.map((l) => l.label), tops.categoryNav.items.map((l) => l.label), 'mobile submenu == dropdown links');
    assert.deepEqual(tops.shopCards.map((l) => l.label), tops.categoryNav.items.filter((l) => !l.isViewAll).map((l) => l.label), 'cards == dropdown links (minus view all)');
    await categoryService.update(snapshot.tops.id, { name: snapshot.tops.name }, actor, brandId);
    pass('RENAME_TOP_CATEGORY_HEADER_FOOTER');
  }

  // ---- 3. change the URL ------------------------------------------------------------
  {
    await categoryService.update(snapshot.polos.id, { slug: 'polo-tees-qa' }, actor, brandId);
    const e = everywhere(await header(), 'mega_tops');
    for (const [where, list] of Object.entries(e)) {
      assert.ok(list.some((l) => l.path === '/collections/polo-tees-qa' && l.label === snapshot.polos.name), `${where} follows the new URL`);
      assert.ok(!list.some((l) => l.path === '/collections/polos'), `${where} has no stale URL`);
    }
    await categoryService.update(snapshot.polos.id, { slug: 'polos' }, actor, brandId);
    const back = everywhere(await header(), 'mega_tops');
    assert.ok(back.desktop.some((l) => l.path === '/collections/polos'), 'URL restored');
    pass('URL_CHANGE_FOLLOWED_EVERYWHERE');
  }

  // ---- 4. archive ------------------------------------------------------------------
  {
    await categoryService.setStatus(snapshot.polos.id, 'ARCHIVED', actor, brandId);
    const e = everywhere(await header(), 'mega_tops');
    for (const [where, list] of Object.entries(e)) assert.ok(!list.some((l) => l.path === '/collections/polos'), `hidden in ${where}`);
    await categoryService.setStatus(snapshot.polos.id, 'ACTIVE', actor, brandId);
    assert.ok(everywhere(await header(), 'mega_tops').mobile.some((l) => l.path === '/collections/polos'), 'shown again after restore');
    pass('ARCHIVE_HIDES_EVERYWHERE');
  }

  // ---- 5. rename a content page ------------------------------------------------------
  {
    await query("UPDATE content_pages SET title = 'Shipping QA' WHERE id = ?", [snapshot.shipping.id]);
    const h = await header();
    assert.ok(h.footer.help.some((l) => l.path === '/pages/shipping' && l.label === 'Shipping QA'), 'footer help link');
    assert.ok(h.mobileMenu.links.some((l) => l.path === '/pages/shipping' && l.label === 'Shipping QA'), 'mobile menu link');
    await query('UPDATE content_pages SET title = ? WHERE id = ?', [snapshot.shipping.title, snapshot.shipping.id]);
    pass('RENAME_PAGE_FOOTER_MOBILE');
  }

  // ---- 6. app routes that are not entities are untouched ------------------------------------
  {
    const h = await header();
    assert.ok(h.footer.help.some((l) => l.path === '/pages/faqs'), 'FAQs link stays');
    assert.ok(h.footer.help.some((l) => l.path === '/track-order'), 'custom route stays');
    pass('CUSTOM_LINKS_UNTOUCHED');
  }

  // ---- 7. homepage product section follows its collection ------------------------------------
  {
    const before = await homepage();
    assert.ok(before.sections.some((s) => s.key === 'best_sellers'), 'bestsellers section shown');
    await collectionService.setStatus(snapshot.bestsellers.id, 'ARCHIVED', actor, brandId);
    assert.ok(!(await homepage()).sections.some((s) => s.key === 'best_sellers'), 'hidden while its collection is archived');
    await collectionService.setStatus(snapshot.bestsellers.id, snapshot.bestsellers.status, actor, brandId);
    assert.ok((await homepage()).sections.some((s) => s.key === 'best_sellers'), 'back after restore');
    pass('HOMEPAGE_SECTION_FOLLOWS_COLLECTION');
  }

  // ---- 7b. a homepage section button follows its page ------------------------------------------
  {
    const story = async () => (await homepage()).sections.find((s) => s.key === 'brand_banner');
    assert.equal((await story()).config.ctaPath, '/pages/our-story', 'story button opens Our Story');

    await query("UPDATE content_pages SET slug = 'our-story-qa' WHERE id = ?", [snapshot.story.id]);
    await query("INSERT IGNORE INTO content_entity_slug_history (entity_type, entity_id, slug, brand_id) VALUES ('PAGE', ?, 'our-story', ?)", [snapshot.story.id, brandId]);
    assert.equal((await story()).config.ctaPath, '/pages/our-story-qa', 'the button follows the page to its new address');

    await query("UPDATE content_pages SET status = 'ARCHIVED' WHERE id = ?", [snapshot.story.id]);
    const off = await story();
    assert.ok(off, 'the section stays when its page is switched off');
    assert.ok(!('ctaPath' in off.config) && !('ctaLabel' in off.config), 'only its button is dropped');
    assert.equal(off.config.heading, 'Built on Purpose', 'the copy stays');

    const usage = await findEntityReferences('PAGE', snapshot.story.id, brandId);
    assert.ok(usage.references.some((r) => r.area === 'Homepage' && /button/.test(r.where)), 'the page lists the homepage button among its references');

    await query('UPDATE content_pages SET slug = ?, status = ? WHERE id = ?', [snapshot.story.slug, snapshot.story.status, snapshot.story.id]);
    await query("DELETE FROM content_entity_slug_history WHERE entity_type = 'PAGE' AND entity_id = ? AND slug IN ('our-story', 'our-story-qa')", [snapshot.story.id]);
    assert.equal((await story()).config.ctaPath, '/pages/our-story', 'restored');
    pass('HOMEPAGE_BUTTON_FOLLOWS_PAGE');
  }

  // ---- 8. delete with dependency awareness ------------------------------------------------------
  {
    const created = await categoryService.create({ name: 'QA Entity Temp', slug: `qa-entity-temp-${Date.now()}`, parentId: snapshot.tops.id, status: 'ACTIVE' }, actor, brandId);
    tempCategoryId = created.id;
    const tempSlug = created.slug;
    assert.equal((await findEntityReferences('CATEGORY', tempCategoryId, brandId)).references.length, 0, 'unused at first');

    const footer = await homeSvc.getFooterDraft(brandId);
    const shop = footer.groups.find((g) => g.groupKey === 'shop');
    const links = shop.links.map((l) => ({ label: l.label, linkType: l.linkType, linkTarget: l.linkTarget, externalUrl: l.externalUrl, linkRefType: l.linkRefType, linkRefId: l.linkRefId }));
    links.push({ label: 'Temp', linkRefType: 'CATEGORY', linkRefId: tempCategoryId });
    const saved = await homeSvc.setFooterGroupLinks('shop', links, footer.document.workingVersion, actor, brandId);
    await homeSvc.publishScope('footer', saved.document.workingVersion, actor, brandId);
    assert.ok((await header()).footer.shop.some((l) => l.path === `/collections/${tempSlug}` && l.label === 'QA Entity Temp'), 'footer shows the entity name, not the typed label');

    const api = await fetch(`${BASE}/api/v1/admin/content/references?type=CATEGORY&id=${tempCategoryId}`, { headers: { origin: ORIGIN, cookie } });
    assert.equal(api.status, 200);
    const usage = (await api.json()).data;
    const refs = usage.references;
    assert.ok(refs.some((r) => r.area === 'Footer' && r.label === 'QA Entity Temp'), 'references list the footer link by the entity\'s own name');
    assert.deepEqual(usage.blockers, [], 'an empty category has no delete blockers');
    const polosUsage = await findEntityReferences('CATEGORY', snapshot.polos.id, brandId);
    assert.ok(polosUsage.references.some((r) => r.label === snapshot.polos.name), 'dropdown reference shows the live name, not the typed copy');
    // Blockers count PRODUCTS: one linked both ways (mapping row + primary column) is still one.
    const [{ n: distinctProducts }] = await query(
      `SELECT COUNT(*) AS n FROM (SELECT product_id AS pid FROM product_categories WHERE category_id = ?
         UNION SELECT id AS pid FROM products WHERE category_id = ? AND brand_id = ?) linked`,
      [snapshot.polos.id, snapshot.polos.id, brandId]);
    const productBlocker = polosUsage.blockers.find((b) => /assigned to/.test(b));
    if (Number(distinctProducts) > 0) {
      assert.equal(productBlocker, `It is still assigned to ${Number(distinctProducts)} product${Number(distinctProducts) === 1 ? '' : 's'}.`, 'blocker counts distinct products');
    } else {
      assert.equal(productBlocker, undefined, 'no product blocker when nothing is assigned');
    }

    await assert.rejects(
      () => categoryService.remove(tempCategoryId, actor, brandId),
      (err) => err.code === 'ENTITY_REFERENCED' && err.status === 409 && err.details.references.length >= 1,
      'delete refused while referenced',
    );
    const refused = await fetch(`${BASE}/api/v1/admin/catalog/categories/${tempCategoryId}`, { method: 'DELETE', headers: { origin: ORIGIN, cookie } });
    assert.equal(refused.status, 409, 'HTTP delete refused without confirmation');

    const confirmed = await fetch(`${BASE}/api/v1/admin/catalog/categories/${tempCategoryId}?confirmReferences=true`, { method: 'DELETE', headers: { origin: ORIGIN, cookie } });
    assert.equal(confirmed.status, 200, 'confirmed delete succeeds');
    tempCategoryId = null;
    assert.ok(!(await header()).footer.shop.some((l) => l.path === `/collections/${tempSlug}`), 'deleted entity\'s links are gone');
    pass('DELETE_WITH_DEPENDENCY_AWARENESS');
  }

  console.log('\nCONTENT_ENTITY_LINKS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_ENTITY_LINKS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  try {
    if (snapshot.polos) await query('UPDATE categories SET name = ?, slug = ?, status = ? WHERE id = ?', [snapshot.polos.name, snapshot.polos.slug, snapshot.polos.status, snapshot.polos.id]);
    if (snapshot.tops) await query('UPDATE categories SET name = ?, status = ? WHERE id = ?', [snapshot.tops.name, snapshot.tops.status, snapshot.tops.id]);
    if (snapshot.bestsellers) await query('UPDATE collections SET status = ? WHERE id = ?', [snapshot.bestsellers.status, snapshot.bestsellers.id]);
    if (snapshot.shipping) await query('UPDATE content_pages SET title = ? WHERE id = ?', [snapshot.shipping.title, snapshot.shipping.id]);
    if (snapshot.story) {
      await query('UPDATE content_pages SET slug = ?, status = ? WHERE id = ?', [snapshot.story.slug, snapshot.story.status, snapshot.story.id]);
      await query("DELETE FROM content_entity_slug_history WHERE entity_type = 'PAGE' AND entity_id = ? AND slug IN ('our-story', 'our-story-qa')", [snapshot.story.id]);
    }
    if (tempCategoryId) await query('DELETE FROM categories WHERE id = ?', [tempCategoryId]);
    if (snapshot.polos) await query('DELETE FROM content_entity_slug_history WHERE entity_id = ?', [snapshot.polos.id]);
    await query("DELETE FROM content_entity_slug_history WHERE slug LIKE 'qa-entity-temp-%'");
    server?.close();
    execSync('node scripts/seed-content.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
    await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@entity-links.test'");
    await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@entity-links.test')");
    await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@entity-links.test'");
  } catch (cleanupErr) {
    console.error('cleanup failed:', cleanupErr.message);
    process.exitCode = 1;
  }
  await pool.end();
}
