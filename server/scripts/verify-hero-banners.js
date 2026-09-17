// Homepage hero slides (CMS -> Experience -> Homepage -> Hero slides).
//
// Proves:
//   - refusals: a switched-on slide without a picture, an unknown text
//     position or colour, a shade over 90%, a time under 3 or over 20
//     seconds, half a button, an unsafe or off-site link, an end before the
//     start, a phone picture that does not exist, and another company's
//     picture — and a refused create stores nothing;
//   - a full slide round-trips every field (desktop + phone picture, both
//     text positions, colour, shade, time), and a bare one gets the look
//     slides had before (bottom-left, white text, 55% shade, 6 seconds);
//   - the storefront feed: only switched-on slides inside their dates, with
//     exactly the public fields; `configured` tells "no slides at all" from
//     "no slide on right now";
//   - duplicate keeps the look and lands switched off; reorder; a picture a
//     slide uses counts as in use;
//   - "start from the current hero" turns the built-in hero into the same
//     slides, only for a company with none, and only from its own pictures;
//   - RBAC on the admin routes and the public route's shape.
//
//   npm run verify:hero-banners
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';

const { createApp } = await import('../src/app.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { cmsAllowedOrigins } = await import('../src/config/index.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { heroBannerService } = await import('../src/modules/heroBanners/service.js');
const { referenceCount } = await import('../src/modules/media/service.js');

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `hero-${Date.now()}`;
const PW = 'Corcotton-HeroSlides-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (r) => `${r.toLowerCase()}.${TAG}@hero-gate.test`;

const BRAND = randomUUID();
const OTHER = randomUUID();
const IMG = randomUUID();
const IMG2 = randomUUID();
const VID = randomUUID();
const FOREIGN = randomUUID();
const httpCreated = [];
let server;
let BASE;

const rejects = async (fn, code, what) => {
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught, `${what}: expected ${code}`);
  assert.equal(caught.code, code, `${what}: got ${caught.code} — ${caught.message}`);
};
const heroRows = () => query('SELECT id FROM hero_banners WHERE brand_id = ?', [BRAND]);

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

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  await query('DELETE FROM hero_banners WHERE brand_id IN (?, ?)', [BRAND, OTHER]).catch(() => {});
  await query('DELETE FROM site_media WHERE brand_id IN (?, ?)', [BRAND, OTHER]).catch(() => {});
  if (httpCreated.length) await query(`DELETE FROM hero_banners WHERE id IN (${httpCreated.map(() => '?').join(',')})`, httpCreated).catch(() => {});
  await query('DELETE FROM media WHERE id IN (?, ?, ?, ?)', [IMG, IMG2, VID, FOREIGN]).catch(() => {});
  await query('DELETE FROM brands WHERE id IN (?, ?)', [BRAND, OTHER]).catch(() => {});
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@hero-gate.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@hero-gate.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@hero-gate.test'").catch(() => {});
  await pool.end();
}

