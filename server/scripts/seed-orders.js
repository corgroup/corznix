// Deterministic order fixture.
//
// The fulfilment, returns and order-ops verification scripts all need a small
// set of orders in a known state. Until now they simply read whatever orders
// happened to be in the local database -- rows left behind by other scripts --
// so their assertions drifted out from under them: of the five ambient orders
// this replaces, only one was still PLACED, two had been advanced to
// PROCESSING, two CANCELLED, and one had a consumed reservation listing a SKU
// that was not on its own order. That is why those scripts sit in the CI
// ADVISORY tier instead of being required.
//
// Everything here is tagged `finalization_source = 'FIXTURE_SEED'`. The script
// only ever deletes rows carrying that tag, so it cannot touch a real order.
//
//   npm run seed:orders --workspace=server
import { randomUUID } from 'node:crypto';

const { env } = await import('../src/config/env.js');

// These are invented orders with invented money on them. In a real environment
// they would land in revenue reports, GST output and reconciliation as if a
// customer had actually bought something, so this refuses to run there at all.
// Deliberately keyed on NODE_ENV rather than a flag that could be passed by
// mistake, and there is no override.
if (env.NODE_ENV === 'production') {
  throw new Error('seed:orders creates fictitious orders and must never run against production');
}

const { pool, query } = await import('../src/database/connection/pool.js');

const SOURCE = 'FIXTURE_SEED';
// Enough that a cancellation can restore into it and a reservation can be taken
// from it without the fixture ever being the thing under test.
const FIXTURE_STOCK = 25;
const CUSTOMER_ID = '00000000-0000-4000-9000-00000000f1x1';

// A complete, deliverable address: readiness blocks on a missing field or a
// non-6-digit PIN, and these orders exist to exercise the gates *after* that.
const ADDRESS = {
  firstName: 'Fixture', lastName: 'Buyer', phone: '9319987171',
  addressLine1: '1 Fixture Road', addressLine2: '', city: 'Delhi',
  state: 'Delhi', postalCode: '110001', country: 'IN',
};
// `estimatedDays` is what the customer tracking surface turns into an
// `estimatedDelivery` date (WP-10). A real checkout always carries it because
// it comes from the shipping quote; omitting it here left verify:order-tracking
// with nothing to read on a fresh database and passing only where somebody's
// dev data happened to hold an older order that had one.
const SHIPPING = { serviceLevel: 'STANDARD', estimatedDays: 3 };

/**
 * Advance one fixture order to the state the logistics/notification/cancellation
 * scripts all select for: PROCESSING, with exactly ONE INITIAL fulfilment still
 * PENDING against a real warehouse, and ONE shipment that has never been booked.
 *
 * Written against the table CHECK constraints rather than around them:
 *   chk_fulfillment_readiness_consistency — READY requires block_reason NULL.
 *   chk_shipment_unbooked_clean           — a NOT_READY/READY shipment must
 *     carry no provider_code, external id, tracking number/url or booked_at.
 * A "booked shipment with no AWB" is unconstructible by design, so the un-booked
 * side has to be genuinely clean rather than half-filled.
 *
 * The snapshots mirror `fulfillment/service.js` (financialSnapshot /
 * shippingMethodSnapshot) so a fixture fulfilment reads the same as a real one.
 */
