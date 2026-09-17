// WP-16 (Orders CMS scale) verification.
//
// Proves, against the local dev database, the new Orders list/detail surface:
//   - listOrders returns each order's customer_name; countOrders matches;
//   - the `q` search matches an order number AND a customer name / contact;
//   - the `status` filter still works;
//   - warehouse scoping — a warehouseIds filter that matches nothing returns
//     zero; one that matches the order's warehouse returns it;
//   - customerForOrder returns the identity used by the detail panel, and a
//     seeded order's shipping_address_snapshot parses to an object.
//
// Read-only against seeded data — creates nothing, cleans nothing.
//
//   npm run verify:order-cms
import assert from 'node:assert/strict';

const { pool, query } = await import('../src/database/connection/pool.js');
const { orderOpsRepository } = await import('../src/modules/orderOps/repository.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

const seed = await one(
  `SELECT o.id, o.order_number, o.order_status, o.customer_id, o.inventory_reservation_id,
          CONCAT_WS(' ', c.first_name, c.last_name) AS customer_name
     FROM orders o JOIN customers c ON c.id = o.customer_id ORDER BY o.placed_at LIMIT 1`);
assert(seed, 'need at least one seeded order');

try {
  // ===================== 1. list + count + customer_name ===============
  {
    const rows = await orderOpsRepository.listOrders({ limit: 200 });
    const total = await orderOpsRepository.countOrders({});
    assert.equal(rows.length, total, 'listOrders length should match countOrders when unpaginated');
    const row = rows.find((r) => r.id === seed.id);
    assert(row, 'the seeded order must be listed');
    assert.equal(row.customer_name, seed.customer_name, 'each row carries the customer name');
    pass('LIST_AND_COUNT', `${total} orders; customer_name present`);
  }

  // ===================== 2. q — by order number ========================
  {
    const frag = seed.order_number.slice(-8);
    const rows = await orderOpsRepository.listOrders({ q: frag, limit: 50 });
    assert(rows.some((r) => r.id === seed.id), 'partial order number must match');
    const count = await orderOpsRepository.countOrders({ q: frag });
    assert.equal(count, rows.length);
    pass('SEARCH_BY_ORDER_NUMBER');
  }

  // ===================== 3. q — by customer name =======================
  {
    const namePart = (seed.customer_name || '').trim().split(/\s+/)[0];
    if (namePart && namePart.length >= 2) {
      const rows = await orderOpsRepository.listOrders({ q: namePart, limit: 50 });
      assert(rows.some((r) => r.id === seed.id), 'a customer-name fragment must match the order');
      pass('SEARCH_BY_CUSTOMER_NAME', `"${namePart}"`);
    } else {
      pass('SEARCH_BY_CUSTOMER_NAME', 'skipped — seeded customer has no usable name');
    }
  }

  // ===================== 4. status filter =============================
  {
    const rows = await orderOpsRepository.listOrders({ status: seed.order_status, limit: 200 });
    assert(rows.every((r) => r.order_status === seed.order_status));
    assert(rows.some((r) => r.id === seed.id));
    pass('STATUS_FILTER', seed.order_status);
  }

  // ===================== 5. warehouse scoping ========================
  {
    // The order's warehouse(s) from its reservation lines / fulfilments.
    const whRows = await query(
      `SELECT DISTINCT warehouse_id FROM (
         SELECT ri.warehouse_id FROM inventory_reservation_items ri WHERE ri.reservation_id = ?
         UNION SELECT f.warehouse_id FROM fulfillments f WHERE f.order_id = ?
       ) x WHERE warehouse_id IS NOT NULL`, [seed.inventory_reservation_id, seed.id]);
    const orderWarehouses = whRows.map((r) => r.warehouse_id);
    assert(orderWarehouses.length >= 1, 'the seeded order must touch at least one warehouse');

    const inScope = await orderOpsRepository.listOrders({ warehouseIds: orderWarehouses, limit: 200 });
    assert(inScope.some((r) => r.id === seed.id), 'an in-scope warehouse filter must include the order');

    const outOfScope = await orderOpsRepository.listOrders({ warehouseIds: ['00000000-0000-0000-0000-000000000000'], limit: 200 });
    assert(!outOfScope.some((r) => r.id === seed.id), 'an unrelated warehouse filter must exclude the order');
    const outCount = await orderOpsRepository.countOrders({ warehouseIds: ['00000000-0000-0000-0000-000000000000'] });
    assert.equal(outCount, 0);
    pass('WAREHOUSE_SCOPE', `order touches ${orderWarehouses.length} warehouse(s); out-of-scope filter = 0`);
  }

  // ===================== 6. detail enrichment ========================
  {
    const cust = await orderOpsRepository.customerForOrder(seed.customer_id);
    assert(cust, 'customerForOrder must return the customer');
    assert.equal(cust.id, seed.customer_id);
    assert('verified_email' in cust && 'verified_phone' in cust, 'contact columns are selected');

    const full = await orderOpsRepository.order(seed.id);
    const addr = typeof full.shipping_address_snapshot === 'string'
      ? JSON.parse(full.shipping_address_snapshot) : full.shipping_address_snapshot;
    assert(addr && typeof addr === 'object', 'shipping_address_snapshot parses to an object');
    pass('DETAIL_ENRICHMENT', 'customer identity + parsed shipping address');
  }

  // ===================== 6. Phase 5 — facets ===========================
  {
    const f = await orderOpsRepository.facets();
    const sum = f.byStatus.PLACED + f.byStatus.CONFIRMED + f.byStatus.PROCESSING + f.byStatus.COMPLETED + f.byStatus.CANCELLED;
    assert.equal(sum, f.total, 'byStatus sums to total');
    assert.equal(f.needsAction, f.byStatus.PLACED + f.byStatus.CONFIRMED, 'needsAction = PLACED + CONFIRMED');
    assert.ok(f.codDueMinor >= 0 && f.grossValueMinor >= 0 && f.avgValueMinor >= 0, 'value facets non-negative');
    pass('FACETS', `${f.total} orders; ${f.needsAction} need action`);
  }

  // ===================== 7. Phase 5 — additive filters =================
  {
    const base = await orderOpsRepository.countOrders({});
    const paid = await orderOpsRepository.countOrders({ paymentStatus: 'PAID' });
    const cod = await orderOpsRepository.countOrders({ paymentStatus: 'COD_DUE' });
    const partial = await orderOpsRepository.countOrders({ paymentStatus: 'PARTIALLY_PAID' });
    assert.ok(paid + cod + partial <= base + 0, 'payment-status filter is a partition subset');
    assert.equal(await orderOpsRepository.countOrders({ placedTo: '2000-01-01' }), 0, 'impossible date range → 0');
    assert.equal(await orderOpsRepository.countOrders({ fulfillmentStatus: 'FULFILLED' }) <= base, true);
    pass('ADDITIVE_FILTERS', 'paymentStatus / fulfillmentStatus / placed date range');
  }

  // ===================== 8. Phase 5 — items + timeline + returns =======
  {
    const items = await orderOpsRepository.itemsForOrder(seed.id);
    assert.ok(Array.isArray(items), 'itemsForOrder returns an array');
    if (items.length) {
      assert.ok(items[0].sku && items[0].product_name && Number(items[0].line_total_minor) >= 0, 'item row shape');
    }
    const tl = await orderOpsRepository.timelineForOrder(seed.id);
    assert.ok(Array.isArray(tl) && tl.length >= 1, 'timeline has at least "Order placed"');
    assert.ok(tl.every((e) => e.at && e.title && e.category), 'timeline row shape');
    const sorted = tl.map((e) => e.at).every((v, i, a) => i === 0 || a[i - 1] <= v);
    assert.ok(sorted, 'timeline is chronologically sorted');
    const rets = await orderOpsRepository.returnsForOrder(seed.id);
    assert.ok(Array.isArray(rets), 'returnsForOrder returns an array');
    pass('ITEMS_TIMELINE_RETURNS', `${items.length} items · ${tl.length} events · ${rets.length} returns`);
  }

  console.log('\nWP-16 Orders CMS scale — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await pool.end();
}
