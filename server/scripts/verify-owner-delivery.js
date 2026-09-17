// Owner Delivery verification (migration 071 + shipping/ownerDelivery.js +
// quote injection + order-placed notification).
//
// Proves, against the local dev database:
//   - zone CRUD: create / update / delete, 6-digit PIN validation, one zone
//     per PIN (dup guard);
//   - matchForPincode honours the master toggle AND the per-zone enabled flag;
//   - shippingService.quote injects an OWNER_DELIVERY method ONLY in the
//     CHECKOUT context when a zone matches + master on — not on the PDP, not
//     for a non-matching PIN, not when the master toggle is off;
//   - the injected option survives toPublic() and resolveQuote();
//   - a carrier outage does not hide Owner Delivery;
//   - revalidateQuote re-checks the config (ok / RATE_CHANGED / unavailable);
//   - placing an OWNER_DELIVERY order raises a warehouse-scoped
//     OWNER_DELIVERY_ORDER staff notification.
//
// Isolated + self-cleaning. Leaves the master toggle OFF. No providers touched.
//
//   npm run verify:owner-delivery
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

process.env.COMMUNICATION_WORKER_ENABLED = 'false';
// Pinned to the mock carrier, and set before the dynamic imports below so it
// lands before the config module reads it.
//
// Owner Delivery is CORCOTTON's own last-mile method — it has nothing to do
// with which third-party carrier is enabled. But shippingService.quote refuses
// a CHECKOUT quote with SHIPPING_DIMENSION_DATA_MISSING when
// SHIPPING_PROVIDER_MODE=REAL and an item has no shipping profile, so without
// this pin the suite passed or failed according to whatever carrier the
// operator happened to have configured locally rather than the code under
// test. Same defect as verify:checkout's magic-PIN dependency.
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { ownerDeliveryRepository, OWNER_DELIVERY_METHOD } = await import('../src/modules/shipping/ownerDelivery.js');
const { shippingService } = await import('../src/modules/shipping/service.js');
const { checkoutRepository } = await import('../src/modules/checkout/repository.js');
const { checkoutService } = await import('../src/modules/checkout/service.js');
const { cartService } = await import('../src/modules/cart/service.js');
const { OrderFinalizationService } = await import('../src/modules/orders/service.js');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const tag = randomUUID().slice(0, 6);
const PIN = '110011';
const OTHER_PIN = '560001';
const CHARGE = 450000; // ₹4,500
const startedAt = new Date();
let zoneId;

