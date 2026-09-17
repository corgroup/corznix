-- WP-12 — the new INVENTORY_RESERVED_DRIFT reconciliation exception keys off
-- "<warehouse_id>:<sku_id>" (two UUIDs), which is 73 chars — the reference_id
-- column was VARCHAR(64), sized for a single UUID. Widen it. Additive; the
-- (reference_type, reference_id) index stays well within InnoDB's key-length
-- limit.
ALTER TABLE reconciliation_exceptions
  MODIFY COLUMN reference_id VARCHAR(120) NOT NULL;
