-- Careers: CMS-managed job postings + candidate applications.
--
-- career_jobs      = the posting itself (draft -> published -> closed). No
--                    hard delete once it has applications (FK RESTRICT) —
--                    "manage" means status, not erasing the record an
--                    applicant applied against.
-- career_applications = one row per submission. Applicant identity is stored
--                    directly (name/email/phone) — an applicant is not a
--                    customer account, there is no login involved.
--                    `job_title_snapshot` freezes what the applicant actually
--                    applied to; a later job edit/close never rewrites it
--                    (mirrors support_tickets.context_snapshot_json / order
--                    line-item snapshots elsewhere in this codebase).
--                    The resume file itself lives in the existing private
--                    document storage boundary (documents/storage.js,
--                    LocalDocumentStorage) — never on a public/CDN path.
-- career_application_events = append-only audit trail (status changes,
--                    internal notes, outbound emails, assignment) — mirrors
--                    support_events.
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE career_jobs (
  id CHAR(36) NOT NULL,
  slug VARCHAR(160) NOT NULL,
  title VARCHAR(160) NOT NULL,
  department VARCHAR(80) NULL,
  location VARCHAR(120) NULL,
  employment_type VARCHAR(20) NOT NULL DEFAULT 'FULL_TIME',
  summary VARCHAR(300) NULL,
  description MEDIUMTEXT NOT NULL,
  -- Each a JSON array of plain strings — bullet lists on the job page.
  responsibilities JSON NULL,
  requirements JSON NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'DRAFT',
  posted_at DATETIME(3) NULL,
  closes_at DATETIME(3) NULL,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_career_jobs_slug (slug),
  KEY idx_career_jobs_status (status, posted_at),
  CONSTRAINT fk_career_jobs_creator FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_career_jobs_status CHECK (status IN ('DRAFT','PUBLISHED','CLOSED')),
  CONSTRAINT chk_career_jobs_employment CHECK (employment_type IN
    ('FULL_TIME','PART_TIME','CONTRACT','INTERNSHIP'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE career_applications (
  id CHAR(36) NOT NULL,
  application_number VARCHAR(48) NOT NULL,
  job_id CHAR(36) NOT NULL,
  job_title_snapshot VARCHAR(160) NOT NULL,
  first_name VARCHAR(80) NOT NULL,
  last_name VARCHAR(80) NOT NULL,
  email VARCHAR(255) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  portfolio_url VARCHAR(500) NULL,
  linkedin_url VARCHAR(500) NULL,
  cover_note VARCHAR(4000) NULL,
  -- Opaque key into documentStorage (LocalDocumentStorage) — PDF only.
  resume_storage_key VARCHAR(160) NOT NULL,
  resume_file_name VARCHAR(255) NOT NULL,
  resume_byte_size INT UNSIGNED NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'NEW',
  assigned_staff_id CHAR(36) NULL,
  -- Optimistic concurrency for assignment (mirrors support_tickets).
  assignment_version INT UNSIGNED NOT NULL DEFAULT 0,
  submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_career_apps_number (application_number),
  KEY idx_career_apps_job (job_id, submitted_at),
  KEY idx_career_apps_status (status, submitted_at),
  KEY idx_career_apps_assigned (assigned_staff_id),
  CONSTRAINT fk_career_apps_job FOREIGN KEY (job_id)
    REFERENCES career_jobs(id) ON DELETE RESTRICT,
  CONSTRAINT fk_career_apps_assigned FOREIGN KEY (assigned_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_career_apps_status CHECK (status IN
    ('NEW','UNDER_REVIEW','SHORTLISTED','INTERVIEW','SELECTED','REJECTED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE career_application_events (
  id CHAR(36) NOT NULL,
  application_id CHAR(36) NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  from_status VARCHAR(16) NULL,
  to_status VARCHAR(16) NULL,
  note VARCHAR(4000) NULL,
  staff_id CHAR(36) NULL,
  detail_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_career_app_events_app (application_id, created_at),
  CONSTRAINT fk_career_app_events_app FOREIGN KEY (application_id)
    REFERENCES career_applications(id) ON DELETE CASCADE,
  CONSTRAINT fk_career_app_events_staff FOREIGN KEY (staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_career_app_events_type CHECK (event_type IN
    ('APPLICATION_RECEIVED','STATUS_CHANGED','NOTE_ADDED','EMAIL_SENT','ASSIGNED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A new application fires a staff notification (CMS topbar bell) same as
-- every other operational event — widen the category whitelist.
ALTER TABLE staff_notifications
  DROP CHECK chk_staff_notifications_category;
ALTER TABLE staff_notifications
  ADD CONSTRAINT chk_staff_notifications_category
    CHECK (category IN ('ORDER','RETURN','SHIPMENT','INVENTORY','SYSTEM','SUPPORT','MESSAGE','MENTION','CAREERS'));
