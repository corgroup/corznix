// Staff auth / RBAC / session / audit / admin-API-boundary verification.
// Runs against the local development database over a real
// HTTP listener (no supertest dependency — Node's global fetch against
// app.listen(0)). Non-destructive to commerce state: touches only the
// staff_* tables plus one throwaway customer row, all cleaned at start.
//
//   npm run verify:staff
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

// Deterministic, finite rate-limit ceiling for this run: high enough that
// the functional tests never trip it, low enough that the dedicated
// rate-limit test reaches it quickly.
process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '40';
process.env.STAFF_LOGIN_RATE_LIMIT_WINDOW_MS = '60000';
process.env.STAFF_SESSION_IDLE_TIMEOUT_MINUTES = '120';
// Simulate the VPS topology (one trusted nginx hop) so the proxy IP /
// rate-limit-keying test below exercises the real X-Forwarded-For path.
process.env.TRUST_PROXY = '1';

// External-call tripwire: any outbound fetch to a non-loopback host during
// this wave is a defect (no Cloudinary / logistics / payment provider).
let externalCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || '';
  if (!/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url)) externalCalls += 1;
  return realFetch(input, init);
};

const { createApp } = await import('../src/app.js');
const { cmsAllowedOrigins, isProduction } = await import('../src/config/index.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { resolvePermissions } = await import('../src/modules/staff/permissions.js');
const { createAccessToken } = await import('../src/utils/jwt.js');
const { hashToken } = await import('../src/utils/otpCrypto.js');
const { hashPassword } = await import('../src/utils/password.js');

// The single-SUPER_ADMIN / company-owner invariant means the SERVICE path can
// only mint a SUPER_ADMIN during first-boot bootstrap. A dev database already
// has its owner, so the throwaway privileged account for the session/RBAC
// tests below is inserted directly. The invariant itself is covered by
// verify:company-governance.
async function provisionStaffDirect({ email, password, firstName, lastName, role }) {
  const id = randomUUID();
  const normalized = email.trim().toLowerCase();
  await query(
    `INSERT INTO staff_users (id, email, email_normalized, password_hash, first_name, last_name, role, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(), NOW())`,
    [id, email.trim(), normalized, hashPassword(password), firstName, lastName, role],
  );
  return staffAuthService.staffUsers.findById(id);
}

const results = {};
const pass = (name) => { results[name] = 'PASS'; console.log(`  PASS  ${name}`); };

const SUPER_EMAIL = `staff.super.${Date.now()}@staff-auth-verify.test`;
const VIEWER_EMAIL = `staff.viewer.${Date.now()}@staff-auth-verify.test`;
let PASSWORD = 'Corcotton-StaffAuth-Str0ng-Passphrase';

// ---- clean slate (staff_* + test customer only) ------------------------------
await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@staff-auth-verify.test' OR staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@staff-auth-verify.test')");
await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@staff-auth-verify.test')");
await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@staff-auth-verify.test'");

const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const ORIGIN = cmsAllowedOrigins[0]; // match the server's CMS allow-list (portable across envs)

async function call(path, { method = 'GET', body, cookie, bearer, origin, xff } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (origin) headers.origin = origin;
  if (xff) headers['x-forwarded-for'] = xff;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, setCookie: res.headers.get('set-cookie') };
}

function staffCookie(setCookieHeader) {
  const match = /cor_group_staff_session=([^;]+)/.exec(setCookieHeader || '');
  return match ? `cor_group_staff_session=${match[1]}` : null;
}

