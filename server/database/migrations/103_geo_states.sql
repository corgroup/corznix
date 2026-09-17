-- ---------------------------------------------------------------------------
-- 103 — the Indian states and union territories, as data.
--
-- The checkout address form carried this list hard-coded in a React file, and
-- it held 14 of the 36. A customer in Assam, Bihar, Odisha or anywhere in the
-- North-East could not complete an order at all: the field is required and
-- their state simply was not offered. Nothing downstream constrained it — the
-- API accepts any non-empty string — so the storefront's own array WAS the
-- rule, and it was wrong.
--
-- Reference data belongs in the database: it is national, it changes (Ladakh
-- and Jammu and Kashmir split in 2019; Dadra and Nagar Haveli merged with
-- Daman and Diu in 2020), and the business may need to stop shipping to a
-- region without a frontend release. `is_active` is that switch.
--
-- Not brand-scoped: the Republic of India is not a tenant of this system.
--
-- Forward-only, non-destructive. MySQL 8.x.
-- ---------------------------------------------------------------------------

CREATE TABLE geo_states (
  code VARCHAR(8) NOT NULL,
  name VARCHAR(80) NOT NULL,
  -- STATE or UNION_TERRITORY. The form groups by this, so a customer looking
  -- for Chandigarh does not have to know which list it landed in.
  kind VARCHAR(16) NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  display_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (code),
  UNIQUE KEY uk_geo_states_name (name),
  KEY ix_geo_states_active (is_active, kind, display_order),
  CONSTRAINT chk_geo_states_kind CHECK (kind IN ('STATE', 'UNION_TERRITORY'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ISO 3166-2:IN codes, so the values mean something outside this database.
INSERT INTO geo_states (code, name, kind, display_order) VALUES
  ('IN-AP', 'Andhra Pradesh', 'STATE', 1),
  ('IN-AR', 'Arunachal Pradesh', 'STATE', 2),
  ('IN-AS', 'Assam', 'STATE', 3),
  ('IN-BR', 'Bihar', 'STATE', 4),
  ('IN-CT', 'Chhattisgarh', 'STATE', 5),
  ('IN-GA', 'Goa', 'STATE', 6),
  ('IN-GJ', 'Gujarat', 'STATE', 7),
  ('IN-HR', 'Haryana', 'STATE', 8),
  ('IN-HP', 'Himachal Pradesh', 'STATE', 9),
  ('IN-JH', 'Jharkhand', 'STATE', 10),
  ('IN-KA', 'Karnataka', 'STATE', 11),
  ('IN-KL', 'Kerala', 'STATE', 12),
  ('IN-MP', 'Madhya Pradesh', 'STATE', 13),
  ('IN-MH', 'Maharashtra', 'STATE', 14),
  ('IN-MN', 'Manipur', 'STATE', 15),
  ('IN-ML', 'Meghalaya', 'STATE', 16),
  ('IN-MZ', 'Mizoram', 'STATE', 17),
  ('IN-NL', 'Nagaland', 'STATE', 18),
  ('IN-OR', 'Odisha', 'STATE', 19),
  ('IN-PB', 'Punjab', 'STATE', 20),
  ('IN-RJ', 'Rajasthan', 'STATE', 21),
  ('IN-SK', 'Sikkim', 'STATE', 22),
  ('IN-TN', 'Tamil Nadu', 'STATE', 23),
  ('IN-TG', 'Telangana', 'STATE', 24),
  ('IN-TR', 'Tripura', 'STATE', 25),
  ('IN-UP', 'Uttar Pradesh', 'STATE', 26),
  ('IN-UT', 'Uttarakhand', 'STATE', 27),
  ('IN-WB', 'West Bengal', 'STATE', 28),
  ('IN-AN', 'Andaman and Nicobar Islands', 'UNION_TERRITORY', 29),
  ('IN-CH', 'Chandigarh', 'UNION_TERRITORY', 30),
  ('IN-DH', 'Dadra and Nagar Haveli and Daman and Diu', 'UNION_TERRITORY', 31),
  ('IN-DL', 'Delhi', 'UNION_TERRITORY', 32),
  ('IN-JK', 'Jammu and Kashmir', 'UNION_TERRITORY', 33),
  ('IN-LA', 'Ladakh', 'UNION_TERRITORY', 34),
  ('IN-LD', 'Lakshadweep', 'UNION_TERRITORY', 35),
  ('IN-PY', 'Puducherry', 'UNION_TERRITORY', 36);
