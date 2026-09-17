-- Warehouse-manager confirmation (fulfilment specification §7).
--
-- The warehouse accepting an order was not a recorded step. Allocation
-- assigned the order and the next thing that existed was PROCESSING, so there
-- was no answer to "who at the warehouse accepted this, and when" other than
-- reading a JSON blob out of an event row.
--
-- Deliberately NOT reusing either existing "ready" concept, which mean
-- different things and must both keep meaning them:
--   * fulfillments.readiness_status ∈ (READY, BLOCKED) is BOOKING readiness —
--     whether carrier weight/dimension metadata exists — and is derived, never
--     set by staff.
--   * fulfillments.status = 'READY' is an operational staff state with its own
--     ready_at timestamp.
-- Neither is "a human at the warehouse has accepted this order", so this adds
-- a state of its own rather than overloading one of theirs.
--
-- Columns rather than only an event row because this has to be queryable:
-- "which orders is this warehouse sitting on unconfirmed" is an operational
-- question, and answering it by unpacking detail_json is not something to
-- build a workbench on.

ALTER TABLE fulfillments
  ADD COLUMN warehouse_confirmed_at DATETIME(3) NULL AFTER ready_at,
  ADD COLUMN warehouse_confirmed_by_staff_id CHAR(36) NULL AFTER warehouse_confirmed_at,
  ADD COLUMN warehouse_confirmation_note VARCHAR(500) NULL AFTER warehouse_confirmed_by_staff_id,
  ADD INDEX idx_fulfillments_warehouse_confirmed (warehouse_id, warehouse_confirmed_at),
  ADD CONSTRAINT fk_fulfillments_warehouse_confirmed_by
    FOREIGN KEY (warehouse_confirmed_by_staff_id) REFERENCES staff_users (id) ON DELETE RESTRICT;

-- The status vocabulary is enforced by the database, not only by the
-- application's transition graph, so the new state has to be admitted here too
-- or every confirmation fails on the CHECK. Keeping that enforcement is the
-- point: the graph can be bypassed by a direct write, this cannot.
ALTER TABLE fulfillments
  DROP CHECK chk_fulfillment_status;

ALTER TABLE fulfillments
  ADD CONSTRAINT chk_fulfillment_status CHECK (
    status IN ('PENDING', 'WAREHOUSE_CONFIRMED', 'READY', 'PROCESSING',
               'PARTIALLY_FULFILLED', 'FULFILLED', 'ON_HOLD', 'CANCELLED')
  );

-- A confirmation is a person and a moment, or it is nothing. Recording one
-- without the other would leave "who accepted this order" unanswerable, which
-- is the only reason this step exists.
ALTER TABLE fulfillments
  ADD CONSTRAINT chk_fulfillment_warehouse_confirmation CHECK (
    (warehouse_confirmed_at IS NULL AND warehouse_confirmed_by_staff_id IS NULL)
    OR (warehouse_confirmed_at IS NOT NULL AND warehouse_confirmed_by_staff_id IS NOT NULL)
  );
