-- Phase 2 · Slice 13 — track PULL reconciliation.
--
-- The track-pull worker (logistics/trackReconciliation.runDueBatch) selects
-- booked, in-flight shipments whose last carrier event is stale:
--
--   WHERE booking_status = 'BOOKED'
--     AND tracking_number IS NOT NULL
--     AND provider_code <> 'MOCK'
--     AND status IN (<in-flight>)
--     AND (last_event_at IS NULL OR last_event_at < ?)
--   ORDER BY last_event_at
--
-- This composite key lets that run as a range scan on (booking_status,
-- last_event_at) instead of a full shipments scan as the table grows. No new
-- columns, no data change — index only.

ALTER TABLE shipments
  ADD KEY idx_shipments_track_pull (booking_status, last_event_at);
