// Wave 8G-6 — promotions + coupons.
//
// Backend-authoritative discount (client sends a code, never an amount);
// integer minor units / basis points; deterministic stacking + priority +
// item allocation; concurrency-safe global + per-customer usage limits (two
// customers race the last redemption -> exactly one wins); RESERVED -> CONSUMED
// exactly once (duplicate finalization / webhook safe); release on
// cancel/payment-fail; immutable per-order + per-line discount snapshot;
// returns never re-price from the live promo. No provider / network calls.
//
//   npm run verify:promotions
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';

const { pool, query } = await import('../src/database/connection/pool.js');
const { roleHasPermission } = await import('../src/modules/staff/permissions.js');
const { promotionService } = await import('../src/modules/promotions/service.js');
const { promotionRepository } = await import('../src/modules/promotions/repository.js');
const engine = await import('../src/modules/promotions/promotionEngine.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { customers: [], staff: [], promotions: [], orders: [], reservations: [] };

async function customer(name) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'P','ACTIVE',NOW(3))", [id, name]);
  return id;
}
async function staff() {
  const id = randomUUID();
  created.staff.push(id);
  await query("INSERT INTO staff_users (id,email,email_normalized,password_hash,first_name,last_name,role,status) VALUES (?,?,?,?,?,?,'ADMIN','ACTIVE')",
    [id, `promo-${id.slice(0, 8)}@x.test`, `promo-${id.slice(0, 8)}@x.test`, 'scrypt$1$1$1$x$x', 'P', 'Staff']);
  return id;
}
async function mkPromo(over = {}) {
  const p = await promotionService.create({
    name: `Promo ${tag} ${created.promotions.length}`,
    discountType: 'PERCENTAGE', discountScope: 'ORDER', discountValue: 1000,
    triggerType: 'CODE_REQUIRED', usageLimitPerCustomer: 1, staffId: created.staff[0], ...over,
  });
  created.promotions.push(p.id);
  await promotionService.update({ id: p.id, status: 'ACTIVE' });
  return p;
}
const line = (over = {}) => ({ lineKey: randomUUID(), productId: randomUUID(), categoryIds: [], collectionIds: [], unitPriceMinor: 100000, quantity: 1, ...over });