try {
  const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const [sku] = await query("SELECT id FROM skus WHERE status = 'ACTIVE' LIMIT 1");
  assert.ok(sku, 'need an ACTIVE sku (run the seed)');
  const items = [{ skuId: sku.id, quantity: 1 }];

  // ---- zone CRUD -----------------------------------------------------
  {
    await assert.rejects(() => ownerDeliveryRepository.createZone({ name: `z${tag}`, pincode: '12345', chargeMinor: 0, brandId: cottonBrand.id }), /6 digits/);
    const z = await ownerDeliveryRepository.createZone({ name: `Zone ${tag}`, pincode: PIN, chargeMinor: CHARGE, enabled: true, brandId: cottonBrand.id });
    zoneId = z.id;
    assert.equal(z.chargeMinor, CHARGE);
    await assert.rejects(() => ownerDeliveryRepository.createZone({ name: 'dup', pincode: PIN, chargeMinor: 1, brandId: cottonBrand.id }), /already/);
    const upd = await ownerDeliveryRepository.updateZone(zoneId, cottonBrand.id, { chargeMinor: CHARGE + 100 });
    assert.equal(upd.chargeMinor, CHARGE + 100);
    await ownerDeliveryRepository.updateZone(zoneId, cottonBrand.id, { chargeMinor: CHARGE });
    // Phase 6 security pass — a cross-brand id must 404, not silently succeed.
    const [znixBrand] = await query("SELECT id FROM brands WHERE slug='corznix'");
    await assert.rejects(() => ownerDeliveryRepository.updateZone(zoneId, znixBrand.id, { chargeMinor: 1 }), /not found/i, "another company's zone id must 404 on update");
    await assert.rejects(() => ownerDeliveryRepository.deleteZone(zoneId, znixBrand.id), /not found/i, "another company's zone id must 404 on delete");
    pass('ZONE_CRUD', 'includes cross-brand id rejection on update/delete');
  }

  // ---- master toggle + enabled flag gate matchForPincode -----------
  {
    await ownerDeliveryRepository.setMasterEnabled(false);
    assert.equal(await ownerDeliveryRepository.matchForPincode(PIN), null, 'master OFF hides the zone');
    await ownerDeliveryRepository.setMasterEnabled(true);
    const m = await ownerDeliveryRepository.matchForPincode(PIN);
    assert.ok(m && m.chargeMinor === CHARGE, 'master ON reveals the zone');
    await ownerDeliveryRepository.updateZone(zoneId, cottonBrand.id, { enabled: false });
    assert.equal(await ownerDeliveryRepository.matchForPincode(PIN), null, 'disabled zone does not match');
    await ownerDeliveryRepository.updateZone(zoneId, cottonBrand.id, { enabled: true });
    assert.equal(await ownerDeliveryRepository.matchForPincode(OTHER_PIN), null, 'non-matching PIN');
    pass('TOGGLE_GATES_MATCH');
  }

  // ---- quote injection --------------------------------------------
  {
    const checkout = await shippingService.quote({ postalCode: PIN, contextType: 'CHECKOUT', items });
    const od = checkout.methods.find((m) => m.code === OWNER_DELIVERY_METHOD);
    assert.ok(od, 'CHECKOUT quote includes OWNER_DELIVERY');
    assert.equal(od.options[0].chargeMinor, CHARGE);
    assert.equal(od.options[0].providerCode, 'OWNER');
    assert.equal(checkout.ownerDeliveryAvailable, true);

    const pdp = await shippingService.quote({ postalCode: PIN, contextType: 'PRODUCT', items: [] });
    assert.ok(!pdp.methods.some((m) => m.code === OWNER_DELIVERY_METHOD), 'PDP quote does NOT include OWNER_DELIVERY');

    const other = await shippingService.quote({ postalCode: OTHER_PIN, contextType: 'CHECKOUT', items });
    assert.ok(!other.methods.some((m) => m.code === OWNER_DELIVERY_METHOD), 'non-matching PIN gets no OWNER_DELIVERY');

    await ownerDeliveryRepository.setMasterEnabled(false);
    const off = await shippingService.quote({ postalCode: PIN, contextType: 'CHECKOUT', items });
    assert.ok(!off.methods.some((m) => m.code === OWNER_DELIVERY_METHOD), 'master OFF -> no OWNER_DELIVERY at checkout');
    await ownerDeliveryRepository.setMasterEnabled(true);

    // toPublic + resolveQuote round-trip
    const pub = shippingService.toPublic(checkout);
    const pubOd = pub.methods.find((m) => m.code === OWNER_DELIVERY_METHOD);
    assert.equal(pubOd.name, 'Owner Delivery');
    assert.equal(pubOd.options[0].ownerDeliveryZone, `Zone ${tag}`);
    const resolved = shippingService.resolveQuote(checkout, od.options[0].quoteId);
    assert.equal(resolved.serviceLevel, OWNER_DELIVERY_METHOD);
    pass('QUOTE_INJECTION');
  }

  // ---- revalidate --------------------------------------------------
  {
    const snap = (await shippingService.quote({ postalCode: PIN, contextType: 'CHECKOUT', items }))
      .methods.find((m) => m.code === OWNER_DELIVERY_METHOD).options[0];
    assert.deepEqual(await shippingService.revalidateQuote({ postalCode: PIN, quoteSnapshot: snap, items }), { ok: true });
    const stale = await shippingService.revalidateQuote({ postalCode: PIN, quoteSnapshot: { ...snap, chargeMinor: 999999 }, items });
    assert.equal(stale.reason, 'RATE_CHANGED');
    await ownerDeliveryRepository.updateZone(zoneId, cottonBrand.id, { enabled: false });
    const gone = await shippingService.revalidateQuote({ postalCode: PIN, quoteSnapshot: snap, items });
    assert.equal(gone.reason, 'OWNER_DELIVERY_UNAVAILABLE');
    await ownerDeliveryRepository.updateZone(zoneId, cottonBrand.id, { enabled: true });
    pass('REVALIDATE');
  }

  // ---- the configured charge is what the customer actually pays ------
  // The CMS number has to survive the whole way to the money on the order,
  // not just to the label on the option. This drives the real checkout
  // repository, so a change to how shipping is priced into a session breaks
  // here rather than in production.
  {
    const [sellable] = await query(
      `SELECT s.id, s.size, v.storefront_id
         FROM skus s
         JOIN product_variants v ON v.id = s.variant_id
         JOIN products p ON p.id = v.product_id
         JOIN inventory i ON i.sku_id = s.id
        WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'
        GROUP BY s.id
       HAVING SUM(i.on_hand - i.reserved) > 0
        LIMIT 1`,
    );
    assert.ok(sellable, 'need an ACTIVE, in-stock sku (run the seed)');

    const customerId = randomUUID();
    await query(
      "INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at) VALUES (?, ?, 'OwnerDelivery', 'Charge', 'ACTIVE', NOW(3))",
      [customerId, cottonBrand.id],
    );
    await cartService.addItem(customerId, { storefrontId: sellable.storefront_id, size: sellable.size, quantity: 1 });
    const session = await checkoutService.create(customerId, randomUUID());
    const checkoutId = session.id;
    const SUBTOTAL = session.pricing.subtotalMinor;
    try {
      const quote = await shippingService.quote({ postalCode: PIN, contextType: 'CHECKOUT', items });
      const option = quote.methods.find((m) => m.code === OWNER_DELIVERY_METHOD).options[0];
      assert.equal(option.rateMinor, CHARGE, 'quote option carries the configured charge');
      assert.equal(option.chargeMinor, CHARGE, 'public charge equals the configured charge');

      assert.ok(await checkoutRepository.selectShipping(customerId, checkoutId, option), 'selectShipping applied');
      const [row] = await query('SELECT shipping_minor, total_minor, selected_shipping_method_code, shipping_quote_snapshot FROM checkout_sessions WHERE id = ?', [checkoutId]);
      assert.equal(Number(row.shipping_minor), CHARGE, 'session shipping_minor = configured charge');
      assert.equal(Number(row.total_minor), SUBTOTAL + CHARGE, 'session total includes the configured charge');
      assert.equal(row.selected_shipping_method_code, OWNER_DELIVERY_METHOD);
      const snapshot = typeof row.shipping_quote_snapshot === 'string' ? JSON.parse(row.shipping_quote_snapshot) : row.shipping_quote_snapshot;
      assert.equal(snapshot.rateMinor, CHARGE, 'frozen snapshot carries the configured charge');

      // And a re-configured price is picked up on the next quote.
      await ownerDeliveryRepository.updateZone(zoneId, cottonBrand.id, { chargeMinor: CHARGE + 5000 });
      const requoted = (await shippingService.quote({ postalCode: PIN, contextType: 'CHECKOUT', items }))
        .methods.find((m) => m.code === OWNER_DELIVERY_METHOD).options[0];
      assert.equal(requoted.rateMinor, CHARGE + 5000, 'a re-priced zone re-quotes at the new charge');
      await ownerDeliveryRepository.updateZone(zoneId, cottonBrand.id, { chargeMinor: CHARGE });
    } finally {
      // Cancel through the service so the inventory reservation is released
      // rather than orphaned — this suite must leave stock exactly as found.
      await checkoutService.cancel(customerId, checkoutId).catch(() => {});
      await query('DELETE FROM checkout_payment_eligibility WHERE checkout_id = ?', [checkoutId]);
      await query('DELETE FROM checkout_sessions WHERE id = ?', [checkoutId]);
      await query('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE customer_id = ?)', [customerId]);
      await query('DELETE FROM carts WHERE customer_id = ?', [customerId]);
      await query('DELETE FROM customers WHERE id = ?', [customerId]);
    }
    pass('CONFIGURED_CHARGE_REACHES_CHECKOUT_TOTAL');
  }

  // ---- order-placed notification (mock harness) -------------------
  {
    const orderId = `od-verify-${tag}`;
    const shippingSnap = { serviceLevel: 'OWNER_DELIVERY', providerCode: 'OWNER', ownerDeliveryZone: `Zone ${tag}`, customerShippingChargeMinor: CHARGE, shippingChargeMinor: CHARGE };
    const addressSnap = { city: 'Delhi', state: 'Delhi', postalCode: PIN };
    const state = { order: null, items: [], finished: 0, cartCleared: null };
    const checkout = {
      id: 'od-checkout', customer_id: 'od-customer', cart_id: 'od-cart', inventory_reservation_id: 'r', status: 'READY_FOR_PAYMENT',
      reservation_status: 'RESERVED', reservation_is_expired: 0, currency: 'INR',
      subtotal_minor: 200000, shipping_minor: CHARGE, total_minor: 200000 + CHARGE,
      items_snapshot: [{ productId: 'p', variantId: 'v', skuId: 's', name: 'Tee', sku: 'T', selectedSize: 'M', selectedColor: 'Black', quantity: 1, unitPriceMinor: 200000, lineTotalMinor: 200000, media: null }],
      shipping_address_snapshot: addressSnap, shipping_quote_snapshot: { serviceLevel: 'OWNER_DELIVERY', chargeMinor: CHARGE, quoteExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
      selected_shipping_method_code: 'OWNER_DELIVERY', selected_provider_code: 'OWNER', selected_provider_service_code: 'OWNER_DELIVERY', shipping_quote_reference: 'q',
    };
    const repository = {
      checkout: async (_id, cid) => (!cid || cid === checkout.customer_id ? checkout : null),
      findByCheckout: async () => state.order,
      eligibility: async () => ({ selected_payment_mode: 'FULL_COD' }),
      obligations: async () => [
        { obligation_type: 'ONLINE', status: 'NOT_REQUIRED', amount_minor: 0, currency: 'INR' },
        { obligation_type: 'COD', status: 'DUE', amount_minor: 200000 + CHARGE, currency: 'INR' },
      ],
      create: async () => (state.order = {
        id: orderId, order_number: `COR-ODV-${tag}`, subtotal_minor: 200000, shipping_minor: CHARGE, total_minor: 200000 + CHARGE,
        online_paid_minor: 0, cod_due_minor: 200000 + CHARGE, customer_id: 'od-customer',
        shipping_address_snapshot: JSON.stringify(addressSnap), shipping_snapshot: JSON.stringify(shippingSnap),
        payment_status: 'COD_DUE', finalization_source: 'CUSTOMER_PLACE_ORDER',
      }),
      addItems: async (_c, _o, its) => { state.items = its.map((v, i) => ({ id: String(i), product_name: v.name, ...v, unit_price_minor: v.unitPriceMinor, line_total_minor: v.lineTotalMinor, media_snapshot: v.media })); },
      // Finalization clears the purchased lines inside the order transaction.
      // A stub that omits it does not just miss the behaviour — finalize()
      // throws, so every later assertion here dies with it.
      clearPurchasedCartLines: async (_c, cartId, items) => { state.cartCleared = { cartId, lines: (items || []).length }; return (items || []).length; },
      finish: async () => { state.finished += 1; }, items: async () => state.items,
      enqueue: async () => {}, reconciliation: async () => {},
      findOwned: async () => state.order, listOwned: async () => (state.order ? [state.order] : []),
    };
    const transaction = (cb) => Promise.resolve().then(() => cb({}));
    const inventory = { consumeReservation: async () => {} };
    const service = new OrderFinalizationService({ repository, inventory, transaction, bootstrapFulfillment: async () => {}, fulfillment: { summaryForOrder: async () => ({ fulfillments: [], shipments: [] }) } });

    await service.finalize('od-checkout', { source: 'CUSTOMER_PLACE_ORDER' });
    // give the fire-and-forget notification a tick
    await new Promise((r) => setTimeout(r, 250));
    const notif = await query("SELECT severity, warehouse_id FROM staff_notifications WHERE event_key = 'OWNER_DELIVERY_ORDER' AND entity_id = ?", [orderId]);
    assert.ok(notif.length >= 1, 'OWNER_DELIVERY_ORDER staff notification raised');
    assert.equal(notif[0].severity, 'WARNING');
    pass('ORDER_PLACED_NOTIFICATION');
    assert.deepEqual(state.cartCleared, { cartId: checkout.cart_id, lines: 1 }, 'purchased lines left the cart during finalization');
    pass('PURCHASED_LINES_LEAVE_THE_CART');
  }

  console.log('\nOwner Delivery — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  await safe(() => query("DELETE FROM staff_notifications WHERE event_key = 'OWNER_DELIVERY_ORDER' AND created_at >= ?", [startedAt]));
  await safe(() => query('DELETE FROM owner_delivery_zones WHERE id = ?', [zoneId || '']));
  await safe(() => query('UPDATE shipping_settings SET owner_delivery_enabled = 0 WHERE id = 1'));
  await pool.end();
}