try {
  // ---- provisioning ---------------------------------------------------------
  const superUser = await provisionStaffDirect({
    email: SUPER_EMAIL, password: PASSWORD, firstName: 'Super', lastName: 'Admin', role: 'SUPER_ADMIN',
  });
  const viewerUser = await staffAuthService.createStaffUser({
    email: VIEWER_EMAIL, password: PASSWORD, firstName: 'View', lastName: 'Only', role: 'VIEWER',
  });
  assert.ok(superUser.id && viewerUser.id);
  // Bootstrap safety: duplicate / invalid / weak / second-owner all rejected.
  await assert.rejects(() => staffAuthService.createStaffUser({ email: VIEWER_EMAIL, password: PASSWORD, firstName: 'D', lastName: 'D', role: 'ADMIN' }), /already exists/i);
  await assert.rejects(() => staffAuthService.createStaffUser({ email: 'not-an-email', password: PASSWORD, firstName: 'D', lastName: 'D', role: 'ADMIN' }), /valid email/i);
  await assert.rejects(() => staffAuthService.createStaffUser({ email: `weak.${Date.now()}@staff-auth-verify.test`, password: 'short', firstName: 'D', lastName: 'D', role: 'ADMIN' }), /at least 12/i);
  await assert.rejects(
    () => staffAuthService.createStaffUser({ email: `second.super.${Date.now()}@staff-auth-verify.test`, password: PASSWORD, firstName: 'D', lastName: 'D', role: 'SUPER_ADMIN' }),
    (err) => err.code === 'SUPER_ADMIN_EXISTS',
  );
  pass('BOOTSTRAP_SAFETY');

  // ---- §56 unauthenticated -> 401 ------------------------------------------
  {
    const r = await call('/api/v1/admin/me');
    assert.equal(r.status, 401);
    const r2 = await call('/api/v1/admin/staff');
    assert.equal(r2.status, 401);
    pass('UNAUTHENTICATED_401');
  }

  // ---- §26/§60 wrong password vs unknown email are indistinguishable -------
  {
    const wrongPw = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: SUPER_EMAIL, password: 'wrong-password-here' } });
    const unknown = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: `ghost.${Date.now()}@staff-auth-verify.test`, password: 'wrong-password-here' } });
    assert.equal(wrongPw.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrongPw.json, unknown.json);
    assert.ok(!wrongPw.setCookie || !/cor_group_staff_session=[^;]+[^;]/.test(wrongPw.setCookie) || /cor_group_staff_session=;/.test(wrongPw.setCookie));
    pass('WRONG_PASSWORD_NO_ENUMERATION');
  }

  // ---- §28/§58 a customer session must not authenticate against admin -----
  {
    const custId = randomUUID();
    await query("INSERT INTO customers (id, brand_id, first_name, last_name, status, created_at, updated_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), 'Test', 'Customer', 'ACTIVE', NOW(), NOW())", [custId]);
    const sessId = randomUUID();
    await query("INSERT INTO auth_sessions (id, customer_id, token_hash, status, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, 'ACTIVE', NOW(), DATE_ADD(NOW(), INTERVAL 1 DAY), NOW())", [sessId, custId, hashToken(`verify.${sessId}`)]);
    const customerJwt = createAccessToken({ customerId: custId, sessionId: sessId });

    const viaCookie = await call('/api/v1/admin/me', { cookie: `cor_group_session=${customerJwt}` });
    const viaBearer = await call('/api/v1/admin/me', { bearer: customerJwt });
    assert.equal(viaCookie.status, 401, 'customer cookie must not reach admin');
    assert.equal(viaBearer.status, 401, 'customer JWT bearer must not reach admin');

    await query('DELETE FROM auth_sessions WHERE id = ?', [sessId]);
    await query('DELETE FROM customers WHERE id = ?', [custId]);
    pass('CUSTOMER_ADMIN_ISOLATION_DENIED');
  }

  // ---- §62 login success + cookie flags -----------------------------------
  const superLogin = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: SUPER_EMAIL, password: PASSWORD } });
  assert.equal(superLogin.status, 200);
  assert.equal(superLogin.json.data.staff.email, SUPER_EMAIL);
  assert.ok(!('password_hash' in superLogin.json.data.staff) && !('passwordHash' in superLogin.json.data.staff));
  {
    const sc = superLogin.setCookie || '';
    assert.match(sc, /cor_group_staff_session=/);
    assert.match(sc, /HttpOnly/i);
    assert.match(sc, /SameSite=Lax/i);
    assert.match(sc, /Path=\/api\/v1\/admin/i);
    // Secure iff production (staging/prod set NODE_ENV=production).
    if (isProduction()) assert.match(sc, /;\s*Secure/i, 'Secure flag required in production');
    else assert.ok(!/;\s*Secure/i.test(sc), 'no Secure flag outside production');
    pass('SESSION_COOKIE_FLAGS');
  }
  const superCookie = staffCookie(superLogin.setCookie);
  assert.ok(superCookie);

  // ---- §48 /me shape, §66 SUPER_ADMIN full permission set -----------------
  {
    const me = await call('/api/v1/admin/me', { cookie: superCookie });
    assert.equal(me.status, 200);
    const s = me.json.data.staff;
    assert.equal(s.role, 'SUPER_ADMIN');
    assert.deepEqual([...s.permissions].sort(), [...resolvePermissions('SUPER_ADMIN')].sort());
    assert.ok(s.permissions.includes('cms.access'));
    for (const leak of ['password_hash', 'passwordHash', 'token', 'tokenHash', 'password']) {
      assert.ok(!(leak in s), `/me must not expose ${leak}`);
    }
    pass('ADMIN_ME_PROFILE');
    pass('SUPER_ADMIN_FULL_PERMISSIONS');
  }

  // ---- §57/§65 permission denial is 403 (not 404) ------------------------
  {
    const superStaff = await call('/api/v1/admin/staff', { cookie: superCookie });
    assert.equal(superStaff.status, 200, 'SUPER_ADMIN has staff.read');
    assert.ok(Array.isArray(superStaff.json.data.staff));

    const viewerLogin = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: VIEWER_EMAIL, password: PASSWORD } });
    assert.equal(viewerLogin.status, 200);
    const viewerCookie = staffCookie(viewerLogin.setCookie);

    const viewerMe = await call('/api/v1/admin/me', { cookie: viewerCookie });
    assert.equal(viewerMe.status, 200, 'VIEWER can access its own profile (has cms.access)');

    const viewerStaff = await call('/api/v1/admin/staff', { cookie: viewerCookie });
    assert.equal(viewerStaff.status, 403, 'VIEWER lacks staff.read -> 403');
    assert.equal(viewerStaff.json.error.code, 'PERMISSION_DENIED');
    pass('RBAC_PERMISSION_DENIED_403');

    // ---- §55/§59 disable staff -> live session dies, re-login denied -----
    // Path A: raw status flip WITHOUT session revocation — proves the
    // per-request validation boundary itself rejects a disabled account
    // (403) and then revokes the stale session.
    await query("UPDATE staff_users SET status = 'DISABLED' WHERE id = ?", [viewerUser.id]);
    const boundaryReject = await call('/api/v1/admin/me', { cookie: viewerCookie });
    assert.equal(boundaryReject.status, 403, 'validation boundary rejects a disabled account');
    assert.equal(boundaryReject.json.error.code, 'STAFF_ACCOUNT_DISABLED');
    const sessionRow = await query('SELECT status FROM staff_sessions WHERE staff_user_id = ? ORDER BY created_at DESC LIMIT 1', [viewerUser.id]);
    assert.equal(sessionRow[0].status, 'REVOKED', 'stale session revoked on rejection');

    // Path B: the service-level disable also proactively kills every live
    // session immediately (not at expiry).
    await query("UPDATE staff_users SET status = 'ACTIVE' WHERE id = ?", [viewerUser.id]);
    const reAuth = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: VIEWER_EMAIL, password: PASSWORD } });
    const reAuthCookie = staffCookie(reAuth.setCookie);
    assert.equal((await call('/api/v1/admin/me', { cookie: reAuthCookie })).status, 200);
    await staffAuthService.setStatus({ staffUserId: viewerUser.id, status: 'DISABLED' });
    const afterServiceDisable = await call('/api/v1/admin/me', { cookie: reAuthCookie });
    assert.ok([401, 403].includes(afterServiceDisable.status), 'disabled staff loses live session immediately');

    const reLogin = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: VIEWER_EMAIL, password: PASSWORD } });
    assert.equal(reLogin.status, 401, 'disabled staff cannot log back in');
    pass('DISABLED_STAFF_ENFORCED');
  }

  // ---- §63 logout revokes server authority ------------------------------
  {
    const before = await call('/api/v1/admin/me', { cookie: superCookie });
    assert.equal(before.status, 200);
    const out = await call('/api/v1/admin/auth/logout', { method: 'POST', origin: ORIGIN, cookie: superCookie });
    assert.equal(out.status, 200);
    const after = await call('/api/v1/admin/me', { cookie: superCookie });
    assert.equal(after.status, 401, 'revoked session no longer authorized');
    pass('LOGOUT_REVOKES_SESSION');
  }

  // ---- staff:password reset — new password works, old rejected, sessions killed
  {
    const NEW_PW = 'Corcotton-StaffAuth-Rotated-Passphrase';
    const pre = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: SUPER_EMAIL, password: PASSWORD } });
    const preCookie = staffCookie(pre.setCookie);
    assert.equal((await call('/api/v1/admin/me', { cookie: preCookie })).status, 200);

    await staffAuthService.resetPassword({ email: SUPER_EMAIL, newPassword: NEW_PW });

    assert.equal((await call('/api/v1/admin/me', { cookie: preCookie })).status, 401, 'sessions revoked on password reset');
    const oldPw = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: SUPER_EMAIL, password: PASSWORD } });
    assert.equal(oldPw.status, 401, 'old password no longer works');
    const newPw = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: SUPER_EMAIL, password: NEW_PW } });
    assert.equal(newPw.status, 200, 'new password works');
    await assert.rejects(() => staffAuthService.resetPassword({ email: SUPER_EMAIL, newPassword: 'short' }), /at least 12/i);
    await assert.rejects(() => staffAuthService.resetPassword({ email: 'ghost@staff-auth-verify.test', newPassword: NEW_PW }), /No staff account/i);
    PASSWORD = NEW_PW; // subsequent tests use the rotated password
    pass('PASSWORD_RESET');
  }

  // ---- §64 session persistence survives a process restart ---------------
  {
    const freshLogin = await call('/api/v1/admin/auth/login', { method: 'POST', origin: ORIGIN, body: { email: SUPER_EMAIL, password: PASSWORD } });
    const freshCookie = staffCookie(freshLogin.setCookie);
    const server2 = createApp().listen(0);
    await new Promise((r) => server2.once('listening', r));
    const res = await fetch(`http://127.0.0.1:${server2.address().port}/api/v1/admin/me`, { headers: { cookie: freshCookie } });
    assert.equal(res.status, 200, 'DB-backed session valid on a new app instance');
    server2.close();
    pass('SESSION_RESTART_SAFETY');
  }

  // ---- §29 admin origin guard -------------------------------------------
  {
    const badOrigin = await call('/api/v1/admin/auth/login', { method: 'POST', origin: 'http://evil.example', body: { email: SUPER_EMAIL, password: PASSWORD } });
    assert.equal(badOrigin.status, 403);
    assert.equal(badOrigin.json.error.code, 'ORIGIN_FORBIDDEN');
    pass('ADMIN_ORIGIN_GUARD');
  }

  // ---- §22-24/§61 rate limiting keys on the real (proxied) client IP ---
  // With TRUST_PROXY=1 the limiter must bucket by the X-Forwarded-For
  // client, so one bad actor cannot 429 everyone, and the server stays up.
  {
    const attackerXff = '203.0.113.7';
    let saw429 = false;
    for (let i = 0; i < 60; i += 1) {
      const r = await call('/api/v1/admin/auth/login', {
        method: 'POST', origin: ORIGIN, xff: attackerXff,
        body: { email: `rl.${i}@staff-auth-verify.test`, password: 'bad' },
      });
      if (r.status === 429) { saw429 = true; break; }
    }
    assert.ok(saw429, 'staff login limiter must eventually return 429 for the abusive IP');

    // A different client IP is an independent bucket — not collapsed to one
    // proxy-gateway key.
    const bystander = await call('/api/v1/admin/auth/login', {
      method: 'POST', origin: ORIGIN, xff: '198.51.100.42',
      body: { email: 'bystander@staff-auth-verify.test', password: 'bad' },
    });
    assert.equal(bystander.status, 401, 'a different client IP must not inherit the attacker\'s 429');

    const stillUp = await call('/api/v1/health');
    assert.equal(stillUp.status, 200, 'server still serving after rate-limit storm');
    pass('LOGIN_RATE_LIMITING');
    pass('PROXY_IP_HANDLING');
  }

  // ---- §67 audit foundation: events present, zero secret leakage --------
  {
    const rows = await query(
      "SELECT action, actor_email, metadata_json FROM staff_audit_logs WHERE actor_email LIKE '%@staff-auth-verify.test' OR staff_user_id IN (?, ?)",
      [superUser.id, viewerUser.id]
    );
    const actions = new Set(rows.map((r) => r.action));
    for (const expected of ['STAFF_LOGIN_SUCCESS', 'STAFF_LOGIN_FAILURE', 'STAFF_LOGOUT', 'STAFF_ACCOUNT_DISABLED']) {
      assert.ok(actions.has(expected), `audit missing ${expected}`);
    }
    const blob = JSON.stringify(rows);
    assert.ok(!blob.includes(PASSWORD), 'audit must never contain a password');
    for (const row of rows) {
      const meta = row.metadata_json || {};
      const keys = Object.keys(meta).map((k) => k.toLowerCase());
      for (const forbidden of ['password', 'token', 'hash', 'secret', 'password_hash']) {
        assert.ok(!keys.includes(forbidden), `audit metadata has forbidden key "${forbidden}"`);
      }
      for (const value of Object.values(meta)) {
        assert.ok(
          !(typeof value === 'string' && /^[A-Za-z0-9_-]{32,}$/.test(value)),
          `audit metadata value looks like a secret: ${value}`
        );
      }
    }
    pass('AUDIT_FOUNDATION');
  }

  // ---- provider independence ------------------------------------------
  {
    assert.equal(externalCalls, 0, 'zero outbound calls to external providers');
    pass('NO_EXTERNAL_PROVIDER_CALLS');
  }

  console.log('\nSTAFF_AUTH_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nSTAFF_AUTH_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  server.close();
  await query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@staff-auth-verify.test' OR staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@staff-auth-verify.test')");
  await query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@staff-auth-verify.test')");
  await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@staff-auth-verify.test'");
  await pool.end();
}
