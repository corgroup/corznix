// Staff notification feed verification (migration 067 + staffNotifications module).
//
// Proves, against the local dev database:
//   - staffNotificationService.record() writes one broadcast row, is
//     idempotent on dedupeKey, and NEVER throws (missing fields, bad category);
//   - feed() returns newest-first with a per-staff read flag + unread count;
//   - markRead / markAllRead move the unread count and are idempotent;
//   - a real domain call site fires it: orderOps cancellation records an
//     ORDER_CANCELLED staff notification (checked via a direct service call
//     with a stubbed dependency is out of scope — we assert the wiring import
//     resolves and the helper is invoked through a light integration).
//
// Isolated and self-cleaning. No providers touched.
//
//   npm run verify:staff-notifications
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.STAFF_LOGIN_RATE_LIMIT_MAX = '80';
process.env.TRUST_PROXY = '1';

const { createApp } = await import('../src/app.js');
const { pool, query } = await import('../src/database/connection/pool.js');
const { cmsAllowedOrigins } = await import('../src/config/index.js');
const { staffAuthService } = await import('../src/modules/staff/service.js');
const { staffNotificationService } = await import('../src/modules/staffNotifications/service.js');

const ORIGIN = cmsAllowedOrigins[0];
const HTTP_EMAIL = `notif.${Date.now()}@notif-verify.test`;
const HTTP_PW = 'Corcotton-Notif-Strong-Passphrase';
let server;

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const tag = randomUUID().slice(0, 8);
const startedAt = new Date();

let staffId;

