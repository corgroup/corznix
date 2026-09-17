// Google redirect sign-in: which origins the callback accepts, the one-time
// nonce that binds a Google ID token to the browser that started the sign-in,
// and that a rejected origin is logged.
//
// No network. GOOGLE_CLIENT_ID is blanked so no credential can ever verify, and
// the binding on the success path is proven at the service with an injected
// verifier. A real Google token can only be exercised by a person signing in.
//
//   npm run verify:google-redirect
import assert from 'node:assert/strict';

process.env.GOOGLE_CLIENT_ID = '';
process.env.TRUST_PROXY = '1';

// Everything the process writes, so the rejection log line can be asserted.
const captured = [];
for (const stream of [process.stdout, process.stderr]) {
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => { captured.push(String(chunk)); return write(chunk, ...rest); };
}

const { createApp } = await import('../src/app.js');
const { allowedOrigins } = await import('../src/config/index.js');
const { pool } = await import('../src/database/connection/pool.js');
const { AuthService } = await import('../src/modules/auth/service.js');

const NONCE = 'cor_group_google_nonce';
const CALLBACK = '/api/v1/auth/google/callback';
const results = {};

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
let ipSeq = 0;

async function post(path, { origin, cookie, form, json } = {}) {
  const headers = { 'x-forwarded-for': `198.51.100.${(ipSeq++ % 250) + 1}` };
  if (origin !== undefined) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  if (json) { headers['content-type'] = 'application/json'; body = JSON.stringify(json); }
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers, body, redirect: 'manual' });
  const location = res.headers.get('location');
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a redirect has no JSON body */ }
  const params = location ? new URL(location).searchParams : null;
  return {
    status: res.status,
    google: params?.get('google') ?? null,
    reason: params?.get('reason') ?? null,
    setCookies: res.headers.getSetCookie?.() || [],
    corsHeader: res.headers.get('access-control-allow-origin'),
    json: parsed,
  };
}
const cookieLine = (setCookies, name) => setCookies.find((c) => c.startsWith(`${name}=`)) || '';
const cleared = (setCookies, name) => /expires=Thu, 01 Jan 1970/i.test(cookieLine(setCookies, name));

