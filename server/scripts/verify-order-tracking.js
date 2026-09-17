// WP-10 (customer tracking surface) verification.
//
// Proves, against the local dev database + pure units:
//   - carrierTrackingUrl builds a Delhivery consumer deep link from an AWB,
//     returns null for MOCK / unknown carriers, and null when the AWB is
//     missing (storefront then shows the AWB as plain text);
//   - orderFinalizationService.getOwned surfaces order_status to the customer;
//   - getOwned computes `estimatedDelivery` from the chosen shipping quote's
//     transit estimate projected from placed_at (null when no estimate);
//   - every shipmentSummary entry carries providerCode + trackingUrl keys so
//     the account order view can render a carrier link.
//
// Read-only against seeded orders — no writes, nothing to clean up.
//
//   npm run verify:order-tracking
import assert from 'node:assert/strict';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { carrierTrackingUrl } = await import('../src/modules/logistics/carrierTracking.js');
const { orderFinalizationService } = await import('../src/modules/orders/service.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

try {
  // ===================== 1. carrierTrackingUrl unit ==================
  {
    const url = carrierTrackingUrl('DELHIVERY', 'ABC 123/45');
    assert.equal(url, 'https://www.delhivery.com/track/package/ABC%20123%2F45');
    assert.equal(carrierTrackingUrl('delhivery', '999'), 'https://www.delhivery.com/track/package/999');
    assert.equal(carrierTrackingUrl('MOCK', '999'), null, 'MOCK has no public tracking page');
    assert.equal(carrierTrackingUrl('SOMEONE_ELSE', '999'), null, 'unknown carrier -> null');
    assert.equal(carrierTrackingUrl('DELHIVERY', ''), null, 'no AWB -> null');
    assert.equal(carrierTrackingUrl(null, null), null);
    pass('CARRIER_TRACKING_URL', 'Delhivery deep link + null fallbacks');
  }

  // ===================== 2. getOwned tracking fields ================
  {
    const seed = await one(
      `SELECT o.id, o.customer_id, o.order_number, o.order_status, o.placed_at
         FROM orders o
        WHERE JSON_EXTRACT(o.shipping_snapshot, '$.estimatedDays') IS NOT NULL
        ORDER BY o.placed_at DESC LIMIT 1`);
    assert(seed, 'need a seeded order with an estimatedDays shipping snapshot');

    const dto = await orderFinalizationService.getOwned(seed.customer_id, seed.order_number);
    assert.equal(dto.order_number, seed.order_number);
    assert.equal(dto.order_status, seed.order_status, 'order_status is surfaced to the customer');

    assert(dto.estimatedDelivery, 'estimatedDelivery computed from the shipping quote estimate');
    const days = Math.round((new Date(dto.estimatedDelivery) - new Date(seed.placed_at)) / 86400000);
    assert.equal(days, Number(dto.shipping.estimatedDays), 'estimatedDelivery = placed_at + quote transit days');

    assert(Array.isArray(dto.shipmentSummary), 'shipmentSummary present');
    for (const pkg of dto.shipmentSummary) {
      assert('providerCode' in pkg, 'each package exposes providerCode');
      assert('trackingUrl' in pkg, 'each package exposes trackingUrl');
      assert('timeline' in pkg && Array.isArray(pkg.timeline), 'each package exposes a timeline array');
      if (pkg.providerCode === 'DELHIVERY' && pkg.awbNumber && !pkg.trackingUrl) {
        assert.fail('a Delhivery package with an AWB must resolve a trackingUrl');
      }
    }
    pass('GET_OWNED_TRACKING', `${seed.order_number} status=${dto.order_status} eta=${dto.estimatedDelivery.slice(0, 10)} packages=${dto.shipmentSummary.length}`);
  }

  // ===================== 3. no estimate -> null ETA =================
  {
    const seed = await one(
      `SELECT o.id, o.customer_id, o.order_number FROM orders o LIMIT 1`);
    const dto = await orderFinalizationService.getOwned(seed.customer_id, seed.order_number);
    // The property must always exist; value is null only when the quote had
    // no transit estimate.
    assert('estimatedDelivery' in dto, 'estimatedDelivery key always present');
    const hasEstimate = Number(dto.shipping?.estimatedDays) > 0;
    assert.equal(dto.estimatedDelivery == null, !hasEstimate);
    pass('ETA_FIELD_CONTRACT', hasEstimate ? 'estimate present' : 'null when quote had no estimate');
  }

  console.log('\nWP-10 customer tracking surface — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  await pool.end();
}
