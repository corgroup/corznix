-- 090 — widen shipment URL columns to fit a real carrier's actual output.
--
-- Discovered live: Delhivery's packing-slip endpoint returns a pre-signed S3
-- URL carrying a full AWS security token — comfortably over 500 characters,
-- the column's previous limit. Every real label fetch failed with
-- "Data too long for column 'label_url'" until this point; MOCK mode's short
-- synthetic URLs never exercised the limit, which is why it went unnoticed.
--
-- tracking_url carries the same real-world risk from the same provider
-- family, so it is widened alongside label_url rather than waiting for its
-- own live failure. TEXT rather than a larger VARCHAR: these values vary
-- widely in length with no natural upper bound, and neither column is
-- indexed (confirmed before this migration), so TEXT costs nothing here.

ALTER TABLE shipments
  MODIFY COLUMN label_url TEXT NULL,
  MODIFY COLUMN tracking_url TEXT NULL;
