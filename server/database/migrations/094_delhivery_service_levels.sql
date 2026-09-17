-- 094 — Delhivery service levels (Surface + Express) as real configuration.
--
-- `shipping_provider_services` maps a carrier's own service code onto the two
-- levels the storefront offers. Migration 008 seeded exactly one row (MOCK),
-- so every Delhivery row in a live database was added by hand — which is why
-- production had a Surface row and no Express one, and checkout could only
-- ever show a single method.
--
-- Both rows are declared here so the mapping is reproducible from the schema.
-- `PIN_SERVICEABILITY` is the code the adapter has always emitted for Surface;
-- keeping it (rather than renaming to SURFACE) means an existing database
-- keeps its working Surface method untouched — this migration only ADDS.
--
-- Rate stays NULL: neither row carries a carrier rate. Surface is ₹0 by
-- policy, Express is the policy surcharge, and a business rate can be set per
-- row later via `rate_override_minor`. Nothing here invents a carrier price.
--
-- Cloned per brand that already has a DELHIVERY provider row, matching how 082
-- scoped this table. DELHIVERY itself ships disabled (008), so a fresh database
-- gains configuration, not behaviour.

INSERT INTO shipping_provider_services
  (brand_id, provider_code, provider_service_code, normalized_service_level, display_name, enabled, customer_visible, rate_override_minor)
SELECT p.brand_id, p.provider_code, level.code, level.normalized, level.label, 1, 1, NULL
  FROM shipping_providers p
  JOIN (
              SELECT 'PIN_SERVICEABILITY' AS code, 'STANDARD' AS normalized, 'Standard Delivery' AS label
    UNION ALL SELECT 'EXPRESS',            'EXPRESS',              'Express Delivery'
  ) AS level
 WHERE p.provider_code = 'DELHIVERY'
-- No-op on an existing row: a database that already has these rows keeps its
-- own display names, enabled flags and rate overrides exactly as configured.
ON DUPLICATE KEY UPDATE provider_code = VALUES(provider_code);
