// Customer login-flow characterization (Provider Platform Migration — Phase 1).
//
// Freezes the OBSERVABLE behaviour of the current working customer login flow
// so that later auth-provider adapter work can prove
// `Current Login Flow Before == Current Login Flow After`. Runs against the
// local dev database over a real HTTP listener (Node global fetch against
// app.listen(0) — no supertest), exactly like verify-staff-auth.js.
//
// It exercises the real endpoints, the real AuthService / OTP crypto / JWT /
// session code, and the real MockOtpProvider delivery path (OTP is read back
// from the `[DEV OTP]` console line the mock provider prints — never sent
// anywhere). No external provider is contacted; NO_EXTERNAL_PROVIDER_CALLS
// asserts that.
//
// Test-run overrides (documented so a reader knows what is NOT frozen here):
//   OTP_PROVIDER_MODE=MOCK              — console delivery, no WhatsApp/SMTP
//   OTP_RESEND_COOLDOWN_SECONDS         — left at the real 60s. It used to be
//                                        forced to 1 so the supersede test
//                                        could sleep past it, which made the
//                                        cooldown test itself a race: on a
//                                        slow runner the second request landed
//                                        after the 1s window and got 200 where
//                                        429 was asserted. The supersede test
//                                        now ages the challenge row instead of
//                                        sleeping, so the real cooldown stands.
//   TRUST_PROXY=1 + per-scenario X-Forwarded-For — isolates the IP-keyed
//                                        rate limiters so functional tests
//                                        don't trip them (the limiter itself
//                                        is characterized on its own IP)
//   GOOGLE_CLIENT_ID=''                 — forces the "not verifiable" path
//                                        without a network call; the Google
//                                        happy-path can only be characterized
//                                        on staging with a real GIS credential
//
// Non-destructive: every customer/contact/identity/session/otp_challenge it
// creates carries a test marker and is removed in `finally`.
//
//   npm run verify:customer-auth
import assert from 'node:assert/strict';

process.env.OTP_PROVIDER_MODE = 'MOCK';
process.env.TRUST_PROXY = '1';
process.env.GOOGLE_CLIENT_ID = '';

// ---- external-call tripwire -------------------------------------------------
let externalCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) externalCalls += 1;
  return realFetch(input, init);
};

// ---- OTP capture: read the code from the mock provider's console line ------
const otpByDestination = new Map();
const realLog = console.log;
console.log = (...args) => {
  const line = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
  const match = /\[DEV OTP\] destination=(\S+) purpose=(\S+) otp=(\d{4})/.exec(line);
  if (match) {
    otpByDestination.set(match[1], match[3]);
    return; // swallow the code so it never reaches the run log
  }
  realLog(...args);
};

