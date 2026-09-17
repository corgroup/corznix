-- Wave 8C-5: tax-profile configuration, real GST company identity, and the
-- rendered-artifact lifecycle for documents.
--
--  * company_profile gains structured GST metadata and is backfilled with
--    CORCOTTON's registered identity (real business data).
--  * tax_profiles / product_tax_profiles hold explicit, effective-dated HSN +
--    GST rates (basis points, never floats). Missing configuration BLOCKS
--    invoice issuance — it never silently defaults to zero tax.
--  * documents gain a render lifecycle (PENDING_RENDER -> RENDERING -> READY /
--    FAILED) + artefact byte size; the immutable content still lives in
--    snapshot_json, the rendered PDF/PNG in private storage (storage_key).
--  * invoices gain tax_status + issue_status; invoice_items snapshot the
--    tax profile per line. Pre-existing zero-tax invoices are marked
--    LEGACY_UNVERIFIED, never rewritten.
--  * credit_notes gain a treatment_status gate (no invented tax reversal).
--
-- Forward-only, non-destructive. MySQL 8.x.

-- ---------------------------------------------------------------------------
-- 1. Company profile — registered GST identity
-- ---------------------------------------------------------------------------
ALTER TABLE company_profile
  ADD COLUMN constitution VARCHAR(40) NULL AFTER trade_name,
  ADD COLUMN gst_registration_type VARCHAR(20) NULL AFTER gstin,
  ADD COLUMN gst_state_code CHAR(2) NULL AFTER gst_registration_type,
  ADD COLUMN gst_effective_from DATE NULL AFTER gst_state_code;

UPDATE company_profile SET
  legal_name = 'CORCOTTON',
  trade_name = 'M/S CORCOTTON',
  constitution = 'Partnership',
  gstin = '09AAVFC6069N1ZF',
  gst_registration_type = 'REGULAR',
  gst_state_code = '09',
  gst_effective_from = '2025-11-22',
  principal_address_line1 = 'C/O AASHA DEVI, Building No. 17, Parasupur',
  principal_address_line2 = 'Parasupur, Parsu Pur, Ghazipur',
  principal_city = 'Parsu Pur',
  principal_state = 'Uttar Pradesh',
  principal_postal_code = '233222',
  principal_country = 'IN',
  updated_at = NOW(3)
WHERE singleton_guard = 1;

-- ---------------------------------------------------------------------------
-- 2. Tax profiles
-- ---------------------------------------------------------------------------
CREATE TABLE tax_profiles (
  id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  hsn_sac VARCHAR(12) NOT NULL,
  taxability VARCHAR(16) NOT NULL DEFAULT 'TAXABLE',
  -- Basis points: 500 = 5.00%. Integer only — never a float.
  gst_rate_bps INT UNSIGNED NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_tax_profiles_status (status, effective_from),
  CONSTRAINT fk_tax_profiles_staff FOREIGN KEY (created_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_tax_profiles_taxability CHECK (taxability IN ('TAXABLE','EXEMPT','NIL_RATED','ZERO_RATED')),
  CONSTRAINT chk_tax_profiles_status CHECK (status IN ('ACTIVE','DISABLED')),
  CONSTRAINT chk_tax_profiles_rate CHECK (gst_rate_bps <= 5000),
  CONSTRAINT chk_tax_profiles_dates CHECK (effective_to IS NULL OR effective_to >= effective_from)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_tax_profiles (
  product_id CHAR(36) NOT NULL,
  tax_profile_id CHAR(36) NOT NULL,
  assigned_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (product_id),
  KEY idx_product_tax_profiles_profile (tax_profile_id),
  CONSTRAINT fk_product_tax_profiles_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_product_tax_profiles_profile FOREIGN KEY (tax_profile_id) REFERENCES tax_profiles(id) ON DELETE RESTRICT,
  CONSTRAINT fk_product_tax_profiles_staff FOREIGN KEY (assigned_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- 3. Invoices — tax + issuance gate; per-line tax snapshot
-- ---------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN tax_status VARCHAR(20) NOT NULL DEFAULT 'READY' AFTER status,
  ADD COLUMN issue_status VARCHAR(12) NOT NULL DEFAULT 'ISSUED' AFTER tax_status,
  ADD CONSTRAINT chk_invoices_tax_status CHECK (tax_status IN ('READY','INCOMPLETE','AMBIGUOUS','LEGACY_UNVERIFIED')),
  ADD CONSTRAINT chk_invoices_issue_status CHECK (issue_status IN ('PENDING','ISSUED'));

UPDATE invoices SET tax_status = 'LEGACY_UNVERIFIED'
  WHERE cgst_minor = 0 AND sgst_minor = 0 AND igst_minor = 0;

ALTER TABLE invoice_items
  ADD COLUMN tax_profile_id CHAR(36) NULL AFTER hsn_sac,
  ADD COLUMN gst_rate_bps INT UNSIGNED NULL AFTER tax_profile_id,
  ADD COLUMN taxability VARCHAR(16) NULL AFTER gst_rate_bps;

-- ---------------------------------------------------------------------------
-- 4. Documents — rendered artefact lifecycle
-- ---------------------------------------------------------------------------
ALTER TABLE documents
  MODIFY COLUMN status VARCHAR(16) NOT NULL DEFAULT 'PENDING_RENDER',
  MODIFY COLUMN format VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  ADD COLUMN byte_size INT UNSIGNED NULL AFTER sha256,
  ADD COLUMN rendered_at DATETIME(3) NULL AFTER byte_size,
  DROP CHECK chk_documents_status,
  ADD CONSTRAINT chk_documents_status CHECK (status IN ('PENDING','PENDING_RENDER','RENDERING','READY','FAILED'));

-- ---------------------------------------------------------------------------
-- 5. Credit notes — treatment gate
-- ---------------------------------------------------------------------------
ALTER TABLE credit_notes
  ADD COLUMN treatment_status VARCHAR(24) NOT NULL DEFAULT 'ISSUED' AFTER status,
  ADD CONSTRAINT chk_credit_notes_treatment CHECK (treatment_status IN ('ISSUED','PENDING_CONFIGURATION'));
