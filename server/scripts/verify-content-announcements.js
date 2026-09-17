// Announcement bar builder (CMS -> Experience -> Announcements).
//
// Proves:
//   - the draft carries the bar settings and each message's link reference;
//     RBAC: read / content.write / content.publish;
//   - settings are validated (time 3–15 s, on/off values, dismiss version)
//     and guarded by the document version;
//   - a message links to a category by REFERENCE; a reference to nothing, an
//     unsafe link, an end before the start and a duplicate key are refused
//     with a readable error (never a 500);
//   - "where is this used" lists the announcement bar for that category;
//   - publishing puts the settings, the dismiss version and the resolved link
//     (no reference) on the public header; rollback restores the previous
//     settings and messages;
//   - link resolution: a message follows its entity's URL, keeps its words
//     and loses only its link when the entity is switched off, and custom
//     links are untouched.
//
// Real HTTP listener + staff sessions. Re-seeds the default content at the end.
//
//   npm run verify:content:announcements
import assert from 'node:assert/strict';
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
const { resolveHeaderLinks } = await import('../src/modules/content/entityLinks.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `ann-${Date.now()}`;
const PW = 'Corcotton-Announcements-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (r) => `${r.toLowerCase()}.${TAG}@content-ann.test`;
const DEFAULT_SETTINGS = { autoplaySeconds: 4, showClock: true, dismissible: true, dismissVersion: 'v1' };

let server;
let BASE;

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
const draft = async (c) => (await call('/api/v1/admin/content/announcements', { cookie: c })).json.data;
const annVersion = async (c) => (await draft(c)).document.workingVersion;

async function reseed() {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/seed-content.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
}

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  await reseed();
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@content-ann.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@content-ann.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-ann.test'").catch(() => {});
  await pool.end();
}

