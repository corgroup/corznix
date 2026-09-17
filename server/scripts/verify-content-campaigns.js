// Campaign + Theme engine (Wave 8E, Phase 6).
//
// Proves: RBAC (read / content.write / content.publish) on themes +
// campaigns, constrained theme-token validation (unknown token + non-hex
// rejected — no arbitrary CSS), campaign window + link validation,
// REQUEST-TIME resolution (a published in-window campaign overlays theme +
// announcements + banner; a dormant future campaign does not), deterministic
// priority conflict resolution, the emergency runtime kill switch, publish /
// history / rollback for a campaign, and the public GET
// /api/v1/content/experience + the /header overlay reflecting only
// published + in-window campaigns. No external provider calls.
//
//   npm run verify:content:campaigns
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

const TAG = `ccamp-${Date.now()}`;
const PW = 'Corcotton-ContentCampaign-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (r) => `${r.toLowerCase()}.${TAG}@content-campaign.test`;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();

const T_THEME = `zz_theme_${Date.now()}`;
const C_LOW = `zz-verify-low-${Date.now()}`;
const C_HIGH = `zz-verify-high-${Date.now()}`;
const C_FUTURE = `zz-verify-future-${Date.now()}`;
const KEYS = { [C_LOW]: `zz_low_${Date.now()}`, [C_HIGH]: `zz_high_${Date.now()}`, [C_FUTURE]: `zz_future_${Date.now()}` };

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
const campVersion = async (slug, c) => (await call(`/api/v1/admin/content/campaigns/${slug}`, { cookie: c })).json.data.document.workingVersion;

async function makeCampaign(admin, slug, { priority, startsMs, endsMs, themeKey, text }) {
  const created = await call('/api/v1/admin/content/campaigns', {
    method: 'POST', cookie: admin,
    body: {
      campaignKey: KEYS[slug], slug, name: `Verify ${slug}`, priority,
      startsAt: iso(startsMs), endsAt: iso(endsMs), themeKey: themeKey || null,
      payload: { announcementMode: 'prepend', announcements: [{ text, link: '/collections/new-arrivals' }], banner: { text: `${text} banner`, ctaLabel: 'Shop', ctaPath: '/collections/new-arrivals' } },
    },
  });
  assert.equal(created.status, 201, `create ${slug}: ${JSON.stringify(created.json)}`);
  const pub = await call(`/api/v1/admin/content/campaigns/${slug}/publish`, { method: 'POST', cookie: admin, body: {} });
  assert.equal(pub.status, 200, `publish ${slug}`);
}

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  for (const slug of [C_LOW, C_HIGH, C_FUTURE]) {
    await query('DELETE FROM content_campaign_runtime WHERE campaign_key = ?', [KEYS[slug]]).catch(() => {});
    await query('DELETE FROM content_documents WHERE doc_type = ? AND doc_key = ?', ['CAMPAIGN', slug]).catch(() => {});
  }
  await query('DELETE FROM content_documents WHERE doc_type = ? AND doc_key = ?', ['THEME', T_THEME]).catch(() => {});
  const { execSync } = await import('node:child_process');
  execSync('node scripts/seed-content-campaigns.js', { cwd: path.join(__dirname, '..'), stdio: 'ignore' });
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@content-campaign.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@content-campaign.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-campaign.test'").catch(() => {});
  await pool.end();
}

