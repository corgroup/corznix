import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';

// Data access for the staff notification feed. Broadcast rows +
// per-staff read markers (see migration 067), optionally warehouse-scoped
// (migration 068).

// Visibility predicate for `scope` ({ all, warehouseIds } from
// warehouseScopeForStaff) + the reader's own staff id:
//   * a row with staff_id set is PRIVATE to that one staff member (direct
//     message, @mention, "a customer replied to your ticket") — role does
//     not matter;
//   * otherwise: company-wide rows (warehouse_id IS NULL) plus rows for a
//     warehouse the staff member is assigned to. Global roles see every
//     non-staff-addressed row.
function visibility({ all, warehouseIds }, staffId) {
  const mine = '(n.staff_id IS NULL OR n.staff_id = ?)';
  if (all) return { sql: mine, params: [staffId] };
  if (!warehouseIds?.length) return { sql: `${mine} AND n.warehouse_id IS NULL`, params: [staffId] };
  const ph = warehouseIds.map(() => '?').join(',');
  return { sql: `${mine} AND (n.warehouse_id IS NULL OR n.warehouse_id IN (${ph}))`, params: [staffId, ...warehouseIds] };
}

export const staffNotificationRepository = {
  // INSERT IGNORE on the UNIQUE dedupe_key — a replayed domain event is a
  // no-op. Returns the new id, or null when the row already existed.
  // `warehouseId` scopes the row to one warehouse's assigned staff (+ global
  // roles); null = company-wide broadcast.
  // Multi-company (DESIGN.md §4.1) — Phase 4. brandId is optional and
  // defaults to the `is_default` brand (utils/defaultBrand.js) — this has
  // ~15+ call sites across order/shipment/support lifecycle events with no
  // request in scope. Read-side (list/unreadCount below) stays unscoped for
  // now — whether a staff member with multi-company access should see
  // notifications from every accessible brand or just the current one is a
  // product decision, not purely a scoping one; deferred.
  async insert({ category, eventKey, severity, title, body, link, entityType, entityId, warehouseId, staffId, dedupeKey, brandId = null }) {
    const id = randomUUID();
    const resolvedBrandId = await resolveBrandId(brandId);
    const res = await query(
      `INSERT IGNORE INTO staff_notifications
         (id, brand_id, category, event_key, severity, title, body, link, entity_type, entity_id, warehouse_id, staff_id, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3))`,
      [id, resolvedBrandId, category, eventKey, severity, title, body ?? null, link ?? null, entityType ?? null, entityId ?? null, warehouseId ?? null, staffId ?? null, dedupeKey],
    );
    return res.affectedRows ? id : null;
  },

  // One page, newest first. Fetches limit+1 so the caller can tell there is
  // another page without a COUNT. `scope` = { all, warehouseIds } from
  // warehouseScopeForStaff — restricts warehouse-targeted rows.
  async list({ staffId, scope = { all: true, warehouseIds: [] }, limit, before, category, unreadOnly, staffAddressedOnly = false }) {
    const vis = visibility(scope, staffId);
    const params = [staffId, ...vis.params];
    const where = [vis.sql];
    if (staffAddressedOnly) { where.push('n.staff_id = ?'); params.push(staffId); }
    if (before) { where.push('n.created_at < ?'); params.push(before); }
    if (category) { where.push('n.category = ?'); params.push(category); }
    if (unreadOnly) where.push('r.notification_id IS NULL');
    return query(
      `SELECT n.id, n.category, n.event_key, n.severity, n.title, n.body, n.link,
              n.entity_type, n.entity_id, n.warehouse_id, n.staff_id, n.created_at,
              (r.notification_id IS NOT NULL) AS is_read, r.read_at
         FROM staff_notifications n
         LEFT JOIN staff_notification_reads r
           ON r.notification_id = n.id AND r.staff_id = ?
         WHERE ${where.join(' AND ')}
         ORDER BY n.created_at DESC
         LIMIT ${Number(limit) + 1}`,
      params,
    );
  },

  async unreadCount(staffId, scope = { all: true, warehouseIds: [] }) {
    const vis = visibility(scope, staffId);
    const rows = await query(
      `SELECT COUNT(*) AS n
         FROM staff_notifications n
         LEFT JOIN staff_notification_reads r
           ON r.notification_id = n.id AND r.staff_id = ?
        WHERE r.notification_id IS NULL AND ${vis.sql}`,
      [staffId, ...vis.params],
    );
    return Number(rows[0]?.n || 0);
  },

  // Visibility-filtered like markAllRead below. This used to insert a receipt
  // for whatever ids the caller supplied, so a staff member could write a row
  // against a notification they cannot see -- another warehouse's, or another
  // company's. It leaked nothing (the feed filters on read), but the two
  // paths applied different rules for the same action, and the permissive one
  // wrote cross-company rows.
  async markRead(staffId, ids, scope = { all: true, warehouseIds: [] }) {
    if (!ids?.length) return 0;
    const vis = visibility(scope, staffId);
    const ph = ids.map(() => '?').join(',');
    const res = await query(
      `INSERT IGNORE INTO staff_notification_reads (staff_id, notification_id, read_at)
       SELECT ?, n.id, NOW(3)
         FROM staff_notifications n
        WHERE n.id IN (${ph}) AND ${vis.sql}`,
      [staffId, ...ids, ...vis.params],
    );
    return res.affectedRows;
  },

  async markAllRead(staffId, before, scope = { all: true, warehouseIds: [] }) {
    const vis = visibility(scope, staffId);
    const res = await query(
      `INSERT IGNORE INTO staff_notification_reads (staff_id, notification_id, read_at)
       SELECT ?, n.id, NOW(3)
         FROM staff_notifications n
        WHERE n.created_at <= ? AND ${vis.sql}
          AND NOT EXISTS (
            SELECT 1 FROM staff_notification_reads r
             WHERE r.notification_id = n.id AND r.staff_id = ?
          )`,
      [staffId, before, ...vis.params, staffId],
    );
    return res.affectedRows;
  },
};
