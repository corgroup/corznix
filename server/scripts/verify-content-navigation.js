// Navigation + Mega Menu + Announcement CMS (Wave 8E, Phase 3).
//
// Proves: RBAC (read/write/publish split), draft edit + optimistic
// concurrency (CONTENT_VERSION_CONFLICT), reorder determinism, link safety
// (external javascript: rejected, internal dead slug rejected), publish gated
// on content.publish, history + rollback, and the public
// GET /api/v1/content/header reflecting only PUBLISHED content and matching
// the seeded DEFAULT exactly.
//
// Real HTTP listener + staff sessions. Publishes throwaway drafts then rolls
// the scope back to the seeded default so the storefront DEFAULT is restored.
//
//   npm run verify:content:navigation
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';

let externalCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) externalCalls += 1;
  return realFetch(input, init);
};

const { createApp } = await import('../src/app.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { cmsAllowedOrigins } = await import('../src/config/index.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF = JSON.parse(await readFile(path.join(__dirname, '..', 'database', 'seeds', 'content-default.json'), 'utf8'));

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `cnav-${Date.now()}`;
const PW = 'Corcotton-ContentNav-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (r) => `${r.toLowerCase()}.${TAG}@content-nav.test`;

let server, BASE;

async function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function loginCookie(role) {
  const res = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: email(role), password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
const navVersion = async (c) => (await call('/api/v1/admin/content/navigation', { cookie: c })).json.data.document.workingVersion;

async function reseed() {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/seed-content.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
}

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  await reseed(); // restore the storefront DEFAULT (rolls forward to the seeded snapshot)
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@content-nav.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@content-nav.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-nav.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-nav.test'");
  for (const role of ['ADMIN', 'CATALOG_MANAGER', 'VIEWER']) {
    await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const admin = await loginCookie('ADMIN');
  const cm = await loginCookie('CATALOG_MANAGER');
  const viewer = await loginCookie('VIEWER');

  // ---- 1. RBAC -----------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/content/navigation')).status, 401);
    assert.equal((await call('/api/v1/admin/content/navigation', { cookie: viewer })).status, 200, 'VIEWER reads');
    assert.equal((await call('/api/v1/admin/content/navigation', { cookie: cm })).status, 200, 'CATALOG_MANAGER reads');

    const v = await navVersion(cm);
    const cmEdit = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: cm, body: { label: 'X', linkType: 'HOME', expectedVersion: v },
    });
    assert.equal(cmEdit.status, 200, 'CATALOG_MANAGER can draft-edit (content.write)');

    const cmPub = await call('/api/v1/admin/content/navigation/publish', { method: 'POST', cookie: cm, body: {} });
    assert.equal(cmPub.status, 403, 'CATALOG_MANAGER cannot publish (needs content.publish)');
    assert.equal(cmPub.json.error.code, 'PERMISSION_DENIED');

    const viewerEdit = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: viewer, body: { label: 'X', linkType: 'HOME', expectedVersion: 1 },
    });
    assert.equal(viewerEdit.status, 403, 'VIEWER cannot edit');
    pass('CONTENT_NAV_RBAC');
  }

  // ---- 2. optimistic concurrency --------------------------------
  {
    const v = await navVersion(admin);
    const first = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: admin, body: { label: `Draft ${TAG}`, linkType: 'CUSTOM_INTERNAL', linkTarget: '/x', expectedVersion: v },
    });
    assert.equal(first.status, 200);
    // a second edit at the SAME (now stale) version is rejected
    const stale = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: admin, body: { label: 'Y', linkType: 'HOME', expectedVersion: v },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'CONTENT_VERSION_CONFLICT');
    pass('CONTENT_OPTIMISTIC_CONCURRENCY');
  }

  // ---- 3. link safety ------------------------------------------
  {
    let v = await navVersion(admin);
    const badExt = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: admin, body: { label: 'Evil', linkType: 'EXTERNAL', externalUrl: 'javascript:alert(1)', expectedVersion: v },
    });
    assert.equal(badExt.status, 422);
    assert.equal(badExt.json.error.code, 'CONTENT_LINK_INVALID');

    v = await navVersion(admin);
    const deadSlug = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: admin, body: { label: 'Ghost', linkType: 'COLLECTION', linkTarget: 'no-such-collection-xyz', expectedVersion: v },
    });
    assert.equal(deadSlug.status, 422);
    assert.equal(deadSlug.json.error.code, 'CONTENT_LINK_INVALID');

    v = await navVersion(admin);
    const goodExt = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: admin, body: { label: 'Blog', linkType: 'EXTERNAL', externalUrl: 'https://example.com', expectedVersion: v },
    });
    assert.equal(goodExt.status, 200);
    pass('CONTENT_LINK_SAFETY');
  }

  // ---- 4. reorder determinism --------------------------------
  {
    const draft = (await call('/api/v1/admin/content/navigation', { cookie: admin })).json.data;
    const topIds = draft.items.map((i) => i.id);
    const v = draft.document.workingVersion;
    const reordered = [...topIds].reverse();
    const r = await call('/api/v1/admin/content/navigation/reorder', {
      method: 'POST', cookie: admin, body: { orderedIds: reordered, expectedVersion: v },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.items.map((i) => i.id), reordered, 'reorder reflected');
    const dbDup = await query(
      "SELECT position, COUNT(*) c FROM content_nav_items WHERE parent_id IS NULL GROUP BY position HAVING c > 1",
    );
    assert.equal(dbDup.length, 0, 'no duplicate top-level positions');
    pass('CONTENT_NAV_REORDER');
  }

  // ---- 5. mega menu + announcement edit --------------------
  {
    let v = (await call('/api/v1/admin/content/mega-menus', { cookie: admin })).json.data.document.workingVersion;
    const mm = await call('/api/v1/admin/content/mega-menus', {
      method: 'PUT', cookie: admin,
      body: {
        menuKey: 'mega_tops', name: 'Tops', expectedVersion: v,
        payload: {
          featured: { heading: 'TOPS EDITED', tagline: 'x', ctaLabel: 'GO', ctaPath: '/collections/tops', background: 'linear-gradient(#000,#111)' },
          categoryNav: { icon: 'shirt', items: [{ label: 'All', desc: 'v', path: '/collections/tops', isViewAll: true }] },
          mobileLinks: [{ label: 'All Tops', path: '/collections/tops' }],
        },
      },
    });
    assert.equal(mm.status, 200);
    // arbitrary css in background is rejected
    v = (await call('/api/v1/admin/content/mega-menus', { cookie: admin })).json.data.document.workingVersion;
    const evilBg = await call('/api/v1/admin/content/mega-menus', {
      method: 'PUT', cookie: admin,
      body: { menuKey: 'mega_tops', name: 'Tops', expectedVersion: v, payload: {
        featured: { heading: 'X', ctaPath: '/x', background: 'url(javascript:alert(1))' },
        categoryNav: { icon: 'shirt', items: [{ label: 'a', path: '/x' }] }, mobileLinks: [{ label: 'a', path: '/x' }],
      } },
    });
    assert.equal(evilBg.status, 422);

    v = (await call('/api/v1/admin/content/announcements', { cookie: admin })).json.data.document.workingVersion;
    const ann = await call('/api/v1/admin/content/announcements', {
      method: 'PUT', cookie: admin,
      body: { text: `Scheduled ${TAG}`, startsAt: '2099-01-01T00:00:00Z', expiresAt: '2099-02-01T00:00:00Z', expectedVersion: v },
    });
    assert.equal(ann.status, 200);
    pass('CONTENT_MEGA_AND_ANNOUNCEMENT_EDIT');
  }

  // ---- 5b. header builder contract: icons, mobile menu settings, dropdown
  //          bounds + hidden items, published snapshot read -------------
  {
    let v = await navVersion(admin);
    const badIcon = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: admin, body: { label: 'Iconic', linkType: 'HOME', icon: 'rocket', expectedVersion: v },
    });
    assert.equal(badIcon.status, 422, 'an icon the storefront cannot draw is refused');
    v = await navVersion(admin);
    const goodIcon = await call('/api/v1/admin/content/navigation/items', {
      method: 'PUT', cookie: admin, body: { label: 'Iconic', linkType: 'HOME', icon: 'star', expectedVersion: v },
    });
    assert.equal(goodIcon.status, 200);
    assert.equal(goodIcon.json.data.items.find((i) => i.label === 'Iconic').icon, 'star', 'icon persisted');

    v = await navVersion(admin);
    const settingsBody = (settings) => ({ settings, expectedVersion: v });
    const viewerSettings = await call('/api/v1/admin/content/navigation/settings', {
      method: 'PUT', cookie: viewer, body: settingsBody({ mobileLinks: [], mobileTagline: '' }),
    });
    assert.equal(viewerSettings.status, 403, 'VIEWER cannot edit mobile menu settings');
    const evilLink = await call('/api/v1/admin/content/navigation/settings', {
      method: 'PUT', cookie: admin, body: settingsBody({ mobileLinks: [{ label: 'Evil', path: 'javascript:alert(1)' }], mobileTagline: '' }),
    });
    assert.equal(evilLink.status, 422, 'unsafe mobile link refused');
    const tooMany = await call('/api/v1/admin/content/navigation/settings', {
      method: 'PUT', cookie: admin, body: settingsBody({ mobileLinks: Array.from({ length: 13 }, (_, i) => ({ label: `L${i}`, path: '/help' })), mobileTagline: '' }),
    });
    assert.ok(tooMany.status >= 400 && tooMany.status < 500, 'more than 12 mobile links refused');
    const okSettings = await call('/api/v1/admin/content/navigation/settings', {
      method: 'PUT', cookie: admin,
      body: settingsBody({ mobileLinks: [{ label: 'About', path: '/pages/our-story' }, { label: 'Secret', path: '/help', hidden: true }], mobileTagline: 'Test tagline' }),
    });
    assert.equal(okSettings.status, 200);
    assert.equal(okSettings.json.data.settings.mobileTagline, 'Test tagline');
    assert.deepEqual(okSettings.json.data.settings.mobileLinks.map((l) => [l.label, Boolean(l.hidden)]), [['About', false], ['Secret', true]], 'hidden link kept in the draft');

    const megaV = async () => (await call('/api/v1/admin/content/mega-menus', { cookie: admin })).json.data.document.workingVersion;
    const megaBody = (payload, expectedVersion) => ({ menuKey: 'mega_tops', name: 'Tops', expectedVersion, payload });
    const basePayload = {
      featured: { heading: 'TOPS', ctaPath: '/collections/tops' },
      categoryNav: { icon: 'shirt', items: [{ label: 'All', path: '/collections/tops', isViewAll: true }, { label: 'Hidden Polo', path: '/collections/polos', hidden: true }] },
      mobileLinks: [{ label: 'All Tops', path: '/collections/tops' }],
    };
    const badPromo = await call('/api/v1/admin/content/mega-menus', {
      method: 'PUT', cookie: admin, body: megaBody({ ...basePayload, mobilePromo: { title: '', ctaLabel: 'Go', ctaPath: '/x' } }, await megaV()),
    });
    assert.equal(badPromo.status, 422, 'a mobile promo card without a title is refused');
    const allHidden = await call('/api/v1/admin/content/mega-menus', {
      method: 'PUT', cookie: admin,
      body: megaBody({ ...basePayload, categoryNav: { icon: 'shirt', items: [{ label: 'x', path: '/x', hidden: true }] } }, await megaV()),
    });
    assert.equal(allHidden.status, 422, 'a dropdown with every category link hidden is refused');
    const badRowPath = await call('/api/v1/admin/content/mega-menus', {
      method: 'PUT', cookie: admin,
      body: megaBody({ ...basePayload, shopCards: [{ label: 'Evil', path: '//evil.example' }] }, await megaV()),
    });
    assert.equal(badRowPath.status, 422, 'protocol-relative card link refused');
    const okMega = await call('/api/v1/admin/content/mega-menus', {
      method: 'PUT', cookie: admin, body: megaBody({ ...basePayload, mobilePromo: { title: 'Built for every season.', ctaLabel: 'Shop Tops', ctaPath: '/collections/tops' } }, await megaV()),
    });
    assert.equal(okMega.status, 200);
    const megaPub = await call('/api/v1/admin/content/mega-menus/publish', { method: 'POST', cookie: admin, body: {} });
    assert.equal(megaPub.status, 200);
    const liveTops = (await call('/api/v1/content/header')).json.data.megaMenus.mega_tops;
    // A view-all link to the Tops category reads "All <category name>" — the
    // label typed into the payload ("All") is not what customers see.
    assert.deepEqual(liveTops.categoryNav.items.map((i) => i.label), ['All Tops'], 'hidden dropdown links never reach customers');
    assert.equal(liveTops.mobilePromo.title, 'Built for every season.');

    const pub = await call('/api/v1/admin/content/mega-menus/published', { cookie: viewer });
    assert.equal(pub.status, 200, 'VIEWER can read the published snapshot');
    assert.deepEqual(pub.json.data.published.snapshot.entries.mega_tops.categoryNav.items.map((i) => i.label), ['All']);
    assert.equal((await call('/api/v1/admin/content/nope/published', { cookie: admin })).status, 422, 'unknown scope refused');
    assert.equal((await call('/api/v1/admin/content/navigation/published')).status, 401, 'published snapshot needs a staff session');
    pass('CONTENT_HEADER_BUILDER_CONTRACT');
  }

  // ---- 6. publish + history + rollback ---------------------
  {
    const beforeHist = (await call('/api/v1/admin/content/navigation/history', { cookie: admin })).json.data;
    const publishedBefore = beforeHist.document.publishedVersion;

    const p = await call('/api/v1/admin/content/navigation/publish', { method: 'POST', cookie: admin, body: {} });
    assert.equal(p.status, 200);
    assert.equal(p.json.data.version, publishedBefore + 1, 'publish advances version');

    const hist = (await call('/api/v1/admin/content/navigation/history', { cookie: admin })).json.data;
    assert.equal(hist.publications[0].version, p.json.data.version);
    assert.equal(hist.publications[0].state, 'PUBLISHED');
    assert.equal(hist.publications[1].state, 'SUPERSEDED');

    // the just-published (reversed + extra items) nav is now live
    const livePub = (await call('/api/v1/content/header')).json.data;
    assert.notDeepEqual(livePub.navigation.map((n) => n.id), REF.navigation.items.map((i) => i.key), 'live nav changed after publish');
    const ourStory = (await query("SELECT title FROM content_pages WHERE slug = 'our-story'"))[0].title;
    assert.deepEqual(livePub.mobileMenu, { links: [{ label: ourStory, path: '/pages/our-story' }], tagline: 'Test tagline' }, 'published mobile menu drops hidden links (and names the page)');

    // roll back to the ORIGINAL seeded publication (the earliest)
    const seeded = hist.publications[hist.publications.length - 1];
    const rb = await call('/api/v1/admin/content/navigation/rollback', {
      method: 'POST', cookie: admin, body: { targetPublicationId: seeded.id },
    });
    assert.equal(rb.status, 200);
    assert.equal(rb.json.data.rolledBackFrom, seeded.version);

    const afterRb = (await call('/api/v1/content/header')).json.data;
    assert.deepEqual(afterRb.navigation.map((n) => n.id), REF.navigation.items.map((i) => i.key), 'rollback restored the DEFAULT nav order/keys');
    // the seeded publication row is untouched (still SUPERSEDED with its snapshot)
    assert.equal((await call('/api/v1/admin/content/navigation/history', { cookie: admin })).json.data.publications.find((x) => x.id === seeded.id).state, 'SUPERSEDED');
    pass('CONTENT_PUBLISH_HISTORY_ROLLBACK');
  }

  // ---- 7. public DTO matches the seeded DEFAULT --------------
  {
    await reseed(); // ensure the default is the live publication
    const h = (await call('/api/v1/content/header')).json.data;
    // Links to categories / collections / pages show the entity's current name
    // (single source of truth); custom routes keep the label they were given.
    const entityName = async (path) => {
      const c = /^\/collections\/([^/?#]+)/.exec(path);
      if (c) return (await query('SELECT name FROM collections WHERE slug = ? UNION ALL SELECT name FROM categories WHERE slug = ?', [c[1], c[1]]))[0]?.name;
      const p = /^\/pages\/([^/?#]+)/.exec(path);
      if (p) return (await query('SELECT title AS name FROM content_pages WHERE slug = ?', [p[1]]))[0]?.name;
      return undefined;
    };
    const expectedNav = [];
    for (const i of REF.navigation.items) {
      expectedNav.push({ id: i.key, label: (await entityName(i.route)) ?? i.label, route: i.route, megaMenuId: i.megaMenuKey, ...(i.icon ? { icon: i.icon } : {}) });
    }
    assert.deepEqual(h.navigation, expectedNav, 'public navigation == DEFAULT (entity names)');
    const expectedMobile = [];
    for (const l of REF.navigation.mobileMenu.mobileLinks) expectedMobile.push({ label: (await entityName(l.path)) ?? l.label, path: l.path });
    assert.deepEqual(h.mobileMenu, { links: expectedMobile, tagline: REF.navigation.mobileMenu.mobileTagline }, 'public mobile menu == DEFAULT (entity names)');
    assert.deepEqual(Object.keys(h.megaMenus).sort(), REF.megaMenus.map((m) => m.key).sort());
    assert.equal(h.megaMenus.mega_tops.featured.heading, 'TOPS');
    assert.equal(h.megaMenus.mega_tops.categoryNav.icon, 'shirt', 'icon stays a name, never a component');
    assert.equal(h.announcements.slides.length, REF.announcements.slides.length);
    assert.equal(h.announcements.slides[0].text, 'Free shipping on all orders');
    // no draft / internal leakage
    const blob = JSON.stringify(h);
    assert.ok(!/document|workingVersion|draft_dirty|staff_user/i.test(blob), 'public DTO has no draft/internal fields');
    pass('CONTENT_PUBLIC_DTO_PARITY');
  }

  // ---- 7b. catalog is the source of truth: a switched-off category leaves
  //          the header (every device) and footer without a republish ------
  {
    const [cat] = await query("SELECT id, status FROM categories WHERE slug = 'polos' LIMIT 1");
    assert.ok(cat, 'polos category exists in this database');
    const before = (await call('/api/v1/content/header')).json.data;
    assert.ok(before.megaMenus.mega_tops.categoryNav.items.some((i) => i.path === '/collections/polos'), 'Polos is in TOPS while its category is on');
    try {
      await query("UPDATE categories SET status = 'ARCHIVED' WHERE id = ?", [cat.id]);
      const off = (await call('/api/v1/content/header')).json.data;
      const tops = off.megaMenus.mega_tops;
      assert.ok(!tops.categoryNav.items.some((i) => i.path === '/collections/polos'), 'desktop dropdown drops the switched-off category');
      assert.ok(!tops.mobileLinks.some((i) => i.path === '/collections/polos'), 'mobile submenu drops it too');
      assert.ok(!(tops.shopCards || []).some((i) => i.path === '/collections/polos'), 'category cards drop it too');
      assert.ok(tops.categoryNav.items.some((i) => i.path === '/collections/tops'), 'other links stay');
    } finally {
      await query('UPDATE categories SET status = ? WHERE id = ?', [cat.status, cat.id]);
    }
    const back = (await call('/api/v1/content/header')).json.data;
    assert.ok(back.megaMenus.mega_tops.categoryNav.items.some((i) => i.path === '/collections/polos'), 'switching it back on restores the link');
    pass('CONTENT_CATALOG_SOURCE_OF_TRUTH');
  }

  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCONTENT_NAVIGATION_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_NAVIGATION_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
