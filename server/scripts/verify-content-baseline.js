// Content baseline characterization (Wave 8E, Phase 1).
//
// Freezes the current DEFAULT storefront chrome — navigation, mega menus,
// announcement slides, footer, homepage section order — so every later phase
// proves BEFORE == AFTER. The canonical values live in
// database/seeds/content-default.json (transcribed verbatim from the
// storefront's features/header/fixtures/*). This script asserts that file is
// structurally complete and internally consistent, and pins the invariants
// the content backfill (migration 026 companion) must reproduce exactly.
//
// From Phase 3 on it also diffs the live GET /api/v1/content/* output against
// this same reference (the DEFAULT-parity gate).
//
//   npm run verify:content:baseline
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REF_PATH = path.join(__dirname, '..', 'database', 'seeds', 'content-default.json');

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const HTTP_ONLY = /^https?:\/\//i;
const INTERNAL_ROUTE = /^\/[a-z0-9\-/?=&.]*$/i;

function walkLinks(node, out) {
  if (Array.isArray(node)) { node.forEach((n) => walkLinks(n, out)); return; }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'path' || k === 'ctaPath' || k === 'route') && typeof v === 'string') out.internal.push(v);
      else if (k === 'href' && typeof v === 'string') out.external.push(v);
      else walkLinks(v, out);
    }
  }
}

