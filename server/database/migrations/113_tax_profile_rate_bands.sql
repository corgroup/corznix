-- Price-band GST rates on a tax profile.
--
-- Apparel is taxed by the sale value per piece (e.g. taxable value up to
-- Rs 2,500 per piece at 5%, above it at 18%), all under one HSN. The engine
-- could hold only one rate per profile, and two ACTIVE profiles on the same HSN
-- make every invoice for that HSN AMBIGUOUS, so an 18% profile could not exist
-- beside the 5% one. A profile may now carry ordered bands; the invoice picks
-- the band from each line's per-piece taxable value.
--
--  * position 1..n, ascending max_unit_taxable_minor; the last band has no
--    upper limit (NULL).
--  * tax_profiles.gst_rate_bps stays NOT NULL and holds the first band's rate
--    (a profile without bands keeps working exactly as before).
--
-- Forward-only, additive. MySQL 8.x.

CREATE TABLE tax_profile_rate_bands (
  id CHAR(36) NOT NULL,
  tax_profile_id CHAR(36) NOT NULL,
  position SMALLINT UNSIGNED NOT NULL,
  -- Per-piece taxable value (excluding GST), in paise. NULL = no upper limit.
  max_unit_taxable_minor INT UNSIGNED NULL,
  -- Basis points: 500 = 5.00%. Integer only.
  gst_rate_bps INT UNSIGNED NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uq_tax_profile_rate_bands_position (tax_profile_id, position),
  CONSTRAINT fk_tax_profile_rate_bands_profile FOREIGN KEY (tax_profile_id) REFERENCES tax_profiles(id) ON DELETE CASCADE,
  CONSTRAINT chk_tax_profile_rate_bands_rate CHECK (gst_rate_bps <= 5000)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
