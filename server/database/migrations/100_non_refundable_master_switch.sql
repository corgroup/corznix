-- 100 — a master switch for the non-refundable advance.
--
-- 098 made it a per-band setting, which is where the amount is decided. But
-- withholding money from a customer is the kind of policy a business needs to
-- be able to stop in ONE place — during a dispute, a support escalation, or a
-- change of mind — without editing every band and hoping none was missed.
--
-- This gates the band flags the same way `partial_cod_enabled` already gates
-- each band's partial_cod_mode: both must be on. Off, nothing is withheld
-- anywhere, whatever the bands say, and every refund goes back in full.
--
-- Default 0 — money is never withheld because a migration ran. But a band that
-- was ALREADY opted in was a deliberate decision, so the switch is turned on
-- for exactly those databases: the backfill preserves the intent that already
-- existed instead of silently reversing it.

ALTER TABLE cod_settings
  ADD COLUMN advance_non_refundable_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER partial_cod_enabled;

UPDATE cod_settings s
   SET s.advance_non_refundable_enabled = 1
 WHERE EXISTS (
   SELECT 1 FROM cod_value_rules r
    WHERE r.brand_id = s.brand_id AND r.status = 'ACTIVE' AND r.advance_non_refundable = 1
 );
