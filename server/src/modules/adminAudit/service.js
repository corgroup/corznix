import { StaffAuditRepository } from '../staff/repositories.js';

const repo = new StaffAuditRepository();

// Normalise a `YYYY-MM-DD` to a day boundary so the CMS date inputs behave
// intuitively: `from` = start of that day, `to` = end of that day.
const dayStart = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v} 00:00:00` : v || null);
const dayEnd = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v} 23:59:59.999` : v || null);

const parseMeta = (raw) => {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: String(raw) }; }
};

const toDto = (row) => ({
  id: row.id,
  at: row.created_at,
  action: row.action,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
  // actor: the staff row if it still exists, otherwise the email captured at
  // write time (the FK is ON DELETE SET NULL, so history outlives the user).
  actor: {
    staffUserId: row.staff_user_id,
    name: row.staff_name?.trim() || null,
    email: row.staff_email || row.actor_email || null,
  },
  ipAddress: row.ip_address,
  requestId: row.request_id,
  metadata: parseMeta(row.metadata_json),
});

class AdminAuditService {
  #normalise(query) {
    return {
      action: query.action || null,
      resourceType: query.resourceType || null,
      actorEmail: query.actorEmail || null,
      staffUserId: query.staffUserId || null,
      q: query.q || null,
      from: dayStart(query.from),
      to: dayEnd(query.to),
      limit: query.limit ?? 50,
      offset: query.offset ?? 0,
    };
  }

  async list(query = {}) {
    const filter = this.#normalise(query);
    const [rows, total] = await Promise.all([repo.search(filter), repo.countSearch(filter)]);
    return { logs: rows.map(toDto), total, limit: filter.limit, offset: filter.offset };
  }

  facets() {
    return repo.facets();
  }
}

export const adminAuditService = new AdminAuditService();