try {
  await query("INSERT INTO brands (id, name, slug, status) VALUES (?, 'QA hero brand', ?, 'active'), (?, 'QA hero other brand', ?, 'active')",
    [BRAND, `qa-${TAG}`, OTHER, `qa-${TAG}-other`]);
  await query(
    `INSERT INTO media (id, brand_id, url, resource_type, status) VALUES
       (?, ?, 'https://res.cloudinary.com/qa/image/upload/qa-hero-wide.jpg', 'image', 'ACTIVE'),
       (?, ?, 'https://res.cloudinary.com/qa/image/upload/qa-hero-wide-2.jpg', 'image', 'ACTIVE'),
       (?, ?, 'https://res.cloudinary.com/qa/video/upload/qa-hero-phone.mp4', 'video', 'ACTIVE'),
       (?, ?, 'https://res.cloudinary.com/qa/image/upload/qa-hero-other-company.jpg', 'image', 'ACTIVE')`,
    [IMG, BRAND, IMG2, BRAND, VID, BRAND, FOREIGN, OTHER]);

  // ---- 1. refusals ------------------------------------------------------------
  {
    assert.deepEqual(await heroBannerService.publicHero(BRAND), { banners: [], configured: false }, 'a company with no slides: nothing, not configured');
    const refused = [
      [{ status: 'ACTIVE' }, 'HERO_BANNER_IMAGE_REQUIRED', 'a switched-on slide without a picture'],
      [{ mediaId: IMG, textPosition: 'LEFT' }, 'HERO_BANNER_INVALID', 'an unknown desktop text position'],
      [{ mediaId: IMG, mobileTextPosition: 'CENTER' }, 'HERO_BANNER_INVALID', 'an unknown phone text position'],
      [{ mediaId: IMG, textTheme: 'BLUE' }, 'HERO_BANNER_INVALID', 'an unknown text colour'],
      [{ mediaId: IMG, overlay: 95 }, 'HERO_BANNER_INVALID', 'a shade over 90%'],
      [{ mediaId: IMG, overlay: 12.5 }, 'HERO_BANNER_INVALID', 'a fractional shade'],
      [{ mediaId: IMG, durationSeconds: 2 }, 'HERO_BANNER_INVALID', 'a slide shorter than 3 seconds'],
      [{ mediaId: IMG, durationSeconds: 21 }, 'HERO_BANNER_INVALID', 'a slide longer than 20 seconds'],
      [{ mediaId: IMG, ctaLabel: 'Shop now' }, 'HERO_BANNER_CTA_INCOMPLETE', 'button text without a link'],
      [{ mediaId: IMG, ctaHref: '/collections' }, 'HERO_BANNER_CTA_INCOMPLETE', 'a link without button text'],
      [{ mediaId: IMG, ctaLabel: 'Go', ctaHref: 'javascript:alert(1)' }, 'HERO_BANNER_LINK_INVALID', 'a javascript: link'],
      [{ mediaId: IMG, ctaLabel: 'Go', ctaHref: '//evil.example/' }, 'HERO_BANNER_LINK_INVALID', 'a protocol-relative link'],
      [{ mediaId: IMG, ctaLabel: 'Go', ctaHref: 'http://example.com/' }, 'HERO_BANNER_LINK_INVALID', 'a plain http link'],
      [{ mediaId: IMG, startsAt: '2026-10-10T00:00:00Z', endsAt: '2026-10-01T00:00:00Z' }, 'HERO_BANNER_SCHEDULE_INVALID', 'an end before the start'],
      [{ mediaId: IMG, mobileMediaId: randomUUID() }, 'MEDIA_NOT_FOUND', 'a phone picture that does not exist'],
      [{ mediaId: FOREIGN }, 'MEDIA_NOT_FOUND', "another company's picture"],
      [{ mediaId: IMG, mobileMediaId: FOREIGN }, 'MEDIA_NOT_FOUND', "another company's phone picture"],
    ];
    for (const [body, code, what] of refused) await rejects(() => heroBannerService.create(BRAND, body, null), code, what);
    assert.equal((await heroRows()).length, 0, 'refused creates store nothing');
    pass('HERO_SLIDE_REFUSALS', `${refused.length} refusals`);
  }

  // ---- 2. round trip + defaults ---------------------------------------------------
  let full;
  let bare;
  {
    full = await heroBannerService.create(BRAND, {
      mediaId: IMG, mobileMediaId: VID, title: '  New season  ', subtitle: 'Cotton for every day.', ctaLabel: 'Shop tops', ctaHref: '/collections/tops',
      altText: 'Two people in white tees', status: 'ACTIVE', textPosition: 'MIDDLE_RIGHT', mobileTextPosition: 'TOP_CENTER',
      textTheme: 'DARK', overlay: 30, durationSeconds: 9,
    }, null);
    assert.deepEqual(
      {
        mediaId: full.mediaId, mobileMediaId: full.mobileMediaId, mobileMediaType: full.mobileMediaType, title: full.title, ctaHref: full.ctaHref,
        status: full.status, textPosition: full.textPosition, mobileTextPosition: full.mobileTextPosition, textTheme: full.textTheme,
        overlay: full.overlay, durationSeconds: full.durationSeconds,
      },
      {
        mediaId: IMG, mobileMediaId: VID, mobileMediaType: 'video', title: 'New season', ctaHref: '/collections/tops',
        status: 'ACTIVE', textPosition: 'MIDDLE_RIGHT', mobileTextPosition: 'TOP_CENTER', textTheme: 'DARK', overlay: 30, durationSeconds: 9,
      },
      'every field round-trips (text trimmed)',
    );
    bare = await heroBannerService.create(BRAND, { mediaId: IMG2 }, null);
    assert.deepEqual(
      { status: bare.status, textPosition: bare.textPosition, mobileTextPosition: bare.mobileTextPosition, textTheme: bare.textTheme, overlay: bare.overlay, durationSeconds: bare.durationSeconds, mobileMediaId: bare.mobileMediaId, displayOrder: bare.displayOrder },
      { status: 'INACTIVE', textPosition: 'BOTTOM_LEFT', mobileTextPosition: 'BOTTOM_LEFT', textTheme: 'LIGHT', overlay: 55, durationSeconds: 6, mobileMediaId: null, displayOrder: 1 },
      'a bare slide is switched off with the original look, at the end',
    );

    const edited = await heroBannerService.update(bare.id, BRAND, { overlay: 0, mobileTextPosition: 'BOTTOM_CENTER' }, null);
    assert.equal(edited.overlay, 0, 'no shade is allowed');
    assert.equal(edited.textPosition, 'BOTTOM_LEFT', 'an edit leaves other fields alone');
    await rejects(() => heroBannerService.update(bare.id, BRAND, { mediaId: null, status: 'ACTIVE' }, null), 'HERO_BANNER_IMAGE_REQUIRED', 'removing the picture while switching on');
    await rejects(() => heroBannerService.update(full.id, BRAND, { ctaHref: null }, null), 'HERO_BANNER_CTA_INCOMPLETE', 'an edit that leaves half a button');
    await rejects(() => heroBannerService.update(full.id, OTHER, { title: 'x' }, null), 'HERO_BANNER_NOT_FOUND', "another company cannot edit this slide");
    const cleared = await heroBannerService.update(full.id, BRAND, { mobileMediaId: null }, null);
    assert.equal(cleared.mobileMediaId, null, 'the phone picture can be removed');
    await heroBannerService.update(full.id, BRAND, { mobileMediaId: VID }, null);
    pass('HERO_SLIDE_ROUND_TRIP_AND_DEFAULTS');
  }

  // ---- 3. storefront feed -----------------------------------------------------
  {
    let hero = await heroBannerService.publicHero(BRAND);
    assert.equal(hero.configured, true);
    assert.deepEqual(hero.banners.map((b) => b.id), [full.id], 'only the switched-on slide');
    assert.deepEqual(hero.banners[0], {
      id: full.id,
      mediaUrl: 'https://res.cloudinary.com/qa/image/upload/qa-hero-wide.jpg', mediaType: 'image',
      mobileMediaUrl: 'https://res.cloudinary.com/qa/video/upload/qa-hero-phone.mp4', mobileMediaType: 'video',
      title: 'New season', subtitle: 'Cotton for every day.', ctaLabel: 'Shop tops', ctaHref: '/collections/tops',
      altText: 'Two people in white tees',
      textPosition: 'MIDDLE_RIGHT', mobileTextPosition: 'TOP_CENTER', textTheme: 'DARK', overlay: 30, durationSeconds: 9,
    }, 'exactly the public fields');

    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();
    await heroBannerService.update(bare.id, BRAND, { status: 'ACTIVE', startsAt: future }, null);
    hero = await heroBannerService.publicHero(BRAND);
    assert.deepEqual(hero.banners.map((b) => b.id), [full.id], 'a slide that has not started is not shown');
    await heroBannerService.update(bare.id, BRAND, { startsAt: null, endsAt: past }, null);
    hero = await heroBannerService.publicHero(BRAND);
    assert.deepEqual(hero.banners.map((b) => b.id), [full.id], 'a slide that has ended is not shown');
    await heroBannerService.update(bare.id, BRAND, { endsAt: null }, null);
    hero = await heroBannerService.publicHero(BRAND);
    assert.deepEqual(hero.banners.map((b) => b.id), [full.id, bare.id], 'both, in order');
    assert.equal(hero.banners[1].mobileMediaUrl, null, 'no phone picture: none sent');

    await heroBannerService.update(full.id, BRAND, { status: 'INACTIVE' }, null);
    await heroBannerService.update(bare.id, BRAND, { status: 'INACTIVE' }, null);
    assert.deepEqual(await heroBannerService.publicHero(BRAND), { banners: [], configured: true }, 'every slide off: no hero, but configured (no fallback)');
    await heroBannerService.update(full.id, BRAND, { status: 'ACTIVE' }, null);
    pass('HERO_STOREFRONT_FEED');
  }

  // ---- 4. duplicate, reorder, pictures in use -------------------------------------
  {
    const copy = await heroBannerService.duplicate(full.id, BRAND, null);
    assert.equal(copy.status, 'INACTIVE', 'a copy lands switched off');
    assert.deepEqual(
      [copy.mobileMediaId, copy.textPosition, copy.mobileTextPosition, copy.textTheme, copy.overlay, copy.durationSeconds, copy.title],
      [VID, 'MIDDLE_RIGHT', 'TOP_CENTER', 'DARK', 30, 9, 'New season (copy)'],
      'a copy keeps the pictures and the look',
    );
    const reordered = await heroBannerService.reorder(BRAND, [copy.id, bare.id, full.id]);
    assert.deepEqual(reordered.map((b) => b.id), [copy.id, bare.id, full.id]);
    await heroBannerService.reorder(OTHER, [full.id, copy.id, bare.id]);
    assert.deepEqual((await heroBannerService.list(BRAND)).map((b) => b.id), [copy.id, bare.id, full.id], "another company's reorder does not move these slides");
    await rejects(() => heroBannerService.reorder(BRAND, ['not-an-id']), 'HERO_BANNER_INVALID', 'a malformed order');
    assert.ok(await referenceCount(VID) >= 2, 'a phone picture in use counts as in use');
    assert.ok(await referenceCount(IMG) >= 2, 'a desktop picture in use counts as in use');
    pass('HERO_DUPLICATE_REORDER_MEDIA_IN_USE');
  }

  // ---- 5. start from the current hero ------------------------------------------------
  {
    await rejects(() => heroBannerService.importCurrent(BRAND, null), 'HERO_BANNERS_EXIST', 'a company that already has slides');
    await query('DELETE FROM hero_banners WHERE brand_id = ?', [BRAND]);

    // The built-in hero's slots belong to a company (site_media is keyed by
    // brand). The real store's slots are another company's: nothing to start from.
    await rejects(() => heroBannerService.importCurrent(BRAND, null), 'HERO_IMPORT_NOTHING', "another company's built-in hero is not imported");
    // A slot of this company that points at another company's picture is not used either.
    await query("INSERT INTO site_media (brand_id, media_key, media_id, alt_text) VALUES (?, 'home_hero_1', ?, NULL)", [BRAND, FOREIGN]);
    await rejects(() => heroBannerService.importCurrent(BRAND, null), 'HERO_IMPORT_NOTHING', "a slot holding another company's picture");
    await query("UPDATE site_media SET media_id = ?, alt_text = 'QA hero one' WHERE brand_id = ? AND media_key = 'home_hero_1'", [VID, BRAND]);
    await query("INSERT INTO site_media (brand_id, media_key, media_id, alt_text) VALUES (?, 'home_hero_2', ?, NULL)", [BRAND, IMG]);
    const imported = (await heroBannerService.importCurrent(BRAND, null)).banners;
    assert.deepEqual(
      imported.map((b) => [b.mediaId, b.title, b.ctaLabel, b.ctaHref, b.status, b.textPosition, b.overlay, b.durationSeconds]),
      [
        [VID, 'Comfort is not a compromise. It is a choice.', 'Explore Collection', '/collections', 'ACTIVE', 'BOTTOM_LEFT', 55, 6],
        [IMG, 'Natural fabrics. Timeless design. Everyday luxury.', 'Shop Tshirt', '/collections', 'ACTIVE', 'BOTTOM_LEFT', 55, 6],
      ],
      'the built-in hero becomes the same two slides, switched on, with the original look',
    );
    assert.equal(imported[0].altText, 'QA hero one', 'the picture description comes along');
    assert.deepEqual((await heroBannerService.publicHero(BRAND)).banners.map((b) => b.title), imported.map((b) => b.title), 'and they are live');
    await rejects(() => heroBannerService.importCurrent(BRAND, null), 'HERO_BANNERS_EXIST', 'importing twice');
    pass('HERO_START_FROM_CURRENT');
  }

  // ---- 6. routes --------------------------------------------------------------
  {
    await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@hero-gate.test'");
    for (const role of ['CATALOG_MANAGER', 'VIEWER']) {
      await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
    }
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}`;
    const cm = await loginCookie('CATALOG_MANAGER');
    const viewer = await loginCookie('VIEWER');

    const pub = await call('/api/v1/content/hero-banners');
    assert.equal(pub.status, 200);
    assert.ok(Array.isArray(pub.json.data.banners) && typeof pub.json.data.configured === 'boolean', 'public shape: { banners, configured }');

    assert.equal((await call('/api/v1/admin/content/hero-banners')).status, 401, 'signed out');
    assert.equal((await call('/api/v1/admin/content/hero-banners', { cookie: viewer })).status, 200, 'content.read lists slides');
    assert.equal((await call('/api/v1/admin/content/hero-banners', { method: 'POST', cookie: viewer, body: {} })).status, 403, 'content.read cannot create');
    assert.equal((await call('/api/v1/admin/content/hero-banners/import-current', { method: 'POST', cookie: viewer, body: {} })).status, 403, 'content.read cannot import');
    const bad = await call('/api/v1/admin/content/hero-banners', { method: 'POST', cookie: cm, body: { overlay: 200 } });
    assert.equal(bad.status, 422, 'a refused slide is a 422');
    assert.equal(bad.json.error.code, 'HERO_BANNER_INVALID');
    const made = await call('/api/v1/admin/content/hero-banners', { method: 'POST', cookie: cm, body: { title: 'QA route slide', textPosition: 'TOP_RIGHT' } });
    assert.equal(made.status, 201, 'content.write creates');
    httpCreated.push(made.json.data.id);
    assert.equal(made.json.data.textPosition, 'TOP_RIGHT');
    const gone = await call(`/api/v1/admin/content/hero-banners/${made.json.data.id}`, { method: 'DELETE', cookie: cm });
    assert.equal(gone.status, 200, 'content.write deletes');
    pass('HERO_ROUTES_RBAC');
  }

  console.log('\nHERO_BANNERS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nHERO_BANNERS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
