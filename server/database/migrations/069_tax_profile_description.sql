-- Optional human description for a tax profile — "what this profile is used
-- for" (e.g. "Apparel priced up to ₹2,500 — 5% GST"). Purely informational;
-- the tax engine still resolves on hsn_sac + gst_rate_bps + effective dates.

ALTER TABLE tax_profiles
  ADD COLUMN description VARCHAR(255) NULL AFTER name;