const { createApp } = await import('../src/app.js');
const { allowedOrigins } = await import('../src/config/index.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { normalizePhone, normalizeEmail } = await import('../src/utils/normalize.js');

const ORIGIN = allowedOrigins[0]; // http://localhost:5173 (storefront)
const EMAIL_DOMAIN = '@corcotton-authchar.test';
const RUN = Date.now();
let emailSeq = 0;
const freshEmail = () => `authchar.${RUN}.${emailSeq++}${EMAIL_DOMAIN}`;

const createdPhones = [];
// The cleanup below deletes every customer that owns one of these numbers, so a
// number that already belongs to someone must never be handed out: a collision
// with another gate's fixture (or a developer's own test account) made this
// script delete rows it did not create, and fail on their foreign keys.
async function freshPhone() {
  for (let i = 0; i < 80; i += 1) {
    const local = `9${Math.floor(100000000 + Math.random() * 899999999)}`; // 10 digits, 9-series
    const norm = normalizePhone(local);
    if (!norm || createdPhones.includes(norm)) continue;
    const [taken] = await query('SELECT id FROM customer_contacts WHERE contact_type = ? AND normalized_value = ? LIMIT 1', ['PHONE', norm]);
    if (taken) continue;
    createdPhones.push(norm);
    return { raw: `+91${local}`, norm };
  }
  throw new Error('could not generate a valid Indian test mobile');
}

let ipSeq = 0;
const nextClientIp = () => `198.51.100.${(ipSeq++ % 250) + 1}`;

const server = createApp().listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function call(path, { method = 'GET', body, cookie, origin, xff } = {}) {
  const headers = { 'x-forwarded-for': xff || nextClientIp() };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const json = await res.json().catch(() => null);
  return { status: res.status, json, setCookies, headers: res.headers };
}

const cookieValue = (setCookies, name) => {
  for (const raw of setCookies) {
    const match = new RegExp(`(?:^|; )${name}=([^;]+)`).exec(raw);
    if (match && match[1] && match[1] !== '') return match[1];
  }
  return null;
};
const cookieAttrs = (setCookies, name) => setCookies.find((raw) => raw.startsWith(`${name}=`)) || '';
const SESSION = 'cor_group_session';
const REFRESH = 'cor_group_refresh';

const results = {};
const pass = (name) => { results[name] = 'PASS'; realLog(`  PASS  ${name}`); };

// Request an OTP and return { challengeId, otp, normalized }.
async function requestOtp(identifier, expectChannel, xff) {
  const ip = xff || nextClientIp();
  const res = await call('/api/v1/auth/otp/request', { method: 'POST', body: { identifier }, xff: ip });
  assert.equal(res.status, 200, `otp/request(${identifier}) -> ${res.status} ${JSON.stringify(res.json)}`);
  assert.equal(res.json.data.channel, expectChannel);
  assert.match(res.json.data.challengeId, /^[0-9a-f-]{36}$/);
  const normalized = expectChannel === 'WHATSAPP' ? normalizePhone(identifier) : normalizeEmail(identifier);
  const otp = otpByDestination.get(normalized);
  assert.ok(/^\d{4}$/.test(otp || ''), `captured 4-digit OTP for ${normalized}`);
  return { challengeId: res.json.data.challengeId, otp, normalized, ip, requestBody: res.json.data };
}

async function login(identifier, expectChannel, xff) {
  const { challengeId, otp, ip } = await requestOtp(identifier, expectChannel, xff);
  const verify = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId, otp }, xff: ip });
  return { verify, challengeId, otp, ip };
}

