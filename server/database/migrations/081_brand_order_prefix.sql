-- Multi-company CMS — Phase 4 follow-up. `orders.order_number` and
-- `support_tickets.ticket_number` both hardcode a literal "COR-" prefix
-- (orders/repository.js, support/service.js) — a real gap found while
-- wiring brand scoping: once Cor-Znix places an order, its number would
-- still read "COR-...", indistinguishable from Cor-Cotton's. `brands.slug`
-- can't derive a safe short code on its own ("corznix" also starts with
-- "cor"), so this adds an explicit, business-owned short code instead of
-- guessing one from the slug.
--
-- Cor-Cotton's is set to the exact literal already in use ("COR") — zero
-- visible change to any existing order/ticket number. Cor-Znix gets a
-- distinct "CRZ" (placeholder, business can rename before Phase 7 launch —
-- this is a plain data value, not a migration to re-run).

ALTER TABLE brands
  ADD COLUMN order_prefix VARCHAR(8) NULL AFTER slug;

UPDATE brands SET order_prefix = 'COR' WHERE slug = 'corcotton';
UPDATE brands SET order_prefix = 'CRZ' WHERE slug = 'corznix';
