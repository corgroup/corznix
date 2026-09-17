-- Phase 2 · Slice 1 — SKU-level shipping weight override.
--
-- Canonical shipping metadata stays carrier-neutral and lives on
-- product_shipping_profiles (migration 009): weight_grams / length_mm /
-- width_mm / height_mm, one row per product. That row is the DEFAULT.
--
-- Brief §9: physical weight can differ per SKU (size runs, packed weight).
-- The smallest correct model is a nullable per-SKU override. Resolution
-- order at read time is: SKU.weight_grams -> product default -> missing.
-- Dimensions remain product-level defaults (brief §7 — final packed
-- dimensions are confirmed at fulfilment, not carried per SKU).
--
-- Additive. No backfill — brief §6/§8 forbid inferred or defaulted weights;
-- an unset weight must surface as "shipping rate not ready", never as a guess.

ALTER TABLE skus
  ADD COLUMN weight_grams INT UNSIGNED NULL AFTER size,
  ADD CONSTRAINT chk_skus_weight_grams CHECK (weight_grams IS NULL OR weight_grams > 0);
