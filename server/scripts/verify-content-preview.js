// Signed short-lived content preview (Wave 8E, Phase 7).
//
// Proves: a staff-minted preview token makes the PUBLIC content endpoints
// serve the DRAFT for its scope only; no token / bad token / revoked token
// / expired token / out-of-scope token all fall back to PUBLISHED content
// (no public leak); preview responses are no-store + noindex; and an
// `asOf` token resolves a scheduled campaign as of that instant.
//
//   npm run verify:content:preview
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TAG = `cprev-${Date.now()}`;
const PW = 'Corcotton-ContentPreview-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (r) => `${r.toLowerCase()}.${TAG}@content-preview.test`;

let server, BASE;

async function call(p, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}
async function loginCookie(role) {
  const res = await fetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: email(role), password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}
const mint = async (cookie, body) => (await call('/api/v1/admin/content/preview-tokens', { method: 'POST', cookie, body })).json.data;

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  const { execSync } = await import('node:child_process');
  execSync('node scripts/seed-content.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  execSync('node scripts/seed-content-pages.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await query("DELETE FROM content_preview_tokens WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@content-preview.test')").catch(() => {});
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@content-preview.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@content-preview.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-preview.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-preview.test'");
  for (const role of ['ADMIN', 'VIEWER']) {
    await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const admin = await loginCookie('ADMIN');
  const viewer = await loginCookie('VIEWER');

  // ---- 1. minting RBAC ----------------------------------------
  {
    assert.equal((await call('/api/v1/admin/content/preview-tokens', { method: 'POST', body: { scope: 'all' } })).status, 401);
    const v = await call('/api/v1/admin/content/preview-tokens', { method: 'POST', cookie: viewer, body: { scope: 'homepage' } });
    assert.equal(v.status, 201, 'VIEWER (content.read) can mint a preview token');
    const bad = await call('/api/v1/admin/content/preview-tokens', { method: 'POST', cookie: admin, body: { scope: 'not-a-scope' } });
    assert.equal(bad.status, 422, 'invalid scope rejected');
    pass('CONTENT_PREVIEW_MINT_RBAC');
  }

  // ---- 2. a homepage token serves the DRAFT for homepage only ---
  {
    // draft-only change: hide the first homepage section, do NOT publish
    const draft = (await call('/api/v1/admin/content/homepage', { cookie: admin })).json.data;
    const first = draft.sections[0];
    await call('/api/v1/admin/content/homepage/sections', {
      method: 'PUT', cookie: admin,
      body: { id: first.id, sectionKey: first.sectionKey, type: first.type, enabled: false, config: first.config, expectedVersion: draft.document.workingVersion },
    });

    const publishedKeys = (await call('/api/v1/content/homepage')).json.data.sections.map((s) => s.key);
    assert.ok(publishedKeys.includes(first.sectionKey), 'without a token the published homepage still has every section');

    const tok = await mint(admin, { scope: 'homepage' });
    const prev = await call(`/api/v1/content/homepage?preview=${tok.token}`);
    assert.equal(prev.json.data.preview, true, 'preview flag set');
    assert.ok(!prev.json.data.sections.map((s) => s.key).includes(first.sectionKey), 'preview reflects the unpublished "hidden section" edit');
    assert.equal(prev.headers.get('cache-control'), 'no-store', 'preview response is no-store');
    assert.match(prev.headers.get('x-robots-tag') || '', /noindex/, 'preview response is noindex');

    // header via X-Content-Preview header also works
    const viaHeader = await fetch(`${BASE}/api/v1/content/homepage`, { headers: { 'x-content-preview': tok.token } });
    assert.equal((await viaHeader.json()).data.preview, true, 'token also accepted via X-Content-Preview header');
    pass('CONTENT_PREVIEW_DRAFT_SERVED');
  }

  // ---- 3. scope isolation -----------------------------------
  {
    // draft edit to a page, unpublished
    const pdraft = (await call('/api/v1/admin/content/pages/press', { cookie: admin })).json.data;
    await call('/api/v1/admin/content/pages/press/blocks', {
      method: 'PUT', cookie: admin,
      body: { blocks: [{ type: 'HEADING', data: { level: 2, text: 'DRAFT ONLY HEADING' } }], expectedVersion: pdraft.document.workingVersion },
    });

    const homepageTok = await mint(admin, { scope: 'homepage' });
    const pageWithHomepageTok = await call(`/api/v1/content/pages/press?preview=${homepageTok.token}`);
    assert.notEqual(pageWithHomepageTok.json.data.blocks[0].text, 'DRAFT ONLY HEADING', 'a homepage-scoped token does NOT unlock page previews');

    const pageTok = await mint(admin, { scope: 'page:press' });
    const pageWithPageTok = await call(`/api/v1/content/pages/press?preview=${pageTok.token}`);
    assert.equal(pageWithPageTok.json.data.blocks[0].text, 'DRAFT ONLY HEADING', 'a page-scoped token unlocks that page');

    const allTok = await mint(admin, { scope: 'all' });
    assert.equal((await call(`/api/v1/content/pages/press?preview=${allTok.token}`)).json.data.blocks[0].text, 'DRAFT ONLY HEADING', '"all" scope covers pages');
    pass('CONTENT_PREVIEW_SCOPE_ISOLATION');
  }

  // ---- 4. bad / revoked / expired token -> published --------
  {
    assert.equal((await call('/api/v1/content/homepage?preview=garbage-not-a-real-token-xxxxxxxx')).json.data.preview, undefined, 'garbage token ignored -> published');
    assert.equal((await call('/api/v1/content/homepage?preview=garbage-not-a-real-token-xxxxxxxx')).status, 200, 'garbage token does not 401');

    const tok = await mint(admin, { scope: 'homepage' });
    const list = (await call('/api/v1/admin/content/preview-tokens', { cookie: admin })).json.data.tokens;
    const row = list.find((x) => x.status === 'ACTIVE');
    const rv = await call(`/api/v1/admin/content/preview-tokens/${row.id}`, { method: 'DELETE', cookie: admin });
    assert.equal(rv.status, 200);
    assert.equal((await call(`/api/v1/content/homepage?preview=${tok.token}`)).json.data.preview, undefined, 'revoked token -> published');

    const tok2 = await mint(admin, { scope: 'homepage' });
    await query('UPDATE content_preview_tokens SET expires_at = (NOW(3) - INTERVAL 1 MINUTE) WHERE token_hash = SHA2(?, 256)', [tok2.token]);
    assert.equal((await call(`/api/v1/content/homepage?preview=${tok2.token}`)).json.data.preview, undefined, 'expired token -> published');
    pass('CONTENT_PREVIEW_INVALID_FALLS_BACK');
  }

  // ---- 5. asOf resolves a scheduled campaign ---------------
  {
    // the seeded "Diwali Test Campaign" is published but dormant (future window)
    const now = (await call('/api/v1/content/experience')).json.data;
    assert.equal(now.campaign, null, 'no campaign active right now');

    const tok = await mint(admin, { scope: 'experience', asOf: '2026-11-08T12:00:00.000Z' });
    const asOf = (await call(`/api/v1/content/experience?preview=${tok.token}`)).json.data;
    assert.equal(asOf.preview === undefined ? asOf.campaign?.key : asOf.campaign?.key, 'diwali_test', 'asOf preview resolves the scheduled Diwali campaign');
    assert.ok(asOf.announcementOverlay && /Diwali/i.test(asOf.announcementOverlay.slides[0].text), 'campaign announcement overlay present in the asOf preview');
    assert.equal(asOf.theme.tokens.announcementBg, '#5a1a1a', 'campaign theme resolved in the asOf preview');
    pass('CONTENT_PREVIEW_AS_OF');
  }

  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCONTENT_PREVIEW_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_PREVIEW_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
