-- 095 — a product's standard display price.
--
-- Price lives on the SKU, because sizes are priced independently. That leaves
-- one question the SKUs cannot answer: what price does a product show BEFORE a
-- size is chosen — on a listing card, and on the PDP at first paint?
--
-- Until now the answer was derived: MIN() across the active SKUs. That is a
-- "from" price, and it made a single discounted size speak for the whole
-- product (one size set to Rs 1 made the product read as Rs 1 everywhere).
--
-- This column lets the CMS state that price outright instead of inferring it.
-- NULL keeps the derived behaviour exactly as it is today, so nothing changes
-- for a product that does not set one.
--
-- Minor units (paise), matching skus.price_minor.

ALTER TABLE products
  ADD COLUMN display_price_minor INT UNSIGNED NULL AFTER product_type;
