-- Wave 8G-5: deterministic saved Customer Segments.
--
-- A segment is a WHITELISTED structured rule definition (JSON) — never
-- arbitrary SQL or JavaScript from the CMS (§85/§87). The backend compiles a
-- validated definition into a fully parameterized query; the CMS only ever
-- submits `{ attribute, operator, value }` triples drawn from a fixed
-- registry.
--
-- Definition authority is DYNAMIC (§84/§90): membership is evaluated on
-- demand from the current revision. Editing a rule creates a NEW immutable
-- revision (§88) so anything that already referenced a revision — a broadcast
-- audience, a promotion eligibility check — keeps evaluating the exact rule
-- it was built against (§92). Snapshots exist only for historical proof and
-- high-scale repeated execution (§90), not as the primary store.
--
-- Segment membership alone is NEVER "marketable" — marketing audience =
-- segment ∩ effective consent ∩ not suppressed, resolved at send time (§91).
--
-- Forward-only, non-destructive. MySQL 8.x.

CREATE TABLE customer_segments (
  id CHAR(36) NOT NULL,
  segment_key VARCHAR(80) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description VARCHAR(500) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  -- The revision membership currently resolves against. NULL only briefly
  -- between INSERT of the segment and its first revision (same transaction).
  current_revision_id CHAR(36) NULL,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_customer_segments_key (segment_key),
  KEY idx_customer_segments_status (status),
  CONSTRAINT fk_customer_segments_creator FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_customer_segments_status CHECK (status IN ('ACTIVE','ARCHIVED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Immutable rule revisions. `revision` increments per segment. `definition_json`
-- is the validated rule tree: { match: 'ALL'|'ANY', conditions: [ { attribute,
-- operator, value, ... } ] }.
CREATE TABLE customer_segment_revisions (
  id CHAR(36) NOT NULL,
  segment_id CHAR(36) NOT NULL,
  revision INT UNSIGNED NOT NULL,
  match_mode VARCHAR(3) NOT NULL DEFAULT 'ALL',
  definition_json JSON NOT NULL,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_segment_revisions_seg_rev (segment_id, revision),
  CONSTRAINT fk_segment_revisions_segment FOREIGN KEY (segment_id)
    REFERENCES customer_segments(id) ON DELETE CASCADE,
  CONSTRAINT fk_segment_revisions_creator FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_segment_revisions_match CHECK (match_mode IN ('ALL','ANY'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE customer_segments
  ADD CONSTRAINT fk_customer_segments_current_rev FOREIGN KEY (current_revision_id)
    REFERENCES customer_segment_revisions(id) ON DELETE RESTRICT;

-- Frozen membership captures. `reason` records why it was taken; a broadcast
-- audience references one of these so a concurrent rule edit cannot produce a
-- half-old / half-new recipient list (§92).
CREATE TABLE customer_segment_snapshots (
  id CHAR(36) NOT NULL,
  segment_id CHAR(36) NOT NULL,
  revision_id CHAR(36) NOT NULL,
  reason VARCHAR(32) NOT NULL,
  member_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_segment_snapshots_segment (segment_id, created_at),
  CONSTRAINT fk_segment_snapshots_segment FOREIGN KEY (segment_id)
    REFERENCES customer_segments(id) ON DELETE CASCADE,
  CONSTRAINT fk_segment_snapshots_revision FOREIGN KEY (revision_id)
    REFERENCES customer_segment_revisions(id) ON DELETE RESTRICT,
  CONSTRAINT fk_segment_snapshots_creator FOREIGN KEY (created_by_staff_id)
    REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_segment_snapshots_reason CHECK (reason IN ('MANUAL','BROADCAST_AUDIENCE','PROMOTION','HISTORICAL_PROOF'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE customer_segment_snapshot_members (
  snapshot_id CHAR(36) NOT NULL,
  customer_id CHAR(36) NOT NULL,
  PRIMARY KEY (snapshot_id, customer_id),
  KEY idx_segment_snapshot_members_customer (customer_id),
  CONSTRAINT fk_segment_snapshot_members_snapshot FOREIGN KEY (snapshot_id)
    REFERENCES customer_segment_snapshots(id) ON DELETE CASCADE,
  CONSTRAINT fk_segment_snapshot_members_customer FOREIGN KEY (customer_id)
    REFERENCES customers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
