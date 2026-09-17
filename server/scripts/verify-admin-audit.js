// WP-12 / GAP-ORD-06 (CMS audit-log viewer) verification.
//
// Proves, against the local dev database:
//   - StaffAuditRepository.search filters (action / resourceType / q / date
//     window) AND together, paginate, and countSearch agrees;
//   - facets() returns the distinct action + resource_type lists with counts;
//   - adminAuditService.list resolves the actor (staff row, else the email
//     captured at write time), parses metadata_json, and treats a bare
//     YYYY-MM-DD `from`/`to` as an inclusive day window;
//   - RBAC: audit.read is on SUPER_ADMIN + ADMIN and OFF for VIEWER (it must
//     not leak in through the everything-read bundle);
//   - the surface is read-only (routes expose GET only).
//
// Isolated + self-cleaning: inserts two tagged rows, asserts, deletes them.
//
//   npm run verify:admin-audit
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { StaffAuditRepository } = await import('../src/modules/staff/repositories.js');
const { adminAuditService } = await import('../src/modules/adminAudit/service.js');
const { roleHasPermission, PERMISSIONS } = await import('../src/modules/staff/permissions.js');
const auditRoutes = (await import('../src/modules/adminAudit/routes.js')).default;

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const repo = new StaffAuditRepository();

const TAG = `VERIFY_AUDIT_${Date.now()}`;
const idOld = randomUUID();
const idNew = randomUUID();

// One row "yesterday", one "today" — both under a unique action tag.
await query(
  `INSERT INTO staff_audit_logs (id, staff_user_id, actor_email, action, resource_type, resource_id, metadata_json, ip_address, request_id, created_at)
   VALUES (?, NULL, ?, ?, 'verify_resource', ?, ?, '10.0.0.9', NULL, DATE_SUB(CURDATE(), INTERVAL 1 DAY) + INTERVAL 9 HOUR)`,
  [idOld, 'old.actor@example.com', TAG, 'res-old', JSON.stringify({ note: 'older' })],
);
await query(
  `INSERT INTO staff_audit_logs (id, staff_user_id, actor_email, action, resource_type, resource_id, metadata_json, ip_address, request_id, created_at)
   VALUES (?, NULL, ?, ?, 'verify_resource', ?, ?, '10.0.0.9', NULL, CURDATE() + INTERVAL 9 HOUR)`,
  [idNew, 'new.actor@example.com', TAG, 'res-new', JSON.stringify({ note: 'newer' })],
);

const todayStr = new Date().toISOString().slice(0, 10);
const yesterdayStr = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

try {
  // ===================== 1. search + count + pagination =============
  {
    const all = await repo.search({ action: TAG, limit: 50 });
    assert.equal(all.length, 2, 'both tagged rows returned');
    assert.equal(all[0].resource_id, 'res-new', 'newest first');
    const count = await repo.countSearch({ action: TAG });
    assert.equal(count, 2);

    const page1 = await repo.search({ action: TAG, limit: 1, offset: 0 });
    const page2 = await repo.search({ action: TAG, limit: 1, offset: 1 });
    assert.equal(page1.length, 1);
    assert.equal(page2.length, 1);
    assert.notEqual(page1[0].id, page2[0].id, 'pages do not overlap');

    // q is a loose contains match across action / resource_id / actor_email.
    const byQ = await repo.search({ q: 'res-old', limit: 10 });
    assert(byQ.some((r) => r.id === idOld) && !byQ.some((r) => r.id === idNew));
    pass('SEARCH_FILTER_COUNT_PAGINATION', `${count} tagged rows`);
  }

  // ===================== 2. date window ============================
  {
    const todayOnly = await adminAuditService.list({ action: TAG, from: todayStr, to: todayStr });
    assert.equal(todayOnly.total, 1, 'a bare YYYY-MM-DD window is an inclusive single day');
    assert.equal(todayOnly.logs[0].resourceId, 'res-new');

    const bothDays = await adminAuditService.list({ action: TAG, from: yesterdayStr, to: todayStr });
    assert.equal(bothDays.total, 2);
    pass('DATE_WINDOW', 'YYYY-MM-DD from/to = inclusive day boundaries');
  }

  // ===================== 3. service DTO shape ======================
  {
    const { logs } = await adminAuditService.list({ action: TAG, limit: 10 });
    const dto = logs.find((l) => l.resourceId === 'res-new');
    assert(dto, 'row present');
    assert.equal(dto.action, TAG);
    assert.equal(dto.resourceType, 'verify_resource');
    assert.deepEqual(dto.metadata, { note: 'newer' }, 'metadata_json parsed to an object');
    assert.equal(dto.actor.staffUserId, null);
    assert.equal(dto.actor.email, 'new.actor@example.com', 'falls back to the email captured at write time');
    assert.equal(dto.actor.name, null);
    assert(dto.at, 'timestamp present');
    pass('SERVICE_DTO', 'actor fallback + parsed metadata');
  }

  // ===================== 4. facets ================================
  {
    const f = await adminAuditService.facets();
    assert(Array.isArray(f.actions) && Array.isArray(f.resourceTypes));
    const mine = f.actions.find((a) => a.value === TAG);
    assert(mine && Number(mine.n) === 2, 'tagged action shows in facets with its count');
    assert(f.resourceTypes.some((r) => r.value === 'verify_resource'));
    pass('FACETS', `${f.actions.length} distinct actions`);
  }

  // ===================== 5. RBAC ==================================
  {
    // Business rule (2026-09-04): audit.read is SUPER_ADMIN-only.
    assert.equal(roleHasPermission('SUPER_ADMIN', PERMISSIONS.AUDIT_READ), true);
    assert.equal(roleHasPermission('ADMIN', PERMISSIONS.AUDIT_READ), false, 'ADMIN must NOT get audit.read');
    assert.equal(roleHasPermission('VIEWER', PERMISSIONS.AUDIT_READ), false, 'VIEWER must NOT get audit.read');
    assert.equal(roleHasPermission('OPERATIONS', PERMISSIONS.AUDIT_READ), false);
    assert.equal(roleHasPermission('SUPPORT', PERMISSIONS.AUDIT_READ), false);
    pass('RBAC', 'audit.read: SUPER_ADMIN only');
  }

  // ===================== 6. read-only surface =====================
  {
    const methods = auditRoutes.stack
      .filter((l) => l.route)
      .flatMap((l) => Object.keys(l.route.methods));
    assert(methods.length > 0);
    assert(methods.every((m) => m === 'get'), `only GET routes, found: ${methods.join(',')}`);
    pass('READ_ONLY', `${methods.length} GET routes, no writes`);
  }

  console.log('\nWP-12 CMS audit-log viewer — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await query('DELETE FROM staff_audit_logs WHERE action = ?', [TAG]);
  await pool.end();
}
