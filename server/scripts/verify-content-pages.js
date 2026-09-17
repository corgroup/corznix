// Content pages + FAQ CMS (Wave 8E, Phase 5).
//
// Proves: RBAC (read / content.write / content.publish) on pages + FAQ,
// typed-block validation (unknown type, unsafe inline href, IMAGE without
// media, bad CONTACT href all rejected — there is no raw-HTML path),
// optimistic concurrency, page create + duplicate-slug guard, publish +
// history + rollback (page and FAQ), ARCHIVED pages hidden from the public
// resolver, and the public GET /api/v1/content/pages/:slug + /faq matching
// the seeded DEFAULT. No external provider calls.
//
//   npm run verify:content:pages
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
const REF = JSON.parse(await readFile(path.join(__dirname, '..', 'database', 'seeds', 'content-pages.json'), 'utf8'));

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `cpage-${Date.now()}`;
const PW = 'Corcotton-ContentPage-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (r) => `${r.toLowerCase()}.${TAG}@content-page.test`;
const NEW_SLUG = `zz-verify-${Date.now()}`;

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
const pageVersion = async (slug, c) => (await call(`/api/v1/admin/content/pages/${slug}`, { cookie: c })).json.data.document.workingVersion;
const faqVersion = async (c) => (await call('/api/v1/admin/content/faq', { cookie: c })).json.data.document.workingVersion;

