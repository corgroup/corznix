// Wave 8H — frozen metric definitions + source-of-truth map.
//
// Reporting READS business truth; it never becomes business truth. Every
// metric below has exactly one authoritative source. All money is integer
// minor units end to end; ₹ formatting happens only at the presentation
// boundary.

export const REPORT_TIMEZONE = 'Asia/Kolkata'; // CORCOTTON operates in India (company_profile GST state)

export const SOURCE_OF_TRUTH_MAP = Object.freeze({
  gross_order_value: 'orders.subtotal_minor (immutable order financial snapshot)',
  order_shipping: 'orders.shipping_minor',
  order_discount: 'order_discounts.discount_total_minor / order_item_discounts (immutable snapshot, never recomputed)',
  order_total: 'orders.total_minor (= subtotal + shipping - discount)',
  captured_revenue: "payment_attempts WHERE status='SUCCEEDED' (canonical payment authority)",
  cod_due: 'orders.cod_due_minor',
  cod_collected: 'shipments.cod_collection_minor (forward shipments)',
  refunded: "refund_attempts WHERE status='SUCCEEDED' (Wave 8F refund authority)",
  refund_unknown: "refund_attempts WHERE status='UNKNOWN' (reconciliation exception, never counted as success/fail)",
  return_count: 'return_requests (Wave 8F) — never derived from support tickets',
  returned_units: 'return_request_items.quantity',
  exchange_value: 'exchange_transactions.eligible_value_minor + reserved_exchange_credits (kept out of spendable store credit)',
  store_credit_liability: 'store_credit_entries ledger — SUM(credit entry_type) - SUM(debit entry_type)',
  reserved_exchange_credit: 'reserved_exchange_credits (distinct from store_credit_entries)',
  credit_notes: 'credit_notes (Wave 8C)',
  inventory_on_hand: 'inventory.on_hand (warehouse inventory authority — sole)',
  inventory_available: 'inventory.on_hand - inventory.reserved (per warehouse, never a global field)',
  shipment_status: 'shipments.status + shipment_events.normalized_status (never raw provider status)',
  promotion_redemption: 'promotion_redemptions (Wave 8G)',
});

// Exact formulas — documented, not user-programmable. No CMS SQL.
export const METRIC_DEFINITIONS = Object.freeze({
  ORDERS: 'COUNT(DISTINCT orders.id) in period by orders.placed_at — a split fulfillment is still ONE order',
  GROSS_ORDER_VALUE_MINOR: 'SUM(orders.subtotal_minor)',
  DISCOUNT_MINOR: 'SUM(orders.discount_minor)  [= immutable applied promotion snapshot]',
  SHIPPING_MINOR: 'SUM(orders.shipping_minor)',
  NET_ORDER_VALUE_MINOR: 'SUM(orders.total_minor)  [gross + shipping - discount]',
  CAPTURED_REVENUE_MINOR: "SUM(payment_attempts.amount_minor) WHERE status='SUCCEEDED' and the attempt's order placed_at is in period",
  NET_CAPTURED_MINOR: "CAPTURED_REVENUE_MINOR - SUM(refund_attempts.amount_minor WHERE status='SUCCEEDED')",
  REFUNDED_MINOR: "SUM(refund_attempts.amount_minor) WHERE status='SUCCEEDED'",
  AOV_MINOR: 'NET_ORDER_VALUE_MINOR / ORDERS  (null when ORDERS = 0)',
  UNITS_SOLD: 'SUM(order_items.quantity) for orders in period',
  CANCELLED_ORDER_COUNT: "COUNT(orders WHERE order_status='CANCELLED') by cancelled/updated time — NOT returns of delivered orders",
  RETURN_RATE: 'returned_units / delivered_units  (consistent quantity basis; null when denominator = 0)',
  RTO_RATE: "RTO shipments / forward shipments that reached a terminal state  (null when denominator = 0)",
  STORE_CREDIT_LIABILITY_MINOR: "SUM(store_credit_entries.amount_minor WHERE entry_type is a credit) - SUM(amount_minor WHERE entry_type is a debit)",
});

// Whitelisted sortable columns per detail report (§24). Anything else → 400.
export const SORTABLE = Object.freeze({
  orders: ['placed_at', 'total_minor', 'order_number'],
  products: ['units', 'revenue_minor', 'product_name'],
  skus: ['units', 'revenue_minor', 'sku'],
  refunds: ['created_at', 'amount_minor', 'status'],
  payments: ['created_at', 'amount_minor', 'status'],
  reconciliation: ['first_detected_at', 'expected_minor', 'status'],
});
