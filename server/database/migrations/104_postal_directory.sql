-- ---------------------------------------------------------------------------
-- 104 — the India Post PIN-code directory, held locally.
--
-- Source: "All India Pincode Directory till last month", published by the
-- Department of Posts (CEPT, Bengaluru) on the Government Open Data platform,
-- refreshed monthly. Filled by scripts/sync-india-post-directory.mjs, never by
-- hand: every row here came from that directory or from a live lookup against
-- it.
--
-- Held locally rather than queried per keystroke because the checkout must not
-- depend on a third-party service being up. A PIN lookup is assistance; when
-- this table cannot answer, the address form stays fully manual.
--
-- Districts offered for a state are derived from this same table, so the
-- district a PIN lookup suggests and the districts the dropdown lists always
-- use the same spelling. Mixing sources would raise false mismatches
-- ("Allahabad" against "Prayagraj").
--
-- Forward-only, non-destructive. MySQL 8.x.
-- ---------------------------------------------------------------------------

CREATE TABLE postal_offices (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  pincode CHAR(6) NOT NULL,
  office_name VARCHAR(160) NOT NULL,
  office_type VARCHAR(16) NULL,
  delivery VARCHAR(24) NULL,
  -- Title-cased on the way in: the source file carries "RAE BARELI" and
  -- "Rae Bareli" for the same district.
  district VARCHAR(120) NULL,
  -- The name as India Post wrote it, and the geo_states code it resolved to.
  -- A NULL code means the name did not resolve; the sync reports those rather
  -- than dropping the rows.
  state_name VARCHAR(120) NULL,
  state_code VARCHAR(8) NULL,
  division_name VARCHAR(120) NULL,
  region_name VARCHAR(120) NULL,
  circle_name VARCHAR(120) NULL,
  latitude DECIMAL(10,7) NULL,
  longitude DECIMAL(10,7) NULL,
  -- DIRECTORY: arrived through a full sync. LIVE: cached from a single PIN
  -- lookup made before the full directory had that PIN.
  source VARCHAR(16) NOT NULL,
  synced_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_postal_offices_pin_office (pincode, office_name),
  KEY ix_postal_offices_state_district (state_code, district),
  CONSTRAINT chk_postal_offices_source CHECK (source IN ('DIRECTORY', 'LIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per sync run, so "when was this directory last refreshed, and did it
-- finish" has an answer.
CREATE TABLE postal_directory_syncs (
  id CHAR(36) NOT NULL,
  resource_id VARCHAR(64) NOT NULL,
  -- FULL: the whole resource, to its last record. PARTIAL: a bounded trial run.
  -- PINCODE: one PIN. Only a succeeded FULL run lets a lookup say a PIN is
  -- "not found" — the others say nothing about the PINs they did not fetch.
  scope VARCHAR(16) NOT NULL,
  status VARCHAR(16) NOT NULL,
  records_fetched INT UNSIGNED NOT NULL DEFAULT 0,
  records_upserted INT UNSIGNED NOT NULL DEFAULT 0,
  unresolved_states JSON NULL,
  error_message VARCHAR(500) NULL,
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY ix_postal_directory_syncs_started (started_at),
  CONSTRAINT chk_postal_directory_syncs_scope CHECK (scope IN ('FULL', 'PARTIAL', 'PINCODE')),
  CONSTRAINT chk_postal_directory_syncs_status CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Addresses gain a district. Nullable: a PIN lookup cannot always supply one,
-- and a customer must never be blocked for want of it.
ALTER TABLE addresses ADD COLUMN district VARCHAR(120) NULL AFTER city;