async function reseed() {
  const { execSync } = await import('node:child_process');
  execSync('node scripts/seed-content-pages.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
}

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  await query('DELETE FROM content_documents WHERE doc_type = ? AND doc_key = ?', ['CONTENT_PAGE', NEW_SLUG]).catch(() => {});
  await reseed();
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@content-page.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@content-page.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-page.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-page.test'");
  for (const role of ['ADMIN', 'CATALOG_MANAGER', 'VIEWER']) {
    await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const admin = await loginCookie('ADMIN');
  const cm = await loginCookie('CATALOG_MANAGER');
  const viewer = await loginCookie('VIEWER');

  // ---- 1. RBAC ---------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/content/pages')).status, 401);
    assert.equal((await call('/api/v1/admin/content/pages', { cookie: viewer })).status, 200, 'VIEWER lists pages');
    assert.equal((await call('/api/v1/admin/content/pages/our-story', { cookie: viewer })).status, 200, 'VIEWER reads a page');

    const v = await pageVersion('our-story', cm);
    const cmEdit = await call('/api/v1/admin/content/pages/our-story', {
      method: 'PUT', cookie: cm, body: { seoTitle: 'CM edit', expectedVersion: v },
    });
    assert.equal(cmEdit.status, 200, 'CATALOG_MANAGER draft-edits (content.write)');

    const cmPub = await call('/api/v1/admin/content/pages/our-story/publish', { method: 'POST', cookie: cm, body: {} });
    assert.equal(cmPub.status, 403, 'CATALOG_MANAGER cannot publish');
    assert.equal(cmPub.json.error.code, 'PERMISSION_DENIED');

    const vEdit = await call('/api/v1/admin/content/pages/our-story', { method: 'PUT', cookie: viewer, body: { seoTitle: 'x', expectedVersion: 1 } });
    assert.equal(vEdit.status, 403, 'VIEWER cannot edit');
    pass('CONTENT_PAGES_RBAC');
  }

  // ---- 2. typed-block validation (no raw HTML path) -------------
  {
    const put = (blocks, v) => call('/api/v1/admin/content/pages/press/blocks', { method: 'PUT', cookie: admin, body: { blocks, expectedVersion: v } });

    let v = await pageVersion('press', admin);
    assert.ok([400, 422].includes((await put([{ type: 'MARKUP', data: { html: '<script>x</script>' } }], v)).status), 'unknown block type rejected');

    v = await pageVersion('press', admin);
    assert.equal((await put([{ type: 'PARAGRAPH', data: { text: 'click [here](javascript:alert(1))' } }], v)).status, 422, 'javascript: inline href rejected');

    v = await pageVersion('press', admin);
    assert.equal((await put([{ type: 'IMAGE', data: { alt: 'x' } }], v)).status, 422, 'IMAGE without media rejected');

    v = await pageVersion('press', admin);
    assert.equal((await put([{ type: 'CONTACT', data: { rows: [{ label: 'X', value: 'y', href: 'data:text/html,evil' }] } }], v)).status, 422, 'unsafe CONTACT href rejected');

    v = await pageVersion('press', admin);
    const ok = await put([
      { type: 'HEADING', data: { level: 2, text: 'Verified' } },
      { type: 'PARAGRAPH', data: { text: 'Contact [us](mailto:press@corcotton.in) or see [terms](/pages/terms-x).' } },
    ], v);
    assert.equal(ok.status, 200, 'valid typed blocks accepted');
    pass('CONTENT_PAGES_BLOCK_VALIDATION');
  }

  // ---- 3. optimistic concurrency ------------------------------
  {
    const v = await pageVersion('careers', admin);
    const first = await call('/api/v1/admin/content/pages/careers', { method: 'PUT', cookie: admin, body: { seoTitle: `A ${TAG}`, expectedVersion: v } });
    assert.equal(first.status, 200);
    const stale = await call('/api/v1/admin/content/pages/careers', { method: 'PUT', cookie: admin, body: { seoTitle: 'B', expectedVersion: v } });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'CONTENT_VERSION_CONFLICT');
    pass('CONTENT_PAGES_OPTIMISTIC_CONCURRENCY');
  }

  // ---- 4. create + duplicate-slug guard ----------------------
  {
    const created = await call('/api/v1/admin/content/pages', {
      method: 'POST', cookie: admin,
      body: { pageKey: `zz_verify_${Date.now()}`, slug: NEW_SLUG, title: 'ZZ Verify', navLabel: 'ZZ' },
    });
    assert.equal(created.status, 201, 'page created');
    const dupe = await call('/api/v1/admin/content/pages', {
      method: 'POST', cookie: admin, body: { pageKey: `zz_verify2_${Date.now()}`, slug: NEW_SLUG, title: 'Dup' },
    });
    assert.equal(dupe.status, 409, 'duplicate slug rejected');
    // an unpublished page is not visible publicly
    assert.equal((await call(`/api/v1/content/pages/${NEW_SLUG}`)).status, 404, 'unpublished page is 404 publicly');
    pass('CONTENT_PAGES_CREATE');
  }

  // ---- 5. publish + history + rollback (page) ----------------
  {
    const before = (await call('/api/v1/admin/content/pages/press/history', { cookie: admin })).json.data;
    const p = await call('/api/v1/admin/content/pages/press/publish', { method: 'POST', cookie: admin, body: {} });
    assert.equal(p.status, 200);
    assert.equal(p.json.data.version, (before.document.publishedVersion || 0) + 1);

    const live = (await call('/api/v1/content/pages/press')).json.data;
    assert.equal(live.blocks[0].text, 'Verified', 'published page reflects the draft edit');

    const hist = (await call('/api/v1/admin/content/pages/press/history', { cookie: admin })).json.data;
    const seeded = hist.publications[hist.publications.length - 1];
    const rb = await call('/api/v1/admin/content/pages/press/rollback', { method: 'POST', cookie: admin, body: { targetPublicationId: seeded.id } });
    assert.equal(rb.status, 200);
    const afterRb = (await call('/api/v1/content/pages/press')).json.data;
    assert.equal(afterRb.blocks[0].text, REF.pages.find((x) => x.slug === 'press').blocks[0].data.text, 'rollback restored the DEFAULT press page');
    pass('CONTENT_PAGES_PUBLISH_HISTORY_ROLLBACK');
  }

  // ---- 6. ARCHIVED page hidden from the public resolver ------
  {
    let v = await pageVersion('journal', admin);
    await call('/api/v1/admin/content/pages/journal', { method: 'PUT', cookie: admin, body: { status: 'ARCHIVED', expectedVersion: v } });
    v = await pageVersion('journal', admin);
    await call('/api/v1/admin/content/pages/journal/publish', { method: 'POST', cookie: admin, body: { expectedVersion: v } });
    assert.equal((await call('/api/v1/content/pages/journal')).status, 404, 'ARCHIVED page is 404 publicly');
    assert.ok(!(await call('/api/v1/content/pages')).json.data.pages.some((x) => x.slug === 'journal'), 'ARCHIVED page absent from the index');
    pass('CONTENT_PAGES_ARCHIVED_HIDDEN');
  }

  // ---- 7. FAQ validation + publish + rollback ---------------
  {
    let v = await faqVersion(admin);
    const bad = await call('/api/v1/admin/content/faq/items', {
      method: 'PUT', cookie: admin, body: { items: [{ question: 'Q?', answer: '' }], expectedVersion: v },
    });
    assert.equal(bad.status, 422, 'FAQ item with empty answer rejected');

    v = await faqVersion(admin);
    const good = await call('/api/v1/admin/content/faq/items', {
      method: 'PUT', cookie: admin,
      body: { items: [
        { category: 'Orders', question: 'How do I track my order?', answer: 'Use the tracking link in your dispatch email.\n\nOr contact support.' },
        { category: 'Orders', question: 'Can I change my address?', answer: 'Contact support before dispatch.' },
        { category: 'Returns', question: 'What is the returns window?', answer: 'See the Returns policy.' },
      ], expectedVersion: v },
    });
    assert.equal(good.status, 200);

    const pub = await call('/api/v1/admin/content/faq/publish', { method: 'POST', cookie: admin, body: {} });
    assert.equal(pub.status, 200);
    const liveFaq = (await call('/api/v1/content/faq')).json.data;
    assert.deepEqual(liveFaq.categories.map((c) => c.title), ['Orders', 'Returns'], 'FAQ grouped by category, first-seen order');
    assert.equal(liveFaq.categories[0].items[0].answer.length, 2, 'answer split into paragraphs');

    const hist = (await call('/api/v1/admin/content/faq/history', { cookie: admin })).json.data;
    const seeded = hist.publications[hist.publications.length - 1];
    const rb = await call('/api/v1/admin/content/faq/rollback', { method: 'POST', cookie: admin, body: { targetPublicationId: seeded.id } });
    assert.equal(rb.status, 200);
    pass('CONTENT_FAQ_VALIDATION_PUBLISH_ROLLBACK');
  }

  // ---- 8. public DTO == seeded DEFAULT ---------------------
  {
    await reseed();
    const idx = (await call('/api/v1/content/pages')).json.data.pages;
    assert.deepEqual(idx.map((p) => p.slug).sort(), REF.pages.map((p) => p.slug).sort(), 'public index == the 9 seeded pages');
    results.CONTENT_PAGES_DEFAULT = idx.length;

    for (const ref of REF.pages) {
      const live = (await call(`/api/v1/content/pages/${ref.slug}`)).json.data;
      assert.equal(live.title, ref.title, `${ref.slug} title`);
      assert.equal(live.blocks.length, ref.blocks.length, `${ref.slug} block count`);
      assert.equal(live.blocks[0].type, ref.blocks[0].type, `${ref.slug} first block type`);
    }
    assert.equal((await call('/api/v1/content/pages/no-such-page-xyz')).status, 404, 'unknown slug 404');

    const faq = (await call('/api/v1/content/faq')).json.data;
    results.FAQ_CONTENT_STATUS = faq.categories.length ? 'SEEDED' : 'MISSING (no Q&A copy supplied)';

    const blob = JSON.stringify(idx);
    assert.ok(!/document|workingVersion|draft_dirty|staff_user/i.test(blob), 'public DTO has no draft/internal fields');
    pass('CONTENT_PAGES_PUBLIC_PARITY');
  }

  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCONTENT_PAGES_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_PAGES_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
