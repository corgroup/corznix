-- Phase 2 · Slice 19 — RVP QC 3.0 foundation.
--
-- Delhivery's Reverse-Pickup QC ("RVP QC 3.0", custom_qc / qc_type=param on the
-- reverse-shipment create payload — Logistics Notes §14-27): the pickup agent
-- runs a CORCOTTON-defined question set at the customer's door; a wrong answer
-- to a REQUIRED question fails QC.
--
-- CORCOTTON owns stable question IDs (CORCOTTON_QC_NNN) with a controlled
-- mapping to Delhivery's account-configured IDs. Limits: max 2 QC items, max 6
-- questions per item — an invalid config is an EXPLICIT error + manual-review
-- fallback, never a silent downgrade. Each reverse shipment freezes the exact
-- config it used (versioning): a later template edit must not alter history.
--
-- This is the FOUNDATION only. The real Delhivery reverse-create field spec and
-- the account-side question mappings still need the Delhivery POC; a question
-- with delhivery_mapping_status <> 'MAPPED' forces MANUAL_REVIEW.

CREATE TABLE qc_questions (
  id CHAR(36) NOT NULL,
  client_question_id VARCHAR(40) NOT NULL,           -- CORCOTTON_QC_001 ... (CORCOTTON-owned, stable)
  prompt VARCHAR(300) NOT NULL,
  answer_type VARCHAR(16) NOT NULL DEFAULT 'multi',  -- multi | single | text
  options_json JSON NULL,                            -- ["Yes","No"]
  correct_value_json JSON NULL,                      -- ["Yes"]  (NULL for informational / free text)
  required TINYINT(1) NOT NULL DEFAULT 1,
  applicable_return_reasons_json JSON NULL,          -- ["SIZE_FIT","QUALITY"]  (NULL = all reasons)
  applicable_product_categories_json JSON NULL,      -- ["apparel"]             (NULL = all categories)
  delhivery_mapping_status VARCHAR(16) NOT NULL DEFAULT 'PENDING',  -- PENDING | MAPPED | REJECTED
  delhivery_question_id VARCHAR(64) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_qc_questions_client_id (client_question_id),
  CONSTRAINT chk_qc_answer_type CHECK (answer_type IN ('multi','single','text')),
  CONSTRAINT chk_qc_mapping_status CHECK (delhivery_mapping_status IN ('PENDING','MAPPED','REJECTED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One frozen QC config + result per return request.
CREATE TABLE return_qc_snapshots (
  id CHAR(36) NOT NULL,
  return_request_id CHAR(36) NOT NULL,
  return_shipment_id CHAR(36) NULL,
  order_id CHAR(36) NULL,
  reverse_awb VARCHAR(120) NULL,
  qc_version VARCHAR(40) NOT NULL,                   -- deterministic hash of the question set at freeze time
  custom_qc_json JSON NOT NULL,                      -- the EXACT payload sent to (or built for) the carrier
  question_ids_json JSON NOT NULL,                   -- ["CORCOTTON_QC_001", ...]
  build_status VARCHAR(16) NOT NULL,                 -- BUILT | MANUAL_REVIEW
  build_error VARCHAR(255) NULL,
  qc_status VARCHAR(16) NOT NULL DEFAULT 'NOT_RUN',  -- NOT_RUN | PASS | FAIL | INCONCLUSIVE
  qc_result_json JSON NULL,                          -- the FE's recorded answers
  failure_details_json JSON NULL,                    -- which required questions failed + expected/got
  qc_source VARCHAR(16) NULL,                        -- PROVIDER_FE | MANUAL | MOCK
  frozen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  qc_recorded_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_return_qc_snapshot_request (return_request_id),
  KEY idx_return_qc_snapshot_awb (reverse_awb),
  CONSTRAINT fk_rqs_request FOREIGN KEY (return_request_id) REFERENCES return_requests(id) ON DELETE CASCADE,
  CONSTRAINT chk_rqs_build CHECK (build_status IN ('BUILT','MANUAL_REVIEW')),
  CONSTRAINT chk_rqs_qc CHECK (qc_status IN ('NOT_RUN','PASS','FAIL','INCONCLUSIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Documented default question set. delhivery_mapping_status = 'PENDING' for all
-- — the Delhivery account POC must supply the real mapped IDs before RVP QC can
-- run for real; until then a reverse pickup that needs QC goes to MANUAL_REVIEW.
-- The exact question wording + correct answers are a BUSINESS decision — these
-- are a sane, spec-aligned starting point (the "damaged return must not fail
-- merely because damaged" rule is reflected in the DAMAGED correct_value).
INSERT INTO qc_questions
  (id, client_question_id, prompt, answer_type, options_json, correct_value_json, required,
   applicable_return_reasons_json, applicable_product_categories_json, sort_order)
VALUES
  (UUID(), 'CORCOTTON_QC_001', 'Is this the same CORCOTTON product the customer ordered?', 'multi',
   '["Yes","No"]', '["Yes"]', 1, NULL, NULL, 10),
  (UUID(), 'CORCOTTON_QC_002', 'Are the original CORCOTTON tags and labels still attached?', 'multi',
   '["Yes","No"]', '["Yes"]', 1, '["SIZE_FIT","CHANGED_MIND","NOT_AS_DESCRIBED","QUALITY","WRONG_ITEM"]', NULL, 20),
  (UUID(), 'CORCOTTON_QC_003', 'Does the item appear unused (unwashed, unworn)?', 'multi',
   '["Yes","No"]', '["Yes"]', 1, '["SIZE_FIT","CHANGED_MIND","NOT_AS_DESCRIBED","WRONG_ITEM"]', NULL, 30),
  (UUID(), 'CORCOTTON_QC_004', 'Does the visible condition match the reported "damaged" issue?', 'multi',
   '["Yes","No"]', '["Yes"]', 1, '["DEFECTIVE","DAMAGED_IN_TRANSIT"]', NULL, 40),
  (UUID(), 'CORCOTTON_QC_005', 'Does the SKU / style on the item match the order?', 'multi',
   '["Yes","No"]', '["Yes"]', 1, '["WRONG_ITEM"]', NULL, 50),
  (UUID(), 'CORCOTTON_QC_006', 'Any additional notes from the pickup agent (optional).', 'text',
   NULL, NULL, 0, NULL, NULL, 60);
