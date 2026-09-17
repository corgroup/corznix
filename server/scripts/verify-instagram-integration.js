// Instagram (official API) — the homepage "Real People. Real Style." feed.
//
// Proves, with Instagram itself replaced by a stand-in (nothing leaves this
// machine):
//   - the access token is stored encrypted (AES-256-GCM, random IV, tamper
//     detected) and connecting fails closed without the encryption key;
//   - connect checks the token with Instagram first: a malformed token, a
//     rejected token and a personal account are refused and store nothing;
//   - sync saves posts, copies each picture once, updates captions, marks a
//     post deleted on Instagram as REMOVED — only inside the window Instagram
//     returned — and reports pictures it could not copy;
//   - renewal waits until the token is 24 hours old and close to expiry, then
//     stores the renewed token and the exact expiry Instagram reports; a
//     rejected renewal marks the account AUTH_FAILED and the worker skips it;
//   - the graph client calls the documented endpoints and maps Instagram's
//     errors (190, rate limits, 5xx, timeouts) to stable provider codes;
//   - the homepage feed shows only live posts with a picture, in the chosen
//     order, and a used picture cannot be deleted from the Media Library;
//   - disconnect forgets the token but keeps the posts;
//   - RBAC on the CMS routes, and the token never appears in a response, an
//     error, a provider attempt or the audit log.
//
//   npm run verify:instagram
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';
process.env.INSTAGRAM_WORKER_ENABLED = 'false';
const KEY = 'ab'.repeat(32);
process.env.PROVIDER_SECRET_ENCRYPTION_KEY = KEY;

let externalCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) {
    externalCalls += 1;
    return Promise.reject(new Error('external network call blocked by verify-instagram-integration'));
  }
  return realFetch(input, init);
};

const { env, cmsAllowedOrigins } = await import('../src/config/index.js');
const { createApp } = await import('../src/app.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { ProviderError } = await import('../src/platform/shared/providerError.js');
const crypto = await import('../src/utils/providerSecretCrypto.js');
const { createInstagramService } = await import('../src/modules/instagram/service.js');
const { createInstagramGraphClient } = await import('../src/modules/instagram/graphClient.js');
const { resolveInstagramSections } = await import('../src/modules/content/instagram.js');
const { referenceCount } = await import('../src/modules/media/service.js');

const results = {};
const pass = (n, note) => { results[n] = note ? `PASS (${note})` : 'PASS'; console.log(`  PASS  ${n}${note ? ` — ${note}` : ''}`); };

const TOKEN = `IGAAQA${'x'.repeat(40)}SECRETTOKENONE`;
const TOKEN2 = `IGAAQA${'y'.repeat(40)}SECRETTOKENTWO`;
const leaks = (value) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  return s.includes('SECRETTOKEN');
};
const DAY = 86_400_000;
const HOUR = 3_600_000;

const TAG = `ig-${Date.now()}`;
const PW = 'Corcotton-Instagram-Gate-Strong-Passphrase';
const ORIGIN = cmsAllowedOrigins[0];
const email = (r) => `${r.toLowerCase()}.${TAG}@instagram-gate.test`;

const BRAND = randomUUID();
const coverIds = [];
let server;
let BASE;

// ---- stand-ins --------------------------------------------------------------
function fakeGraph() {
  const g = {
    calls: [],
    profileResult: { igUserId: '17841400000000001', username: 'corcotton.qa', accountType: 'BUSINESS' },
    posts: [],
    failWith: null,
    refreshResult: null,
    badPictures: new Set(),
  };
  g.profile = async (token) => { g.calls.push(['profile', token]); if (g.failWith) throw g.failWith; return g.profileResult; };
  g.recentMedia = async (token, opts) => { g.calls.push(['media', token, opts?.max]); if (g.failWith) throw g.failWith; return g.posts; };
  g.refresh = async (token) => { g.calls.push(['refresh', token]); if (g.failWith) throw g.failWith; return g.refreshResult; };
  g.downloadPicture = async (url) => {
    g.calls.push(['picture', url]);
    if (g.badPictures.has(url)) throw new ProviderError({ code: 'PROVIDER_UNAVAILABLE', message: 'picture down' });
    return Buffer.from('fake-jpeg');
  };
  g.count = (kind) => g.calls.filter((c) => c[0] === kind).length;
  return g;
}

