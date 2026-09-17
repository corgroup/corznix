-- Wave 8F-5 fixup: 'MANUAL_RETURN_LOGISTICS_REQUIRED' (31 chars) overflows
-- return_shipments.status VARCHAR(24). Widen it; the CHECK is unchanged.
--
-- Forward-only, non-destructive. MySQL 8.x.
ALTER TABLE return_shipments
  MODIFY COLUMN status VARCHAR(40) NOT NULL DEFAULT 'PENDING';
