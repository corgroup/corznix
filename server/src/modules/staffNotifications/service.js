import { logger } from '../../utils/logger.js';
import { staffNotificationRepository } from './repository.js';

// The staff notification feed — the real backing for the CMS topbar bell.
//
// record() is called fire-and-forget from domain flows (alongside the
// customer-facing notificationService.emit() call sites). Like emit(), it
// NEVER throws: a notification write failure must not affect the order /
// return / shipment transaction that triggered it. Callers still wrap it in
// `.catch(() => {})` as defence in depth.

const log = logger('staff-notifications');

const CATEGORIES = new Set(['ORDER', 'RETURN', 'SHIPMENT', 'INVENTORY', 'SYSTEM', 'MESSAGE', 'MENTION', 'SUPPORT', 'CAREERS']);
const SEVERITIES = new Set(['INFO', 'WARNING', 'CRITICAL']);
const MAX_MARK = 200;

function toDto(row) {
  return {
    id: row.id,
    category: row.category,
    eventKey: row.event_key,
    severity: row.severity,
    title: row.title,
    body: row.body,
    link: row.link,
    entityType: row.entity_type,
    entityId: row.entity_id,
    warehouseId: row.warehouse_id || null,
    staffId: row.staff_id || null,
    read: Boolean(Number(row.is_read)),
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

export const staffNotificationService = {
  /**
   * Post one operational event to every staff member's feed. Idempotent per
   * `dedupeKey` (UNIQUE) — a replayed event does not double-post. Never throws.
   *
   * @param {object} input
   * @param {'ORDER'|'RETURN'|'SHIPMENT'|'INVENTORY'|'SYSTEM'} input.category
   * @param {string} input.eventKey     stable event id (e.g. 'ORDER_PLACED')
   * @param {'INFO'|'WARNING'|'CRITICAL'} [input.severity='INFO']
   * @param {string} input.title        short headline (<=200 chars)
   * @param {string} [input.body]       one line of detail (<=500 chars)
   * @param {string} [input.link]       CMS route to deep-link to
   * @param {string} [input.entityType] e.g. 'order'
   * @param {string} [input.entityId]
   * @param {string} [input.warehouseId] scope the row to one warehouse's staff
   * @param {string} [input.staffId]     address the row to ONE staff member (DM / @mention / assigned-ticket reply) — private to them
   * @param {string} input.dedupeKey    deterministic per logical occurrence
   * @returns {Promise<string|null>} new id, or null (deduped / failed)
   */
  async record(input = {}) {
    try {
      if (!input.title || !input.dedupeKey) {
        log.warn('staff_notification_missing_fields', { eventKey: input.eventKey || null });
        return null;
      }
      const category = CATEGORIES.has(input.category) ? input.category : 'SYSTEM';
      const severity = SEVERITIES.has(input.severity) ? input.severity : 'INFO';
      return await staffNotificationRepository.insert({
        category,
        eventKey: (input.eventKey || 'SYSTEM').slice(0, 60),
        severity,
        title: String(input.title).slice(0, 200),
        body: input.body ? String(input.body).slice(0, 500) : null,
        link: input.link ? String(input.link).slice(0, 300) : null,
        entityType: input.entityType ? String(input.entityType).slice(0, 40) : null,
        entityId: input.entityId ? String(input.entityId).slice(0, 64) : null,
        warehouseId: input.warehouseId ? String(input.warehouseId).slice(0, 36) : null,
        staffId: input.staffId ? String(input.staffId).slice(0, 36) : null,
        dedupeKey: String(input.dedupeKey).slice(0, 200),
      });
    } catch (err) {
      log.error('staff_notification_record_failed', { eventKey: input.eventKey || null, error: err.message });
      return null;
    }
  },

  async feed(staffId, { scope = { all: true, warehouseIds: [] }, limit = 20, before = null, category = null, unreadOnly = false, staffAddressedOnly = false } = {}) {
    const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const rows = await staffNotificationRepository.list({ staffId, scope, limit: capped, before, category, unreadOnly, staffAddressedOnly });
    const hasMore = rows.length > capped;
    const items = rows.slice(0, capped).map(toDto);
    const unreadCount = await staffNotificationRepository.unreadCount(staffId, scope);
    return {
      items,
      unreadCount,
      nextCursor: hasMore ? items[items.length - 1].createdAt : null,
    };
  },

  async unreadCount(staffId, scope = { all: true, warehouseIds: [] }) {
    return { count: await staffNotificationRepository.unreadCount(staffId, scope) };
  },

  async markRead(staffId, ids, scope = { all: true, warehouseIds: [] }) {
    const clean = [...new Set((ids || []).filter((x) => typeof x === 'string' && x))].slice(0, MAX_MARK);
    const marked = await staffNotificationRepository.markRead(staffId, clean, scope);
    return { marked, unreadCount: await staffNotificationRepository.unreadCount(staffId, scope) };
  },

  async markAllRead(staffId, scope = { all: true, warehouseIds: [] }) {
    const marked = await staffNotificationRepository.markAllRead(staffId, new Date(), scope);
    return { marked, unreadCount: 0 };
  },
};