try {
  // 1 — guest session bootstrap ---------------------------------------------
  {
    const res = await call('/api/v1/auth/session');
    assert.equal(res.status, 200);
    // refreshable:false is what stops the storefront spending a refresh that
    // can only 401 — a genuine guest has no refresh cookie to spend.
    assert.deepEqual(res.json.data, { authenticated: false, customer: null, refreshable: false });
    pass('SESSION_BOOTSTRAP_GUEST');
  }

  // 1b — an expired access token must still be recoverable ------------------
  // Same authenticated:false as a guest, but a refresh cookie is present, so
  // the storefront must still try. Presence only; /refresh judges validity.
  {
    const res = await call('/api/v1/auth/session', { cookie: `${REFRESH}=present-but-unverified` });
    assert.equal(res.status, 200);
    assert.equal(res.json.data.authenticated, false);
    assert.equal(res.json.data.refreshable, true, 'a present refresh cookie must be reported as refreshable');
    pass('SESSION_SIGNALS_REFRESHABLE');
  }

  // 2/3/4 — channel is derived server-side from the identifier shape --------
  {
    const emailReq = await requestOtp(freshEmail(), 'EMAIL');
    assert.equal(typeof emailReq.requestBody.expiresInSeconds, 'number');
    assert.equal(emailReq.requestBody.expiresInSeconds, 300);
    assert.equal(typeof emailReq.requestBody.resendAfterSeconds, 'number');

    const { raw } = await freshPhone();
    await requestOtp(raw, 'WHATSAPP');

    // digits in an email local-part must not misroute to the phone channel.
    // Stamped with the run: a fixed local-part shares the real 60s per-identifier
    // resend cooldown with the previous run, so two runs inside a minute made
    // this line 429 and the gate fail for a reason that was never the code.
    await requestOtp(`digits20260101.${RUN}${EMAIL_DOMAIN}`, 'EMAIL');
    pass('OTP_CHANNEL_DERIVED_SERVERSIDE');
  }

  // 5/6 — input validation -------------------------------------------------
  {
    const badId = await call('/api/v1/auth/otp/request', { method: 'POST', body: { identifier: 'not-valid' } });
    assert.equal(badId.status, 400);
    assert.equal(badId.json.error.code, 'VALIDATION_ERROR');

    const badChallenge = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId: 'nope', otp: '1234' } });
    assert.equal(badChallenge.status, 400);
    assert.equal(badChallenge.json.error.code, 'VALIDATION_ERROR');

    const badOtp = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId: '00000000-0000-0000-0000-000000000000', otp: '12' } });
    assert.equal(badOtp.status, 400);
    assert.equal(badOtp.json.error.code, 'VALIDATION_ERROR');
    pass('INPUT_VALIDATION_CONTRACT');
  }

  // 7 — wrong code -------------------------------------------------------
  {
    const { challengeId, otp, ip } = await requestOtp(freshEmail(), 'EMAIL');
    const wrong = String((Number(otp) + 1) % 10000).padStart(4, '0');
    const res = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId, otp: wrong }, xff: ip });
    assert.equal(res.status, 400);
    assert.equal(res.json.error.code, 'OTP_INVALID');
    pass('OTP_VERIFY_WRONG_CODE');
  }

  // 8/9/10 — happy path (new customer), cookie contract, single-use --------
  let firstCustomerId;
  {
    const email = freshEmail();
    const { verify, challengeId, otp } = await login(email, 'EMAIL');
    assert.equal(verify.status, 200);
    assert.equal(verify.json.data.authenticated, true);

    const customer = verify.json.data.customer;
    assert.match(customer.id, /^[0-9a-f-]{36}$/);
    assert.equal(customer.profileComplete, false);
    assert.deepEqual([...customer.requiredFields].sort(), ['firstName', 'lastName', 'phone']);
    assert.equal(customer.email.value, email);
    assert.equal(customer.email.verified, true);
    firstCustomerId = customer.id;

    // tokens travel only in httpOnly cookies, never the JSON body
    const bodyText = JSON.stringify(verify.json);
    assert.ok(!/accessToken|refreshToken/i.test(bodyText), 'no token in response body');

    const sessionCookie = cookieAttrs(verify.setCookies, SESSION);
    const refreshCookie = cookieAttrs(verify.setCookies, REFRESH);
    assert.match(sessionCookie, /HttpOnly/i);
    assert.match(sessionCookie, /SameSite=Lax/i);
    assert.match(sessionCookie, /Path=\/(;|$| )/i);
    assert.match(refreshCookie, /HttpOnly/i);
    assert.match(refreshCookie, /Path=\/api\/v1\/auth/i);
    assert.ok(!/;\s*Secure/i.test(sessionCookie), 'no Secure flag outside production');
    pass('OTP_LOGIN_NEW_CUSTOMER');

    const sessionValue = cookieValue(verify.setCookies, SESSION);
    const session = await call('/api/v1/auth/session', { cookie: `${SESSION}=${sessionValue}` });
    assert.equal(session.status, 200);
    assert.equal(session.json.data.authenticated, true);
    assert.equal(session.json.data.customer.id, firstCustomerId);
    pass('SESSION_COOKIE_AUTHENTICATES');

    const reuse = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId, otp } });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.json.error.code, 'OTP_ALREADY_USED');
    pass('OTP_CHALLENGE_SINGLE_USE');
  }

  // 11 — resend cooldown (per-destination, not per-IP) ---------------------
  {
    const email = freshEmail();
    await requestOtp(email, 'EMAIL');
    const again = await call('/api/v1/auth/otp/request', { method: 'POST', body: { identifier: email } });
    assert.equal(again.status, 429);
    assert.equal(again.json.error.code, 'OTP_RATE_LIMITED');
    pass('OTP_RESEND_COOLDOWN');
  }

  // 12 — an accepted resend supersedes every older pending code -----------
  {
    const email = freshEmail();
    const first = await requestOtp(email, 'EMAIL');
    // Age the pending challenge past the cooldown instead of sleeping through
    // it — the cooldown is measured from created_at, so this is exact and
    // instant, and it lets the cooldown itself stay at its real 60s (see 11).
    await query('UPDATE otp_challenges SET created_at = DATE_SUB(NOW(3), INTERVAL 10 MINUTE) WHERE id = ?', [first.challengeId]);
    const second = await requestOtp(email, 'EMAIL');
    assert.notEqual(first.challengeId, second.challengeId);

    const stale = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId: first.challengeId, otp: first.otp } });
    assert.equal(stale.status, 429);
    assert.equal(stale.json.error.code, 'OTP_RATE_LIMITED');

    const fresh = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId: second.challengeId, otp: second.otp } });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.json.data.authenticated, true, 'the newest code still authenticates');
    pass('OTP_RESEND_SUPERSEDES_PRIOR_CODE');
  }

  // 13 — expired challenge ----------------------------------------------
  {
    const { challengeId, otp, ip } = await requestOtp(freshEmail(), 'EMAIL');
    await query('UPDATE otp_challenges SET expires_at = DATE_SUB(NOW(3), INTERVAL 5 MINUTE) WHERE id = ?', [challengeId]);
    const res = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId, otp }, xff: ip });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'OTP_EXPIRED');
    pass('OTP_EXPIRED');
  }

  // 14 — attempt cap locks the challenge (default OTP_MAX_ATTEMPTS = 5) ----
  {
    const { raw } = await freshPhone();
    const { challengeId, otp, ip } = await requestOtp(raw, 'WHATSAPP');
    const wrong = String((Number(otp) + 1) % 10000).padStart(4, '0');
    const codes = [];
    for (let i = 0; i < 5; i += 1) {
      const res = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId, otp: wrong }, xff: ip });
      codes.push(`${res.status}:${res.json.error.code}`);
    }
    assert.deepEqual(codes.slice(0, 4), Array(4).fill('400:OTP_INVALID'));
    assert.equal(codes[4], '429:OTP_ATTEMPTS_EXCEEDED');

    const locked = await call('/api/v1/auth/otp/verify', { method: 'POST', body: { challengeId, otp }, xff: ip });
    assert.equal(locked.status, 429);
    assert.equal(locked.json.error.code, 'OTP_ATTEMPTS_EXCEEDED');
    pass('OTP_ATTEMPT_LOCKOUT');
  }

  // 15 — profile completion promotes PENDING_PROFILE -> ACTIVE ------------
  {
    const { raw } = await freshPhone();
    const { verify, ip } = await login(raw, 'WHATSAPP');
    assert.equal(verify.status, 200);
    assert.equal(verify.json.data.customer.profileComplete, false);
    const sessionValue = cookieValue(verify.setCookies, SESSION);

    const noAuth = await call('/api/v1/auth/profile/complete', { method: 'POST', body: { firstName: 'A', lastName: 'B' } });
    assert.equal(noAuth.status, 401);
    assert.equal(noAuth.json.error.code, 'AUTH_REQUIRED');

    const done = await call('/api/v1/auth/profile/complete', {
      method: 'POST',
      origin: ORIGIN,
      cookie: `${SESSION}=${sessionValue}`,
      body: { firstName: 'Char', lastName: 'Test', email: freshEmail() },
      xff: ip,
    });
    assert.equal(done.status, 200);
    assert.equal(done.json.data.customer.profileComplete, true);

    const [row] = await query('SELECT status, profile_completed_at FROM customers WHERE id = ?', [done.json.data.customer.id]);
    assert.equal(row.status, 'ACTIVE');
    assert.ok(row.profile_completed_at, 'profile_completed_at stamped');
    pass('PROFILE_COMPLETE_FLOW');
  }

  // 16 — protected storefront route -------------------------------------
  {
    const anon = await call('/api/v1/customers/me');
    assert.equal(anon.status, 401);
    assert.equal(anon.json.error.code, 'AUTH_REQUIRED');

    const { verify } = await login(freshEmail(), 'EMAIL');
    const sessionValue = cookieValue(verify.setCookies, SESSION);
    const me = await call('/api/v1/customers/me', { cookie: `${SESSION}=${sessionValue}` });
    assert.equal(me.status, 200);
    assert.equal(me.json.data.id, verify.json.data.customer.id);
    pass('PROTECTED_ROUTE_REQUIRES_AUTH');

    // Download Invoice, over the real route. It answered 500 on production for
    // every order because the route declared :id while the handler read
    // :orderId, so the ownership lookup ran with an undefined id — invisible to
    // every gate that called the service directly. Someone else's (here: a
    // non-existent) order must be an ordinary 404, never a 500.
    const strangersOrder = await call('/api/v1/orders/00000000-0000-4000-8000-000000000000/invoice', { cookie: `${SESSION}=${sessionValue}` });
    assert.equal(strangersOrder.status, 404, 'invoice route reached the handler with the order id');
    assert.equal(strangersOrder.json.error.code, 'ORDER_NOT_FOUND');
    pass('INVOICE_ROUTE_RESOLVES_THE_ORDER_ID');
  }

  // 17/18 — refresh rotates; reusing a rotated token revokes the session --
  {
    const { verify, ip } = await login(freshEmail(), 'EMAIL');
    const accessV1 = cookieValue(verify.setCookies, SESSION);
    const refreshV1 = cookieValue(verify.setCookies, REFRESH);

    const r1 = await call('/api/v1/auth/refresh', { method: 'POST', origin: ORIGIN, cookie: `${REFRESH}=${refreshV1}`, xff: ip });
    assert.equal(r1.status, 200);
    assert.deepEqual(r1.json.data, { authenticated: true });
    const refreshV2 = cookieValue(r1.setCookies, REFRESH);
    assert.ok(refreshV2 && refreshV2 !== refreshV1, 'refresh token rotated');

    const r2 = await call('/api/v1/auth/refresh', { method: 'POST', origin: ORIGIN, cookie: `${REFRESH}=${refreshV2}`, xff: ip });
    assert.equal(r2.status, 200, 'the rotated token works');
    const refreshV3 = cookieValue(r2.setCookies, REFRESH);
    pass('SESSION_REFRESH_ROTATES');

    const reuse = await call('/api/v1/auth/refresh', { method: 'POST', origin: ORIGIN, cookie: `${REFRESH}=${refreshV2}`, xff: ip });
    assert.equal(reuse.status, 401, 'reusing a rotated refresh token is rejected');

    const afterReuse = await call('/api/v1/auth/refresh', { method: 'POST', origin: ORIGIN, cookie: `${REFRESH}=${refreshV3}`, xff: ip });
    assert.equal(afterReuse.status, 401, 'token reuse revokes the whole session');

    const deadSession = await call('/api/v1/auth/session', { cookie: `${SESSION}=${accessV1}` });
    assert.equal(deadSession.status, 401);
    assert.equal(deadSession.json.error.code, 'SESSION_REVOKED');
    pass('REFRESH_TOKEN_REUSE_REVOKES_SESSION');
  }

  // 19 — refresh with no token --------------------------------------------
  {
    const res = await call('/api/v1/auth/refresh', { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(res.json.error.code, 'REFRESH_TOKEN_INVALID');
    pass('REFRESH_REQUIRES_TOKEN');
  }

  // 20 — logout revokes server-side authority ---------------------------
  {
    const { verify, ip } = await login(freshEmail(), 'EMAIL');
    const sessionValue = cookieValue(verify.setCookies, SESSION);
    const cookie = `${SESSION}=${sessionValue}`;

    assert.equal((await call('/api/v1/customers/me', { cookie })).status, 200);
    const out = await call('/api/v1/auth/logout', { method: 'POST', origin: ORIGIN, cookie, xff: ip });
    assert.equal(out.status, 200);
    assert.deepEqual(out.json.data, { loggedOut: true });

    const afterSession = await call('/api/v1/auth/session', { cookie });
    assert.equal(afterSession.status, 401);
    assert.equal(afterSession.json.error.code, 'SESSION_REVOKED');
    assert.equal((await call('/api/v1/customers/me', { cookie })).status, 401);
    pass('LOGOUT_REVOKES_SESSION');
  }

  // 20b — session expiry policy (idle timeout + maximum lifetime) ------------
  // A customer used to stay signed in indefinitely: every refresh pushed the
  // session 30 days further. Time is simulated by ageing the session row.
  {
    const policy = await import('../src/modules/auth/sessionPolicy.js');
    const sidOf = (setCookies) => cookieValue(setCookies, REFRESH).split('.')[0];
    const maxAgeOf = (setCookies, name) => Number((/Max-Age=(\d+)/i.exec(cookieAttrs(setCookies, name)) || [])[1]);

    // Refresh never extends the absolute deadline; the cookie ends with it.
    {
      const { verify, ip } = await login(freshEmail(), 'EMAIL');
      const sid = sidOf(verify.setCookies);
      const [row] = await query('SELECT expires_at, TIMESTAMPDIFF(SECOND, created_at, expires_at) AS span FROM auth_sessions WHERE id = ?', [sid]);
      assert.ok(Math.abs(Number(row.span) - policy.maxLifetimeSeconds()) <= 5, `login deadline = max lifetime (span ${row.span}s)`);
      assert.ok(maxAgeOf(verify.setCookies, REFRESH) <= policy.maxLifetimeSeconds(), 'refresh cookie never outlives the session');
      const r = await call('/api/v1/auth/refresh', { method: 'POST', origin: ORIGIN, cookie: `${REFRESH}=${cookieValue(verify.setCookies, REFRESH)}`, xff: ip });
      assert.equal(r.status, 200);
      const [after] = await query('SELECT expires_at FROM auth_sessions WHERE id = ?', [sid]);
      assert.equal(String(after.expires_at), String(row.expires_at), 'refresh left the absolute deadline where it was');
      pass('REFRESH_DOES_NOT_EXTEND_SESSION');
    }

    // Idle past the timeout: the access token is refused AND refresh is refused.
    {
      const { verify, ip } = await login(freshEmail(), 'EMAIL');
      const sid = sidOf(verify.setCookies);
      await query('UPDATE auth_sessions SET last_seen_at = NOW() - INTERVAL ? SECOND WHERE id = ?', [policy.idleTimeoutSeconds() + 60, sid]);
      const me = await call('/api/v1/customers/me', { cookie: `${SESSION}=${cookieValue(verify.setCookies, SESSION)}` });
      assert.equal(me.status, 401);
      assert.equal(me.json.error.code, 'SESSION_EXPIRED');
      const [row] = await query('SELECT status FROM auth_sessions WHERE id = ?', [sid]);
      assert.equal(row.status, 'EXPIRED');
      const r = await call('/api/v1/auth/refresh', { method: 'POST', origin: ORIGIN, cookie: `${REFRESH}=${cookieValue(verify.setCookies, REFRESH)}`, xff: ip });
      assert.equal(r.status, 401);
      assert.equal(r.json.error.code, 'SESSION_EXPIRED');

      // Refresh alone (the browser dropped the access cookie) is refused too.
      const second = await login(freshEmail(), 'EMAIL');
      await query('UPDATE auth_sessions SET last_seen_at = NOW() - INTERVAL ? SECOND WHERE id = ?', [policy.idleTimeoutSeconds() + 60, sidOf(second.verify.setCookies)]);
      const r2 = await call('/api/v1/auth/refresh', { method: 'POST', origin: ORIGIN, cookie: `${REFRESH}=${cookieValue(second.verify.setCookies, REFRESH)}`, xff: second.ip });
      assert.equal(r2.status, 401);
      assert.equal(r2.json.error.code, 'SESSION_EXPIRED');
      assert.ok(r2.setCookies.some((c) => c.startsWith(`${REFRESH}=;`)), 'a refused refresh clears the refresh cookie');
      pass('IDLE_TIMEOUT_EXPIRES_SESSION');
    }

    // Past the maximum lifetime, even a session in constant use ends.
    {
      const { verify, ip } = await login(freshEmail(), 'EMAIL');
      const sid = sidOf(verify.setCookies);
      await query('UPDATE auth_sessions SET created_at = NOW() - INTERVAL ? SECOND, last_seen_at = NOW() WHERE id = ?', [policy.maxLifetimeSeconds() + 60, sid]);
      const me = await call('/api/v1/customers/me', { cookie: `${SESSION}=${cookieValue(verify.setCookies, SESSION)}` });
      assert.equal(me.status, 401);
      assert.equal(me.json.error.code, 'SESSION_EXPIRED');
      const r = await call('/api/v1/auth/refresh', { method: 'POST', origin: ORIGIN, cookie: `${REFRESH}=${cookieValue(verify.setCookies, REFRESH)}`, xff: ip });
      assert.equal(r.status, 401);
      pass('MAX_LIFETIME_EXPIRES_ACTIVE_SESSION');
    }

    // Using the site keeps a session alive, and account responses are never cached.
    {
      const { verify } = await login(freshEmail(), 'EMAIL');
      const sid = sidOf(verify.setCookies);
      await query('UPDATE auth_sessions SET last_seen_at = NOW() - INTERVAL ? SECOND WHERE id = ?', [Math.max(policy.activityWriteIntervalSeconds() + 5, policy.idleTimeoutSeconds() - 120), sid]);
      const me = await call('/api/v1/customers/me', { cookie: `${SESSION}=${cookieValue(verify.setCookies, SESSION)}` });
      assert.equal(me.status, 200);
      assert.match(me.headers.get('cache-control') || '', /no-store/, 'authenticated responses are no-store');
      const [row] = await query('SELECT TIMESTAMPDIFF(SECOND, last_seen_at, NOW()) AS idle FROM auth_sessions WHERE id = ?', [sid]);
      assert.ok(Number(row.idle) <= 5, `activity refreshed last_seen_at (idle ${row.idle}s)`);
      pass('ACTIVITY_KEEPS_SESSION_ALIVE');
    }

    // Opening the site with an expired session is a clear SESSION_EXPIRED, not a silent guest.
    {
      const { verify } = await login(freshEmail(), 'EMAIL');
      await query('UPDATE auth_sessions SET last_seen_at = NOW() - INTERVAL ? SECOND WHERE id = ?', [policy.idleTimeoutSeconds() + 60, sidOf(verify.setCookies)]);
      const boot = await call('/api/v1/auth/session', { cookie: `${SESSION}=${cookieValue(verify.setCookies, SESSION)}` });
      assert.equal(boot.status, 401);
      assert.equal(boot.json.error.code, 'SESSION_EXPIRED');
      pass('EXPIRED_SESSION_BOOTSTRAP_REPORTED');
    }
  }

  // 21 — customer identity is stable across logins ----------------------
  {
    const { raw, norm } = await freshPhone();
    const a = await login(raw, 'WHATSAPP');
    const b = await login(raw, 'WHATSAPP');
    assert.equal(a.verify.status, 200);
    assert.equal(b.verify.status, 200);
    assert.equal(a.verify.json.data.customer.id, b.verify.json.data.customer.id, 'same phone -> same customer');

    const rows = await query("SELECT DISTINCT customer_id FROM customer_contacts WHERE contact_type = 'PHONE' AND normalized_value = ?", [norm]);
    assert.equal(rows.length, 1, 'exactly one customer owns the phone contact');
    pass('CUSTOMER_RESOLUTION_STABLE_ACROSS_LOGINS');

    // 21b — a returning WhatsApp login verifies the number it just proved.
    // Production: the owner's phone had been saved from the profile page
    // (unverified), and every later OTP login left it unverified, so no
    // WhatsApp reminder could ever reach them.
    await query("UPDATE customer_contacts SET is_verified = 0, verified_at = NULL, source = 'PROFILE' WHERE contact_type = 'PHONE' AND normalized_value = ?", [norm]);
    const c = await login(raw, 'WHATSAPP');
    assert.equal(c.verify.status, 200);
    const [after] = await query("SELECT is_verified, verified_at FROM customer_contacts WHERE contact_type = 'PHONE' AND normalized_value = ?", [norm]);
    assert.equal(Number(after.is_verified), 1, 'the OTP login marked the proven number verified');
    assert.ok(after.verified_at, 'with a verification time');
    pass('RETURNING_OTP_LOGIN_VERIFIES_THE_PROVEN_CONTACT');

    // 21c — a real HTTP OTP login applies default-ON WhatsApp marketing for
    // the proven number (the phone was never decided about).
    const [consent] = await query("SELECT effective_action FROM consent_state WHERE contact_key = ? AND channel = 'WHATSAPP' AND purpose = 'MARKETING'", [norm]);
    assert.equal(consent?.effective_action, 'GRANTED', 'OTP login granted default WhatsApp marketing');
    pass('OTP_LOGIN_APPLIES_DEFAULT_MARKETING');
  }

  // 22 — Google: rejection contract (happy path needs a staging credential)
  {
    const missing = await call('/api/v1/auth/google', { method: 'POST', body: {} });
    assert.equal(missing.status, 400);
    assert.equal(missing.json.error.code, 'VALIDATION_ERROR');

    const tooShort = await call('/api/v1/auth/google', { method: 'POST', body: { credential: 'short' } });
    assert.equal(tooShort.status, 400);

    const bad = await call('/api/v1/auth/google', { method: 'POST', body: { credential: 'aaaaaaaaaa.bbbbbbbbbb.cccccccccc' } });
    assert.equal(bad.status, 401);
    assert.equal(bad.json.error.code, 'GOOGLE_AUTH_FAILED');
    assert.equal(externalCalls, 0, 'rejection path makes no network call');
    pass('GOOGLE_REJECTION_CONTRACT');
  }

  // 23 — IP-keyed OTP request limiter (max 10 / 60s) --------------------
  {
    const attackerIp = '203.0.113.9';
    let saw429;
    for (let i = 0; i < 15; i += 1) {
      const res = await call('/api/v1/auth/otp/request', {
        method: 'POST',
        body: { identifier: `flood.${RUN}.${i}${EMAIL_DOMAIN}` },
        xff: attackerIp,
      });
      if (res.status === 429) { saw429 = res.json.error.code; break; }
    }
    assert.equal(saw429, 'OTP_RATE_LIMITED', 'the OTP request limiter eventually 429s one IP');

    const bystander = await call('/api/v1/auth/session');
    assert.equal(bystander.status, 200, 'server still serving during the storm');
    pass('OTP_REQUEST_RATE_LIMIT');
  }

  // 24 — provider independence -----------------------------------------
  {
    assert.equal(externalCalls, 0, 'zero outbound calls to external providers');
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  realLog('\nCUSTOMER_AUTH_CHARACTERIZATION = PASS');
  realLog(JSON.stringify(results, null, 2));
} catch (err) {
  console.log = realLog;
  console.error('\nCUSTOMER_AUTH_CHARACTERIZATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  console.log = realLog;
  server.close();
  try {
    const marked = new Set();
    // THIS run's emails only (`authchar.<RUN>.`). Matching the whole test domain
    // swept up customers left behind by earlier runs and by other scripts that
    // borrow the domain — one of those owned a checkout, so the single DELETE
    // hit a foreign key and the entire cleanup aborted, leaving this run's rows
    // behind too.
    const emailOwners = await query(
      "SELECT DISTINCT customer_id FROM customer_contacts WHERE normalized_value LIKE ?",
      [`authchar.${RUN}.%${EMAIL_DOMAIN}`],
    );
    for (const row of emailOwners) if (row.customer_id) marked.add(row.customer_id);
    if (createdPhones.length) {
      const placeholders = createdPhones.map(() => '?').join(',');
      const phoneOwners = await query(
        `SELECT DISTINCT customer_id FROM customer_contacts WHERE contact_type = 'PHONE' AND normalized_value IN (${placeholders})`,
        createdPhones,
      );
      for (const row of phoneOwners) if (row.customer_id) marked.add(row.customer_id);
    }
    const ids = [...marked];
    if (ids.length) {
      const ph = ids.map(() => '?').join(',');
      await query(`DELETE FROM audit_logs WHERE customer_id IN (${ph})`, ids);
      await query(`DELETE FROM customers WHERE id IN (${ph})`, ids); // cascades identities/contacts/sessions/link-requests
    }
    await query(`DELETE FROM otp_challenges WHERE destination_normalized LIKE '%${EMAIL_DOMAIN}'`);
    // Sign-in now records default marketing consent for the fixtures' verified
    // contacts; remove it with them so no consent row outlives its customer.
    for (const table of ['consent_records', 'consent_state', 'marketing_suppressions']) {
      await query(`DELETE FROM ${table} WHERE contact_key LIKE '%${EMAIL_DOMAIN}'`);
      if (createdPhones.length) {
        await query(`DELETE FROM ${table} WHERE contact_key IN (${createdPhones.map(() => '?').join(',')})`, createdPhones);
      }
    }
    if (createdPhones.length) {
      const placeholders = createdPhones.map(() => '?').join(',');
      await query(`DELETE FROM otp_challenges WHERE destination_normalized IN (${placeholders})`, createdPhones);
    }
  } finally {
    await pool.end();
  }
}