async function advanceToProcessing(order, brand, warehouse) {
  if (!order) throw new Error('fixture plan is missing its PROCESSING order');

  const items = await query(
    'SELECT id, sku_id, quantity FROM order_items WHERE order_id = ?', [order.orderId]);
  if (!items.length) throw new Error('the PROCESSING fixture order has no items');

  await query(
    "UPDATE orders SET order_status = 'PROCESSING', fulfillment_status = 'UNFULFILLED' WHERE id = ?",
    [order.orderId]);

  const fulfillmentId = randomUUID();
  await query(
    `INSERT INTO fulfillments
       (id, brand_id, order_id, warehouse_id, fulfillment_number, fulfillment_type, sequence,
        status, readiness_status, block_reason,
        shipping_address_snapshot_json, shipping_method_snapshot_json, financial_snapshot_json,
        warehouse_snapshot_json, ready_at)
     VALUES (?, ?, ?, ?, ?, 'INITIAL', 1, 'PENDING', 'READY', NULL,
        CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), NOW(3))`,
    [fulfillmentId, brand.id, order.orderId, warehouse.id,
      `FUL-COR-FIXTURE-${order.label}-1`,
      JSON.stringify(ADDRESS),
      JSON.stringify(SHIPPING),
      JSON.stringify({
        currency: 'INR',
        paymentMode: order.mode,
        orderTotalMinor: order.subtotal,
        onlinePaidMinor: order.subtotal - order.codDue,
        codDueMinor: order.codDue,
        codCollectionMinor: order.codDue,
        warehouseId: warehouse.id,
      }),
      JSON.stringify({ id: warehouse.id, code: warehouse.code, name: warehouse.name })]);

  for (const item of items) {
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO fulfillment_items (id, fulfillment_id, order_item_id, sku_id, quantity)
       VALUES (?, ?, ?, ?, ?)`,
      [randomUUID(), fulfillmentId, item.id, item.sku_id, item.quantity]);
  }

  const shipmentId = randomUUID();
  await query(
    `INSERT INTO shipments
       (id, brand_id, fulfillment_id, warehouse_id, shipment_number, sequence,
        status, booking_status, cod_collection_minor)
     VALUES (?, ?, ?, ?, ?, 1, 'DRAFT', 'NOT_READY', ?)`,
    [shipmentId, brand.id, fulfillmentId, warehouse.id,
      `SHP-COR-FIXTURE-${order.label}-1`, order.codDue]);

  return { orderId: order.orderId, fulfillmentId, shipmentId, items: items.length };
}

async function removePriorFixture() {
  const prior = await query(
    'SELECT id, checkout_id, inventory_reservation_id FROM orders WHERE finalization_source = ?', [SOURCE]);
  if (!prior.length) return 0;
  const ids = prior.map((o) => o.id);
  const marks = ids.map(() => '?').join(',');
  // Derived paperwork first: documents and invoices RESTRICT-reference
  // shipments, fulfilments and orders.
  await query(`DELETE pj FROM print_jobs pj JOIN documents d ON d.id = pj.document_id WHERE d.order_id IN (${marks})`, ids);
  await query(`DELETE FROM documents WHERE order_id IN (${marks})`, ids);
  await query(`DELETE ii FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id WHERE i.order_id IN (${marks})`, ids);
  await query(`DELETE FROM credit_notes WHERE order_id IN (${marks})`, ids);
  await query(`DELETE FROM invoices WHERE order_id IN (${marks})`, ids);
  await query(`DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id = fe.fulfillment_id WHERE f.order_id IN (${marks})`, ids);
  await query(`DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id = fi.fulfillment_id WHERE f.order_id IN (${marks})`, ids);
  await query(`DELETE s FROM shipments s JOIN fulfillments f ON f.id = s.fulfillment_id WHERE f.order_id IN (${marks})`, ids);
  await query(`DELETE FROM fulfillments WHERE order_id IN (${marks})`, ids);
  await query(`DELETE FROM order_items WHERE order_id IN (${marks})`, ids);
  await query(`DELETE FROM orders WHERE id IN (${marks})`, ids);

  const checkoutIds = prior.map((o) => o.checkout_id).filter(Boolean);
  if (checkoutIds.length) {
    const cm = checkoutIds.map(() => '?').join(',');
    const carts = await query(`SELECT cart_id FROM checkout_sessions WHERE id IN (${cm})`, checkoutIds);
    await query(`DELETE FROM checkout_sessions WHERE id IN (${cm})`, checkoutIds);
    const cartIds = [...new Set(carts.map((c) => c.cart_id).filter(Boolean))];
    if (cartIds.length) {
      const km = cartIds.map(() => '?').join(',');
      await query(`DELETE FROM cart_items WHERE cart_id IN (${km})`, cartIds);
      await query(`DELETE FROM carts WHERE id IN (${km})`, cartIds);
    }
  }

  const resIds = prior.map((o) => o.inventory_reservation_id).filter(Boolean);
  if (resIds.length) {
    const rm = resIds.map(() => '?').join(',');
    await query(`DELETE FROM inventory_reservation_items WHERE reservation_id IN (${rm})`, resIds);
    await query(`DELETE FROM inventory_reservations WHERE id IN (${rm})`, resIds);
  }
  return ids.length;
}

async function main() {
  const [brand] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  if (!brand) throw new Error('no corcotton brand — run the migrations and seed first');
  // code/name feed the fulfilment's warehouse_snapshot_json, same as the real
  // service records it.
  const [warehouse] = await query("SELECT id, code, name FROM warehouses WHERE status = 'ACTIVE' ORDER BY id LIMIT 1");
  if (!warehouse) throw new Error('no active warehouse — run seed:warehouses first');

  const skus = await query(
    `SELECT s.id, s.sku, s.size, s.price_minor, v.id variant_id, v.product_id, p.name
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id
       JOIN products p ON p.id = v.product_id
      WHERE s.status = 'ACTIVE' AND v.status = 'ACTIVE' AND p.status = 'ACTIVE'
      ORDER BY s.id LIMIT 3`);
  if (skus.length < 3) throw new Error('need at least 3 active SKUs — run the catalog seed first');

  const removed = await removePriorFixture();

  // Every order below carries a CONSUMED reservation, which asserts that stock
  // was drawn down -- so the inventory row it was drawn from has to exist.
  // `seed:warehouses` only stocks anything when passed --distribute, and CI does
  // not pass it, so a freshly seeded database has NO inventory rows at all:
  // verify:order-cancellation restored its snapshot of a row that was never
  // there and died dereferencing undefined, after its actual assertion passed.
  //
  // Insert-only. An existing row is left exactly as it is (`updated_at =
  // updated_at` is a deliberate no-op) so running this against a database that
  // holds real stock can never rewrite a real quantity.
  for (const sku of skus) {
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO inventory (id, brand_id, warehouse_id, sku_id, on_hand, reserved, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, NOW(3), NOW(3))
       ON DUPLICATE KEY UPDATE updated_at = updated_at`,
      [randomUUID(), brand.id, warehouse.id, sku.id, FIXTURE_STOCK]);
  }

  await query(
    `INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at)
     VALUES (?, ?, 'Fixture', 'Buyer', 'ACTIVE', NOW(3))
     ON DUPLICATE KEY UPDATE status = 'ACTIVE'`,
    [CUSTOMER_ID, brand.id]);

  // One cart, reused: `uk_carts_customer` allows a customer exactly one, which
  // is how the real thing behaves too -- the cart persists and is emptied and
  // refilled between orders rather than replaced.
  const cartId = randomUUID();
  await query('INSERT INTO carts (id, brand_id, customer_id, currency) VALUES (?, ?, ?, \'INR\')',
    [cartId, brand.id, CUSTOMER_ID]);

  // (label, payment mode, line items, share of the total collected on delivery)
  const PLAN = [
    ['PREPAID', 'PREPAID', [skus[0], skus[1]], 0],
    // A remainder, deliberately not the full total: the fulfilment script
    // asserts partial COD collects only what is still owed.
    ['PARTIALCOD', 'PARTIAL_COD', [skus[0], skus[2]], 0.4],
    ['FULLCOD', 'FULL_COD', [skus[2]], 1],
    ['SPARE', 'PREPAID', [skus[1]], 0],
    // Advanced to PROCESSING with a fulfilment and an un-booked shipment by
    // `advanceToProcessing` below. Kept as its own order rather than promoting
    // SPARE so the four orders above stay byte-identical to what the scripts
    // that already pass are reading.
    ['PROCESSING', 'PREPAID', [skus[0]], 0],
  ];

  const made = [];
  for (const [label, mode, lines, codShare] of PLAN) {
    const subtotal = lines.reduce((sum, sku) => sum + Number(sku.price_minor), 0);
    const codDue = Math.round(subtotal * codShare);
    const reservationId = randomUUID();
    const orderId = randomUUID();
    const checkoutId = randomUUID();

    // CONSUMED, so it contributes nothing to inventory.reserved and the
    // `inventory_reserved_matches_open_reservations` invariant is untouched.
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO inventory_reservations (id, brand_id, customer_id, idempotency_key, request_fingerprint, status, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY), NOW(3))`,
      [reservationId, brand.id, CUSTOMER_ID, `fixture:${label}:${orderId}`, 'f'.repeat(64)]);

    for (const sku of lines) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO inventory_reservation_items (id, reservation_id, warehouse_id, sku_id, quantity)
         VALUES (?, ?, ?, ?, 1)`,
        [randomUUID(), reservationId, warehouse.id, sku.id]);
    }

    // A real order always comes from a checkout, and several invariants read
    // through that link -- `GROUP BY checkout_id HAVING COUNT(*) > 1` groups
    // NULLs together, so orders without one look like duplicates of each other.
    const itemsSnapshot = lines.map((sku) => ({
      skuId: sku.id, productId: sku.product_id, variantId: sku.variant_id,
      name: sku.name, sku: sku.sku, selectedSize: sku.size,
      quantity: 1, unitPriceMinor: Number(sku.price_minor), lineTotalMinor: Number(sku.price_minor),
    }));

    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO checkout_sessions (id, brand_id, customer_id, cart_id, inventory_reservation_id,
         idempotency_key, cart_fingerprint, items_snapshot, status, currency,
         subtotal_minor, shipping_minor, total_minor, shipping_address_snapshot,
         reservation_expires_at, expires_at, finalized_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), 'FINALIZED', 'INR', ?, 0, ?, CAST(? AS JSON),
         DATE_ADD(NOW(3), INTERVAL 1 DAY), DATE_ADD(NOW(3), INTERVAL 1 DAY), NOW(3))`,
      [checkoutId, brand.id, CUSTOMER_ID, cartId, reservationId,
        `fixture:checkout:${label}`, 'f'.repeat(64), JSON.stringify(itemsSnapshot),
        subtotal, subtotal, JSON.stringify(ADDRESS)]);

    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO orders (id, brand_id, order_number, checkout_id, customer_id, inventory_reservation_id, order_status,
         payment_status, payment_mode, currency, subtotal_minor, shipping_minor, total_minor,
         online_paid_minor, cod_due_minor, shipping_address_snapshot, shipping_snapshot, finalization_source, placed_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PLACED', ?, ?, 'INR', ?, 0, ?, ?, ?, ?, ?, ?, NOW(3))`,
      [orderId, brand.id, `COR-FIXTURE-${label}`, checkoutId, CUSTOMER_ID, reservationId,
        codDue > 0 ? 'COD_DUE' : 'PAID', mode, subtotal, subtotal, subtotal - codDue, codDue,
        JSON.stringify(ADDRESS), JSON.stringify(SHIPPING), SOURCE]);

    for (const sku of lines) {
      // eslint-disable-next-line no-await-in-loop
      await query(
        `INSERT INTO order_items (id, order_id, product_id, variant_id, sku_id, product_name, sku, selected_size, quantity, unit_price_minor, line_total_minor)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [randomUUID(), orderId, sku.product_id, sku.variant_id, sku.id, sku.name, sku.sku, sku.size,
          Number(sku.price_minor), Number(sku.price_minor)]);
    }

    made.push({ label, mode, orderId, lines: lines.length, subtotal, codDue });
  }

  const advanced = await advanceToProcessing(
    made.find((o) => o.label === 'PROCESSING'), brand, warehouse);

  // The defect this fixture exists to rule out: a reservation line that is not
  // an item on its own order. Asserted here, not merely hoped for.
  const mismatched = await query(
    `SELECT o.order_number,
            (SELECT COUNT(*) FROM order_items oi WHERE oi.order_id = o.id
               AND oi.sku_id NOT IN (SELECT ri.sku_id FROM inventory_reservation_items ri
                                      WHERE ri.reservation_id = o.inventory_reservation_id)) bad
       FROM orders o WHERE o.finalization_source = ? HAVING bad > 0`, [SOURCE]);
  if (mismatched.length) throw new Error(`fixture is inconsistent: ${JSON.stringify(mismatched)}`);

  // The other axis: order lines must equal the checkout's immutable snapshot.
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  for (const order of made) {
    // eslint-disable-next-line no-await-in-loop
    const [checkout] = await query(
      'SELECT items_snapshot FROM checkout_sessions WHERE id = (SELECT checkout_id FROM orders WHERE id = ?)',
      [order.orderId]);
    const snapshot = (parse(checkout.items_snapshot) || []).map((i) => i.skuId).sort();
    // eslint-disable-next-line no-await-in-loop
    const rows = await query('SELECT sku_id FROM order_items WHERE order_id = ?', [order.orderId]);
    const actual = rows.map((r) => r.sku_id).sort();
    if (JSON.stringify(snapshot) !== JSON.stringify(actual)) {
      throw new Error(`${order.label}: order items ${JSON.stringify(actual)} do not match checkout snapshot ${JSON.stringify(snapshot)}`);
    }
  }

  console.log(JSON.stringify({ removedPriorFixtureOrders: removed, created: made, advanced }, null, 2));
}

try {
  await main();
} finally {
  await pool.end();
}