try {
  const ref = JSON.parse(await readFile(REF_PATH, 'utf8'));

  // ---- 1. navigation --------------------------------------------------
  {
    const items = ref.navigation.items;
    assert.equal(ref.navigation.menuKey, 'primary');
    assert.deepEqual(items.map((i) => i.key), ['nav_tops', 'nav_bottoms', 'nav_accessories', 'nav_new_in'], 'nav item keys + order frozen');
    assert.deepEqual(items.map((i) => i.label), ['TOPS', 'BOTTOMS', 'ACCESSORIES', 'NEW IN'], 'nav labels frozen');
    assert.deepEqual(items.map((i) => i.position), [0, 1, 2, 3], 'contiguous positions');
    for (const it of items) {
      assert.ok(INTERNAL_ROUTE.test(it.route), `nav route "${it.route}" is an internal path`);
      assert.ok(['COLLECTION', 'CATEGORY', 'CONTENT_PAGE', 'HOME', 'SEARCH', 'CUSTOM_INTERNAL', 'EXTERNAL'].includes(it.linkType));
    }
    pass('NAVIGATION_FROZEN', `${items.length} primary items`);
  }

  // ---- 2. mega menus -----------------------------------------------
  {
    const menuKeys = ref.megaMenus.map((m) => m.key).sort();
    const referenced = ref.navigation.items.map((i) => i.megaMenuKey).filter(Boolean).sort();
    assert.deepEqual(menuKeys, referenced, 'every nav megaMenuKey resolves to exactly one mega menu, and vice versa');
    for (const m of ref.megaMenus) {
      assert.ok(m.featured && m.featured.heading && m.featured.ctaPath, `${m.key} has featured heading + cta`);
      assert.ok(Array.isArray(m.categoryNav.items) && m.categoryNav.items.length >= 1, `${m.key} categoryNav items`);
      assert.ok(m.categoryNav.items.some((x) => x.isViewAll), `${m.key} has a "view all" item`);
      assert.ok(Array.isArray(m.mobileLinks) && m.mobileLinks.length >= 1, `${m.key} mobileLinks (MobileMenu contract)`);
      assert.equal(typeof m.categoryNav.icon, 'string', `${m.key} icon is a stable name, not a component`);
    }
    // the exact promo/featured backgrounds are frozen (gradient placeholders today)
    assert.equal(ref.megaMenus.find((m) => m.key === 'mega_tops').featured.background, 'linear-gradient(160deg, #2c2c2c, #050505)');
    pass('MEGA_MENUS_FROZEN', `${ref.megaMenus.length} entries`);
  }

  // ---- 3. announcements ------------------------------------------
  {
    // Baseline moved deliberately (2026-09-09). Three slides were removed:
    // ann_summer_sale and ann_summer_collection advertised a 40%-off sale and
    // a Summer Collection linking to collections that have never existed, and
    // ann_limited_offer expired in July. All three were development fixture
    // copy that this gate had frozen into place, and they ran on the live
    // storefront for months. The gate's job is unchanged — nobody may alter
    // the chrome by accident — but a baseline is only worth freezing while it
    // is true, so it now pins what is actually shown.
    const a = ref.announcements;
    assert.equal(a.dismissVersion, 'v1');
    assert.deepEqual(a.slides.map((s) => s.key), ['ann_free_shipping', 'ann_luxury_essentials']);
    assert.equal(a.slides[0].text, 'Free shipping on all orders');
    for (const s of a.slides) if (s.link) assert.ok(INTERNAL_ROUTE.test(s.link), `announcement link "${s.link}" internal`);
    // A slide may still be scheduled; if one is, its expiry has to be a real
    // instant rather than a string nobody parses.
    for (const s of a.slides) {
      if (s.expiresAt) assert.ok(!Number.isNaN(Date.parse(s.expiresAt)), `announcement "${s.key}" expiresAt parses`);
    }
    pass('ANNOUNCEMENTS_FROZEN', `${a.slides.length} slides`);
  }

  // ---- 4. footer -----------------------------------------------
  {
    const f = ref.footer;
    assert.deepEqual(Object.keys(f.groups).sort(), ['about', 'help', 'legal', 'shop']);
    // Also moved deliberately (2026-09-09): the "Sale" link pointed at
    // /collections/sale, which does not exist, and the Legal column carried a
    // "Blog" link that duplicated About's "Journal". The contact block was
    // placeholder data — a mailbox that does not resolve, a number of all
    // zeros and a city the business does not operate from — which this gate
    // had been holding in place. These are the real values, matching the
    // Contact Us page and the registered address.
    assert.equal(f.groups.shop.length, 5);
    assert.equal(f.groups.help.length, 7);
    assert.equal(f.groups.legal.length, 3, 'the legal column holds the legal pages and nothing else');
    assert.equal(f.contact.email, 'support@corcotton.in');
    assert.equal(f.contact.phoneHref, 'tel:+915493358300');
    assert.deepEqual(f.socials.map((s) => s.icon), ['instagram', 'facebook', 'pinterest', 'youtube']);
    for (const s of f.socials) assert.ok(HTTP_ONLY.test(s.href), `social href "${s.href}" is http(s)`);
    pass('FOOTER_FROZEN', `${Object.values(f.groups).flat().length} links, ${f.socials.length} socials`);
  }

  // ---- 5. homepage section order --------------------------------
  {
    const s = ref.homepage.sections;
    assert.equal(ref.homepage.sectionKey, 'home');
    // The seventh slot was the REVIEWS (testimonials) section until the homepage
    // replaced it with Instagram videos (migration 108) — same place, same order.
    assert.deepEqual(s.map((x) => x.type), ['HERO', 'BRAND_STRIP', 'PRODUCT_CAROUSEL', 'CATEGORY_SECTION', 'PRODUCT_CAROUSEL', 'EDITORIAL_BANNER', 'INSTAGRAM_VIDEOS', 'TRUST_STRIP'], 'homepage section type order frozen (Home.jsx)');
    assert.deepEqual(s.map((x) => x.position), [0, 1, 2, 3, 4, 5, 6, 7]);
    assert.ok(s.every((x) => x.enabled === true), 'all sections enabled by default');
    assert.equal(s[2].config.collectionSlug, 'new-arrivals');
    assert.equal(s[4].config.collectionSlug, 'bestsellers');
    pass('HOMEPAGE_SECTIONS_FROZEN', `${s.length} sections`);
  }

  // ---- 6. link safety across the whole reference ---------------
  {
    const links = { internal: [], external: [] };
    walkLinks(ref, links);
    for (const url of links.external) {
      assert.ok(HTTP_ONLY.test(url), `external link "${url}" must be http(s)`);
      assert.ok(!/^javascript:/i.test(url) && !/^data:/i.test(url), `external link "${url}" not a dangerous scheme`);
    }
    for (const p of links.internal) assert.ok(p.startsWith('/'), `internal link "${p}" starts with /`);
    pass('LINK_SAFETY', `${links.internal.length} internal, ${links.external.length} external`);
  }

  // ---- 7. footer -> content-page coverage ----------------------------
  // A footer link that has no page behind it is a 404 on every page of the
  // site, so this asserts rather than reports.
  //
  // It used to hold a hand-written list of which pages had been written, and
  // that list went stale: it still named the five legal and policy pages as
  // "copy not yet supplied" after they were authored, while saying nothing
  // when a link pointed at a page that had never existed. The coverage is now
  // read from content-pages.json itself, so it cannot drift from the seed.
  {
    const pagesRef = JSON.parse(await readFile(path.join(__dirname, '..', 'database', 'seeds', 'content-pages.json'), 'utf8'));
    const seededSlugs = new Set(pagesRef.pages.map((p) => `/pages/${p.slug}`));
    // Two footer routes are not content pages: /pages/faqs renders the FAQ
    // document, and /blog renders the journal page under its own route.
    const NON_PAGE_ROUTES = new Set(['/pages/faqs', '/blog']);
    assert.ok(pagesRef.faq?.items?.length > 0, '/pages/faqs has FAQ entries behind it');
    assert.ok(seededSlugs.has('/pages/journal'), '/blog has the journal page behind it');

    const footerPaths = Object.values(ref.footer.groups).flat().map((l) => l.path);
    const contentPageRoutes = footerPaths.filter((p) => /^\/(legal|help|about|pages|blog)\b/.test(p));
    const missing = [...new Set(contentPageRoutes.filter((p) => !NON_PAGE_ROUTES.has(p) && !seededSlugs.has(p)))];
    results.CONTENT_PAGE_ROUTES_TOTAL = contentPageRoutes.length;
    results.CONTENT_PAGE_ROUTES_WITHOUT_PAGES = missing.length;
    assert.deepEqual(missing, [], `every footer link needs a page behind it; missing: ${missing.join(', ')}`);
    pass('FOOTER_PAGE_COVERAGE', `${contentPageRoutes.length} content routes, all backed`);
  }

  console.log('\nCONTENT_BASELINE_CHARACTERIZATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_BASELINE_CHARACTERIZATION = FAIL');
  console.error(err);
  process.exitCode = 1;
}
