-- 089 — mandatory warehouse pickup contact.
--
-- A carrier pickup agent who cannot reach the warehouse is a failed pickup.
-- The contact therefore belongs to the ALLOCATED WAREHOUSE record — never the
-- customer, never a global default — and the operational gate refuses
-- READY_FOR_PICKUP without it rather than sending an incomplete request.
--
-- Canonical storage is +91XXXXXXXXXX. The CHECK enforces the shape in the
-- database, independent of application code; adapters convert to whatever
-- provider-specific format they need at the edge.
--
-- Mandatory-ness is enforced by the service (warehouse activation + the
-- pickup gate), NOT by a NOT NULL column: three existing ACTIVE warehouses
-- carry no contact and blanket-disabling them would silently remove them from
-- allocation, which is a business decision and not this migration's to make.

ALTER TABLE warehouses
  ADD COLUMN contact_phone_alt VARCHAR(20) NULL AFTER contact_phone;

-- Normalise every recoverable form BEFORE the CHECK is added, otherwise this
-- migration fails on any environment holding a number written differently —
-- and a failed migration fails the whole deploy. Local held bare 10-digit
-- values, but staging/production were never surveyed, so every shape a human
-- or an import could plausibly have produced is handled here:
--   "9278092710"       bare 10-digit
--   "09278092710"      domestic trunk prefix
--   "919278092710"     country code, no plus
--   "+91 92780 92710"  spaces / hyphens / brackets
UPDATE warehouses
   SET contact_phone = REGEXP_REPLACE(contact_phone, '[^0-9+]', '')
 WHERE contact_phone IS NOT NULL;

UPDATE warehouses SET contact_phone = CONCAT('+91', SUBSTRING(contact_phone, 2))
 WHERE contact_phone REGEXP '^0[6-9][0-9]{9}$';
UPDATE warehouses SET contact_phone = CONCAT('+', contact_phone)
 WHERE contact_phone REGEXP '^91[6-9][0-9]{9}$';
UPDATE warehouses SET contact_phone = CONCAT('+91', contact_phone)
 WHERE contact_phone REGEXP '^[6-9][0-9]{9}$';

-- Anything still not a valid Indian mobile could never have reached a pickup
-- agent. NULL is the honest state: the service already refuses READY_FOR_PICKUP
-- without a valid contact, so this makes the data say what was already true
-- rather than letting an unusable string block the deploy.
UPDATE warehouses
   SET contact_phone = NULL
 WHERE contact_phone IS NOT NULL
   AND contact_phone NOT REGEXP '^[+]91[6-9][0-9]{9}$';

-- Same treatment for the alternate column, which starts empty here but is
-- normalised for symmetry if a re-run ever finds data in it.
UPDATE warehouses
   SET contact_phone_alt = NULL
 WHERE contact_phone_alt IS NOT NULL
   AND contact_phone_alt NOT REGEXP '^[+]91[6-9][0-9]{9}$';

-- The real pickup contact for the operating warehouse (business-supplied).
UPDATE warehouses
   SET contact_phone = '+919278092710',
       contact_name  = COALESCE(NULLIF(TRIM(contact_name), ''), 'Warehouse Pickup Desk')
 WHERE code = 'WH-GZP-PARSUPUR-01';

ALTER TABLE warehouses
  ADD CONSTRAINT chk_warehouses_contact_phone
    CHECK (contact_phone IS NULL OR contact_phone REGEXP '^[+]91[6-9][0-9]{9}$'),
  ADD CONSTRAINT chk_warehouses_contact_phone_alt
    CHECK (contact_phone_alt IS NULL OR contact_phone_alt REGEXP '^[+]91[6-9][0-9]{9}$');
