// Wave 8J-5 — read-only data-integrity verifier. Asserts the cross-table
// invariants the schema's own CHECK/UNIQUE constraints cannot express. Makes
// NO writes — safe to run against the live dev DB or a fresh restore (the
// restore test reuses it). Any non-empty result set is a failure.
//
//   npm run verify:data-integrity
import { pool, query } from '../src/database/connection/pool.js';

const results = {};
const check = async (name, sql, params = []) => {
  try {
    const rows = await query(sql, params);
    const bad = Number(rows[0]?.violations ?? rows.length);
    results[name] = bad === 0 ? 'PASS' : `FAIL (${bad})`;
    console.log(`  ${bad === 0 ? 'PASS' : 'FAIL'}  ${name}${bad ? ` — ${bad}` : ''}`);
  } catch (e) {
    results[name] = `ERROR: ${e.message}`;
    console.log(`  ERR   ${name}: ${e.message}`);
  }
};

try {
  // --- store credit ledger reconciles to the account balance -------
  await check('store_credit_balance_matches_ledger',
    `SELECT COUNT(*) violations FROM (
       SELECT a.id FROM store_credit_accounts a
       LEFT JOIN (SELECT account_id, SUM(amount_minor) s FROM store_credit_entries GROUP BY account_id) e ON e.account_id = a.id
       WHERE a.balance_minor <> COALESCE(e.s, 0)
     ) x`);
  await check('store_credit_last_entry_balance_after_matches',
    `SELECT COUNT(*) violations FROM store_credit_accounts a
       JOIN store_credit_entries e ON e.account_id = a.id
       WHERE e.created_at = (SELECT MAX(e2.created_at) FROM store_credit_entries e2 WHERE e2.account_id = a.id)
         AND e.balance_after_minor <> a.balance_minor`);
  await check('store_credit_no_negative_balance',
    `SELECT COUNT(*) violations FROM store_credit_accounts WHERE balance_minor < 0`);

  // --- returns: never return more than was ordered ----------------
  await check('return_quantity_not_over_ordered',
    `SELECT COUNT(*) violations FROM (
       SELECT ri.order_item_id, oi.quantity ordered, SUM(ri.quantity) returned
       FROM return_request_items ri
       JOIN return_requests rr ON rr.id = ri.return_request_id AND rr.status <> 'REJECTED'
       JOIN order_items oi ON oi.id = ri.order_item_id
       GROUP BY ri.order_item_id, oi.quantity
       HAVING returned > ordered
     ) x`);

  // --- refunds: one per return, never exceeding eligible value ----
  await check('refund_not_exceeding_return_value',
    `SELECT COUNT(*) violations FROM refund_attempts ra
       JOIN (SELECT return_request_id, SUM(eligible_value_minor) v FROM return_request_items GROUP BY return_request_id) ri
         ON ri.return_request_id = ra.return_request_id
       WHERE ra.status IN ('SUCCEEDED','SUCCESS','COMPLETED') AND ra.amount_minor > ri.v`);
  await check('refund_one_per_return_request',
    `SELECT COUNT(*) violations FROM (
       SELECT return_request_id FROM refund_attempts GROUP BY return_request_id HAVING COUNT(*) > 1
     ) x`);

  // --- credit notes: no duplicate per return, value = unit*qty ----
  await check('credit_note_no_duplicate_per_return',
    `SELECT COUNT(*) violations FROM (
       SELECT return_request_id FROM credit_notes WHERE return_request_id IS NOT NULL
       GROUP BY return_request_id HAVING COUNT(*) > 1
     ) x`);
  await check('credit_note_item_value_consistent',
    `SELECT COUNT(*) violations FROM credit_note_items WHERE returned_value_minor <> unit_price_minor * quantity`);

  // --- single-authority rows -------------------------------------
  // Multi-company (Phase 7): company_profiles is plural, PK'd on brand_id —
  // "exactly one" is now "every active brand has exactly one row" (the PK
  // itself already forbids more than one per brand).
  await check('every_active_brand_has_one_company_profile',
    `SELECT COUNT(*) violations FROM brands b WHERE b.status = 'active' AND NOT EXISTS (SELECT 1 FROM company_profiles cp WHERE cp.brand_id = b.id)`);
  await check('at_most_one_default_warehouse',
    `SELECT GREATEST(COUNT(*) - 1, 0) violations FROM warehouses WHERE is_default = 1`);

  // --- critical orphan FKs (belt-and-braces; FKs are RESTRICT) ----
  await check('no_orphan_order_items',
    `SELECT COUNT(*) violations FROM order_items oi LEFT JOIN orders o ON o.id = oi.order_id WHERE o.id IS NULL`);
  await check('no_orphan_return_requests',
    `SELECT COUNT(*) violations FROM return_requests rr LEFT JOIN orders o ON o.id = rr.order_id WHERE o.id IS NULL`);
  await check('no_orphan_provider_config_revisions',
    `SELECT COUNT(*) violations FROM provider_configuration_revisions r
       LEFT JOIN provider_configurations c ON c.capability = r.capability AND c.provider_key = r.provider_key
       WHERE c.id IS NULL`);

  // --- 8I operational tables: no stuck PROCESSING beyond lease ----
  await check('no_permanently_stuck_outbox',
    `SELECT COUNT(*) violations FROM platform_outbox
       WHERE status = 'PROCESSING' AND locked_at < DATE_SUB(NOW(3), INTERVAL 1 HOUR)`);

  // --- WP-12: inventory authority invariants ---------------------
  // DB CHECKs already enforce these per row; belt-and-braces here so a
  // fresh restore / drift is caught by the same read-only sweep.
  await check('inventory_no_negative',
    `SELECT COUNT(*) violations FROM inventory WHERE on_hand < 0 OR reserved < 0`);
  await check('inventory_reserved_within_on_hand',
    `SELECT COUNT(*) violations FROM inventory WHERE reserved > on_hand`);
  // The drift check: inventory.reserved must equal the summed quantity of
  // every RESERVED reservation line touching that (warehouse, sku). A failed
  // reservation transition or a movement recorded without the matching
  // balance change surfaces here.
  await check('inventory_reserved_matches_open_reservations',
    `SELECT COUNT(*) violations FROM inventory i
       WHERE i.reserved <> (
         SELECT COALESCE(SUM(ri.quantity), 0)
           FROM inventory_reservation_items ri
           JOIN inventory_reservations r ON r.id = ri.reservation_id
          WHERE ri.warehouse_id = i.warehouse_id AND ri.sku_id = i.sku_id AND r.status = 'RESERVED')`);
  await check('no_orphan_inventory_reservation_items',
    `SELECT COUNT(*) violations FROM inventory_reservation_items ri
       LEFT JOIN inventory_reservations r ON r.id = ri.reservation_id WHERE r.id IS NULL`);
  await check('no_permanently_stuck_inventory_reservation',
    `SELECT COUNT(*) violations FROM inventory_reservations
       WHERE status = 'RESERVED' AND expires_at < DATE_SUB(NOW(3), INTERVAL 1 DAY)`);
  // WP-12 / GAP-INV-03 — the non_sellable quarantine bucket on each inventory
  // row must equal the still-undisposed units across its OPEN quarantine
  // batches. A QC_QUARANTINED / QC_RELEASED / QC_SCRAPPED movement applied
  // without the matching batch counter (or vice versa) surfaces here.
  await check('inventory_non_sellable_matches_open_quarantine',
    `SELECT COUNT(*) violations FROM inventory i
       WHERE i.non_sellable <> (
         SELECT COALESCE(SUM(q.quantity - q.quantity_released - q.quantity_scrapped), 0)
           FROM inventory_quarantine q
          WHERE q.warehouse_id = i.warehouse_id AND q.sku_id = i.sku_id AND q.status = 'OPEN')`);
  await check('no_orphan_quarantine_over_disposed',
    `SELECT COUNT(*) violations FROM inventory_quarantine
       WHERE quantity_released + quantity_scrapped > quantity`);
} catch (err) {
  console.error('verify-data-integrity crashed:', err);
  process.exitCode = 1;
} finally {
  const failed = Object.entries(results).filter(([, v]) => !String(v).startsWith('PASS'));
  console.log('\n──── data integrity ────');
  console.log(JSON.stringify(results, null, 1));
  if (failed.length) { console.log(`\n${failed.length} invariant(s) violated`); process.exitCode = 1; }
  else console.log('\nAll invariants hold');
  await pool.end();
}
