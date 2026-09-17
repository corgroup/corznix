-- Wave 8J-3 — two indexes justified by measured hot-path query shapes
-- (scripts/verify-query-audit.js). Both target tables that grow unbounded.
-- Forward-only, non-destructive.
--
--   * staff_audit_logs: the CMS audit view lists the most recent rows with
--     no filter (ORDER BY created_at DESC LIMIT n). The existing composite
--     indexes are (staff_user_id, created_at) / (action, created_at) — neither
--     serves an unfiltered recency sort, so it degrades to filesort as the
--     append-only log grows.
--   * products: storefront + CMS catalog listing is WHERE status = ? ORDER BY
--     created_at DESC LIMIT n. idx_products_status alone filters then sorts.

ALTER TABLE staff_audit_logs
  ADD INDEX idx_staff_audit_logs_created_at (created_at);

ALTER TABLE products
  ADD INDEX idx_products_status_created (status, created_at);
