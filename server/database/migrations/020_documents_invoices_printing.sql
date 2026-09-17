-- Document, invoice / credit-note, and print-station subsystem (Wave 8C-3/8C-4).
--
-- `documents` is the single backend authority for every generated artefact
-- (invoice, credit note, packing slip, shipping label). The immutable content
-- lives in `snapshot_json`; `storage_key` is a future hook for a rendered
-- PDF/PNG in private object storage. Generation is idempotent — one READY
-- document per (type, refs, version).
--
-- Invoices carry immutable supplier + dispatch-warehouse snapshots (kept
-- separate on purpose). Tax columns exist but stay 0 until CORCOTTON's real
-- GST configuration is supplied — the tax split is a pluggable policy.
--
-- Forward-only, non-destructive. MySQL 8.x. No real carrier / storage calls.

CREATE TABLE document_counters (
  name VARCHAR(64) NOT NULL,
  value INT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE documents (
  id CHAR(36) NOT NULL,
  document_type VARCHAR(24) NOT NULL,
  order_id CHAR(36) NULL,
  fulfillment_id CHAR(36) NULL,
  shipment_id CHAR(36) NULL,
  warehouse_id CHAR(36) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'READY',
  format VARCHAR(8) NOT NULL DEFAULT 'JSON',
  version INT UNSIGNED NOT NULL DEFAULT 1,
  -- Immutable rendered content. A later PDF pipeline sets storage_key instead.
  snapshot_json JSON NOT NULL,
  sha256 CHAR(64) NOT NULL,
  storage_key VARCHAR(255) NULL,
  failure_code VARCHAR(80) NULL,
  created_by_staff_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  -- The idempotency key: at most one document per (type, its owning ref, version).
  dedupe_key VARCHAR(160) GENERATED ALWAYS AS (CONCAT(
    document_type, ':',
    COALESCE(shipment_id, fulfillment_id, order_id, ''), ':', version
  )) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY uk_documents_dedupe (dedupe_key),
  KEY idx_documents_order (order_id),
  KEY idx_documents_warehouse (warehouse_id),
  CONSTRAINT fk_documents_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents_fulfillment FOREIGN KEY (fulfillment_id) REFERENCES fulfillments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents_shipment FOREIGN KEY (shipment_id) REFERENCES shipments(id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  CONSTRAINT fk_documents_staff FOREIGN KEY (created_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_documents_type CHECK (document_type IN ('INVOICE','CREDIT_NOTE','PACKING_SLIP','SHIPPING_LABEL')),
  CONSTRAINT chk_documents_status CHECK (status IN ('PENDING','READY','FAILED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE invoices (
  id CHAR(36) NOT NULL,
  order_id CHAR(36) NOT NULL,
  invoice_number VARCHAR(40) NOT NULL,
  issued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  currency CHAR(3) NOT NULL,
  supplier_snapshot_json JSON NOT NULL,
  dispatch_snapshot_json JSON NULL,
  billing_snapshot_json JSON NOT NULL,
  shipping_snapshot_json JSON NOT NULL,
  subtotal_minor INT UNSIGNED NOT NULL,
  discount_minor INT UNSIGNED NOT NULL DEFAULT 0,
  taxable_minor INT UNSIGNED NOT NULL,
  cgst_minor INT UNSIGNED NOT NULL DEFAULT 0,
  sgst_minor INT UNSIGNED NOT NULL DEFAULT 0,
  igst_minor INT UNSIGNED NOT NULL DEFAULT 0,
  shipping_minor INT UNSIGNED NOT NULL DEFAULT 0,
  grand_total_minor INT UNSIGNED NOT NULL,
  online_paid_minor INT UNSIGNED NOT NULL DEFAULT 0,
  cod_due_minor INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(12) NOT NULL DEFAULT 'ISSUED',
  document_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_invoices_order (order_id),
  UNIQUE KEY uk_invoices_number (invoice_number),
  CONSTRAINT fk_invoices_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_invoices_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
  CONSTRAINT chk_invoices_status CHECK (status IN ('ISSUED','CANCELLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE invoice_items (
  id CHAR(36) NOT NULL,
  invoice_id CHAR(36) NOT NULL,
  sku VARCHAR(64) NOT NULL,
  product_name VARCHAR(200) NOT NULL,
  hsn_sac VARCHAR(20) NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price_minor INT UNSIGNED NOT NULL,
  discount_minor INT UNSIGNED NOT NULL DEFAULT 0,
  taxable_minor INT UNSIGNED NOT NULL,
  tax_minor INT UNSIGNED NOT NULL DEFAULT 0,
  total_minor INT UNSIGNED NOT NULL,
  PRIMARY KEY (id),
  KEY idx_invoice_items_invoice (invoice_id),
  CONSTRAINT fk_invoice_items_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE credit_notes (
  id CHAR(36) NOT NULL,
  invoice_id CHAR(36) NOT NULL,
  order_id CHAR(36) NOT NULL,
  credit_note_number VARCHAR(40) NOT NULL,
  issued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  amount_minor INT UNSIGNED NOT NULL,
  reason VARCHAR(255) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ISSUED',
  document_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_credit_notes_number (credit_note_number),
  UNIQUE KEY uk_credit_notes_invoice (invoice_id),
  CONSTRAINT fk_credit_notes_invoice FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE RESTRICT,
  CONSTRAINT fk_credit_notes_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE RESTRICT,
  CONSTRAINT fk_credit_notes_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE SET NULL,
  CONSTRAINT chk_credit_notes_status CHECK (status IN ('ISSUED','VOIDED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE print_stations (
  id CHAR(36) NOT NULL,
  warehouse_id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_print_stations_wh_name (warehouse_id, name),
  CONSTRAINT fk_print_stations_warehouse FOREIGN KEY (warehouse_id) REFERENCES warehouses(id) ON DELETE RESTRICT,
  CONSTRAINT chk_print_stations_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE printers (
  id CHAR(36) NOT NULL,
  print_station_id CHAR(36) NOT NULL,
  name VARCHAR(120) NOT NULL,
  printer_type VARCHAR(16) NOT NULL DEFAULT 'A4_PDF',
  label_size VARCHAR(16) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'ACTIVE',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_printers_station_name (print_station_id, name),
  CONSTRAINT fk_printers_station FOREIGN KEY (print_station_id) REFERENCES print_stations(id) ON DELETE CASCADE,
  CONSTRAINT chk_printers_type CHECK (printer_type IN ('A4_PDF','LABEL_4X6_PDF','ZPL')),
  CONSTRAINT chk_printers_status CHECK (status IN ('ACTIVE','DISABLED'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE print_jobs (
  id CHAR(36) NOT NULL,
  document_id CHAR(36) NOT NULL,
  printer_id CHAR(36) NOT NULL,
  print_station_id CHAR(36) NOT NULL,
  requested_by_staff_id CHAR(36) NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'QUEUED',
  copies INT UNSIGNED NOT NULL DEFAULT 1,
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  failure_code VARCHAR(80) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_print_jobs_status (status, created_at),
  KEY idx_print_jobs_station (print_station_id),
  CONSTRAINT fk_print_jobs_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  CONSTRAINT fk_print_jobs_printer FOREIGN KEY (printer_id) REFERENCES printers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_print_jobs_station FOREIGN KEY (print_station_id) REFERENCES print_stations(id) ON DELETE RESTRICT,
  CONSTRAINT fk_print_jobs_staff FOREIGN KEY (requested_by_staff_id) REFERENCES staff_users(id) ON DELETE SET NULL,
  CONSTRAINT chk_print_jobs_status CHECK (status IN ('QUEUED','PROCESSING','PRINTED','FAILED','CANCELLED')),
  CONSTRAINT chk_print_jobs_copies CHECK (copies BETWEEN 1 AND 20)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