async function storeCover(_buffer, { brandId, shortcode }) {
  const id = randomUUID();
  await query("INSERT INTO media (id, brand_id, url, resource_type, status) VALUES (?, ?, ?, 'image', 'ACTIVE')",
    [id, brandId, `https://res.cloudinary.com/qa/image/upload/qa-ig-${shortcode}-${id.slice(0, 6)}.jpg`]);
  coverIds.push(id);
  return { id };
}

const day = (n) => new Date(Date.UTC(2026, 8, n, 9, 0, 0)).toISOString();
function post(n, { at = day(Math.min(n, 28)), image = false, caption = `  Caption ${n}  ` } = {}) {
  const shortcode = `QAig${String(n).padStart(3, '0')}x`;
  return {
    // Instagram ids exceed Number.MAX_SAFE_INTEGER: always strings.
    id: `179000000000${String(n).padStart(5, '0')}`,
    media_type: image ? 'IMAGE' : 'VIDEO',
    media_product_type: image ? 'FEED' : 'REELS',
    permalink: `https://www.instagram.com/${image ? 'p' : 'reel'}/${shortcode}/`,
    shortcode,
    caption,
    timestamp: at,
    ...(image ? { media_url: `https://cdn.instagram.test/${shortcode}.jpg` } : { thumbnail_url: `https://cdn.instagram.test/${shortcode}-thumb.jpg`, media_url: `https://cdn.instagram.test/${shortcode}.mp4` }),
  };
}

const igRows = () => query('SELECT ig_media_id, status, caption, cover_media_id FROM instagram_media WHERE brand_id = ? ORDER BY ig_media_id', [BRAND]);
const connection = async () => (await query('SELECT * FROM instagram_connections WHERE brand_id = ?', [BRAND]))[0] || null;
const rejectsWith = async (fn, code, what) => {
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught, `${what}: expected ${code}`);
  assert.equal(caught.code, code, `${what}: ${caught.message}`);
  assert.ok(!leaks(caught.message), `${what}: the error message carries no token`);
  return caught;
};

async function call(p, { method = 'GET', body, cookie } = {}) {
  const headers = { origin: ORIGIN };
  if (cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await realFetch(`${BASE}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text };
}
async function loginCookie(role) {
  const res = await realFetch(`${BASE}/api/v1/admin/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify({ email: email(role), password: PW }),
  });
  return (res.headers.get('set-cookie') || '').split(';')[0];
}

async function cleanup() {
  try { server?.close(); } catch { /* noop */ }
  await query('DELETE FROM instagram_media WHERE brand_id = ?', [BRAND]).catch(() => {});
  if (coverIds.length) await query(`DELETE FROM media WHERE id IN (${coverIds.map(() => '?').join(',')})`, coverIds).catch(() => {});
  await query('DELETE FROM instagram_connections WHERE brand_id = ?', [BRAND]).catch(() => {});
  await query("DELETE FROM provider_attempts WHERE capability = 'social' AND provider_key = 'INSTAGRAM' AND resource_id = ?", [BRAND]).catch(() => {});
  await query('DELETE FROM brands WHERE id = ?', [BRAND]).catch(() => {});
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@instagram-gate.test'").catch(() => {});
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@instagram-gate.test')").catch(() => {});
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@instagram-gate.test'").catch(() => {});
  await pool.end();
}