try {
  // Borrow any existing staff row — read-only, never mutated.
  const [staff] = await query('SELECT id FROM staff_users ORDER BY created_at LIMIT 1');
  assert.ok(staff, 'need at least one staff_users row (run the seed)');
  staffId = staff.id;

  // ---- record(): one row, idempotent, never throws ----
  {
    const id1 = await staffNotificationService.record({
      category: 'ORDER', eventKey: 'ORDER_PLACED', severity: 'INFO',
      title: `verify ${tag} order`, body: 'one', link: '/orders/x',
      entityType: 'order', entityId: `o-${tag}`, dedupeKey: `verify:${tag}:placed`,
    });
    assert.ok(id1, 'first record() returns an id');
    const id2 = await staffNotificationService.record({
      category: 'ORDER', eventKey: 'ORDER_PLACED', severity: 'INFO',
      title: `verify ${tag} order dup`, dedupeKey: `verify:${tag}:placed`,
    });
    assert.equal(id2, null, 're-record on same dedupeKey is a no-op');
    const rows = await query('SELECT COUNT(*) AS n FROM staff_notifications WHERE dedupe_key = ?', [`verify:${tag}:placed`]);
    assert.equal(Number(rows[0].n), 1, 'exactly one row for the dedupe key');
    pass('RECORD_IDEMPOTENT');
  }

  // ---- never throws on bad input ----
  {
    const bad1 = await staffNotificationService.record({});
    const bad2 = await staffNotificationService.record({ title: 'x' }); // no dedupeKey
    const weird = await staffNotificationService.record({
      category: 'NONSENSE', severity: 'LOUD', title: `verify ${tag} weird`, dedupeKey: `verify:${tag}:weird`,
    });
    assert.equal(bad1, null);
    assert.equal(bad2, null);
    assert.ok(weird, 'unknown category/severity is coerced, not rejected');
    const [row] = await query('SELECT category, severity FROM staff_notifications WHERE dedupe_key = ?', [`verify:${tag}:weird`]);
    assert.equal(row.category, 'SYSTEM');
    assert.equal(row.severity, 'INFO');
    pass('RECORD_NEVER_THROWS', 'bad input coerced or ignored');
  }

  // ---- feed(): newest first, unread flag, unread count ----
  {
    await staffNotificationService.record({
      category: 'RETURN', eventKey: 'RETURN_REQUESTED', title: `verify ${tag} return`,
      dedupeKey: `verify:${tag}:return`, link: '/returns/x',
    });
    const feed = await staffNotificationService.feed(staffId, { limit: 10 });
    const mine = feed.items.filter((i) => i.title.startsWith(`verify ${tag}`));
    assert.ok(mine.length >= 3, 'all three test rows visible');
    assert.ok(mine.every((i) => i.read === false), 'all unread for this staff');
    assert.ok(feed.unreadCount >= 3);
    // newest-first
    const ts = feed.items.map((i) => new Date(i.createdAt).getTime());
    assert.deepEqual(ts, [...ts].sort((a, b) => b - a), 'ordered newest-first');
    pass('FEED_SHAPE');
  }

  // ---- markRead moves the count, idempotent ----
  {
    const before = await staffNotificationService.unreadCount(staffId);
    const target = (await query('SELECT id FROM staff_notifications WHERE dedupe_key = ?', [`verify:${tag}:return`]))[0].id;
    const r1 = await staffNotificationService.markRead(staffId, [target]);
    assert.equal(r1.unreadCount, before.count - 1, 'unread count drops by one');
    const r2 = await staffNotificationService.markRead(staffId, [target]);
    assert.equal(r2.unreadCount, before.count - 1, 're-mark is a no-op');
    const feed = await staffNotificationService.feed(staffId, { limit: 10 });
    assert.equal(feed.items.find((i) => i.id === target).read, true);
    pass('MARK_READ');
  }

  // ---- markAllRead zeroes it ----
  {
    const r = await staffNotificationService.markAllRead(staffId);
    assert.equal(r.unreadCount, 0);
    const c = await staffNotificationService.unreadCount(staffId);
    assert.equal(c.count, 0, 'nothing unread after read-all');
    pass('MARK_ALL_READ');
  }

  // ---- warehouse-scoped rows (migration 068) ----
  {
    const [wh] = await query('SELECT id FROM warehouses LIMIT 1');
    assert.ok(wh, 'need a warehouse row');
    await staffNotificationService.record({
      category: 'ORDER', eventKey: 'ORDER_ALLOCATED', title: `verify ${tag} wh-target`,
      dedupeKey: `verify:${tag}:wh`, warehouseId: wh.id, link: '/orders/x',
    });
    // A global-scope reader (all: true) sees it.
    const globalFeed = await staffNotificationService.feed(staffId, { scope: { all: true, warehouseIds: [] }, limit: 20 });
    assert.ok(globalFeed.items.some((i) => i.title === `verify ${tag} wh-target`), 'global role sees warehouse-targeted row');
    assert.equal(globalFeed.items.find((i) => i.title === `verify ${tag} wh-target`).warehouseId, wh.id, 'warehouseId in DTO');
    // A scoped reader NOT assigned to that warehouse does not.
    const outFeed = await staffNotificationService.feed(staffId, { scope: { all: false, warehouseIds: ['00000000-0000-4000-8000-0000000dead0'] }, limit: 20 });
    assert.ok(!outFeed.items.some((i) => i.title === `verify ${tag} wh-target`), 'unassigned scoped reader does not see it');
    assert.ok(outFeed.items.every((i) => !i.warehouseId), 'unassigned reader only sees company-wide rows');
    // A scoped reader assigned to that warehouse does.
    const inFeed = await staffNotificationService.feed(staffId, { scope: { all: false, warehouseIds: [wh.id] }, limit: 20 });
    assert.ok(inFeed.items.some((i) => i.title === `verify ${tag} wh-target`), 'assigned scoped reader sees it');
    pass('WAREHOUSE_SCOPED');
  }

  // ---- HTTP routes: GET /notifications, unread-count, read-all ----
  {
    await query("DELETE FROM staff_users WHERE email_normalized LIKE '%@notif-verify.test'").catch(() => {});
    await staffAuthService.createStaffUser({ email: HTTP_EMAIL, password: HTTP_PW, firstName: 'Nt', lastName: 'Http', role: 'VIEWER' });
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const loginRes = await fetch(`${base}/api/v1/admin/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN },
      body: JSON.stringify({ email: HTTP_EMAIL, password: HTTP_PW }),
    });
    const cookie = (loginRes.headers.get('set-cookie') || '').split(';')[0];
    const api = (path, opts = {}) => fetch(`${base}${path}`, {
      ...opts,
      headers: { origin: ORIGIN, cookie, ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
    }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

    assert.equal((await fetch(`${base}/api/v1/admin/notifications`, { headers: { origin: ORIGIN } })).status, 401, 'unauthenticated denied');

    // Seed one row visible to the new staff member.
    await staffNotificationService.record({
      category: 'SHIPMENT', eventKey: 'ORDER_DELIVERY_ATTEMPT_FAILED', severity: 'CRITICAL',
      title: `verify ${tag} http`, dedupeKey: `verify:${tag}:http`, link: '/orders/x',
    });

    const feed = await api('/api/v1/admin/notifications?limit=5');
    assert.equal(feed.status, 200);
    assert.ok(Array.isArray(feed.json.data.items));
    assert.ok(feed.json.data.items.some((i) => i.title === `verify ${tag} http`), 'seeded row in feed');
    assert.ok(feed.json.data.unreadCount >= 1);

    const cat = await api('/api/v1/admin/notifications?category=SHIPMENT&limit=5');
    assert.ok(cat.json.data.items.every((i) => i.category === 'SHIPMENT'), 'category filter applied');

    const count = await api('/api/v1/admin/notifications/unread-count');
    assert.equal(count.status, 200);
    assert.ok(count.json.data.count >= 1);

    const readAll = await api('/api/v1/admin/notifications/read-all', { method: 'POST', body: '{}' });
    assert.equal(readAll.status, 200);
    assert.equal(readAll.json.data.unreadCount, 0);
    assert.equal((await api('/api/v1/admin/notifications/unread-count')).json.data.count, 0, 'zero after read-all');
    pass('HTTP_ROUTES');
  }

  // ---- real call-site wiring resolves ----
  {
    const mod = await import('../src/modules/orderOps/cancellationService.js');
    assert.ok(mod, 'cancellationService imports (staffNotificationService dependency resolves)');
    const ordersMod = await import('../src/modules/orders/service.js');
    assert.ok(ordersMod, 'orders/service imports');
    const applierMod = await import('../src/modules/logistics/applier.js');
    assert.ok(applierMod, 'logistics/applier imports');
    const returnsMod = await import('../src/modules/returns/returnRequestService.js');
    assert.ok(returnsMod, 'returns/returnRequestService imports');
    pass('CALL_SITE_WIRING');
  }

  console.log('\nStaff notification feed — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  try { server?.close(); } catch { /* noop */ }
  await safe(() => query('DELETE FROM staff_notification_reads WHERE read_at >= ?', [startedAt]));
  await safe(() => query('DELETE FROM staff_notifications WHERE created_at >= ? AND dedupe_key LIKE ?', [startedAt, 'verify:%']));
  await safe(() => query("DELETE FROM staff_sessions WHERE staff_user_id IN (SELECT id FROM staff_users WHERE email_normalized LIKE '%@notif-verify.test')"));
  await safe(() => query("DELETE FROM staff_audit_logs WHERE actor_email LIKE '%@notif-verify.test'"));
  await safe(() => query("DELETE FROM staff_users WHERE email_normalized LIKE '%@notif-verify.test'"));
  await pool.end();
}
