import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

const parseJson = (v) => (v == null ? null : (typeof v === 'string' ? JSON.parse(v) : v));

const jobDto = (r) => ({
  id: r.id, slug: r.slug, title: r.title, department: r.department, location: r.location,
  employmentType: r.employment_type, summary: r.summary,
  description: r.description, responsibilities: parseJson(r.responsibilities) || [], requirements: parseJson(r.requirements) || [],
  status: r.status, postedAt: r.posted_at, closesAt: r.closes_at,
  createdByStaffId: r.created_by_staff_id, createdAt: r.created_at, updatedAt: r.updated_at,
  applicationCount: r.application_count != null ? Number(r.application_count) : undefined,
});

export class CareerJobRepository {
  async list({ status = null } = {}) {
    const where = status ? 'WHERE j.status = ?' : '';
    const rows = await query(
      `SELECT j.*, (SELECT COUNT(*) FROM career_applications a WHERE a.job_id = j.id) AS application_count
         FROM career_jobs j ${where}
        ORDER BY (j.status = 'PUBLISHED') DESC, j.updated_at DESC`,
      status ? [status] : [],
    );
    return rows.map(jobDto);
  }

  async listPublished({ department = null, location = null } = {}) {
    const where = ["status = 'PUBLISHED'", "(closes_at IS NULL OR closes_at > NOW(3))"];
    const params = [];
    if (department) { where.push('department = ?'); params.push(department); }
    if (location) { where.push('location = ?'); params.push(location); }
    const rows = await query(
      `SELECT * FROM career_jobs WHERE ${where.join(' AND ')} ORDER BY posted_at DESC`, params,
    );
    return rows.map(jobDto);
  }

  async byId(id) {
    const rows = await query('SELECT * FROM career_jobs WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? jobDto(rows[0]) : null;
  }

  async bySlug(slug, { publishedOnly = false } = {}) {
    const rows = await query(
      `SELECT * FROM career_jobs WHERE slug = ? ${publishedOnly ? "AND status = 'PUBLISHED'" : ''} LIMIT 1`,
      [slug],
    );
    return rows[0] ? jobDto(rows[0]) : null;
  }

  async slugExists(slug) {
    const rows = await query('SELECT 1 FROM career_jobs WHERE slug = ? LIMIT 1', [slug]);
    return rows.length > 0;
  }

  async insert(input, staffId) {
    const id = randomUUID();
    await query(
      `INSERT INTO career_jobs
        (id, slug, title, department, location, employment_type, summary, description, responsibilities, requirements, status, posted_at, created_by_staff_id)
       VALUES (?,?,?,?,?,?,?,?,CAST(? AS JSON),CAST(? AS JSON),?,?,?)`,
      [id, input.slug, input.title, input.department ?? null, input.location ?? null, input.employmentType || 'FULL_TIME',
        input.summary ?? null, input.description, JSON.stringify(input.responsibilities || []), JSON.stringify(input.requirements || []),
        input.status || 'DRAFT', input.status === 'PUBLISHED' ? new Date() : null, staffId ?? null],
    );
    return this.byId(id);
  }

  async update(id, patch) {
    const map = {
      title: 'title', department: 'department', location: 'location', employmentType: 'employment_type',
      summary: 'summary', description: 'description', closesAt: 'closes_at',
    };
    const jsonMap = { responsibilities: 'responsibilities', requirements: 'requirements' };
    const sets = [];
    const params = [];
    for (const [k, col] of Object.entries(map)) {
      if (patch[k] === undefined) continue;
      sets.push(`${col} = ?`); params.push(patch[k]);
    }
    for (const [k, col] of Object.entries(jsonMap)) {
      if (patch[k] === undefined) continue;
      sets.push(`${col} = CAST(? AS JSON)`); params.push(JSON.stringify(patch[k] || []));
    }
    if (!sets.length) return this.byId(id);
    params.push(id);
    await query(`UPDATE career_jobs SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ?`, params);
    return this.byId(id);
  }

  async setStatus(id, status) {
    const postedAtSet = status === 'PUBLISHED' ? ', posted_at = COALESCE(posted_at, NOW(3))' : '';
    await query(`UPDATE career_jobs SET status = ?, updated_at = NOW(3)${postedAtSet} WHERE id = ?`, [status, id]);
    return this.byId(id);
  }
}

const appDto = (r) => ({
  id: r.id, applicationNumber: r.application_number, jobId: r.job_id, jobTitleSnapshot: r.job_title_snapshot,
  firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone,
  portfolioUrl: r.portfolio_url, linkedinUrl: r.linkedin_url, coverNote: r.cover_note,
  resumeStorageKey: r.resume_storage_key, resumeFileName: r.resume_file_name, resumeByteSize: Number(r.resume_byte_size),
  status: r.status, assignedStaffId: r.assigned_staff_id, assignmentVersion: Number(r.assignment_version),
  submittedAt: r.submitted_at, updatedAt: r.updated_at,
  jobSlug: r.job_slug, assignedStaffEmail: r.assigned_staff_email,
});

export class CareerApplicationRepository {
  async insert(input) {
    const id = randomUUID();
    await query(
      `INSERT INTO career_applications
        (id, application_number, job_id, job_title_snapshot, first_name, last_name, email, phone,
         portfolio_url, linkedin_url, cover_note, resume_storage_key, resume_file_name, resume_byte_size, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'NEW')`,
      [id, input.applicationNumber, input.jobId, input.jobTitleSnapshot, input.firstName, input.lastName, input.email, input.phone,
        input.portfolioUrl ?? null, input.linkedinUrl ?? null, input.coverNote ?? null,
        input.resumeStorageKey, input.resumeFileName, input.resumeByteSize],
    );
    return this.byId(id);
  }