try {
  const ORIGIN = allowedOrigins[0];

  // 1 — the storefront is issued a nonce, kept where the callback can read it --
  const first = await post('/api/v1/auth/google/nonce', { origin: ORIGIN });
  assert.equal(first.status, 200, `nonce -> ${first.status} ${JSON.stringify(first.json)}`);
  const nonce = first.json?.data?.nonce;
  assert.match(nonce || '', /^[A-Za-z0-9_-]{43}$/, '32 random bytes, base64url');
  const line = cookieLine(first.setCookies, NONCE);
  assert.ok(line.startsWith(`${NONCE}=${nonce};`), 'the cookie holds the nonce the page was given');
  for (const attr of [/HttpOnly/i, /Secure/i, /SameSite=None/i, /Path=\/api\/v1\/auth\/google(;|$)/i, /Max-Age=1800/i]) {
    assert.match(line, attr, `nonce cookie ${attr}`);
  }
  const second = await post('/api/v1/auth/google/nonce', { origin: ORIGIN });
  assert.notEqual(second.json?.data?.nonce, nonce, 'every issue is fresh');
  results.nonceIssued = 'PASS';

  // 2 — every origin Google's form post really arrives with reaches the handler
  for (const origin of ['null', 'https://accounts.google.com', undefined]) {
    const r = await post(CALLBACK, { origin, form: { credential: 'x', g_csrf_token: 'y' } });
    assert.equal(r.status, 302, `origin ${origin} must not be refused before the handler (got ${r.status})`);
    assert.equal(r.reason, 'expired', `origin ${origin}: without a nonce the sign-in has expired`);
    assert.equal(r.corsHeader, null, 'a form navigation gets no CORS headers');
  }
  results.googleOriginsAccepted = 'PASS';

  // 3 — any other origin is still refused, and the refusal is now logged --------
  const evil = await post(CALLBACK, { origin: 'https://evil.example', form: { credential: 'x' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.json?.error?.code, 'ORIGIN_FORBIDDEN');
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  const logText = captured.join('');
  assert.match(logText, /origin_rejected[^\n]*https:\/\/evil\.example/, 'the rejected origin is named in the log');
  const refusedLines = logText.match(/"route":"\/api\/v1\/auth\/google\/callback","status":403/g) || [];
  assert.equal(refusedLines.length, 1, `the refused request is logged exactly once (got ${refusedLines.length})`);
  results.otherOriginsRefusedAndLogged = 'PASS';

  // 4 — failure paths with a nonce present; the nonce never survives a use ------
  const noCredential = await post(CALLBACK, { origin: 'null', cookie: `${NONCE}=${nonce}`, form: {} });
  assert.equal(noCredential.reason, 'no_credential');
  assert.ok(cleared(noCredential.setCookies, NONCE), 'nonce cleared after use');
  const bogus = await post(CALLBACK, {
    origin: 'https://accounts.google.com', cookie: `${NONCE}=${nonce}`, form: { credential: 'not-a-token', g_csrf_token: 'a' },
  });
  assert.equal(bogus.reason, 'verify', 'an unverifiable token is a verify failure');
  assert.ok(cleared(bogus.setCookies, NONCE), 'nonce cleared after a failed verification');
  const disagreeing = await post(CALLBACK, {
    origin: 'null', cookie: `${NONCE}=${nonce}; g_csrf_token=one`, form: { credential: 'x', g_csrf_token: 'two' },
  });
  assert.equal(disagreeing.reason, 'csrf', 'a double-submit pair that is present must agree');
  results.callbackFailurePaths = 'PASS';

  // 5 — the binding itself, at the service --------------------------------------
  const claims = { sub: 'verify-google-sub', email: 'verify.google@example.test', firstName: 'V', lastName: 'G', nonce: 'nonce-A' };
  const codeOf = async (promise) => { try { await promise; return 'OK'; } catch (error) { return error?.code || error?.name; } };
  const withNonce = new AuthService({ googleVerifier: async () => claims });
  const withoutNonce = new AuthService({ googleVerifier: async () => ({ ...claims, nonce: null }) });
  assert.equal(await codeOf(withNonce.loginWithGoogle({ credential: 't', expectedNonce: 'nonce-B', brandId: 'b' })), 'GOOGLE_NONCE_MISMATCH', 'a token issued to another browser is refused');
  assert.equal(await codeOf(withoutNonce.loginWithGoogle({ credential: 't', expectedNonce: 'nonce-A', brandId: 'b' })), 'GOOGLE_NONCE_MISMATCH', 'a token without a nonce is refused on the redirect path');
  assert.equal(await codeOf(withNonce.loginWithGoogle({ credential: 't', expectedNonce: 'nonce-AB', brandId: 'b' })), 'GOOGLE_NONCE_MISMATCH', 'lengths differ: still refused, never thrown');
  // A matching nonce passes the binding and moves on to the account lookup
  // (the repositories are absent here, so it stops there with a TypeError).
  assert.notEqual(await codeOf(withNonce.loginWithGoogle({ credential: 't', expectedNonce: 'nonce-A', brandId: 'b' })), 'GOOGLE_NONCE_MISMATCH');
  assert.notEqual(await codeOf(withoutNonce.loginWithGoogle({ credential: 't', brandId: 'b' })), 'GOOGLE_NONCE_MISMATCH', 'the JSON sign-in path is unchanged');
  results.nonceBinding = 'PASS';

  results.status = 'PASS';
  console.log('\nGOOGLE_REDIRECT_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nGOOGLE_REDIRECT_VERIFICATION = FAIL');
  console.error(error);
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => { server.close(resolve); });
  await pool.end();
}