try {
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@content-campaign.test'");
  for (const role of ['ADMIN', 'CATALOG_MANAGER', 'VIEWER']) {
    await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
  }
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  BASE = `http://127.0.0.1:${server.address().port}`;
  const admin = await loginCookie('ADMIN');
  const cm = await loginCookie('CATALOG_MANAGER');
  const viewer = await loginCookie('VIEWER');

  // ---- 1. RBAC -------------------------------------------------
  {
    assert.equal((await call('/api/v1/admin/content/campaigns')).status, 401);
    assert.equal((await call('/api/v1/admin/content/campaigns', { cookie: viewer })).status, 200, 'VIEWER lists campaigns');
    assert.equal((await call('/api/v1/admin/content/themes', { cookie: viewer })).status, 200, 'VIEWER lists themes');

    const cmCreate = await call('/api/v1/admin/content/themes', {
      method: 'POST', cookie: cm, body: { themeKey: `${T_THEME}_x`, name: 'X', tokens: { accent: '#123456' } },
    });
    assert.equal(cmCreate.status, 201, 'CATALOG_MANAGER creates a theme (content.write)');
    const cmPub = await call(`/api/v1/admin/content/themes/${T_THEME}_x/publish`, { method: 'POST', cookie: cm, body: {} });
    assert.equal(cmPub.status, 403, 'CATALOG_MANAGER cannot publish');
    await query('DELETE FROM content_documents WHERE doc_type = ? AND doc_key = ?', ['THEME', `${T_THEME}_x`]);

    const vCreate = await call('/api/v1/admin/content/campaigns', { method: 'POST', cookie: viewer, body: {} });
    assert.equal(vCreate.status, 403, 'VIEWER cannot create');
    pass('CONTENT_CAMPAIGN_RBAC');
  }

  // ---- 2. constrained theme tokens (no arbitrary CSS) --------
  {
    const bad1 = await call('/api/v1/admin/content/themes', {
      method: 'POST', cookie: admin, body: { themeKey: `${T_THEME}_b`, name: 'B', tokens: { evil: '#000' } },
    });
    assert.equal(bad1.status, 422, 'unknown theme token rejected');
    const bad2 = await call('/api/v1/admin/content/themes', {
      method: 'POST', cookie: admin, body: { themeKey: `${T_THEME}_b`, name: 'B', tokens: { accent: 'url(x); background: red' } },
    });
    assert.equal(bad2.status, 422, 'non-hex token value rejected');

    const ok = await call('/api/v1/admin/content/themes', {
      method: 'POST', cookie: admin,
      body: { themeKey: T_THEME, name: 'Verify Theme', tokens: { announcementBg: '#123456', announcementFg: '#abcdef', accent: '#654321' } },
    });
    assert.equal(ok.status, 201);
    const v = ok.json.data.document.workingVersion;
    assert.equal((await call(`/api/v1/admin/content/themes/${T_THEME}/publish`, { method: 'POST', cookie: admin, body: { expectedVersion: v } })).status, 200);
    pass('CONTENT_THEME_TOKEN_VALIDATION');
  }

  // ---- 3. campaign window + link validation ------------------
  {
    const badWin = await call('/api/v1/admin/content/campaigns', {
      method: 'POST', cookie: admin,
      body: { campaignKey: 'zz_badwin', slug: 'zz-badwin', name: 'x', startsAt: iso(3600e3), endsAt: iso(0), payload: {} },
    });
    assert.equal(badWin.status, 422, 'endsAt <= startsAt rejected');
    const badLink = await call('/api/v1/admin/content/campaigns', {
      method: 'POST', cookie: admin,
      body: { campaignKey: 'zz_badlink', slug: 'zz-badlink', name: 'x', startsAt: iso(0), endsAt: iso(3600e3),
        payload: { announcements: [{ text: 'x', link: 'https://evil.example' }] } },
    });
    assert.equal(badLink.status, 422, 'external announcement link rejected');
    pass('CONTENT_CAMPAIGN_VALIDATION');
  }

  // ---- 4. request-time resolution --------------------------
  {
    await makeCampaign(admin, C_LOW, { priority: 50, startsMs: -3600e3, endsMs: 3600e3, themeKey: T_THEME, text: 'Low priority live' });

    const exp = (await call('/api/v1/content/experience')).json.data;
    assert.equal(exp.campaign?.key, KEYS[C_LOW], 'in-window published campaign is the active one');
    assert.equal(exp.theme.tokens.announcementBg, '#123456', 'campaign theme overlaid onto base tokens');
    assert.equal(exp.theme.tokens.bannerBg, '#111111', 'un-overridden base token preserved');
    assert.ok(exp.announcementOverlay && exp.announcementOverlay.slides[0].text === 'Low priority live', 'announcement overlay present');
    assert.ok(exp.banner && /Low priority live/.test(exp.banner.text), 'banner present');

    const header = (await call('/api/v1/content/header')).json.data;
    assert.equal(header.announcements.slides[0].source, 'campaign', 'header prepends the campaign slide');
    assert.equal(header.theme.tokens.announcementBg, '#123456', 'header carries the resolved theme');
    pass('CONTENT_EXPERIENCE_RESOLVE');
  }

  // ---- 5. deterministic priority conflict --------------------
  {
    await makeCampaign(admin, C_HIGH, { priority: 200, startsMs: -1800e3, endsMs: 1800e3, themeKey: null, text: 'High priority live' });
    const exp = (await call('/api/v1/content/experience')).json.data;
    assert.equal(exp.campaign.key, KEYS[C_HIGH], 'higher priority wins');
    assert.deepEqual(exp.activeCampaignKeys, [KEYS[C_HIGH], KEYS[C_LOW]], 'both active, ordered by priority');
    assert.equal(exp.announcementOverlay.slides[0].text, 'High priority live');
    assert.equal(exp.theme.tokens.announcementBg, '#000000', 'winner has no theme -> base tokens');
    pass('CONTENT_CAMPAIGN_PRIORITY');
  }

  // ---- 6. emergency runtime kill switch ---------------------
  {
    const cmDisable = await call(`/api/v1/admin/content/campaigns/${C_HIGH}/disable`, { method: 'POST', cookie: cm, body: { disabled: true } });
    assert.equal(cmDisable.status, 403, 'disable needs content.publish');

    const d = await call(`/api/v1/admin/content/campaigns/${C_HIGH}/disable`, { method: 'POST', cookie: admin, body: { disabled: true, reason: 'verify' } });
    assert.equal(d.status, 200);
    let exp = (await call('/api/v1/content/experience')).json.data;
    assert.equal(exp.campaign.key, KEYS[C_LOW], 'disabled campaign drops out; next priority takes over');

    await call(`/api/v1/admin/content/campaigns/${C_HIGH}/disable`, { method: 'POST', cookie: admin, body: { disabled: false } });
    exp = (await call('/api/v1/content/experience')).json.data;
    assert.equal(exp.campaign.key, KEYS[C_HIGH], 're-enable restores it');
    pass('CONTENT_CAMPAIGN_KILL_SWITCH');
  }

  // ---- 7. dormant future campaign does not resolve ----------
  {
    await makeCampaign(admin, C_FUTURE, { priority: 999, startsMs: 86400e3, endsMs: 172800e3, themeKey: T_THEME, text: 'Future' });
    const exp = (await call('/api/v1/content/experience')).json.data;
    assert.notEqual(exp.campaign.key, KEYS[C_FUTURE], 'a published campaign outside its window never resolves');
    assert.ok(!exp.activeCampaignKeys.includes(KEYS[C_FUTURE]));
    pass('CONTENT_CAMPAIGN_DORMANT');
  }

  // ---- 8. publish / history / rollback (campaign) -----------
  {
    let v = await campVersion(C_LOW, admin);
    await call(`/api/v1/admin/content/campaigns/${C_LOW}`, { method: 'PUT', cookie: admin, body: { priority: 75, expectedVersion: v } });
    v = await campVersion(C_LOW, admin);
    const p2 = await call(`/api/v1/admin/content/campaigns/${C_LOW}/publish`, { method: 'POST', cookie: admin, body: { expectedVersion: v } });
    assert.equal(p2.status, 200);
    assert.equal(p2.json.data.version, 2);

    const hist = (await call(`/api/v1/admin/content/campaigns/${C_LOW}/history`, { cookie: admin })).json.data;
    const first = hist.publications[hist.publications.length - 1];
    const rb = await call(`/api/v1/admin/content/campaigns/${C_LOW}/rollback`, { method: 'POST', cookie: admin, body: { targetPublicationId: first.id } });
    assert.equal(rb.status, 200);
    assert.equal((await call(`/api/v1/admin/content/campaigns/${C_LOW}`, { cookie: admin })).json.data.campaign.priority, 50, 'rollback restored the original priority');
    pass('CONTENT_CAMPAIGN_PUBLISH_HISTORY_ROLLBACK');
  }

  // ---- 9. DEFAULT (seeded) experience is unchanged ----------
  {
    // remove the verify campaigns, reseed, and confirm the base experience
    for (const slug of [C_LOW, C_HIGH, C_FUTURE]) {
      await query('DELETE FROM content_campaign_runtime WHERE campaign_key = ?', [KEYS[slug]]);
      await query('DELETE FROM content_documents WHERE doc_type = ? AND doc_key = ?', ['CAMPAIGN', slug]);
    }
    const exp = (await call('/api/v1/content/experience')).json.data;
    assert.equal(exp.campaign, null, 'no active campaign by default (Diwali seed is dormant)');
    assert.equal(exp.announcementOverlay, null);
    assert.equal(exp.theme.tokens.announcementBg, '#000000', 'base theme tokens = current look');
    const header = (await call('/api/v1/content/header')).json.data;
    assert.ok(!header.announcements.slides.some((s) => s.source === 'campaign'), 'no campaign slides in the default header');
    results.CAMPAIGN_DEFAULT_EXPERIENCE_REGRESSION = 0;
    pass('CONTENT_EXPERIENCE_DEFAULT');
  }

  {
    assert.equal(externalCalls, 0);
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nCONTENT_CAMPAIGNS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nCONTENT_CAMPAIGNS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