  #baseSelect() {
    return `SELECT a.*, j.slug AS job_slug, su.email AS assigned_staff_email
              FROM career_applications a
              JOIN career_jobs j ON j.id = a.job_id
              LEFT JOIN staff_users su ON su.id = a.assigned_staff_id`;
  }

  async list({ jobId = null, status = null, q = null, assignedStaffId = null, limit = 50, offset = 0 } = {}) {
    const where = [];
    const params = [];
    if (jobId) { where.push('a.job_id = ?'); params.push(jobId); }
    if (status) { where.push('a.status = ?'); params.push(status); }
    if (assignedStaffId) { where.push('a.assigned_staff_id = ?'); params.push(assignedStaffId); }
    if (q) {
      where.push('(a.first_name LIKE ? OR a.last_name LIKE ? OR a.email LIKE ? OR a.application_number LIKE ?)');
      const like = `%${q}%`; params.push(like, like, like, like);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await query(
      `${this.#baseSelect()} ${clause} ORDER BY a.submitted_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)],
    );
    const [{ n }] = await query(`SELECT COUNT(*) n FROM career_applications a ${clause}`, params);
    return { applications: rows.map(appDto), total: Number(n) };
  }

  async byId(id) {
    const rows = await query(`${this.#baseSelect()} WHERE a.id = ? LIMIT 1`, [id]);
    return rows[0] ? appDto(rows[0]) : null;
  }

  facets() {
    return query("SELECT status, COUNT(*) n FROM career_applications GROUP BY status").then((rows) => {
      const out = { NEW: 0, UNDER_REVIEW: 0, SHORTLISTED: 0, INTERVIEW: 0, SELECTED: 0, REJECTED: 0 };
      for (const r of rows) out[r.status] = Number(r.n);
      return out;
    });
  }

  async setStatus(id, status) {
    await query('UPDATE career_applications SET status = ?, updated_at = NOW(3) WHERE id = ?', [status, id]);
    return this.byId(id);
  }

  async assign(id, staffId, expectedVersion) {
    const result = await query(
      'UPDATE career_applications SET assigned_staff_id = ?, assignment_version = assignment_version + 1, updated_at = NOW(3) WHERE id = ? AND assignment_version = ?',
      [staffId, id, expectedVersion],
    );
    return result.affectedRows > 0 ? this.byId(id) : null;
  }

  insertEvent(e) {
    return query(
      `INSERT INTO career_application_events (id, application_id, event_type, from_status, to_status, note, staff_id, detail_json)
       VALUES (?,?,?,?,?,?,?,CAST(? AS JSON))`,
      [randomUUID(), e.applicationId, e.eventType, e.fromStatus ?? null, e.toStatus ?? null, e.note ?? null, e.staffId ?? null, JSON.stringify(e.detail ?? null)],
    );
  }

  events(applicationId) {
    return query(
      `SELECT ev.*, su.email AS staff_email FROM career_application_events ev
        LEFT JOIN staff_users su ON su.id = ev.staff_id
        WHERE ev.application_id = ? ORDER BY ev.created_at ASC`,
      [applicationId],
    ).then((rows) => rows.map((r) => ({
      id: r.id, eventType: r.event_type, fromStatus: r.from_status, toStatus: r.to_status,
      note: r.note, staffId: r.staff_id, staffEmail: r.staff_email, detail: parseJson(r.detail_json), createdAt: r.created_at,
    })));
  }
}

export const careerJobRepository = new CareerJobRepository();
export const careerApplicationRepository = new CareerApplicationRepository();
