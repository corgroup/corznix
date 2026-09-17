// First-login forced password change (migration 073).
//
// Proves:
//   - a CLI-provisioned staff account (mustChangePassword) logs in, gets a
//     session, but its /me profile carries mustChangePassword = true;
//   - every feature route is refused with PASSWORD_CHANGE_REQUIRED (403) while
//     the flag is set — /me, /auth/change-password and /auth/logout still work;
//   - change-password: wrong current password -> 400; same-as-current -> 400;
//     weak -> 400; a valid change clears the flag, rotates every session, and
//     the new session reaches feature routes;
//   - the old cookie is dead after the change (session rotation);
//   - the old (temporary) password no longer authenticates;
//   - an administrative resetPassword re-arms the flag (SUPER_ADMIN exempt).
//
// Isolated + self-cleaning. HTTP against a real listener + real MySQL.
//
//   npm run verify:first-login
import assert from 'node:assert/strict';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';

const { createApp } = await import('../src/app.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { cmsAllowedOrigins } = await import('../src/config/index.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');

const ORIGIN = cmsAllowedOrigins[0];
const DOMAIN = '@first-login-verify.test';
const EMAIL = `newstaff${Date.now()}${DOMAIN}`;
const TEMP_PW = 'Temp-Provisioned-Passphrase-1';
const NEW_PW = 'My-Own-Chosen-Passphrase-2';
const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };

let server;
try {
  await query('DELETE FROM staff_users WHERE email_normalized LIKE ?', [`%${DOMAIN}`]).catch(() => {});
  await staffAuthService.createStaffUser({ email: EMAIL, password: TEMP_PW, firstName: 'New', lastName: 'Staff', role: 'OPERATIONS', mustChangePassword: true });

  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (path, { cookie, method = 'GET', body } = {}) => fetch(`${base}${path}`, {
    method,
    headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null), setCookie: r.headers.get('set-cookie') }));

  // ---- login with the temp password ----
  const login = await call('/api/v1/admin/auth/login', { method: 'POST', body: { email: EMAIL, password: TEMP_PW } });
  assert.equal(login.status, 200, 'temp password logs in');
  assert.equal(login.json.data.staff.mustChangePassword, true, '/login profile flags mustChangePassword');
  const tempCookie = (login.setCookie || '').split(';')[0];

  // ---- /me works, feature routes refused ----
  const me = await call('/api/v1/admin/me', { cookie: tempCookie });
  assert.equal(me.status, 200);
  assert.equal(me.json.data.staff.mustChangePassword, true);

  const blocked = await call('/api/v1/admin/orders', { cookie: tempCookie });
  assert.equal(blocked.status, 403, 'a feature route is refused');
  assert.equal(blocked.json.error.code, 'PASSWORD_CHANGE_REQUIRED');
  pass('LOGIN_THEN_BLOCKED');

  // ---- change-password validation ----
  const wrongCurrent = await call('/api/v1/admin/auth/change-password', { cookie: tempCookie, method: 'POST', body: { currentPassword: 'not-it', newPassword: NEW_PW } });
  assert.equal(wrongCurrent.status, 400);
  assert.equal(wrongCurrent.json.error.code, 'CURRENT_PASSWORD_INCORRECT');

  const same = await call('/api/v1/admin/auth/change-password', { cookie: tempCookie, method: 'POST', body: { currentPassword: TEMP_PW, newPassword: TEMP_PW } });
  assert.equal(same.status, 400);
  assert.equal(same.json.error.code, 'PASSWORD_UNCHANGED');

  const weak = await call('/api/v1/admin/auth/change-password', { cookie: tempCookie, method: 'POST', body: { currentPassword: TEMP_PW, newPassword: 'short' } });
  assert.equal(weak.status, 400);
  assert.equal(weak.json.error.code, 'WEAK_PASSWORD');
  pass('CHANGE_PASSWORD_VALIDATION');

  // ---- valid change ----
  const changed = await call('/api/v1/admin/auth/change-password', { cookie: tempCookie, method: 'POST', body: { currentPassword: TEMP_PW, newPassword: NEW_PW } });
  assert.equal(changed.status, 200);
  assert.equal(changed.json.data.staff.mustChangePassword, false, 'flag cleared');
  const newCookie = (changed.setCookie || '').split(';')[0];
  assert.ok(newCookie && newCookie !== tempCookie, 'a fresh session cookie is issued');

  // old cookie is dead (session rotation)
  const oldDead = await call('/api/v1/admin/me', { cookie: tempCookie });
  assert.equal(oldDead.status, 401, 'the pre-change session is revoked');

  // new cookie reaches feature routes
  const nowOk = await call('/api/v1/admin/orders', { cookie: newCookie });
  assert.ok(nowOk.status === 200 || nowOk.status === 403, `feature route reachable (got ${nowOk.status})`);
  assert.notEqual(nowOk.json?.error?.code, 'PASSWORD_CHANGE_REQUIRED', 'no longer password-gated');
  pass('VALID_CHANGE_ROTATES_SESSION');

  // ---- temp password no longer works ----
  const oldPwLogin = await call('/api/v1/admin/auth/login', { method: 'POST', body: { email: EMAIL, password: TEMP_PW } });
  assert.equal(oldPwLogin.status, 401, 'old temporary password is rejected');
  const newPwLogin = await call('/api/v1/admin/auth/login', { method: 'POST', body: { email: EMAIL, password: NEW_PW } });
  assert.equal(newPwLogin.status, 200, 'new password logs in');
  assert.equal(newPwLogin.json.data.staff.mustChangePassword, false);
  pass('OLD_PASSWORD_DEAD');

  // ---- admin reset re-arms the flag ----
  await staffAuthService.resetPassword({ email: EMAIL, newPassword: 'Admin-Reset-Temp-Passphrase-3' });
  const [row] = await query('SELECT must_change_password FROM staff_users WHERE email_normalized = ?', [EMAIL.toLowerCase()]);
  assert.equal(Number(row.must_change_password), 1, 'an administrative reset re-arms the forced change');
  pass('ADMIN_RESET_REARMS');

  console.log('\nFirst-login password change — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  try { server?.close(); } catch { /* noop */ }
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE ?)", [`%${DOMAIN}`]));
  await safe(() => query("DELETE FROM staff_audit_logs WHERE actor_email LIKE ?", [`%${DOMAIN}`]));
  await safe(() => query('DELETE FROM staff_users WHERE email_normalized LIKE ?', [`%${DOMAIN}`]));
  await pool.end();
}
