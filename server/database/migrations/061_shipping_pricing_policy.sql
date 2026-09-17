-- Phase 2 · Slice 5/6 — customer shipping charge policy, kept separate from the
-- actual logistics cost CORCOTTON pays the carrier.
--
-- Business decision (2026-09-03):
--   Surface : customer always sees ₹0 (the business absorbs the real cost).
--   Express : customer pays the real provider rate + a fixed CORCOTTON
--             surcharge (previously decided = ₹100).
-- The ₹100 lives here (backend config), NOT in the Delhivery adapter.

ALTER TABLE shipping_settings
  ADD COLUMN surface_customer_charge_mode VARCHAR(16) NOT NULL DEFAULT 'ZERO'
    AFTER quote_ttl_seconds,
  ADD COLUMN surface_flat_charge_minor INT UNSIGNED NOT NULL DEFAULT 0
    AFTER surface_customer_charge_mode,
  ADD COLUMN express_additional_charge_minor INT UNSIGNED NOT NULL DEFAULT 10000
    AFTER surface_flat_charge_minor,
  ADD CONSTRAINT chk_shipping_surface_charge_mode
    CHECK (surface_customer_charge_mode IN ('ZERO', 'PROVIDER_RATE', 'FLAT'));

-- Per-shipment money: what the customer paid for this shipment vs. what
-- CORCOTTON owes the carrier for it. Never conflate the two (brief §6).
ALTER TABLE shipments
  ADD COLUMN customer_shipping_charge_minor INT UNSIGNED NULL AFTER cod_collection_minor,
  ADD COLUMN actual_logistics_cost_minor INT UNSIGNED NULL AFTER customer_shipping_charge_minor,
  ADD COLUMN actual_logistics_cost_currency CHAR(3) NOT NULL DEFAULT 'INR' AFTER actual_logistics_cost_minor,
  -- PROVIDER_QUOTE (Shipping Cost API estimate) | PROVIDER_INVOICE (billed) | MANUAL
  ADD COLUMN shipping_cost_source VARCHAR(20) NULL AFTER actual_logistics_cost_currency;
