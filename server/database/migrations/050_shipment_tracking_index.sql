-- WP-01 (logistics webhook ingest spine) — index the column an inbound
-- Delhivery Scan Push resolves against. Every scan carries an AWB, not a
-- CORCOTTON shipment id, so the webhook applier looks shipments up by
-- `tracking_number`. Without this index that lookup is a full table scan at
-- webhook volume; additive and non-destructive (adds an index only).
ALTER TABLE shipments
  ADD KEY idx_shipments_tracking_number (tracking_number);
