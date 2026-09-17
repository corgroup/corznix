import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { istDateExpr } from './reportTime.js';

// Wave 8H — all analytical SQL. Read-only projections over authoritative
// domains. Every parameter is bound; the only interpolated tokens are
// whitelisted sort columns / directions resolved by guards.js.
//
// BRAND SCOPING (multi-company). Every projection here is per-company. The
// caller supplies req.brandId and each statement carries a brand predicate,
// reached through a join where the base table has no brand_id of its own:
//   order_items / payment_attempts / payment_obligations -> orders.brand_id
//   return_request_items                                 -> return_requests.brand_id
//   fulfillment_items                                    -> fulfillments.brand_id
//   inventory_movements                                  -> warehouses.brand_id
//   return_shipments                                     -> return_requests.brand_id
//   store_credit_entries                                 -> store_credit_accounts.brand_id
//   promotion_redemptions                                -> promotions.brand_id
//   product_reviews                                      -> products.brand_id
//   reserved_exchange_credits / communication_messages   -> customers.brand_id
// A missing brandId is a programming error, not an empty result — it throws,
// so a new caller cannot silently reintroduce a cross-company total.

const inPeriod = (col) => `${col} >= ? AND ${col} < ?`;
// Optional warehouse scope: [] means "all"; a non-empty list restricts.
const whClause = (col, ids) => (ids && ids.length ? ` AND ${col} IN (${ids.map(() => '?').join(',')})` : '');
const needBrand = (brandId) => {
  if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required for every report projection.', 500);
  return brandId;
};