try {
  await reseed();
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-ann.test'");
  for (const role of ['ADMIN', 'CATALOG_MANAGER', 'VIEWER']) {
    await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const admin = await loginCookie('ADMIN');
  const cm = await loginCookie('CATALOG_MANAGER');
  const viewer = await loginCookie('VIEWER');
  const [brand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  // A category the storefront actually shows: active, under an active parent.
  // An active child of an archived parent (Bags under an archived Accessories)
  // is hidden everywhere, so its link is rightly dropped and cannot be the fixture.
  const [category] = await query(
    `SELECT c.id, c.slug, c.name FROM categories c LEFT JOIN categories p ON p.id = c.parent_id
      WHERE c.status = 'ACTIVE' AND c.brand_id = ? AND (c.parent_id IS NULL OR p.status = 'ACTIVE')
      ORDER BY c.slug LIMIT 1`, [brand.id]);
  assert.ok(category, 'the seeded catalog has an active category to link to');

  // ---- 1. draft shape + RBAC ----------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/content/announcements')).status, 401, 'signed out');
    const d = await draft(viewer);
    assert.deepEqual(d.settings, DEFAULT_SETTINGS, 'the draft carries the default bar settings');
    assert.equal(d.dismissVersion, 'v1');
    assert.ok(d.announcements.length > 0 && d.announcements.every((a) => 'linkRefType' in a && 'linkRefId' in a), 'each message says what it links to');
    const v = d.document.workingVersion;
    assert.equal((await call('/api/v1/admin/content/announcements/settings', { method: 'PUT', cookie: viewer, body: { settings: DEFAULT_SETTINGS, expectedVersion: v } })).status, 403, 'content.read cannot change the bar');
    assert.equal((await call('/api/v1/admin/content/announcements/publish', { method: 'POST', cookie: cm, body: {} })).status, 403, 'content.write cannot publish');
    pass('ANNOUNCEMENTS_DRAFT_AND_RBAC');
  }

  // ---- 2. settings validation --------------------------------------------------
  {
    const v = await annVersion(cm);
    const refused = [
      [{ ...DEFAULT_SETTINGS, autoplaySeconds: 20 }, 'longer than 15 seconds'],
      [{ ...DEFAULT_SETTINGS, autoplaySeconds: 2 }, 'shorter than 3 seconds'],
      [{ ...DEFAULT_SETTINGS, autoplaySeconds: 4.5 }, 'a fraction of a second'],
      [{ ...DEFAULT_SETTINGS, showClock: 'yes' }, 'a clock that is not on/off'],
      [{ ...DEFAULT_SETTINGS, dismissible: null }, 'closing that is not on/off'],
      [{ ...DEFAULT_SETTINGS, dismissVersion: 'x1' }, 'a malformed dismiss version'],
    ];
    for (const [settings, what] of refused) {
      const r = await call('/api/v1/admin/content/announcements/settings', { method: 'PUT', cookie: cm, body: { settings, expectedVersion: v } });
      assert.equal(r.status, 400, `${what} is refused`);
      assert.equal(r.json.error.code, 'VALIDATION_ERROR');
    }
    const stale = await call('/api/v1/admin/content/announcements/settings', { method: 'PUT', cookie: cm, body: { settings: DEFAULT_SETTINGS, expectedVersion: v + 50 } });
    assert.equal(stale.status, 409, 'an out-of-date editor cannot overwrite the bar');
    const ok = await call('/api/v1/admin/content/announcements/settings', {
      method: 'PUT', cookie: cm, body: { settings: { autoplaySeconds: 6, showClock: false, dismissible: true, dismissVersion: 'v1' }, expectedVersion: v },
    });
    assert.equal(ok.status, 200, 'content.write changes the draft settings');
    assert.deepEqual(ok.json.data.settings, { autoplaySeconds: 6, showClock: false, dismissible: true, dismissVersion: 'v1' });
    pass('ANNOUNCEMENT_SETTINGS_VALIDATION', `${refused.length} refusals`);
  }

  // ---- 3. messages: link by reference, refusals ----------------------------------
  const TEXT = `Shop ${category.name} ${TAG}`;
  {
    let v = await annVersion(cm);
    const linked = await call('/api/v1/admin/content/announcements', {
      method: 'PUT', cookie: cm, body: { announcementKey: 'ann_qa_linked', text: TEXT, linkRefType: 'CATEGORY', linkRefId: category.id, expectedVersion: v },
    });
    assert.equal(linked.status, 200, 'a message linking to a category is saved');
    const row = linked.json.data.announcements.find((a) => a.announcementKey === 'ann_qa_linked');
    assert.deepEqual(
      [row.linkType, row.linkTarget, row.linkRefType, row.linkRefId, row.status],
      ['COLLECTION', category.slug, 'CATEGORY', category.id, 'ACTIVE'],
      'stored as a reference, with the category\'s current address',
    );

    const refused = [
      [{ announcementKey: 'ann_qa_ghost', text: 'Ghost', linkRefType: 'CATEGORY', linkRefId: '00000000-0000-4000-8000-000000000000' }, 422, 'CONTENT_LINK_INVALID', 'a link to a category that does not exist'],
      [{ announcementKey: 'ann_qa_js', text: 'Script', linkType: 'EXTERNAL', externalUrl: 'javascript:alert(1)' }, 422, 'CONTENT_LINK_INVALID', 'a javascript: link'],
      [{ announcementKey: 'ann_qa_nowhere', text: 'Nowhere', linkType: 'COLLECTION', linkTarget: 'no-such-collection-qa' }, 422, 'CONTENT_LINK_INVALID', 'a link to a collection that does not exist'],
      [{ announcementKey: 'ann_qa_when', text: 'When', startsAt: '2099-02-01T00:00:00Z', expiresAt: '2099-01-01T00:00:00Z' }, 422, 'CONTENT_INVALID', 'an end before the start'],
      [{ announcementKey: 'ann_qa_linked', text: 'Duplicate' }, 409, 'CONTENT_CONFLICT', 'a second message with the same key'],
    ];
    for (const [body, status, code, what] of refused) {
      v = await annVersion(cm);
      const r = await call('/api/v1/admin/content/announcements', { method: 'PUT', cookie: cm, body: { ...body, expectedVersion: v } });
      assert.equal(r.status, status, `${what}: HTTP ${r.status} ${JSON.stringify(r.json?.error)}`);
      assert.equal(r.json.error.code, code, what);
    }
    assert.equal((await draft(cm)).announcements.filter((a) => a.announcementKey.startsWith('ann_qa_')).length, 1, 'refused messages store nothing');

    const refs = await call(`/api/v1/admin/content/references?type=CATEGORY&id=${category.id}`, { cookie: viewer });
    assert.equal(refs.status, 200);
    const blob = JSON.stringify(refs.json.data.references);
    assert.ok(blob.includes('Announcement bar') && blob.includes(TEXT), '"where is this used" lists the announcement');
    pass('ANNOUNCEMENT_LINK_BY_REFERENCE');
  }

  // ---- 4. publish + public header + rollback ----------------------------------------
  {
    const before = await draft(admin);
    const previousVersion = before.document.publishedVersion;
    let v = before.document.workingVersion;
    const set = await call('/api/v1/admin/content/announcements/settings', {
      method: 'PUT', cookie: admin, body: { settings: { autoplaySeconds: 6, showClock: false, dismissible: false, dismissVersion: 'v2qa' }, expectedVersion: v },
    });
    assert.equal(set.status, 200);
    v = set.json.data.document.workingVersion;
    const pub = await call('/api/v1/admin/content/announcements/publish', { method: 'POST', cookie: admin, body: { expectedVersion: v } });
    assert.equal(pub.status, 200, `publish: ${JSON.stringify(pub.json?.error)}`);

    const header = (await call('/api/v1/content/header')).json.data;
    assert.deepEqual(header.announcements.settings, { autoplaySeconds: 6, showClock: false, dismissible: false }, 'the public bar settings (no internal fields)');
    assert.equal(header.announcements.dismissVersion, 'v2qa', 'visitors who closed the bar see it again');
    const slide = header.announcements.slides.find((s) => s.text === TEXT);
    assert.ok(slide, 'the published message is on the public header');
    assert.equal(slide.link, `/collections/${category.slug}`, 'its link is the category\'s address');
    assert.ok(header.announcements.slides.every((s) => !('ref' in s)), 'references never reach the storefront');

    const hist = await call('/api/v1/admin/content/announcements/history', { cookie: admin });
    assert.equal(hist.status, 200);
    const list = Array.isArray(hist.json.data) ? hist.json.data : hist.json.data.publications;
    const target = list.find((p) => Number(p.version) === Number(previousVersion));
    assert.ok(target, `the previously published version (${previousVersion}) is in the history`);
    const rb = await call('/api/v1/admin/content/announcements/rollback', { method: 'POST', cookie: admin, body: { targetPublicationId: target.id } });
    assert.equal(rb.status, 200, `rollback: ${JSON.stringify(rb.json?.error)}`);
    const after = await draft(admin);
    assert.deepEqual(after.settings, DEFAULT_SETTINGS, 'rollback restores the previous bar settings');
    assert.ok(!after.announcements.some((a) => a.announcementKey === 'ann_qa_linked'), 'and the previous messages');
    const live = (await call('/api/v1/content/header')).json.data.announcements;
    assert.deepEqual([live.settings, live.dismissVersion], [{ autoplaySeconds: 4, showClock: true, dismissible: true }, 'v1'], 'the website is back to the previous bar');
    pass('ANNOUNCEMENT_PUBLISH_PUBLIC_ROLLBACK');
  }

  // ---- 5. link resolution ----------------------------------------------------------
  {
    const index = {
      byId: new Map([
        ['CATEGORY:c1', { type: 'CATEGORY', id: 'c1', slug: 'tees-renamed', name: 'Tees', live: true, route: '/collections/tees-renamed' }],
        ['CATEGORY:c2', { type: 'CATEGORY', id: 'c2', slug: 'winter', name: 'Winter', live: false, route: '/collections/winter' }],
      ]),
      catalogBySlug: new Map(),
      pageBySlug: new Map(),
      historyBySlug: new Map(),
    };
    const resolved = resolveHeaderLinks({
      navigation: [], megaMenus: {}, footer: null,
      announcements: {
        dismissVersion: 'v1', settings: { autoplaySeconds: 4, showClock: true, dismissible: true },
        slides: [
          { id: 'a', text: 'Tees are here', link: '/collections/tees', ref: { type: 'CATEGORY', id: 'c1' } },
          { id: 'b', text: 'Winter is coming', link: '/collections/winter', ref: { type: 'CATEGORY', id: 'c2' } },
          { id: 'c', text: 'Track your order', link: '/track-order' },
          { id: 'd', text: 'Free shipping' },
        ],
      },
    }, index);
    assert.deepEqual(resolved.announcements.slides, [
      { id: 'a', text: 'Tees are here', link: '/collections/tees-renamed' },
      { id: 'b', text: 'Winter is coming' },
      { id: 'c', text: 'Track your order', link: '/track-order' },
      { id: 'd', text: 'Free shipping' },
    ], 'follows the entity; a switched-off entity drops only the link; custom links untouched');
    assert.deepEqual(resolved.announcements.settings, { autoplaySeconds: 4, showClock: true, dismissible: true }, 'settings pass through');
    pass('ANNOUNCEMENT_LINK_RESOLUTION');
  }

  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCONTENT_ANNOUNCEMENTS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_ANNOUNCEMENTS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
