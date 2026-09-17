import { query, pool } from '../src/database/connection/pool.js';

try {
  const [catalog] = await query(`SELECT COUNT(*) total, SUM(size_guide_id IS NOT NULL) with_guide FROM products WHERE status='ACTIVE'`);
  const [table] = await query(`SELECT COUNT(*) c FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='product_shipping_profiles'`);
  let shipping = { with_weight: 0, complete: 0, missing: Number(catalog.total) };
  if (Number(table.c)) {
    [shipping] = await query(`SELECT
      SUM(psp.weight_grams IS NOT NULL) with_weight,
      SUM(psp.weight_grams IS NOT NULL AND psp.length_mm IS NOT NULL AND psp.width_mm IS NOT NULL AND psp.height_mm IS NOT NULL) complete,
      SUM(psp.product_id IS NULL OR psp.weight_grams IS NULL OR psp.length_mm IS NULL OR psp.width_mm IS NULL OR psp.height_mm IS NULL) missing
      FROM products p LEFT JOIN product_shipping_profiles psp ON psp.product_id=p.id WHERE p.status='ACTIVE'`);
  }
  console.log(JSON.stringify({
    TOTAL_ACTIVE_PRODUCTS: Number(catalog.total),
    PRODUCTS_WITH_SIZE_GUIDE: Number(catalog.with_guide || 0),
    PRODUCTS_MISSING_SIZE_GUIDE: Number(catalog.total) - Number(catalog.with_guide || 0),
    PRODUCTS_WITH_WEIGHT: Number(shipping.with_weight || 0),
    PRODUCTS_WITH_COMPLETE_DIMENSIONS: Number(shipping.complete || 0),
    PRODUCTS_MISSING_SHIPPING_DATA: Number(shipping.missing || 0),
    MIGRATION_009_APPLIED: Boolean(Number(table.c)),
  }, null, 2));
} finally {
  await pool.end();
}