export const reportingRepository = {
  // ---- sales / orders --------------------------------------------
  async salesSummary({ start, end, brandId }) {
    needBrand(brandId);
    const [r] = await query(
      `SELECT COUNT(*) AS orders,
              COALESCE(SUM(o.subtotal_minor),0) AS gross_minor,
              COALESCE(SUM(o.discount_minor),0) AS discount_minor,
              COALESCE(SUM(o.shipping_minor),0) AS shipping_minor,
              COALESCE(SUM(o.total_minor),0) AS net_minor,
              COALESCE(SUM(o.online_paid_minor),0) AS online_paid_minor,
              COALESCE(SUM(o.cod_due_minor),0) AS cod_due_minor
         FROM orders o WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?`, [start, end, brandId]);
    const [u] = await query(
      `SELECT COALESCE(SUM(oi.quantity),0) AS units
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?`, [start, end, brandId]);
    return { ...r, units: Number(u.units) };
  },

  capturedRevenue({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT COALESCE(SUM(pa.amount_minor),0) AS captured_minor, COUNT(*) AS captures
         FROM payment_attempts pa
         JOIN payment_obligations po ON po.id = pa.obligation_id
         JOIN orders o ON o.id = po.order_id
        WHERE pa.status = 'SUCCEEDED' AND ${inPeriod('o.placed_at')} AND o.brand_id = ?`, [start, end, brandId]).then((r) => r[0]);
  },

  salesTimeSeries({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT ${istDateExpr('o.placed_at')} AS day,
              COUNT(*) AS orders,
              COALESCE(SUM(o.subtotal_minor),0) AS gross_minor,
              COALESCE(SUM(o.discount_minor),0) AS discount_minor,
              COALESCE(SUM(o.total_minor),0) AS net_minor
         FROM orders o WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?
        GROUP BY day ORDER BY day`, [start, end, brandId]);
  },

  orderStatusBreakdown({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT o.order_status AS status, COUNT(*) AS n, COALESCE(SUM(o.total_minor),0) AS value_minor
         FROM orders o WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ? GROUP BY o.order_status`, [start, end, brandId]);
  },

  paymentModeBreakdown({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT o.payment_mode AS mode, COUNT(*) AS n,
              COALESCE(SUM(o.online_paid_minor),0) AS online_minor,
              COALESCE(SUM(o.cod_due_minor),0) AS cod_minor
         FROM orders o WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ? GROUP BY o.payment_mode`, [start, end, brandId]);
  },

  splitFulfilmentCount({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT COUNT(*) AS n FROM (
         SELECT f.order_id FROM fulfillments f
           JOIN orders o ON o.id = f.order_id
          WHERE f.return_request_id IS NULL AND ${inPeriod('o.placed_at')} AND o.brand_id = ?
          GROUP BY f.order_id HAVING COUNT(*) > 1) x`, [start, end, brandId]).then((r) => Number(r[0].n));
  },

  ordersDetail({ start, end, sort, offset, limit, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT o.id, o.order_number, o.order_status, o.payment_status, o.payment_mode,
              o.subtotal_minor, o.discount_minor, o.shipping_minor, o.total_minor, o.placed_at
         FROM orders o WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?
        ORDER BY o.${sort.column} ${sort.direction} LIMIT ${limit} OFFSET ${offset}`, [start, end, brandId]);
  },
  ordersCount({ start, end, brandId }) {
    needBrand(brandId);
    return query(`SELECT COUNT(*) n FROM orders o WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?`, [start, end, brandId]).then((r) => Number(r[0].n));
  },

  // Historical product/SKU attribution uses the ORDER-ITEM snapshot (name/sku
  // frozen at purchase) — never the current catalog row (§37/§38).
  topProducts({ start, end, limit = 20, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT oi.product_id, MAX(oi.product_name) AS product_name,
              SUM(oi.quantity) AS units, SUM(oi.line_total_minor) AS revenue_minor
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?
        GROUP BY oi.product_id ORDER BY units DESC LIMIT ${Number(limit)}`, [start, end, brandId]);
  },
  topSkus({ start, end, limit = 20, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT oi.sku_id, MAX(oi.sku) AS sku, MAX(oi.product_name) AS product_name,
              SUM(oi.quantity) AS units, SUM(oi.line_total_minor) AS revenue_minor
         FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?
        GROUP BY oi.sku_id ORDER BY units DESC LIMIT ${Number(limit)}`, [start, end, brandId]);
  },

  // Current-classification catalog rollup — LABELLED as current, not historical (§49).
  categoryPerformanceCurrent({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT c.id AS category_id, c.name AS category_name,
              SUM(oi.quantity) AS units, SUM(oi.line_total_minor) AS revenue_minor
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         JOIN products p ON p.id = oi.product_id
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?
        GROUP BY c.id, c.name ORDER BY revenue_minor DESC`, [start, end, brandId]);
  },

  // ---- returns / exchanges -------------------------------------
  returnsSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT COUNT(*) AS requests,
              SUM(rr.status = 'APPROVED') AS approved,
              SUM(rr.status = 'REJECTED') AS rejected,
              SUM(rr.status = 'CANCELLED') AS cancelled,
              SUM(rr.status = 'COMPLETED') AS completed,
              SUM(rr.qc_result = 'PASS') AS qc_pass,
              SUM(rr.qc_result = 'FAIL') AS qc_fail,
              SUM(rr.request_type = 'RETURN') AS type_return,
              SUM(rr.request_type = 'REPLACEMENT') AS type_replacement,
              SUM(rr.request_type = 'SAME_STYLE_EXCHANGE') AS type_same_style_exchange,
              SUM(rr.request_type = 'DIFFERENT_STYLE_EXCHANGE') AS type_different_style_exchange
         FROM return_requests rr WHERE ${inPeriod('rr.requested_at')} AND rr.brand_id = ?`, [start, end, brandId]).then((r) => r[0]);
  },
  returnUnits({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT COALESCE(SUM(rri.quantity),0) AS returned_units,
              COALESCE(SUM(rri.eligible_value_minor),0) AS return_value_minor
         FROM return_request_items rri
         JOIN return_requests rr ON rr.id = rri.return_request_id
        WHERE ${inPeriod('rr.requested_at')} AND rr.brand_id = ?`, [start, end, brandId]).then((r) => r[0]);
  },
  reasonBreakdown({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT rr.reason_code AS reason, COUNT(*) AS n
         FROM return_requests rr WHERE ${inPeriod('rr.requested_at')} AND rr.brand_id = ?
        GROUP BY rr.reason_code ORDER BY n DESC`, [start, end, brandId]);
  },
  deliveredUnits({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT COALESCE(SUM(fi.quantity),0) AS delivered_units
         FROM fulfillment_items fi
         JOIN fulfillments f ON f.id = fi.fulfillment_id AND f.return_request_id IS NULL
         JOIN shipments sh ON sh.fulfillment_id = f.id AND sh.status = 'DELIVERED'
        WHERE ${inPeriod('sh.delivered_at')} AND f.brand_id = ?`, [start, end, brandId]).then((r) => Number(r[0].delivered_units));
  },
  exchangeSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT COUNT(*) AS transactions,
              COALESCE(SUM(et.eligible_value_minor),0) AS eligible_value_minor,
              SUM(et.status = 'RESERVED') AS reserved,
              SUM(et.status = 'CONSUMED') AS consumed,
              SUM(et.status = 'CANCELLED') AS cancelled,
              SUM(et.status = 'EXPIRED') AS expired
         FROM exchange_transactions et WHERE ${inPeriod('et.reserved_at')} AND et.brand_id = ?`, [start, end, brandId]).then((r) => r[0]);
  },
  // reserved_exchange_credits carries no brand_id — scoped through its customer.
  reservedExchangeCredit(brandId) {
    needBrand(brandId);
    return query(
      `SELECT COALESCE(SUM(CASE WHEN rec.status='RESERVED' THEN rec.amount_minor - rec.consumed_amount_minor ELSE 0 END),0) AS reserved_minor,
              COALESCE(SUM(rec.consumed_amount_minor),0) AS consumed_minor,
              COALESCE(SUM(CASE WHEN rec.status='CANCELLED' THEN rec.amount_minor ELSE 0 END),0) AS cancelled_minor,
              COALESCE(SUM(CASE WHEN rec.status='EXPIRED' THEN rec.amount_minor - rec.consumed_amount_minor ELSE 0 END),0) AS expired_minor
         FROM reserved_exchange_credits rec
         JOIN customers c ON c.id = rec.customer_id
        WHERE c.brand_id = ?`, [brandId]).then((r) => r[0]);
  },

  // ---- customers -----------------------------------------------
  // New vs returning: a customer's FIRST paid order (payment_status in the
  // paid set) marks them new for that order's period; every later paid order
  // is "returning". Documented deterministic rule (§46).
  customerSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `WITH paid AS (
         SELECT o.customer_id, o.id, o.placed_at,
                ROW_NUMBER() OVER (PARTITION BY o.customer_id ORDER BY o.placed_at, o.id) AS rn
           FROM orders o WHERE o.payment_status IN ('PAID','COD_DUE','PARTIALLY_PAID') AND o.brand_id = ?)
       SELECT
         (SELECT COUNT(DISTINCT customer_id) FROM paid WHERE rn = 1 AND ${inPeriod('placed_at')}) AS new_customers,
         (SELECT COUNT(DISTINCT customer_id) FROM paid WHERE rn > 1 AND ${inPeriod('placed_at')}) AS returning_customers,
         (SELECT COUNT(*) FROM customers WHERE brand_id = ?) AS total_customers`,
      [brandId, start, end, start, end, brandId]).then((r) => r[0]);
  },
  repeatRate(brandId) {
    needBrand(brandId);
    return query(
      `SELECT
         COUNT(*) AS customers_with_orders,
         SUM(order_count > 1) AS repeat_customers
       FROM (SELECT customer_id, COUNT(*) order_count
               FROM orders WHERE payment_status IN ('PAID','COD_DUE','PARTIALLY_PAID') AND brand_id = ?
              GROUP BY customer_id) x`, [brandId]).then((r) => r[0]);
  },

  // ---- inventory / warehouses ---------------------------------
  inventoryByWarehouse({ warehouseIds, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT i.warehouse_id, w.code AS warehouse_code, w.name AS warehouse_name,
              COUNT(*) AS sku_lines,
              COALESCE(SUM(i.on_hand),0) AS on_hand,
              COALESCE(SUM(i.reserved),0) AS reserved,
              COALESCE(SUM(GREATEST(i.on_hand - i.reserved, 0)),0) AS available
         FROM inventory i JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.brand_id = ?${whClause('i.warehouse_id', warehouseIds)}
        GROUP BY i.warehouse_id, w.code, w.name ORDER BY w.code`, [brandId, ...(warehouseIds || [])]);
  },
  lowStock({ warehouseIds, threshold, brandId }) {
    needBrand(brandId);
    const params = [brandId];
    let cond;
    if (threshold != null) { cond = '(i.on_hand - i.reserved) <= ?'; params.push(Number(threshold)); }
    else cond = 'i.low_stock_threshold IS NOT NULL AND (i.on_hand - i.reserved) <= i.low_stock_threshold';
    return query(
      `SELECT i.warehouse_id, w.code AS warehouse_code, s.sku,
              i.on_hand, i.reserved, GREATEST(i.on_hand - i.reserved, 0) AS available, i.low_stock_threshold
         FROM inventory i
         JOIN warehouses w ON w.id = i.warehouse_id
         JOIN skus s ON s.id = i.sku_id
        WHERE i.brand_id = ? AND ${cond}${whClause('i.warehouse_id', warehouseIds)}
        ORDER BY available ASC LIMIT 200`, [...params, ...(warehouseIds || [])]);
  },
  // inventory_movements has no brand_id — scoped through its warehouse.
  stockMovements({ start, end, warehouseIds, offset, limit, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT im.movement_type, im.quantity_delta, im.reference_type, im.reference_id,
              s.sku, w.code AS warehouse_code, im.created_at
         FROM inventory_movements im
         JOIN skus s ON s.id = im.sku_id
         JOIN warehouses w ON w.id = im.warehouse_id
        WHERE ${inPeriod('im.created_at')} AND w.brand_id = ?${whClause('im.warehouse_id', warehouseIds)}
        ORDER BY im.created_at DESC LIMIT ${limit} OFFSET ${offset}`, [start, end, brandId, ...(warehouseIds || [])]);
  },
  warehouseOps({ start, end, warehouseIds, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT w.id AS warehouse_id, w.code AS warehouse_code,
              (SELECT COUNT(*) FROM fulfillments f WHERE f.warehouse_id = w.id AND f.return_request_id IS NULL AND ${inPeriod('f.created_at')}) AS fulfillments,
              (SELECT COUNT(*) FROM shipments sh JOIN fulfillments f2 ON f2.id = sh.fulfillment_id WHERE f2.warehouse_id = w.id AND ${inPeriod('sh.created_at')}) AS shipments,
              (SELECT COUNT(*) FROM return_requests rr WHERE rr.return_warehouse_id = w.id AND ${inPeriod('rr.received_at')}) AS returns_received
         FROM warehouses w
        WHERE w.brand_id = ?${whClause('w.id', warehouseIds)}
        ORDER BY w.code`,
      [start, end, start, end, start, end, brandId, ...(warehouseIds || [])]);
  },

  // ---- logistics ----------------------------------------------
  forwardShipments({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT sh.status, COUNT(*) AS n,
              AVG(CASE WHEN sh.delivered_at IS NOT NULL AND sh.booked_at IS NOT NULL
                       THEN TIMESTAMPDIFF(HOUR, sh.booked_at, sh.delivered_at) END) AS avg_delivery_hours
         FROM shipments sh
         JOIN fulfillments f ON f.id = sh.fulfillment_id AND f.return_request_id IS NULL
        WHERE ${inPeriod('sh.created_at')} AND sh.brand_id = ?
        GROUP BY sh.status`, [start, end, brandId]);
  },
  // return_shipments has no brand_id — scoped through its return request.
  reverseShipments({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT rs.status, COUNT(*) AS n
         FROM return_shipments rs
         JOIN return_requests rr ON rr.id = rs.return_request_id
        WHERE ${inPeriod('rs.created_at')} AND rr.brand_id = ?
        GROUP BY rs.status`, [start, end, brandId]);
  },
  providerBreakdown({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT sh.provider_code, COUNT(*) AS shipments,
              SUM(sh.status = 'DELIVERED') AS delivered,
              SUM(sh.status = 'RTO' OR sh.status = 'RTO_DELIVERED') AS rto
         FROM shipments sh
         JOIN fulfillments f ON f.id = sh.fulfillment_id AND f.return_request_id IS NULL
        WHERE ${inPeriod('sh.created_at')} AND sh.brand_id = ?
        GROUP BY sh.provider_code`, [start, end, brandId]);
  },
  rtoSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT
         SUM(sh.status IN ('RTO','RTO_INITIATED','RTO_DELIVERED')) AS rto_count,
         COUNT(*) AS forward_terminal
       FROM shipments sh
       JOIN fulfillments f ON f.id = sh.fulfillment_id AND f.return_request_id IS NULL
      WHERE ${inPeriod('sh.created_at')} AND sh.brand_id = ? AND sh.status IN ('DELIVERED','RTO','RTO_INITIATED','RTO_DELIVERED','CANCELLED')`,
      [start, end, brandId]).then((r) => r[0]);
  },

  // ---- payments / refunds / COD ------------------------------
  // payment_attempts has no brand_id — scoped through obligation -> order.
  paymentSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT pa.status, pa.provider_code, COUNT(*) AS n, COALESCE(SUM(pa.amount_minor),0) AS amount_minor
         FROM payment_attempts pa
         JOIN payment_obligations po ON po.id = pa.obligation_id
         JOIN orders o ON o.id = po.order_id
        WHERE ${inPeriod('pa.created_at')} AND o.brand_id = ?
        GROUP BY pa.status, pa.provider_code`, [start, end, brandId]);
  },
  paymentFailureCategories({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT COALESCE(pa.failure_code,'UNSPECIFIED') AS failure_code, COUNT(*) AS n
         FROM payment_attempts pa
         JOIN payment_obligations po ON po.id = pa.obligation_id
         JOIN orders o ON o.id = po.order_id
        WHERE pa.status = 'FAILED' AND ${inPeriod('pa.created_at')} AND o.brand_id = ?
        GROUP BY failure_code ORDER BY n DESC`, [start, end, brandId]);
  },
  refundSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT ra.status, ra.provider_code, ra.method, COUNT(*) AS n, COALESCE(SUM(ra.amount_minor),0) AS amount_minor
         FROM refund_attempts ra WHERE ${inPeriod('ra.created_at')} AND ra.brand_id = ?
        GROUP BY ra.status, ra.provider_code, ra.method`, [start, end, brandId]);
  },
  refundsDetail({ start, end, offset, limit, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT ra.refund_number, ra.status, ra.method, ra.provider_code, ra.amount_minor,
              ra.return_request_id, ra.order_id, ra.failure_code, ra.created_at, ra.completed_at
         FROM refund_attempts ra WHERE ${inPeriod('ra.created_at')} AND ra.brand_id = ?
        ORDER BY ra.created_at DESC LIMIT ${limit} OFFSET ${offset}`, [start, end, brandId]);
  },
  async codSummary({ start, end, brandId }) {
    needBrand(brandId);
    const [due] = await query(
      `SELECT COALESCE(SUM(o.cod_due_minor),0) AS cod_due_minor,
              COALESCE(SUM(o.online_paid_minor),0) AS prepaid_component_minor,
              SUM(o.payment_mode = 'PARTIAL_COD') AS partial_cod_orders
         FROM orders o WHERE o.cod_due_minor > 0 AND ${inPeriod('o.placed_at')} AND o.brand_id = ?`, [start, end, brandId]);
    const [coll] = await query(
      `SELECT COALESCE(SUM(sh.cod_collection_minor),0) AS cod_collected_minor
         FROM shipments sh
         JOIN fulfillments f ON f.id = sh.fulfillment_id AND f.return_request_id IS NULL
         JOIN orders o ON o.id = f.order_id
        WHERE ${inPeriod('o.placed_at')} AND o.brand_id = ?`, [start, end, brandId]);
    return { ...due, ...coll };
  },
  codSplitMismatches(brandId) {
    needBrand(brandId);
    // Orders whose forward shipment COD allocations don't sum to cod_due.
    return query(
      `SELECT o.id AS order_id, o.order_number, o.cod_due_minor,
              COALESCE(SUM(sh.cod_collection_minor),0) AS allocated_minor
         FROM orders o
         JOIN fulfillments f ON f.order_id = o.id AND f.return_request_id IS NULL
         JOIN shipments sh ON sh.fulfillment_id = f.id
        WHERE o.cod_due_minor > 0 AND o.brand_id = ?
        GROUP BY o.id, o.order_number, o.cod_due_minor
       HAVING allocated_minor <> o.cod_due_minor`, [brandId]);
  },

  // ---- store credit / credit notes --------------------------
  // store_credit_entries has no brand_id — scoped through its account.
  storeCreditLiability(brandId) {
    needBrand(brandId);
    return query(
      `SELECT
         COALESCE(SUM(CASE WHEN e.entry_type = 'GRANT' THEN e.amount_minor ELSE 0 END),0) AS granted_minor,
         COALESCE(SUM(CASE WHEN e.entry_type IN ('DEBIT','EXPIRE') THEN -e.amount_minor ELSE 0 END),0) AS consumed_expired_minor,
         COALESCE(SUM(CASE WHEN e.entry_type = 'EXPIRE' THEN -e.amount_minor ELSE 0 END),0) AS expired_minor,
         COALESCE(SUM(CASE WHEN e.entry_type = 'REVERSAL' THEN e.amount_minor ELSE 0 END),0) AS reversal_minor,
         COALESCE(SUM(e.amount_minor),0) AS ledger_liability_minor,
         (SELECT COALESCE(SUM(balance_minor),0) FROM store_credit_accounts WHERE brand_id = ?) AS accounts_balance_minor
       FROM store_credit_entries e
       JOIN store_credit_accounts a ON a.id = e.account_id
      WHERE a.brand_id = ?`, [brandId, brandId]).then((r) => r[0]);
  },
  storeCreditLedgerDrift(brandId) {
    needBrand(brandId);
    // Per account: mutable balance vs ledger sum vs last running balance_after.
    return query(
      `SELECT x.account_id, x.balance_minor, x.ledger_sum, x.last_balance_after
         FROM (
           SELECT a.id AS account_id, a.balance_minor,
                  COALESCE(le.ledger_sum, 0) AS ledger_sum,
                  COALESCE(le.last_balance_after, 0) AS last_balance_after
             FROM store_credit_accounts a
             LEFT JOIN (
               SELECT account_id,
                      SUM(amount_minor) AS ledger_sum,
                      CAST(SUBSTRING_INDEX(GROUP_CONCAT(balance_after_minor ORDER BY created_at, entry_seq), ',', -1) AS SIGNED) AS last_balance_after
                 FROM store_credit_entries GROUP BY account_id) le ON le.account_id = a.id
            WHERE a.brand_id = ?
         ) x
        WHERE x.balance_minor <> x.ledger_sum OR x.balance_minor <> x.last_balance_after`, [brandId]);
  },
  creditNoteSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT cn.status, cn.credit_note_type, COUNT(*) AS n, COALESCE(SUM(cn.amount_minor),0) AS amount_minor
         FROM credit_notes cn WHERE ${inPeriod('cn.created_at')} AND cn.brand_id = ?
        GROUP BY cn.status, cn.credit_note_type`, [start, end, brandId]);
  },
  creditNoteDuplicates(brandId) {
    needBrand(brandId);
    return query(
      `SELECT return_request_id, COUNT(*) AS n
         FROM credit_notes WHERE return_request_id IS NOT NULL AND brand_id = ?
        GROUP BY return_request_id HAVING COUNT(*) > 1`, [brandId]);
  },
  refundUnknown(brandId) {
    needBrand(brandId);
    return query(
      `SELECT ra.refund_number, ra.order_id, ra.return_request_id, ra.amount_minor, ra.provider_code, ra.created_at
         FROM refund_attempts ra WHERE ra.status = 'UNKNOWN' AND ra.brand_id = ?`, [brandId]);
  },
  paymentUnknown(brandId) {
    needBrand(brandId);
    return query(
      `SELECT pa.id, pa.merchant_reference, pa.checkout_id, pa.amount_minor, pa.provider_code, pa.created_at
         FROM payment_attempts pa
         JOIN payment_obligations po ON po.id = pa.obligation_id
         JOIN orders o ON o.id = po.order_id
        WHERE pa.status IN ('UNKNOWN','PENDING') AND pa.created_at < DATE_SUB(NOW(3), INTERVAL 1 DAY) AND o.brand_id = ?`, [brandId]);
  },
  /** WP-12 — inventory rows whose `reserved` diverges from their open reservations. */
  inventoryReservedDrift(brandId) {
    needBrand(brandId);
    return query(
      `SELECT i.warehouse_id, i.sku_id, s.sku, i.on_hand, i.reserved,
              (SELECT COALESCE(SUM(ri.quantity), 0)
                 FROM inventory_reservation_items ri
                 JOIN inventory_reservations r ON r.id = ri.reservation_id
                WHERE ri.warehouse_id = i.warehouse_id AND ri.sku_id = i.sku_id AND r.status = 'RESERVED'
              ) AS reserved_from_reservations
         FROM inventory i
         JOIN skus s ON s.id = i.sku_id
        WHERE i.brand_id = ?
       HAVING i.reserved <> reserved_from_reservations`, [brandId]);
  },

  // ---- 8G analytics seams (source may not exist) -------------
  // product_reviews has no brand_id — scoped through the reviewed product.
  reviewSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT
         COALESCE(SUM(pr.status='PENDING'),0) AS pending,
         COALESCE(SUM(pr.status='PUBLISHED'),0) AS published,
         COALESCE(SUM(pr.status='REJECTED'),0) AS rejected,
         COUNT(*) AS total,
         ROUND(AVG(CASE WHEN pr.status='PUBLISHED' THEN pr.rating END),2) AS avg_published_rating
       FROM product_reviews pr
       JOIN products p ON p.id = pr.product_id
      WHERE ${inPeriod('pr.created_at')} AND p.brand_id = ?`, [start, end, brandId]).then((r) => r[0]);
  },
  promotionSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT p.name, p.discount_type,
              COUNT(pr.id) AS redemptions,
              COALESCE(SUM(pr.discount_minor),0) AS discount_minor
         FROM promotion_redemptions pr
         JOIN promotions p ON p.id = pr.promotion_id
        WHERE pr.status = 'CONSUMED' AND ${inPeriod('pr.consumed_at')} AND p.brand_id = ?
        GROUP BY p.id, p.name, p.discount_type ORDER BY redemptions DESC`, [start, end, brandId]);
  },
  // communication_messages has no brand_id. It is scoped through the recipient
  // customer, so messages with no customer recipient (ops/internal notices) are
  // deliberately EXCLUDED rather than counted against an arbitrary company —
  // under-reporting is acceptable here, cross-company leakage is not.
  communicationSummary({ start, end, brandId }) {
    needBrand(brandId);
    return query(
      `SELECT cm.classification, cm.status, COUNT(*) AS n
         FROM communication_messages cm
         JOIN customers c ON c.id = cm.recipient_customer_id
        WHERE ${inPeriod('cm.created_at')} AND c.brand_id = ?
        GROUP BY cm.classification, cm.status`, [start, end, brandId]);
  },
};
