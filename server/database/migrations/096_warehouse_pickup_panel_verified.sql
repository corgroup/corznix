-- 096 — record that a human checked a linked pickup name in the carrier panel.
--
-- `registered_at` means one specific thing: CORCOTTON created this pickup
-- location through the carrier's API and the carrier confirmed the name back.
-- A name typed in from the carrier's own panel can never earn that, because no
-- carrier exposes a read endpoint to confirm it against — so detectDrift warns
-- NEVER_REGISTERED_VIA_API forever, even for a mapping someone has just stood
-- in the panel and verified by eye.
--
-- A permanent warning on a correct mapping is how a real warning stops being
-- read. These columns record the weaker, human claim WITHOUT pretending it is
-- the strong one: the warning drops to informational, never to "registered".
--
-- Deliberately two separate facts. A row can have neither, one, or both.

ALTER TABLE warehouse_provider_locations
  ADD COLUMN panel_verified_at DATETIME(3) NULL AFTER registered_at,
  ADD COLUMN panel_verified_by CHAR(36) NULL AFTER panel_verified_at;
