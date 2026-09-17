-- Phase 2 · Slice 18 — NDR (Non-Delivery Report) actions.
--
-- A failed delivery attempt surfaces as a DELIVERY_EXCEPTION shipment_event
-- (with status_type / nsl_code, migration 060). This table records the
-- operator's (or automation's) instruction to the carrier in response:
-- RE_ATTEMPT (retry delivery) or RESCHEDULE (reverse pickup) via
-- POST /api/p/update, which is ASYNC — it returns a UPL id polled through
-- GET /api/cmu/get_bulk_upl/{UPL_ID}.
--
-- The NDR "occurrence" itself is already the shipment_event; this is only the
-- outbound action + its resolution. Idempotent on `idempotency_key`.

CREATE TABLE shipment_ndr_actions (
  id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NOT NULL,
  awb VARCHAR(120) NOT NULL,
  provider_code VARCHAR(32) NOT NULL,
  action VARCHAR(16) NOT NULL,           -- RE_ATTEMPT | RESCHEDULE
  trigger_nsl_code VARCHAR(24) NULL,     -- the NSL on the DELIVERY_EXCEPTION that prompted this
  attempt_number INT UNSIGNED NULL,      -- carrier delivery-attempt count at request time
  status VARCHAR(16) NOT NULL DEFAULT 'PENDING',  -- PENDING | SUBMITTED | ACCEPTED | REJECTED | UNKNOWN | FAILED
  provider_upl_id VARCHAR(120) NULL,
  provider_response_json JSON NULL,
  provider_remark VARCHAR(500) NULL,
  idempotency_key VARCHAR(120) NOT NULL,
  requested_by_staff_id CHAR(36) NULL,
  instructions VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  submitted_at DATETIME(3) NULL,
  polled_at DATETIME(3) NULL,
  resolved_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ndr_idempotency (idempotency_key),
  KEY idx_ndr_shipment (shipment_id, created_at),
  KEY idx_ndr_poll (status, polled_at),
  CONSTRAINT fk_ndr_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
  CONSTRAINT fk_ndr_staff FOREIGN KEY (requested_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_ndr_action CHECK (action IN ('RE_ATTEMPT','RESCHEDULE')),
  CONSTRAINT chk_ndr_status CHECK (status IN ('PENDING','SUBMITTED','ACCEPTED','REJECTED','UNKNOWN','FAILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
