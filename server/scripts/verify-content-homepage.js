// Homepage + Footer CMS (Wave 8E, Phase 4).
//
// Proves: RBAC (read / content.write / content.publish split on both the
// homepage and footer scopes), homepage section enable/disable + reorder
// determinism + per-type config validation (PRODUCT_CAROUSEL needs a real
// collectionSlug), footer group-link editing + link safety (dead internal
// target and non-http social URL rejected), publish gated on content.publish,
// history + rollback for both scopes, and the public
// GET /api/v1/content/homepage + the `footer` block of
// GET /api/v1/content/header reflecting only PUBLISHED content and matching
// the seeded DEFAULT exactly (HOMEPAGE_DEFAULT_VISUAL_REGRESSION = 0).
//
// Real HTTP listener + staff sessions. Publishes throwaway drafts then
// re-seeds so the storefront DEFAULT is restored.
//
//   npm run verify:content:homepage
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

const TAG = `chome-${Date.now()}`;
const PW = 'Corcotton-ContentHome-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (r) => `${r.toLowerCase()}.${TAG}@content-home.test`;

let server, BASE;

async function call(p, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json().catch(() => null) };
}
async function loginCookie(role) {
  const res = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: email(role), password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
const homeDraft = async (c) => (await call('/api/v1/admin/content/homepage', { cookie: c })).json.data;
const homeVersion = async (c) => (await homeDraft(c)).document.workingVersion;
const footerVersion = async (c) => (await call('/api/v1/admin/content/footer', { cookie: c })).json.data.document.workingVersion;

async function reseed() {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/seed-content.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
}

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  await reseed();
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@content-home.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@content-home.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-home.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-home.test'");
  for (const role of ['ADMIN', 'CATALOG_MANAGER', 'VIEWER']) {
    await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const admin = await loginCookie('ADMIN');
  const cm = await loginCookie('CATALOG_MANAGER');
  const viewer = await loginCookie('VIEWER');

  // ---- 1. RBAC (homepage + footer) --------------------------------
  {
    assert.equal((await call('/api/v1/admin/content/homepage')).status, 401);
    assert.equal((await call('/api/v1/admin/content/homepage', { cookie: viewer })).status, 200, 'VIEWER reads homepage');
    assert.equal((await call('/api/v1/admin/content/footer', { cookie: viewer })).status, 200, 'VIEWER reads footer');

    const v = await homeVersion(cm);
    const cmEdit = await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: cm, body: { type: 'TRUST_STRIP', enabled: true, config: {}, expectedVersion: v },
    });
    assert.equal(cmEdit.status, 200, 'CATALOG_MANAGER can draft-edit homepage (content.write)');

    const cmPub = await call('/api/v1/admin/content/homepage/publish', { method: 'POST', cookie: cm, body: {} });
    assert.equal(cmPub.status, 403, 'CATALOG_MANAGER cannot publish homepage');
    assert.equal(cmPub.json.error.code, 'PERMISSION_DENIED');

    const viewerEdit = await call('/api/v1/admin/content/footer/groups/shop/links', {
      method: 'PUT', cookie: viewer, body: { links: [], expectedVersion: 1 },
    });
    assert.equal(viewerEdit.status, 403, 'VIEWER cannot edit footer');
    pass('CONTENT_HOME_RBAC');
  }

  // ---- 2. section config validation --------------------------------
  {
    let v = await homeVersion(admin);
    const badType = await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: admin, body: { type: 'ARBITRARY_HTML', config: {}, expectedVersion: v },
    });
    assert.equal(badType.status, 422, 'unknown section type rejected');

    v = await homeVersion(admin);
    const noSlug = await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: admin, body: { type: 'PRODUCT_CAROUSEL', config: {}, expectedVersion: v },
    });
    assert.equal(noSlug.status, 422, 'PRODUCT_CAROUSEL without collectionSlug rejected');

    v = await homeVersion(admin);
    const deadSlug = await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: admin, body: { type: 'PRODUCT_CAROUSEL', config: { collectionSlug: 'no-such-collection-xyz' }, expectedVersion: v },
    });
    assert.equal(deadSlug.status, 422, 'PRODUCT_CAROUSEL with dead collectionSlug rejected');
    assert.equal(deadSlug.json.error.code, 'CONTENT_LINK_INVALID');

    v = await homeVersion(admin);
    const okSlug = await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: admin, body: { type: 'PRODUCT_CAROUSEL', config: { collectionSlug: REF.homepage.sections[2].config.collectionSlug, heading: 'X' }, expectedVersion: v },
    });
    assert.equal(okSlug.status, 200, 'PRODUCT_CAROUSEL with a real collectionSlug accepted');

    // Every section the homepage builder edits refuses what the storefront
    // cannot show properly — never a dead button or an empty strip.
    const refused = [
      ['BRAND_STRIP', { phrases: [] }, 'an empty brand strip'],
      ['BRAND_STRIP', { phrases: Array.from({ length: 9 }, (_, i) => `Phrase ${i}`) }, 'more than 8 brand strip phrases'],
      ['BRAND_STRIP', { phrases: ['x'.repeat(41)] }, 'a brand strip phrase over 40 characters'],
      ['TRUST_STRIP', { items: [{ icon: 'rocket', title: 'Fast' }] }, 'a trust strip icon that does not exist'],
      ['TRUST_STRIP', { items: [{ icon: 'leaf', title: '' }] }, 'a trust strip item without a title'],
      ['TRUST_STRIP', { items: Array.from({ length: 5 }, () => ({ icon: 'leaf', title: 'T' })) }, 'more than 4 trust strip items'],
      ['REVIEWS', { heading: 'x'.repeat(81) }, 'a reviews heading over 80 characters'],
      ['EDITORIAL_BANNER', { heading: 'H', ctaLabel: 'Go' }, 'button text without a link'],
      ['EDITORIAL_BANNER', { heading: 'H', ctaPath: '/pages/our-story' }, 'a button link without text'],
      ['EDITORIAL_BANNER', { heading: 'H', overlay: 95 }, 'image darkening above 90'],
      ['EDITORIAL_BANNER', { heading: 'H', ctaLabel: 'Go', ctaPath: '/pages/x', ctaRef: { type: 'PAGE', id: '00000000-0000-4000-8000-000000000000' } }, 'a button pointing at a page that does not exist'],
      ['INSTAGRAM_VIDEOS', { mode: 'RANDOM' }, 'an unknown way of choosing posts'],
      ['INSTAGRAM_VIDEOS', { limit: 2 }, 'fewer than 3 posts'],
      ['INSTAGRAM_VIDEOS', { limit: 13 }, 'more than 12 posts'],
      ['INSTAGRAM_VIDEOS', { picks: [{ igMediaId: 'https://www.instagram.com/p/DZRVEhhk3jw/' }] }, 'a pick that is not an Instagram post id'],
      ['INSTAGRAM_VIDEOS', { picks: [{ igMediaId: '17900001', enabled: true }, { igMediaId: '17900001', enabled: false }] }, 'the same post picked twice'],
      ['INSTAGRAM_VIDEOS', { picks: Array.from({ length: 25 }, (_, i) => ({ igMediaId: String(17900000 + i) })) }, 'more than 24 picks'],
      ['INSTAGRAM_VIDEOS', { autoplaySeconds: 1 }, 'auto-scroll faster than 3 seconds'],
    ];
    for (const [type, config, what] of refused) {
      v = await homeVersion(admin);
      const r = await call('/api/v1/admin/content/homepage/sections', { method: 'PUT', cookie: admin, body: { type, config, expectedVersion: v } });
      assert.equal(r.status, 422, `${what} is refused`);
    }
    v = await homeVersion(admin);
    const story = REF.homepage.sections.find((s) => s.key === 'brand_banner');
    const okStory = await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: admin, body: { type: 'EDITORIAL_BANNER', config: { ...story.config, overlay: 40 }, expectedVersion: v },
    });
    assert.equal(okStory.status, 200, 'a complete story banner is accepted');

    v = await homeVersion(admin);
    const okInstagram = await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: admin, body: {
        type: 'INSTAGRAM_VIDEOS', expectedVersion: v,
        config: { eyebrow: 'The CORCOTTON community', heading: 'Real People. Real Style.', description: 'See how our community wears CORCOTTON every day.', autoplaySeconds: 6, mode: 'PICKED', limit: 8, picks: [
          { igMediaId: '17900000000000001', enabled: true }, { igMediaId: '17900000000000002', enabled: false },
        ] },
      },
    });
    assert.equal(okInstagram.status, 200, 'a section showing picked Instagram posts is accepted');

    // What the homepage shows comes from the synced Instagram posts: only live
    // posts with a copied picture, newest first (LATEST) or in the editor's
    // order (PICKED). Throwaway synced rows stand in for an Instagram sync.
    const { randomUUID } = await import('node:crypto');
    const { resolveInstagramSections } = await import('../src/modules/content/instagram.js');
    const [brandRow] = await query('SELECT id FROM brands ORDER BY is_default DESC LIMIT 1');
    const coverId = randomUUID();
    const coverUrl = 'https://res.cloudinary.com/qa/image/upload/qa-instagram-cover.jpg';
    const rows = [
      ['17900000000000001', 'QAreel0001', 'VIDEO', 'REELS', '2026-09-10 10:00:00', 'ACTIVE', coverId],
      ['17900000000000002', 'QApost0002', 'IMAGE', 'FEED', '2026-09-12 10:00:00', 'ACTIVE', coverId],
      ['17900000000000003', 'QAgone0003', 'IMAGE', 'FEED', '2026-09-13 10:00:00', 'REMOVED', coverId],
      ['17900000000000004', 'QAnopic004', 'IMAGE', 'FEED', '2026-09-14 10:00:00', 'ACTIVE', null],
    ];
    await query("INSERT INTO media (id, brand_id, url, resource_type, status) VALUES (?, ?, ?, 'image', 'ACTIVE')", [coverId, brandRow.id, coverUrl]);
    try {
      for (const [ig, short, type, product, at, status, cover] of rows) {
        await query(
          `INSERT INTO instagram_media (id, brand_id, ig_media_id, media_type, media_product_type, shortcode, permalink, caption, posted_at, cover_media_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [randomUUID(), brandRow.id, ig, type, product, short, `https://www.instagram.com/p/${short}/`, `  QA caption ${short}  `, at, cover, status],
        );
      }
      const section = (config) => [{ key: 'ig', type: 'INSTAGRAM_VIDEOS', config }];
      const [latest] = await resolveInstagramSections(section({ heading: 'H', mode: 'LATEST', limit: 3 }), { brandId: brandRow.id });
      assert.deepEqual(latest.config.posts.map((p) => p.id), ['17900000000000002', '17900000000000001'],
        'latest: newest first; a post removed on Instagram and a post without a picture are left out');
      assert.deepEqual(latest.config.posts[1], {
        id: '17900000000000001', kind: 'reel',
        permalink: 'https://www.instagram.com/p/QAreel0001/', embedUrl: 'https://www.instagram.com/p/QAreel0001/embed/',
        coverUrl, caption: 'QA caption QAreel0001',
      }, 'a public post carries only what the card needs');
      assert.ok(!('mode' in latest.config) && !('limit' in latest.config) && !('picks' in latest.config), 'editing settings are not in the public payload');
      const [picked] = await resolveInstagramSections(section({ mode: 'PICKED', picks: [
        { igMediaId: '17900000000000001', enabled: true }, { igMediaId: '17900000000000003', enabled: true }, { igMediaId: '17900000000000002', enabled: false },
      ] }), { brandId: brandRow.id });
      assert.deepEqual(picked.config.posts.map((p) => p.id), ['17900000000000001'], 'picked: editor order; hidden and removed posts left out');
      const { referenceCount } = await import('../src/modules/media/service.js');
      assert.ok(await referenceCount(coverId) >= 3, 'a picture used by Instagram posts counts as in use and cannot be deleted');
    } finally {
      await query("DELETE FROM instagram_media WHERE brand_id = ? AND ig_media_id LIKE '179000000000000%'", [brandRow.id]);
      await query('DELETE FROM media WHERE id = ?', [coverId]);
    }
    pass('CONTENT_HOME_SECTION_VALIDATION');
  }

  // ---- 3. enable/disable + reorder determinism --------------------
  {
    let d = await homeDraft(admin);
    const first = d.sections[0];
    const toggle = await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: admin,
      body: { id: first.id, sectionKey: first.sectionKey, type: first.type, enabled: !first.enabled, config: first.config, expectedVersion: d.document.workingVersion },
    });
    assert.equal(toggle.status, 200);
    assert.equal(toggle.json.data.sections[0].enabled, !first.enabled, 'enable flag flipped');

    d = await homeDraft(admin);
    const ids = d.sections.map((s) => s.id);
    const reordered = [...ids].reverse();
    const r = await call('/api/v1/admin/content/homepage/reorder', {
      method: 'POST', cookie: admin, body: { orderedIds: reordered, expectedVersion: d.document.workingVersion },
    });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.data.sections.map((s) => s.id), reordered, 'reorder reflected');
    const dup = await query('SELECT position, COUNT(*) c FROM content_home_sections GROUP BY document_id, position HAVING c > 1');
    assert.equal(dup.length, 0, 'no duplicate section positions');
    pass('CONTENT_HOME_ENABLE_REORDER');
  }

  // ---- 4. footer editing + link safety --------------------------
  {
    let v = await footerVersion(admin);
    const deadLink = await call('/api/v1/admin/content/footer/groups/help/links', {
      method: 'PUT', cookie: admin,
      body: { links: [{ label: 'Ghost', linkType: 'COLLECTION', linkTarget: 'no-such-collection-xyz' }], expectedVersion: v },
    });
    assert.equal(deadLink.status, 422, 'dead internal footer link rejected');

    v = await footerVersion(admin);
    const evilSocial = await call('/api/v1/admin/content/footer/meta', {
      method: 'PUT', cookie: admin,
      body: { meta: { contact: {}, socials: [{ label: 'X', href: 'javascript:alert(1)', icon: 'instagram' }] }, expectedVersion: v },
    });
    assert.equal(evilSocial.status, 422, 'non-http social URL rejected');

    v = await footerVersion(admin);
    const okLinks = await call('/api/v1/admin/content/footer/groups/shop/links', {
      method: 'PUT', cookie: admin,
      body: { links: [{ label: 'New In', linkType: 'CUSTOM_INTERNAL', linkTarget: '/collections/new-arrivals' }], expectedVersion: v },
    });
    assert.equal(okLinks.status, 200, 'valid footer links accepted');
    pass('CONTENT_FOOTER_EDIT_SAFETY');
  }

  // ---- 5. publish + history + rollback (homepage) ---------------
  {
    const before = (await call('/api/v1/admin/content/homepage/history', { cookie: admin })).json.data;
    const publishedBefore = before.document.publishedVersion;
    const p = await call('/api/v1/admin/content/homepage/publish', { method: 'POST', cookie: admin, body: {} });
    assert.equal(p.status, 200);
    assert.equal(p.json.data.version, publishedBefore + 1, 'publish advances version');

    const live = (await call('/api/v1/content/homepage')).json.data;
    assert.notDeepEqual(live.sections.map((s) => s.key), REF.homepage.sections.map((s) => s.key), 'live homepage changed after publish');

    const hist = (await call('/api/v1/admin/content/homepage/history', { cookie: admin })).json.data;
    const seeded = hist.publications[hist.publications.length - 1];
    const rb = await call('/api/v1/admin/content/homepage/rollback', {
      method: 'POST', cookie: admin, body: { targetPublicationId: seeded.id },
    });
    assert.equal(rb.status, 200);
    const afterRb = (await call('/api/v1/content/homepage')).json.data;
    assert.deepEqual(afterRb.sections.map((s) => s.key), REF.homepage.sections.map((s) => s.key), 'rollback restored DEFAULT homepage order');
    pass('CONTENT_HOME_PUBLISH_HISTORY_ROLLBACK');
  }

  // ---- 6. footer publish + rollback ---------------------------
  {
    const p = await call('/api/v1/admin/content/footer/publish', { method: 'POST', cookie: admin, body: {} });
    assert.equal(p.status, 200);
    const live = (await call('/api/v1/content/header')).json.data;
    assert.equal(live.footer.shop.length, 1, 'live footer shop column changed after publish');

    const hist = (await call('/api/v1/admin/content/footer/history', { cookie: admin })).json.data;
    const seeded = hist.publications[hist.publications.length - 1];
    const rb = await call('/api/v1/admin/content/footer/rollback', {
      method: 'POST', cookie: admin, body: { targetPublicationId: seeded.id },
    });
    assert.equal(rb.status, 200);
    pass('CONTENT_FOOTER_PUBLISH_ROLLBACK');
  }

  // ---- 7. public DTO == seeded DEFAULT (zero visual regression) --
  {
    await reseed();
    const home = (await call('/api/v1/content/homepage')).json.data;
    assert.deepEqual(
      home.sections.map((s) => ({ key: s.key, type: s.type })),
      REF.homepage.sections.map((s) => ({ key: s.key, type: s.type })),
      'public homepage section key + type order == DEFAULT (Home.jsx)',
    );
    // The storefront renders each section from its config, so the copy is
    // part of the default too — "The Latest Drop", "Built on Purpose", ...
    // The Instagram section's public copy is its seeded copy; which posts it
    // shows depends on the connected account (none in a fresh database), and
    // its editing settings (mode, limit, picks) are not public.
    const publicCopy = (s) => {
      if (s.type !== 'INSTAGRAM_VIDEOS') return s.config;
      const { mode, limit, picks, posts, ...copy } = s.config;
      void mode; void limit; void picks; void posts;
      return copy;
    };
    assert.deepEqual(
      home.sections.map((s) => ({ key: s.key, config: publicCopy(s) })),
      REF.homepage.sections.map((s) => ({ key: s.key, config: publicCopy(s) })),
      'public homepage copy == DEFAULT',
    );
    assert.ok(home.sections.filter((s) => s.type === 'INSTAGRAM_VIDEOS').every((s) => Array.isArray(s.config.posts)), 'the Instagram section carries its posts');
    assert.ok(home.sections.every((s) => !('collectionRef' in s.config) && !('ctaRef' in s.config)), 'public homepage carries no references');
    results.HOMEPAGE_DEFAULT_VISUAL_REGRESSION = 0;

    const header = (await call('/api/v1/content/header')).json.data;
    for (const gk of ['shop', 'about', 'help', 'legal']) {
      assert.deepEqual(header.footer[gk], REF.footer.groups[gk], `public footer.${gk} == DEFAULT`);
    }
    assert.deepEqual(header.footer.contact, REF.footer.contact, 'footer contact == DEFAULT');
    assert.deepEqual(header.footer.socials, REF.footer.socials, 'footer socials == DEFAULT');

    const blob = JSON.stringify({ home, footer: header.footer });
    assert.ok(!/document|workingVersion|draft_dirty|staff_user/i.test(blob), 'public DTO has no draft/internal fields');
    pass('CONTENT_HOME_FOOTER_PUBLIC_PARITY');
  }

  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCONTENT_HOMEPAGE_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_HOMEPAGE_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
