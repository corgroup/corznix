import { pool, query } from '../src/database/connection/pool.js';

try {
  const [coverage] = await query(
    `SELECT COUNT(*) AS total_active_sellable_skus,
            SUM(i.sku_id IS NOT NULL) AS skus_with_inventory,
            SUM(i.sku_id IS NULL) AS skus_without_inventory
     FROM skus s
     JOIN product_variants v ON v.id=s.variant_id AND v.status='ACTIVE'
     JOIN products p ON p.id=v.product_id AND p.status='ACTIVE'
     LEFT JOIN inventory i ON i.sku_id=s.id
     WHERE s.status='ACTIVE'`,
  );
  const [totals] = await query(
    `SELECT COUNT(*) AS inventory_rows, COALESCE(SUM(on_hand),0) AS on_hand,
            COALESCE(SUM(reserved),0) AS reserved FROM inventory`,
  );
  const [movementCoverage] = await query(
    `SELECT COUNT(DISTINCT i.sku_id) AS inventory_skus,
            COUNT(DISTINCT m.sku_id) AS skus_with_movements,
            COUNT(*) AS movement_rows
     FROM inventory i LEFT JOIN inventory_movements m ON m.sku_id=i.sku_id`,
  );
  const distribution = await query('SELECT on_hand, COUNT(*) AS sku_count FROM inventory GROUP BY on_hand ORDER BY on_hand');
  const [reservations] = await query('SELECT COUNT(*) AS reservation_rows FROM inventory_reservations');
  const indexes = await query(
    `SELECT TABLE_NAME,INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_list
     FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE()
       AND TABLE_NAME IN ('inventory','inventory_reservations','inventory_reservation_items')
     GROUP BY TABLE_NAME,INDEX_NAME ORDER BY TABLE_NAME,INDEX_NAME`);
  const constraints = await query(
    `SELECT TABLE_NAME,CONSTRAINT_NAME,CONSTRAINT_TYPE FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA=DATABASE() AND TABLE_NAME IN ('inventory','inventory_reservations','inventory_reservation_items')
     ORDER BY TABLE_NAME,CONSTRAINT_NAME`);
  const checkoutIndexes = await query(`SELECT INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_list FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='checkout_sessions' GROUP BY INDEX_NAME ORDER BY INDEX_NAME`);
  const [orphans] = await query(`SELECT
    (SELECT COUNT(*) FROM checkout_sessions cs LEFT JOIN inventory_reservations ir ON ir.id=cs.inventory_reservation_id WHERE ir.id IS NULL) AS checkout_reservation_orphans,
    (SELECT COUNT(*) FROM inventory_reservations ir LEFT JOIN checkout_sessions cs ON cs.inventory_reservation_id=ir.id WHERE ir.idempotency_key LIKE 'checkout:%' AND cs.id IS NULL) AS reservation_checkout_orphans`);
  console.log(JSON.stringify({ coverage, totals, movementCoverage, distribution, reservations, indexes, constraints, checkoutIndexes, orphans }, null, 2));
} finally {
  await pool.end();
}