async function realOrder(customerId, totalMinor, itemSpecs) {
  const rid = randomUUID();
  created.reservations.push(rid);
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [rid, customerId, `promo:${randomUUID()}`, '0'.repeat(64)]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const grossSubtotal = itemSpecs.reduce((s, it) => s + it.unitPriceMinor * it.quantity, 0);
  const discountMinor = grossSubtotal - totalMinor;
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,discount_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source,placed_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,NULL,?,?, 'PAID','PREPAID','INR', ?,0,?,?,?,0,'{}','{}','PROMO_TEST',NOW(3))`,
    [orderId, `COR-PROMO-${tag}-${created.orders.length}`, customerId, rid,
      grossSubtotal, totalMinor, discountMinor, totalMinor]);
  const items = [];
  for (const it of itemSpecs) {
    const iid = randomUUID();
    await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [iid, orderId, it.productId, it.variantId, it.skuId, 'Item', it.sku, it.quantity, it.unitPriceMinor, it.unitPriceMinor * it.quantity]);
    items.push({ id: iid, skuId: it.skuId, lineKey: it.skuId });
  }
  return { orderId, items };
}

try {
  const s1 = await staff();
  void s1;
  const A = await customer(`A${tag}`);
  const B = await customer(`B${tag}`);
  const realSkus = await query(
    `SELECT s.id, s.sku, v.id variant_id, p.id product_id FROM skus s
       JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE' ORDER BY s.id LIMIT 4`);
  assert.ok(realSkus.length >= 2, 'need 2 ACTIVE skus');
  const skuSpec = (i, unitPriceMinor, quantity = 1) => ({
    skuId: realSkus[i].id, sku: realSkus[i].sku, productId: realSkus[i].product_id, variantId: realSkus[i].variant_id,
    unitPriceMinor, quantity,
  });

  // ============ 1. engine — integer money, cap, floor ============
  assert.equal(engine.rawDiscount({ discountType: 'PERCENTAGE', discountValue: 1500, maxDiscountMinor: null }, 100000), 15000);
  assert.equal(engine.rawDiscount({ discountType: 'PERCENTAGE', discountValue: 3333, maxDiscountMinor: null }, 100000), 33330, 'floor, not round');
  assert.equal(engine.rawDiscount({ discountType: 'PERCENTAGE', discountValue: 5000, maxDiscountMinor: 2000 }, 100000), 2000, 'cap applied');
  assert.equal(engine.rawDiscount({ discountType: 'FIXED_AMOUNT', discountValue: 999999, maxDiscountMinor: null }, 50000), 50000, 'never exceeds base (no negative)');
  results.integerMinorUnits = 'PASS';

  // ============ 2. engine — deterministic line allocation ============
  const alloc = engine.allocateToLines(1000, [
    { lineKey: 'a', unitPriceMinor: 333, quantity: 1 },
    { lineKey: 'b', unitPriceMinor: 333, quantity: 1 },
    { lineKey: 'c', unitPriceMinor: 334, quantity: 1 },
  ]);
  assert.equal(alloc.reduce((s, x) => s + x.discountMinor, 0), 1000, 'allocation sums to the total (remainder assigned)');
  const alloc2 = engine.allocateToLines(1000, [
    { lineKey: 'a', unitPriceMinor: 333, quantity: 1 },
    { lineKey: 'b', unitPriceMinor: 333, quantity: 1 },
    { lineKey: 'c', unitPriceMinor: 334, quantity: 1 },
  ]);
  assert.deepEqual(alloc, alloc2, 'allocation is deterministic');
  results.itemAllocation = 'PASS';

  // ============ 3. engine — stacking + priority + exclusivity ============
  const exclusiveHi = { id: 'p-excl', version: 1, name: 'excl', discountType: 'PERCENTAGE', discountScope: 'ORDER', discountValue: 1000, maxDiscountMinor: null, minSubtotalMinor: 0, minQuantity: 0, eligibleProductIds: [], eligibleCategoryIds: [], eligibleCollectionIds: [], eligibleSegmentId: null, firstOrderOnly: false, stackable: false, priority: 10 };
  const stackA = { ...exclusiveHi, id: 'p-stackA', stackable: true, priority: 20, discountValue: 500 };
  const stackB = { ...exclusiveHi, id: 'p-stackB', stackable: true, priority: 30, discountValue: 500 };
  const ctx = { subtotalMinor: 100000, lines: [{ lineKey: 'l', productId: 'x', categoryIds: [], collectionIds: [], unitPriceMinor: 100000, quantity: 1 }], segmentIds: new Set(), isFirstOrder: true };
  const exclusiveResult = engine.evaluate([stackA, exclusiveHi, stackB], ctx);
  assert.deepEqual(exclusiveResult.appliedPromotions.map((a) => a.promotionId), ['p-excl'], 'highest-priority exclusive wins the whole slot');
  assert.ok(exclusiveResult.rejected.some((r) => r.promotionId === 'p-stackA' && r.reason === 'BLOCKED_BY_EXCLUSIVE'));
  const stackResult = engine.evaluate([stackA, stackB], ctx);
  assert.deepEqual(stackResult.appliedPromotions.map((a) => a.promotionId), ['p-stackA', 'p-stackB'], 'stackables chain in priority order');
  assert.equal(stackResult.totalDiscountMinor, 5000 + Math.floor(95000 * 0.05), 'second stackable applies to the reduced running total');
  results.stacking = 'PASS';

  // ============ 3b. a SCHEDULED promotion can actually be saved ============
  // The admin API validates startsAt/endsAt as ISO-8601 (`z.string().datetime()`,
  // which requires the trailing Z) and the repository handed that literal
  // straight to MySQL, which rejects it for a DATETIME column. Every scheduled
  // promotion created from the CMS returned a 500, so no sale could be given a
  // start or end date at all — only seeds, which write MySQL-shaped literals,
  // ever got dates in. Nothing here passed a date before, which is exactly why
  // it went unseen.
  {
    const startsAt = new Date(Date.now() - 3600_000).toISOString();
    const endsAt = new Date(Date.now() + 7 * 86400_000).toISOString();
    const scheduled = await mkPromo({ startsAt, endsAt });
    const [row] = await query('SELECT starts_at, ends_at FROM promotions WHERE id=?', [scheduled.id]);
    assert(row.starts_at, 'startsAt must persist, not vanish');
    assert(row.ends_at, 'endsAt must persist, not vanish');
    assert.equal(new Date(row.starts_at).getTime(), new Date(startsAt).getTime(), 'startsAt must round-trip exactly');
    assert.equal(new Date(row.ends_at).getTime(), new Date(endsAt).getTime(), 'endsAt must round-trip exactly');

    // The same coercion on the update path.
    const moved = new Date(Date.now() + 14 * 86400_000).toISOString();
    await promotionService.update({ id: scheduled.id, endsAt: moved });
    const [after] = await query('SELECT ends_at FROM promotions WHERE id=?', [scheduled.id]);
    assert.equal(new Date(after.ends_at).getTime(), new Date(moved).getTime(), 'rescheduling must persist too');

    // A junk date is a 400, never an Invalid Date silently stored as NULL.
    await assert.rejects(
      () => promotionService.update({ id: scheduled.id, endsAt: 'not-a-date' }),
      (e) => e.code === 'VALIDATION_ERROR',
      'an unparseable date must be refused, not written as NULL',
    );
    results.scheduledPromotionDates = 'PASS (ISO-8601 startsAt/endsAt round-trip on create + update)';
  }

  // ============ 4. backend-authoritative quote (client amount ignored) ============
  const promo = await mkPromo({ discountValue: 2000, usageLimitPerCustomer: 5 });
  await promotionService.addCoupon({ promotionId: promo.id, code: `SAVE20-${tag}` });
  const q = await promotionService.quote({ customerId: A, subtotalMinor: 100000, lines: [line()], couponCode: `save20-${tag}` });
  assert.equal(q.totalDiscountMinor, 20000, 'server computes 20% of 100000 — a client-sent amount would be irrelevant');
  assert.equal(q.couponCode, `SAVE20-${tag}`.toUpperCase(), 'coupon code normalized upper-case');
  results.backendAuthoritativeDiscount = 'PASS';
  results.coupons = 'PASS';

  // invalid / inactive code
  await assert.rejects(() => promotionService.quote({ customerId: A, subtotalMinor: 100000, lines: [line()], couponCode: 'NOPE' }), (e) => e.code === 'COUPON_INVALID');
  // min subtotal not met
  const minPromo = await mkPromo({ minSubtotalMinor: 500000 });
  await promotionService.addCoupon({ promotionId: minPromo.id, code: `MIN-${tag}` });
  await assert.rejects(() => promotionService.quote({ customerId: A, subtotalMinor: 100000, lines: [line()], couponCode: `MIN-${tag}` }), (e) => e.code === 'COUPON_NOT_ELIGIBLE');

  // ============ 5. global usage-limit race ============
  const scarce = await mkPromo({ usageLimitTotal: 1, usageLimitPerCustomer: 1, discountValue: 1000 });
  await promotionService.addCoupon({ promotionId: scarce.id, code: `LAST1-${tag}` });
  const raceGlobal = await Promise.allSettled([
    promotionService.applyToCheckout({ customerId: A, checkoutId: randomUUID(), subtotalMinor: 100000, lines: [line()], couponCode: `LAST1-${tag}` }),
    promotionService.applyToCheckout({ customerId: B, checkoutId: randomUUID(), subtotalMinor: 100000, lines: [line()], couponCode: `LAST1-${tag}` }),
  ]);
  assert.equal(raceGlobal.filter((r) => r.status === 'fulfilled' && r.value.couponCode).length, 1, 'exactly one customer reserves the last global redemption');
  assert.ok(raceGlobal.some((r) => r.status === 'rejected' && r.reason.code === 'COUPON_LIMIT_REACHED'));
  assert.equal((await query("SELECT COUNT(*) c FROM promotion_redemptions WHERE promotion_id=? AND status='RESERVED'", [scarce.id]))[0].c, 1);
  results.globalLimitRace = 'PASS';

  // ============ 6. per-customer limit race ============
  const perCust = await mkPromo({ usageLimitTotal: null, usageLimitPerCustomer: 1, discountValue: 1000 });
  await promotionService.addCoupon({ promotionId: perCust.id, code: `ONCE-${tag}` });
  const racePer = await Promise.allSettled([
    promotionService.applyToCheckout({ customerId: A, checkoutId: randomUUID(), subtotalMinor: 100000, lines: [line()], couponCode: `ONCE-${tag}` }),
    promotionService.applyToCheckout({ customerId: A, checkoutId: randomUUID(), subtotalMinor: 100000, lines: [line()], couponCode: `ONCE-${tag}` }),
  ]);
  assert.equal(racePer.filter((r) => r.status === 'fulfilled' && r.value.couponCode).length, 1, 'the same customer can only hold one reservation');
  assert.ok(racePer.some((r) => r.status === 'rejected' && r.reason.code === 'COUPON_ALREADY_USED'));
  results.perCustomerLimitRace = 'PASS';

  // ============ 7. release on cancel/payment-fail frees the slot ============
  const heldCheckout = raceGlobal.find((r) => r.status === 'fulfilled' && r.value.couponCode)
    ? (await query("SELECT checkout_id FROM promotion_redemptions WHERE promotion_id=? AND status='RESERVED'", [scarce.id]))[0].checkout_id
    : null;
  await promotionService.releaseCheckout({ checkoutId: heldCheckout, reason: 'PAYMENT_FAILED' });
  assert.equal((await query("SELECT COUNT(*) c FROM promotion_redemptions WHERE promotion_id=? AND status='RESERVED'", [scarce.id]))[0].c, 0);
  const afterRelease = await promotionService.applyToCheckout({ customerId: B, checkoutId: randomUUID(), subtotalMinor: 100000, lines: [line()], couponCode: `LAST1-${tag}` });
  assert.ok(afterRelease.couponCode, 'released slot is reusable by another customer');
  results.paymentFailRelease = 'PASS';

  // ============ 8. RESERVED -> CONSUMED exactly once + order snapshot ============
  const snapPromo = await mkPromo({ discountValue: 1500, discountScope: 'ORDER', usageLimitPerCustomer: 3 });
  await promotionService.addCoupon({ promotionId: snapPromo.id, code: `SNAP-${tag}` });
  const checkoutId = randomUUID();
  const s1specs = [skuSpec(0, 60000), skuSpec(1, 40000)];
  const applied = await promotionService.applyToCheckout({
    customerId: A, checkoutId, subtotalMinor: 100000,
    lines: s1specs.map((it) => line({ lineKey: it.skuId, unitPriceMinor: it.unitPriceMinor })),
    couponCode: `SNAP-${tag}`,
  });
  assert.equal(applied.totalDiscountMinor, 15000);
  const ord = await realOrder(A, 100000 - 15000, s1specs);
  const consume1 = await promotionService.consumeForOrder({ checkoutId, orderId: ord.orderId, context: applied.context, orderItems: ord.items });
  assert.equal(consume1.consumedTotalMinor, 15000);
  const consume2 = await promotionService.consumeForOrder({ checkoutId, orderId: ord.orderId, context: applied.context, orderItems: ord.items });
  assert.equal(consume2.consumedTotalMinor, 0, 'second consume is a no-op — DUPLICATE_REDEMPTION = 0');
  assert.equal((await query("SELECT COUNT(*) c FROM promotion_redemptions WHERE promotion_id=? AND order_id=? AND status='CONSUMED'", [snapPromo.id, ord.orderId]))[0].c, 1);
  results.duplicateRedemption = 0;

  const od = await query('SELECT * FROM order_discounts WHERE order_id=?', [ord.orderId]);
  assert.equal(od.length, 1);
  assert.equal(Number(od[0].discount_total_minor), 15000);
  assert.equal(Number(od[0].promotion_version), applied.appliedPromotions[0].promotionVersion);
  const oid = await query('SELECT * FROM order_item_discounts WHERE order_id=?', [ord.orderId]);
  assert.equal(oid.reduce((s, r) => s + Number(r.discount_minor), 0), 15000, 'per-line allocation sums to the order discount');
  results.orderDiscountSnapshot = 'PASS';

  // ============ 9. snapshot immutable + returns never re-price ============
  await promotionService.update({ id: snapPromo.id, discountValue: 9000 }); // bumps version, big change
  const odAfter = await query('SELECT discount_total_minor, promotion_version FROM order_discounts WHERE order_id=?', [ord.orderId]);
  assert.equal(Number(odAfter[0].discount_total_minor), 15000, 'editing the promo never rewrites a past order');
  const itemsAfter = await query('SELECT line_total_minor FROM order_items WHERE order_id=?', [ord.orderId]);
  assert.equal(itemsAfter.reduce((s, r) => s + Number(r.line_total_minor), 0), 100000, 'order_items keep GROSS line totals; discount lives only in the snapshot');
  const returnsSrc = readFileSync(new URL('../src/modules/returns/refundService.js', import.meta.url), 'utf8');
  assert.ok(!/promotions\/(service|promotionEngine|repository)/.test(returnsSrc), 'refund service does not import the live promotion engine (§116)');
  results.returnRepricingFromCurrentPromo = 0;

  // ============ 10. first-order eligibility from real order truth ============
  const firstOnly = await mkPromo({ firstOrderOnly: true, discountValue: 1000, usageLimitPerCustomer: 5 });
  await promotionService.addCoupon({ promotionId: firstOnly.id, code: `FIRST-${tag}` });
  // A already has a PAID order (ord) -> not first order
  await assert.rejects(() => promotionService.quote({ customerId: A, subtotalMinor: 100000, lines: [line()], couponCode: `FIRST-${tag}` }),
    (e) => e.code === 'COUPON_NOT_ELIGIBLE');
  // B has no orders -> eligible
  const bFirst = await promotionService.quote({ customerId: B, subtotalMinor: 100000, lines: [line()], couponCode: `FIRST-${tag}` });
  assert.equal(bFirst.totalDiscountMinor, 10000);
  results.firstOrderPromotion = 'PASS (from backend order truth)';

  // ============ 11. restore policy is a config seam, not an assumption ============
  assert.equal(promo.restorePolicy ?? (await promotionService.detail(promo.id)).restorePolicy, 'CONFIG_REQUIRED');
  results.couponRestorePolicy = 'CONFIG_REQUIRED';

  // ============ 11b. checkout total folds in the discount (payment stays authoritative) ============
  const { checkoutRepository } = await import('../src/modules/checkout/repository.js');
  const csId = randomUUID();
  const csRes = randomUUID();
  const csCart = randomUUID();
  created.reservations.push(csRes);
  created.carts = created.carts || [];
  created.carts.push(csCart);
  await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [csCart, A, 'INR']);
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'RESERVED', DATE_ADD(NOW(3),INTERVAL 1 DAY))`, [csRes, A, `promo:cs:${randomUUID()}`, '0'.repeat(64)]);
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,items_snapshot,status,currency,subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, '[]', 'READY_FOR_PAYMENT','INR', 100000, 5000, 105000, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [csId, A, csCart, csRes, `promo-cs-${tag}`, 'f'.repeat(64)]);
  await checkoutRepository.applyDiscount(A, csId, { couponCode: `SNAP-${tag}`, discountMinor: 15000, context: { appliedPromotions: [], couponCode: `SNAP-${tag}` } });
  let cs = (await query('SELECT total_minor, discount_minor, coupon_code FROM checkout_sessions WHERE id=?', [csId]))[0];
  assert.equal(Number(cs.total_minor), 100000 + 5000 - 15000, 'total = subtotal + shipping - discount');
  assert.equal(Number(cs.discount_minor), 15000);
  await checkoutRepository.clearDiscount(A, csId);
  cs = (await query('SELECT total_minor, discount_minor, coupon_code FROM checkout_sessions WHERE id=?', [csId]))[0];
  assert.equal(Number(cs.total_minor), 105000);
  assert.equal(Number(cs.discount_minor), 0);
  assert.equal(cs.coupon_code, null);
  await query('DELETE FROM checkout_sessions WHERE id=?', [csId]);
  results.checkoutDiscountFold = 'PASS';

  // ============ 12. RBAC + audit ============
  assert.equal(roleHasPermission('ADMIN', 'promotions.manage'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'promotions.read'), true);
  assert.equal(roleHasPermission('OPERATIONS', 'promotions.manage'), false);
  assert.equal(roleHasPermission('SUPPORT', 'promotions.read'), false);
  assert.equal(roleHasPermission('VIEWER', 'promotions.read'), true);
  const adminRoutesSrc = readFileSync(new URL('../src/modules/promotions/adminRoutes.js', import.meta.url), 'utf8');
  assert.ok(/audit\.log/.test(adminRoutesSrc) && /PROMOTION_CREATED/.test(adminRoutesSrc));
  const engineSrc = readFileSync(new URL('../src/modules/promotions/promotionEngine.js', import.meta.url), 'utf8');
  assert.ok(!/DECIMAL|parseFloat|\.toFixed/.test(engineSrc), 'engine uses integer arithmetic only');
  results.promotionsRbac = 'PASS';
  results.promotionsAudit = 'PASS';

  assert.equal(networkCalls, 0);
  results.realProviderCalls = 0;
  results.promotions = 'PASS';
  results.status = 'PASS';
  console.log('\nPROMOTIONS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nPROMOTIONS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  for (const oid of created.orders) {
    await safe(() => query('DELETE FROM order_item_discounts WHERE order_id=?', [oid]));
    await safe(() => query('DELETE FROM order_discounts WHERE order_id=?', [oid]));
    await safe(() => query('DELETE FROM order_items WHERE order_id=?', [oid]));
    await safe(() => query('DELETE FROM orders WHERE id=?', [oid]));
  }
  for (const ct of (created.carts || [])) await safe(() => query('DELETE FROM checkout_sessions WHERE cart_id=?', [ct]));
  for (const rid of created.reservations) await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [rid]));
  for (const pid of created.promotions) {
    await safe(() => query('DELETE FROM promotion_redemptions WHERE promotion_id=?', [pid]));
    await safe(() => query('DELETE FROM promotion_coupons WHERE promotion_id=?', [pid]));
    await safe(() => query('DELETE FROM promotions WHERE id=?', [pid]));
  }
  for (const ct of (created.carts || [])) await safe(() => query('DELETE FROM carts WHERE id=?', [ct]));
  for (const cid of created.customers) await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
  for (const cid of created.customers) await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  for (const sid of created.staff) await safe(() => query('DELETE FROM staff_users WHERE id=?', [sid]));
  await pool.end();
}
