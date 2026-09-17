-- Phase 2 · Slice 17 — carrier-provided shipment documents.
--
-- Delhivery pushes three document webhooks, SEPARATE from Scan Push (EPOD /
-- QC image / Sorter image) and also exposes a Download Document API
-- (GET /api/rest/fetch/pkg/document/, doc_type SIGNATURE_URL | RVP_QC_IMAGE |
-- EPOD | SELLER_RETURN_IMAGE). Both land here.
--
-- These are provider-hosted binaries (base64 in the push, or a URL) — NOT
-- CORCOTTON-rendered-from-snapshot like the `documents` table. So they get
-- their own store: idempotent on the provider event key, linked to a shipment
-- by AWB (the provider order ref is recorded but never trusted as the sole
-- key — QC `returnId` semantics are ambiguous per the requirement template).

CREATE TABLE shipment_provider_documents (
  id CHAR(36) NOT NULL,
  shipment_id CHAR(36) NULL,
  order_id CHAR(36) NULL,
  provider_code VARCHAR(32) NOT NULL,
  awb VARCHAR(120) NULL,
  doc_type VARCHAR(24) NOT NULL,          -- EPOD | QC_IMAGE | SORTER_IMAGE | SIGNATURE
  source VARCHAR(16) NOT NULL,            -- WEBHOOK | API_PULL
  provider_event_key VARCHAR(120) NOT NULL,
  image_status VARCHAR(16) NOT NULL DEFAULT 'PENDING_FETCH',  -- STORED | LINKED_URL | PENDING_FETCH | UNAVAILABLE
  image_url VARCHAR(1000) NULL,           -- provider-hosted URL (push carried one, or Download API returned one)
  storage_key VARCHAR(255) NULL,          -- opaque key into private document storage (bytes we copied)
  sha256 CHAR(64) NULL,
  byte_size INT UNSIGNED NULL,
  content_type VARCHAR(80) NULL,
  provider_order_ref VARCHAR(160) NULL,   -- the orderID / returnId / doc the provider sent (untrusted)
  link_status VARCHAR(16) NOT NULL DEFAULT 'LINKED',          -- LINKED | UNMATCHED_AWB | REF_MISMATCH
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  fetched_at DATETIME(3) NULL,
  metadata_json JSON NULL,
  PRIMARY KEY (id),
  -- A replayed webhook / a repeated API pull is ONE row.
  UNIQUE KEY uk_spd_provider_event (provider_code, provider_event_key),
  KEY idx_spd_shipment (shipment_id, doc_type),
  KEY idx_spd_order (order_id),
  KEY idx_spd_awb (awb),
  CONSTRAINT fk_spd_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE CASCADE,
  CONSTRAINT fk_spd_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT chk_spd_doc_type CHECK (doc_type IN ('EPOD','QC_IMAGE','SORTER_IMAGE','SIGNATURE')),
  CONSTRAINT chk_spd_image_status CHECK (image_status IN ('STORED','LINKED_URL','PENDING_FETCH','UNAVAILABLE')),
  CONSTRAINT chk_spd_source CHECK (source IN ('WEBHOOK','API_PULL')),
  CONSTRAINT chk_spd_link_status CHECK (link_status IN ('LINKED','UNMATCHED_AWB','REF_MISMATCH'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