try {
  assert.equal(env.PROVIDER_SECRET_ENCRYPTION_KEY, KEY, 'the gate runs with its own throwaway encryption key');
  await query("INSERT INTO brands (id, name, slug, status) VALUES (?, 'QA Instagram brand', ?, 'active')", [BRAND, `qa-${TAG}`]);

  // ---- 1. encryption at rest ------------------------------------------------
  {
    crypto._resetProviderSecretKey();
    const a = crypto.encryptProviderSecret(TOKEN);
    const b = crypto.encryptProviderSecret(TOKEN);
    assert.ok(!leaks(a), 'ciphertext does not contain the token');
    assert.notEqual(a, b, 'a fresh IV every time');
    assert.equal(a.split(':').length, 3, 'iv:tag:ciphertext');
    assert.equal(crypto.decryptProviderSecret(a), TOKEN, 'round trip');
    const [iv, tag, data] = a.split(':');
    const flipped = `${iv}:${tag}:${data.slice(0, -2)}${data.endsWith('AA') ? 'BB' : 'AA'}`;
    assert.throws(() => crypto.decryptProviderSecret(flipped), (e) => e.code === 'PROVIDER_SECRET_CORRUPT', 'a tampered ciphertext is refused');

    env.PROVIDER_SECRET_ENCRYPTION_KEY = '';
    crypto._resetProviderSecretKey();
    try {
      assert.equal(crypto.providerSecretEncryptionAvailable(), false, 'no key: not available');
      assert.throws(() => crypto.encryptProviderSecret(TOKEN), (e) => e.code === 'PROVIDER_SECRET_ENCRYPTION_UNAVAILABLE', 'no key: nothing is stored in the clear');
      const g = fakeGraph();
      const svc = createInstagramService({ graph: g, storeCover });
      await rejectsWith(() => svc.connect(BRAND, TOKEN), 'PROVIDER_SECRET_ENCRYPTION_UNAVAILABLE', 'connect without a key');
      assert.equal(g.calls.length, 0, 'no key: Instagram is not even asked');
      assert.equal(await connection(), null, 'no key: nothing stored');
      env.PROVIDER_SECRET_ENCRYPTION_KEY = 'not-a-key';
      crypto._resetProviderSecretKey();
      assert.equal(crypto.providerSecretEncryptionAvailable(), false, 'a malformed key is not a key');
    } finally {
      env.PROVIDER_SECRET_ENCRYPTION_KEY = KEY;
      crypto._resetProviderSecretKey();
    }
    assert.equal(crypto.providerSecretEncryptionAvailable(), true);
    pass('INSTAGRAM_TOKEN_ENCRYPTED_AT_REST');
  }

  const g = fakeGraph();
  let clock = new Date('2026-09-14T10:00:00.000Z');
  const connectedAt = clock.getTime();
  const svc = createInstagramService({ graph: g, storeCover, now: () => clock });

  // ---- 2. connect ----------------------------------------------------------
  {
    await rejectsWith(() => svc.connect(BRAND, 'short'), 'INSTAGRAM_TOKEN_INVALID', 'a malformed token');
    await rejectsWith(() => svc.connect(BRAND, `${TOKEN} extra`), 'INSTAGRAM_TOKEN_INVALID', 'a token with spaces');
    assert.equal(g.calls.length, 0, 'a malformed token never reaches Instagram');

    g.failWith = new ProviderError({ code: 'PROVIDER_AUTH_FAILED', message: 'Instagram said: Invalid OAuth access token', providerKey: 'INSTAGRAM', capability: 'social' });
    const rejected = await rejectsWith(() => svc.connect(BRAND, TOKEN), 'INSTAGRAM_TOKEN_REJECTED', 'a token Instagram rejects');
    assert.equal(rejected.statusCode ?? rejected.status, 422);
    g.failWith = null;

    g.profileResult = { igUserId: '17841400000000009', username: 'someone.personal', accountType: 'PERSONAL' };
    await rejectsWith(() => svc.connect(BRAND, TOKEN), 'INSTAGRAM_ACCOUNT_NOT_PROFESSIONAL', 'a personal account');
    assert.equal(await connection(), null, 'refused connects store nothing');
    g.profileResult = { igUserId: '17841400000000001', username: 'corcotton.qa', accountType: 'BUSINESS' };

    g.posts = [post(3), post(2, { image: true }), post(1)];
    g.calls.length = 0;
    const result = await svc.connect(BRAND, `  ${TOKEN}\n`);
    assert.equal(result.syncError, null, 'connect pulls the posts');
    assert.deepEqual(
      { fetched: result.sync.fetched, added: result.sync.added, removed: result.sync.removed, coversCopied: result.sync.coversCopied, coverFailures: result.sync.coverFailures },
      { fetched: 3, added: 3, removed: 0, coversCopied: 3, coverFailures: 0 },
    );
    assert.ok(g.calls.filter((c) => c[0] !== 'picture').every((c) => c[1] === TOKEN), 'the trimmed token is what Instagram receives');
    assert.deepEqual(
      g.calls.filter((c) => c[0] === 'picture').map((c) => c[1]).sort(),
      ['https://cdn.instagram.test/QAig001x-thumb.jpg', 'https://cdn.instagram.test/QAig002x.jpg', 'https://cdn.instagram.test/QAig003x-thumb.jpg'],
      'a reel\'s picture is its thumbnail, a photo\'s is the photo',
    );

    const row = await connection();
    assert.equal(row.username, 'corcotton.qa');
    assert.equal(row.status, 'CONNECTED');
    assert.ok(!leaks(row.token_ciphertext), 'the stored token is ciphertext');
    assert.equal(crypto.decryptProviderSecret(row.token_ciphertext), TOKEN, 'and decrypts to the pasted token');
    assert.equal(row.token_expires_at, null, 'expiry unknown until the first renewal');
    assert.equal(new Date(row.token_refresh_after).getTime(), connectedAt + DAY, 'first renewal no earlier than 24 hours');

    const status = await svc.status(BRAND);
    assert.ok(!leaks(status) && !JSON.stringify(status).includes(row.token_ciphertext), 'status carries neither token nor ciphertext');
    assert.deepEqual({ connected: status.connected, username: status.username, posts: status.posts }, { connected: true, username: 'corcotton.qa', posts: { live: 3, withCover: 3 } });

    const attempts = await query("SELECT operation, outcome, normalized_error_code FROM provider_attempts WHERE capability = 'social' AND provider_key = 'INSTAGRAM' AND resource_id = ?", [BRAND]);
    assert.ok(attempts.some((a) => a.operation === 'instagram.profile' && a.outcome === 'SUCCESS'), 'a successful check is recorded');
    assert.ok(attempts.some((a) => a.operation === 'instagram.profile' && a.outcome === 'FAILURE' && a.normalized_error_code === 'PROVIDER_AUTH_FAILED'), 'the rejected token is recorded as an auth failure');
    assert.ok(attempts.some((a) => a.operation === 'instagram.media.list' && a.outcome === 'SUCCESS'));
    assert.ok(!leaks(attempts), 'no token in provider attempts');
    pass('INSTAGRAM_CONNECT');
  }

  // ---- 3. sync: upsert, removal window, picture copies -----------------------
  {
    g.calls.length = 0;
    const p1 = post(1, { caption: 'Edited on Instagram' });
    const p4 = post(4, { image: true });
    g.badPictures.add(p4.media_url);
    g.posts = [p4, post(3), p1]; // post 2 deleted on Instagram
    const r = await svc.sync(BRAND);
    assert.deepEqual({ added: r.added, removed: r.removed, coversCopied: r.coversCopied, coverFailures: r.coverFailures }, { added: 1, removed: 1, coversCopied: 0, coverFailures: 1 });
    assert.equal(g.count('picture'), 1, 'pictures already copied are not downloaded again');
    let rows = await igRows();
    const byId = Object.fromEntries(rows.map((x) => [x.ig_media_id, x]));
    assert.equal(byId[p1.id].caption, 'Edited on Instagram', 'captions follow Instagram');
    assert.equal(byId[post(2).id].status, 'REMOVED', 'a post deleted on Instagram is REMOVED');
    assert.equal(byId[p4.id].cover_media_id, null, 'a picture that failed to copy stays empty');
    const conn = await connection();
    assert.match(conn.last_sync_error, /1 post picture could not be copied/, 'the failed copy is reported');
    assert.ok(conn.last_synced_at, 'sync time recorded');

    g.badPictures.clear();
    const again = await svc.sync(BRAND);
    assert.equal(again.coversCopied, 1, 'the next sync copies the missing picture');
    assert.equal((await connection()).last_sync_error, null, 'and clears the report');

    // Instagram returns at most 50 posts; an older post outside that window
    // is not "deleted", only not fetched.
    g.posts = Array.from({ length: 50 }, (_, i) => post(100 + i, { at: new Date(Date.UTC(2026, 8, 10, 0, i)).toISOString() })).reverse();
    const window = await svc.sync(BRAND);
    assert.equal(window.fetched, 50);
    assert.equal(window.removed, 0, 'posts older than the fetched window stay live');
    rows = await igRows();
    assert.equal(rows.find((x) => x.ig_media_id === p1.id).status, 'ACTIVE');
    assert.equal(rows.filter((x) => x.status === 'ACTIVE').length, 53);

    g.failWith = new ProviderError({ code: 'PROVIDER_UNAVAILABLE', message: 'Instagram said: HTTP 503' });
    await rejectsWith(() => svc.sync(BRAND), 'INSTAGRAM_UNAVAILABLE', 'Instagram down');
    assert.equal((await connection()).status, 'CONNECTED', 'an outage is not an auth failure');
    assert.equal((await igRows()).filter((x) => x.status === 'ACTIVE').length, 53, 'an outage removes nothing');
    g.failWith = null;
    pass('INSTAGRAM_SYNC');
  }

  // ---- 4. homepage feed -------------------------------------------------------
  {
    // Back to a small account: the 50 window posts are gone from Instagram.
    g.posts = [post(4, { image: true }), post(3), post(1, { caption: 'Edited on Instagram' })];
    await svc.sync(BRAND);
    const section = (config) => [{ key: 'instagram_videos', type: 'INSTAGRAM_VIDEOS', config: { heading: 'Real People. Real Style.', ...config } }];
    const [latest] = await resolveInstagramSections(section({ mode: 'LATEST', limit: 3 }), { brandId: BRAND });
    assert.deepEqual(latest.config.posts.map((p) => p.id), [post(4).id, post(3).id, post(1).id], 'latest: newest first, removed posts left out');
    assert.deepEqual(Object.keys(latest.config.posts[0]).sort(), ['caption', 'coverUrl', 'embedUrl', 'id', 'kind', 'permalink']);
    assert.equal(latest.config.posts[0].kind, 'post');
    assert.equal(latest.config.posts[1].kind, 'reel');
    assert.equal(latest.config.posts[1].embedUrl, 'https://www.instagram.com/p/QAig003x/embed/');
    assert.equal(latest.config.posts[1].caption, 'Caption 3', 'caption trimmed');
    assert.ok(!('mode' in latest.config) && !('picks' in latest.config) && !('limit' in latest.config), 'editing settings stay private');

    const [picked] = await resolveInstagramSections(section({ mode: 'PICKED', picks: [
      { igMediaId: post(1).id, enabled: true }, { igMediaId: post(2).id, enabled: true }, { igMediaId: post(3).id, enabled: false }, { igMediaId: post(4).id },
    ] }), { brandId: BRAND });
    assert.deepEqual(picked.config.posts.map((p) => p.id), [post(1).id, post(4).id], 'picked: editor order, hidden and deleted posts left out');

    const [cover] = await query('SELECT cover_media_id FROM instagram_media WHERE brand_id = ? AND ig_media_id = ?', [BRAND, post(1).id]);
    assert.ok(await referenceCount(cover.cover_media_id) >= 1, 'a picture in use by Instagram posts counts as in use');
    pass('INSTAGRAM_HOMEPAGE_FEED');
  }

  // ---- 5. renewal -------------------------------------------------------------
  {
    g.calls.length = 0;
    clock = new Date(connectedAt + 1 * HOUR);
    assert.deepEqual(await svc.renewIfDue(BRAND), { renewed: false, reason: 'too early' });
    assert.equal(g.count('refresh'), 0, 'Instagram refuses renewing a token under 24 hours old; we do not ask');

    clock = new Date(connectedAt + 25 * HOUR);
    g.refreshResult = { token: TOKEN2, expiresInSeconds: 60 * 24 * 3600 };
    const renewed = await svc.renewIfDue(BRAND);
    assert.equal(renewed.renewed, true);
    assert.deepEqual(g.calls.filter((c) => c[0] === 'refresh'), [['refresh', TOKEN]], 'renewal uses the stored token');
    let row = await connection();
    const expires = clock.getTime() + 60 * DAY;
    assert.equal(crypto.decryptProviderSecret(row.token_ciphertext), TOKEN2, 'the renewed token replaces the old one, encrypted');
    assert.equal(new Date(row.token_expires_at).getTime(), expires, 'the expiry Instagram reported');
    assert.equal(new Date(row.token_refreshed_at).getTime(), clock.getTime());
    assert.equal(new Date(row.token_refresh_after).getTime(), expires - 20 * DAY, 'next renewal 20 days before expiry');

    clock = new Date(connectedAt + 30 * HOUR);
    assert.deepEqual(await svc.renewIfDue(BRAND), { renewed: false, reason: 'too early' });
    clock = new Date(expires - 19 * DAY);
    g.refreshResult = { token: TOKEN, expiresInSeconds: 60 * 24 * 3600 };
    assert.equal((await svc.renewIfDue(BRAND)).renewed, true, 'renewed again inside the last 20 days');
    assert.equal(g.calls.filter((c) => c[0] === 'refresh').at(-1)[1], TOKEN2, 'with the token it had');

    clock = new Date(clock.getTime() + 45 * DAY);
    g.failWith = new ProviderError({ code: 'PROVIDER_AUTH_FAILED', message: 'Instagram said: Error validating access token' });
    await rejectsWith(() => svc.renewIfDue(BRAND), 'INSTAGRAM_TOKEN_REJECTED', 'a revoked token');
    row = await connection();
    assert.equal(row.status, 'AUTH_FAILED', 'a rejected renewal marks the account');
    assert.ok(row.last_sync_error && !leaks(row.last_sync_error), 'with a readable reason, no token');
    g.failWith = null;

    g.calls.length = 0;
    const pass1 = await svc.maintainAll({ brandId: BRAND });
    assert.deepEqual(pass1, { accounts: 0, synced: 0, failed: 0 }, 'the worker leaves an account that needs reconnecting alone');
    assert.equal(g.calls.length, 0);
    assert.deepEqual(await svc.renewIfDue(BRAND), { renewed: false, reason: 'not connected' });

    // Reconnecting with a fresh token recovers it; the worker then syncs.
    g.posts = [post(4, { image: true }), post(3), post(1, { caption: 'Edited on Instagram' })];
    await svc.connect(BRAND, TOKEN2);
    const pass2 = await svc.maintainAll({ brandId: BRAND });
    assert.deepEqual(pass2, { accounts: 1, synced: 1, failed: 0 });
    pass('INSTAGRAM_TOKEN_RENEWAL');
  }

  // ---- 6. graph client --------------------------------------------------------
  {
    const seen = [];
    const reply = (status, body, headers = {}) => ({
      ok: status >= 200 && status < 300, status,
      json: async () => body,
      arrayBuffer: async () => new TextEncoder().encode(typeof body === 'string' ? body : 'x').buffer,
      headers: { get: (h) => headers[h.toLowerCase()] ?? null },
    });
    let next = [];
    const client = createInstagramGraphClient({
      timeoutMs: 30,
      fetchImpl: async (url, init) => {
        seen.push(url);
        const step = next.shift();
        return typeof step === 'function' ? step(url, init) : step;
      },
    });

    next = [reply(200, { user_id: '17841400000000001', username: 'corcotton.qa', account_type: 'MEDIA_CREATOR' })];
    assert.deepEqual(await client.profile(TOKEN), { igUserId: '17841400000000001', username: 'corcotton.qa', accountType: 'MEDIA_CREATOR' });
    let u = new URL(seen.at(-1));
    assert.equal(`${u.origin}${u.pathname}`, 'https://graph.instagram.com/v25.0/me');
    assert.equal(u.searchParams.get('fields'), 'user_id,username,account_type');
    assert.equal(u.searchParams.get('access_token'), TOKEN);

    next = [
      reply(200, { data: [post(9), post(8)], paging: { cursors: { after: 'CUR1' }, next: 'https://graph.instagram.com/next' } }),
      reply(200, { data: [post(7), post(6)], paging: { cursors: { after: 'CUR2' }, next: 'https://graph.instagram.com/next' } }),
    ];
    const media = await client.recentMedia(TOKEN, { max: 3 });
    assert.deepEqual(media.map((m) => m.id), [post(9).id, post(8).id, post(7).id], 'follows pages and stops at max');
    u = new URL(seen.at(-1));
    assert.equal(u.pathname, '/v25.0/me/media');
    assert.equal(u.searchParams.get('after'), 'CUR1');
    assert.equal(u.searchParams.get('limit'), '1');
    assert.match(u.searchParams.get('fields'), /thumbnail_url/);

    next = [reply(200, { access_token: TOKEN2, token_type: 'bearer', expires_in: 5183944 })];
    assert.deepEqual(await client.refresh(TOKEN), { token: TOKEN2, expiresInSeconds: 5183944 });
    u = new URL(seen.at(-1));
    assert.equal(`${u.origin}${u.pathname}`, 'https://graph.instagram.com/refresh_access_token');
    assert.equal(u.searchParams.get('grant_type'), 'ig_refresh_token');

    const mapped = async (step, fn, code, what) => {
      next = [step];
      await rejectsWith(fn, code, what);
    };
    await mapped(reply(400, { error: { message: 'Invalid OAuth access token - Cannot parse access token', type: 'OAuthException', code: 190 } }), () => client.profile(TOKEN), 'PROVIDER_AUTH_FAILED', 'error 190');
    await mapped(reply(403, { error: { message: 'Application does not have permission', code: 10 } }), () => client.recentMedia(TOKEN), 'PROVIDER_AUTH_FAILED', 'missing permission');
    await mapped(reply(400, { error: { message: 'Application request limit reached', code: 4 } }), () => client.recentMedia(TOKEN), 'RATE_LIMITED', 'rate limit');
    await mapped(reply(503, null), () => client.profile(TOKEN), 'PROVIDER_UNAVAILABLE', 'a 5xx');
    await mapped((_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))), () => client.profile(TOKEN), 'PROVIDER_TIMEOUT', 'a timeout');
    await mapped(() => Promise.reject(new Error(`getaddrinfo ENOTFOUND for ${TOKEN}`)), () => client.profile(TOKEN), 'PROVIDER_UNAVAILABLE', 'a network failure');
    await mapped(reply(200, { access_token: TOKEN2 }), () => client.refresh(TOKEN), 'PROVIDER_RESPONSE_INVALID', 'a renewal without expiry');
    await mapped(reply(200, { username: 'x' }), () => client.profile(TOKEN), 'PROVIDER_RESPONSE_INVALID', 'a profile without an id');
    await mapped(reply(200, '<html>', { 'content-type': 'text/html' }), () => client.downloadPicture('https://cdn.instagram.test/a.jpg'), 'PROVIDER_RESPONSE_INVALID', 'a picture that is not an image');
    next = [reply(200, 'jpegbytes', { 'content-type': 'image/jpeg' })];
    assert.ok((await client.downloadPicture('https://cdn.instagram.test/a.jpg')).length > 0);
    pass('INSTAGRAM_GRAPH_CLIENT');
  }

  // ---- 7. disconnect --------------------------------------------------------
  {
    assert.deepEqual(await svc.disconnect(BRAND), { disconnected: true });
    assert.equal(await connection(), null, 'the token is gone');
    assert.ok((await igRows()).some((x) => x.status === 'ACTIVE'), 'the posts stay, so the homepage keeps working');
    await rejectsWith(() => svc.sync(BRAND), 'INSTAGRAM_NOT_CONNECTED', 'sync after disconnect');
    const s = await svc.status(BRAND);
    assert.equal(s.connected, false);
    pass('INSTAGRAM_DISCONNECT');
  }

  // ---- 8. CMS routes: RBAC and no token in responses ----------------------------
  {
    await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@instagram-gate.test'");
    for (const role of ['ADMIN', 'OPERATIONS', 'CATALOG_MANAGER']) {
      await staffAuthService.createStaffUser({ email: email(role), password: PW, firstName: role, lastName: 'T', role });
    }
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    BASE = `http://127.0.0.1:${server.address().port}`;
    const admin = await loginCookie('ADMIN');
    const ops = await loginCookie('OPERATIONS');
    const cm = await loginCookie('CATALOG_MANAGER');
    const CONN = '/api/v1/admin/providers/social/INSTAGRAM/connection';

    assert.equal((await call(CONN)).status, 401, 'signed out');
    assert.equal((await call(CONN, { cookie: cm })).status, 403, 'content staff cannot see the connection');
    assert.equal((await call('/api/v1/admin/instagram/posts', { cookie: cm })).status, 200, 'content staff can pick from synced posts');
    const opsRead = await call(CONN, { cookie: ops });
    assert.equal(opsRead.status, 200, 'providers.read sees the connection');
    assert.ok(!/token_ciphertext|accessToken|access_token/i.test(opsRead.text), 'no token field in the response');
    assert.equal((await call(CONN, { method: 'PUT', cookie: ops, body: { accessToken: TOKEN } })).status, 403, 'providers.read cannot connect');
    assert.equal((await call('/api/v1/admin/providers/social/INSTAGRAM/sync', { method: 'POST', cookie: ops })).status, 403, 'providers.read cannot sync');
    assert.equal((await call(CONN, { method: 'DELETE', cookie: ops })).status, 403, 'providers.read cannot disconnect');
    const bad = await call(CONN, { method: 'PUT', cookie: admin, body: { accessToken: 'not a token' } });
    assert.equal(bad.status, 422, 'a malformed token is refused before anything else');
    assert.equal(bad.json.error.code, 'INSTAGRAM_TOKEN_INVALID');
    const overview = await call('/api/v1/admin/providers', { cookie: ops });
    assert.equal(overview.status, 200);
    assert.ok(overview.json.data.some((p) => p.capability === 'social' && p.providerKey === 'INSTAGRAM'), 'Instagram is listed with the other providers');
    pass('INSTAGRAM_CMS_RBAC');
  }

  {
    const audit = await query("SELECT COUNT(*) AS c FROM staff_audit_logs WHERE metadata_json LIKE '%SECRETTOKEN%'");
    assert.equal(Number(audit[0].c), 0, 'no token in the audit log');
    const attempts = await query("SELECT COUNT(*) AS c FROM provider_attempts WHERE resource_id = ? AND (operation LIKE '%SECRETTOKEN%' OR normalized_error_code LIKE '%SECRETTOKEN%')", [BRAND]);
    assert.equal(Number(attempts[0].c), 0);
    assert.equal(externalCalls, 0, 'nothing left this machine');
    pass('INSTAGRAM_NO_TOKEN_LEAK_NO_EXTERNAL_CALLS');
  }

  console.log('\nINSTAGRAM_INTEGRATION_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nINSTAGRAM_INTEGRATION_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
