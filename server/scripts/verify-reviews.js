// Wave 8G-4 — product reviews + moderation.
//
// Verified-purchase is backend-computed from a DELIVERED order item owned by
// the reviewer (never client-asserted); one review per delivered order item;
// rating 1-5 integer; concurrent-submit race → DUPLICATE_REVIEWS = 0;
// moderation moves status only and NEVER rewrites the customer's text
// (ORIGINAL_REVIEW_SILENT_REWRITE = 0); publish-vs-reject race resolved by
// status_version (one winner); only PUBLISHED reviews reach the public PDP
// (PUBLIC_PENDING_REVIEW_LEAK = 0); aggregate recomputed from PUBLISHED only;
// RBAC + audit wiring. No provider / network calls.
//
//   npm run verify:reviews
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

process.env.ORDER_FINALIZATION_WORKER_ENABLED = 'false';
process.env.FULFILLMENT_RECOVERY_WORKER_ENABLED = 'false';
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { roleHasPermission } = await import('../src/modules/staff/permissions.js');
const { fulfillmentService } = await import('../src/modules/fulfillment/service.js');
const { reviewService } = await import('../src/modules/reviews/service.js');
const { reviewAdminService } = await import('../src/modules/reviews/adminService.js');

const realFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = (...a) => { networkCalls += 1; return realFetch?.(...a); };

const results = {};
const tag = randomUUID().slice(0, 8);
const created = { orders: [], customers: [], staff: [] };

// One ACTIVE sku per DISTINCT product. Review eligibility is per PRODUCT, so
// two skus of the same product are the same subject: the delivered order in
// test 1 would make test 3's "undelivered" product eligible and the suite
// would fail on which sizes happened to sort first, not on the code.
async function skus(n) {
  return query(
    `SELECT MIN(s.id) id, MIN(s.sku) sku, MIN(s.price_minor) price_minor,
            MIN(v.id) variant_id, p.id product_id, MIN(p.name) name
       FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id
      WHERE s.status='ACTIVE'
      GROUP BY p.id
      ORDER BY p.id LIMIT ${Number(n)}`);
}
async function customer(name) {
  const id = randomUUID();
  created.customers.push(id);
  await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,'T','ACTIVE',NOW(3))", [id, name]);
  return id;
}
async function staff(role = 'CATALOG_MANAGER') {
  const id = randomUUID();
  created.staff.push(id);
  await query("INSERT INTO staff_users (id,email,email_normalized,password_hash,first_name,last_name,role,status) VALUES (?,?,?,?,?,?,?,'ACTIVE')",
    [id, `rev-${id.slice(0, 8)}@x.test`, `rev-${id.slice(0, 8)}@x.test`, 'scrypt$1$1$1$x$x', 'R', role, role]);
  return id;
}

async function order({ customerId, sku, qty = 1, deliver = true }) {
  let cartId = (await query('SELECT id FROM carts WHERE customer_id=? LIMIT 1', [customerId]))[0]?.id;
  if (!cartId) { cartId = randomUUID(); await query('INSERT INTO carts (id, brand_id,customer_id,currency) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?)', [cartId, customerId, 'INR']); }
  const reservationId = randomUUID();
  await query(`INSERT INTO inventory_reservations (id, brand_id, customer_id,idempotency_key,request_fingerprint,status,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?,?,?, 'CONSUMED', DATE_ADD(NOW(3), INTERVAL 1 DAY))`, [reservationId, customerId, `rv:${randomUUID()}`, '0'.repeat(64)]);
  const def = (await query('SELECT id FROM warehouses WHERE is_default=1 LIMIT 1'))[0];
  await query('INSERT INTO inventory_reservation_items (id,reservation_id,warehouse_id,sku_id,quantity) VALUES (?,?,?,?,?)',
    [randomUUID(), reservationId, def.id, sku.id, qty]);
  const unit = Number(sku.price_minor || 50000);
  const subtotal = unit * qty;
  const checkoutId = randomUUID();
  await query(`INSERT INTO checkout_sessions (id, brand_id,customer_id,cart_id,inventory_reservation_id,idempotency_key,cart_fingerprint,status,currency,
       subtotal_minor,shipping_minor,total_minor,reservation_expires_at,expires_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?,?, 'FINALIZED','INR', ?,0,?, DATE_ADD(NOW(3),INTERVAL 1 DAY), DATE_ADD(NOW(3),INTERVAL 1 DAY))`,
    [checkoutId, customerId, cartId, reservationId, `rv:co:${randomUUID()}`, 'f'.repeat(64), subtotal, subtotal]);
  const orderId = randomUUID();
  created.orders.push(orderId);
  const address = { firstName: 'RV', lastName: 'T', phone: '9999999999', addressLine1: '1 Rd', city: 'Lucknow', state: 'UP', postalCode: '226001', country: 'IN' };
  await query(`INSERT INTO orders (id, brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,
       subtotal_minor,shipping_minor,total_minor,online_paid_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,?, 'PAID','PREPAID','INR', ?,0,?,?,0,?,?, 'RV_TEST')`,
    [orderId, `COR-RV-${tag}-${created.orders.length}`, checkoutId, customerId, reservationId,
      subtotal, subtotal, subtotal, JSON.stringify(address), JSON.stringify({ serviceLevel: 'STANDARD' })]);
  const orderItemId = randomUUID();
  await query(`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,quantity,unit_price_minor,line_total_minor)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [orderItemId, orderId, sku.product_id, sku.variant_id, sku.id, sku.name, sku.sku, qty, unit, subtotal]);
  await fulfillmentService.ensureForOrder(orderId);
  if (deliver) {
    const deliveredAt = new Date(Date.now() - 86400000);
    await query(`UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id
        SET s.status='DELIVERED', s.delivered_at=?, s.booking_status='BOOKED', s.provider_code='MOCK',
            s.external_shipment_id=?, s.tracking_number=?, s.booked_at=? WHERE f.order_id=?`,
      [deliveredAt, `EXT-${randomUUID().slice(0, 8)}`, `AWB-${randomUUID().slice(0, 8)}`, deliveredAt, orderId]);
  }
  return { orderId, orderItemId, productId: sku.product_id, unit };
}

try {
  const [sku1, sku2] = await skus(2);
  assert.ok(sku2, 'need ACTIVE skus on 2 distinct products');
  assert.notEqual(sku1.product_id, sku2.product_id, 'the two skus must belong to different products');
  const A = await customer('RevAlice');
  const B = await customer('RevBob');
  const mod = await staff('CATALOG_MANAGER');

  // ============ 1. eligibility — delivered owned item ============
  const oA = await order({ customerId: A, sku: sku1 });
  const elig = await reviewService.eligibility({ customerId: A, productId: sku1.product_id });
  assert.equal(elig.canReview, true);
  assert.ok(elig.eligibleOrderItems.some((i) => i.orderItemId === oA.orderItemId));
  results.eligibilityDelivered = 'PASS';

  // ============ 2. non-purchaser denied ============
  await assert.rejects(
    () => reviewService.submit({ customerId: B, orderItemId: oA.orderItemId, rating: 5, body: 'not my purchase' }),
    (e) => e.code === 'REVIEW_NOT_ELIGIBLE');
  results.nonPurchaserDenied = 'DENIED';
  results.fakeVerifiedPurchase = 0;

  // ============ 3. undelivered denied ============
  const oUndelivered = await order({ customerId: A, sku: sku2, deliver: false });
  const eligU = await reviewService.eligibility({ customerId: A, productId: sku2.product_id });
  assert.equal(eligU.canReview, false, 'undelivered item is not eligible');
  await assert.rejects(
    () => reviewService.submit({ customerId: A, orderItemId: oUndelivered.orderItemId, rating: 4, body: 'too soon' }),
    (e) => e.code === 'REVIEW_NOT_ELIGIBLE');
  results.undeliveredDenied = 'DENIED';

  // ============ 4. rating validation ============
  for (const bad of [0, 6, 3.5, -1]) {
    await assert.rejects(
      () => reviewService.submit({ customerId: A, orderItemId: oA.orderItemId, rating: bad, body: 'valid body here' }),
      (e) => e.code === 'VALIDATION_ERROR', `rating ${bad} rejected`);
  }
  await assert.rejects(
    () => reviewService.submit({ customerId: A, orderItemId: oA.orderItemId, rating: 4, body: 'x' }),
    (e) => e.code === 'VALIDATION_ERROR', 'too-short body rejected');
  results.ratingValidation = 'PASS';

  // ============ 5. submit — PENDING + verified badge ============
  const r1 = await reviewService.submit({ customerId: A, orderItemId: oA.orderItemId, rating: 4, title: 'Solid', body: 'Comfortable and well made.' });
  assert.equal(r1.status, 'PENDING');
  assert.equal(r1.verifiedPurchase, true, 'verified-purchase badge computed by backend');
  results.submitPending = 'PASS';
  results.verifiedPurchaseBadge = 'PASS';

  // not visible on the public PDP while PENDING
  let pub = await reviewService.publicForProduct(sku1.product_id);
  assert.equal(pub.reviews.length, 0, 'PENDING review not on public PDP');
  assert.equal(pub.summary.count, 0);

  // ============ 6. duplicate-submit race ============
  const oDup = await order({ customerId: B, sku: sku1 });
  const race = await Promise.allSettled([
    reviewService.submit({ customerId: B, orderItemId: oDup.orderItemId, rating: 5, body: 'first attempt body' }),
    reviewService.submit({ customerId: B, orderItemId: oDup.orderItemId, rating: 3, body: 'second attempt body' }),
  ]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one concurrent submit wins');
  assert.ok(race.some((r) => r.status === 'rejected' && r.reason.code === 'REVIEW_ALREADY_EXISTS'));
  const dupCount = (await query('SELECT COUNT(*) c FROM product_reviews WHERE order_item_id=?', [oDup.orderItemId]))[0].c;
  assert.equal(dupCount, 1, 'DUPLICATE_REVIEWS = 0');
  results.duplicateSubmitRace = 'PASS';
  results.duplicateReviews = 0;

  // sequential duplicate also rejected
  await assert.rejects(
    () => reviewService.submit({ customerId: A, orderItemId: oA.orderItemId, rating: 2, body: 'trying again later' }),
    (e) => e.code === 'REVIEW_ALREADY_EXISTS');

  // ============ 7. moderation — publish (status only, text immutable) ============
  const full = (await query('SELECT * FROM product_reviews WHERE id=?', [r1.id]))[0];
  const bodyBefore = full.body;
  const titleBefore = full.title;
  const detail1 = await reviewAdminService.detail(r1.id);
  const pubResult = await reviewAdminService.moderate({ reviewId: r1.id, action: 'PUBLISH', reason: 'looks good', expectedVersion: detail1.statusVersion, staffId: mod });
  assert.equal(pubResult.status, 'PUBLISHED');
  const afterPub = (await query('SELECT * FROM product_reviews WHERE id=?', [r1.id]))[0];
  assert.equal(afterPub.body, bodyBefore, 'ORIGINAL_REVIEW_SILENT_REWRITE = 0 (body)');
  assert.equal(afterPub.title, titleBefore, 'ORIGINAL_REVIEW_SILENT_REWRITE = 0 (title)');
  assert.ok(afterPub.published_at, 'published_at set');
  const evs = await query("SELECT event_type FROM product_review_events WHERE review_id=?", [r1.id]);
  assert.ok(evs.some((e) => e.event_type === 'REVIEW_SUBMITTED'));
  assert.ok(evs.some((e) => e.event_type === 'REVIEW_PUBLISHED'));
  results.moderationPublish = 'PASS';
  results.originalReviewSilentRewrite = 0;

  // now visible publicly
  pub = await reviewService.publicForProduct(sku1.product_id);
  assert.equal(pub.reviews.length, 1);
  assert.equal(pub.reviews[0].body, bodyBefore);
  assert.equal(pub.reviews[0].verifiedPurchase, true);
  assert.equal(pub.summary.count, 1);
  assert.equal(pub.summary.average, 4);

  // ============ 8. moderation race — status_version compare-and-set ============
  const oC = await order({ customerId: A, sku: sku2 });
  await query(`UPDATE shipments s JOIN fulfillments f ON f.id=s.fulfillment_id SET s.status='DELIVERED', s.delivered_at=? WHERE f.order_id=?`,
    [new Date(Date.now() - 3600000), oC.orderId]);
  const r2 = await reviewService.submit({ customerId: A, orderItemId: oC.orderItemId, rating: 2, body: 'Not what I expected at all.' });
  const d2 = await reviewAdminService.detail(r2.id);
  const modRace = await Promise.allSettled([
    reviewAdminService.moderate({ reviewId: r2.id, action: 'PUBLISH', expectedVersion: d2.statusVersion, staffId: mod }),
    reviewAdminService.moderate({ reviewId: r2.id, action: 'REJECT', reason: 'spam', expectedVersion: d2.statusVersion, staffId: mod }),
  ]);
  assert.equal(modRace.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one concurrent moderation wins');
  assert.equal(modRace.find((r) => r.status === 'rejected').reason.code, 'REVIEW_MODERATION_CONFLICT');
  results.moderationRace = 'PASS';

  // ============ 9. public PDP never leaks non-PUBLISHED ============
  await reviewAdminService.rebuildAggregates();
  const r2now = (await query('SELECT status FROM product_reviews WHERE id=?', [r2.id]))[0].status;
  const pub2 = await reviewService.publicForProduct(sku2.product_id);
  const leaked = pub2.reviews.length > 0 && r2now !== 'PUBLISHED';
  assert.equal(leaked && pub2.summary.count > (r2now === 'PUBLISHED' ? 0 : 0) ? 1 : 0, 0);
  // stronger: query all non-published for this product, assert none appear
  const nonPublished = await query("SELECT id, body FROM product_reviews WHERE product_id=? AND status <> 'PUBLISHED'", [sku2.product_id]);
  for (const np of nonPublished) {
    assert.ok(!pub2.reviews.some((rr) => rr.body === np.body), `PUBLIC_PENDING_REVIEW_LEAK = 0 (${np.id})`);
  }
  results.publicPendingReviewLeak = 0;

  // ============ 10. aggregate recompute (PUBLISHED only, integer bps) ============
  // publish r2 if it was rejected in the race, else it's already published
  if (r2now !== 'PUBLISHED') {
    const d2b = await reviewAdminService.detail(r2.id);
    if (d2b.status !== 'PUBLISHED') {
      await reviewAdminService.moderate({ reviewId: r2.id, action: 'PUBLISH', expectedVersion: d2b.statusVersion, staffId: mod });
    }
  }
  let agg = (await query('SELECT * FROM product_rating_aggregates WHERE product_id=?', [sku2.product_id]))[0];
  assert.equal(Number(agg.review_count), 1);
  assert.equal(Number(agg.rating_sum), 2);
  assert.equal(Number(agg.average_bps), 20000, 'average_bps = 2.0 * 10000');

  // hide it → aggregate drops to zero
  const d2c = await reviewAdminService.detail(r2.id);
  await reviewAdminService.moderate({ reviewId: r2.id, action: 'HIDE', reason: 'temp', expectedVersion: d2c.statusVersion, staffId: mod });
  agg = (await query('SELECT * FROM product_rating_aggregates WHERE product_id=?', [sku2.product_id]))[0];
  assert.equal(Number(agg.review_count), 0, 'HIDE removes the review from the aggregate');
  assert.equal(Number(agg.average_bps), 0);
  const pub3 = await reviewService.publicForProduct(sku2.product_id);
  assert.equal(pub3.reviews.length, 0, 'hidden review not on PDP');
  assert.equal(pub3.summary.average, null);
  results.aggregateRecompute = 'PASS';

  // ============ 11. customer ownership — myReviews ============
  const aMine = await reviewService.myReviews(A);
  const bMine = await reviewService.myReviews(B);
  assert.ok(aMine.every((r) => r.id !== undefined));
  assert.ok(!aMine.some((r) => bMine.some((br) => br.id === r.id)), 'no cross-customer review bleed');
  assert.ok(bMine.length >= 1 && aMine.length >= 2);
  results.customerOwnership = 'PASS';

  // ============ 12. RBAC + audit + no-rewrite source guard ============
  assert.equal(roleHasPermission('SUPER_ADMIN', 'reviews.moderate'), true);
  assert.equal(roleHasPermission('ADMIN', 'reviews.moderate'), true);
  assert.equal(roleHasPermission('CATALOG_MANAGER', 'reviews.moderate'), true);
  assert.equal(roleHasPermission('SUPPORT', 'reviews.moderate'), false);
  assert.equal(roleHasPermission('SUPPORT', 'reviews.read'), true);
  assert.equal(roleHasPermission('VIEWER', 'reviews.read'), true);
  assert.equal(roleHasPermission('VIEWER', 'reviews.moderate'), false);
  const adminRoutesSrc = readFileSync(new URL('../src/modules/reviews/adminRoutes.js', import.meta.url), 'utf8');
  assert.ok(/audit\.log/.test(adminRoutesSrc) && /REVIEW_MODERATED/.test(adminRoutesSrc), 'admin review actions are audited');
  const repoSrc = readFileSync(new URL('../src/modules/reviews/repository.js', import.meta.url), 'utf8');
  assert.ok(!/UPDATE product_reviews[\s\S]*?\bSET\b[\s\S]*?\bbody\s*=/.test(repoSrc), 'no UPDATE ... SET body on product_reviews (§72)');
  assert.ok(!/UPDATE product_reviews[\s\S]*?\bSET\b[\s\S]*?\btitle\s*=/.test(repoSrc), 'no UPDATE ... SET title on product_reviews (§72)');
  const adminSvcSrc = readFileSync(new URL('../src/modules/reviews/adminService.js', import.meta.url), 'utf8');
  assert.ok(/status_version/.test(adminSvcSrc), 'moderation is guarded by status_version');
  results.reviewsRbac = 'PASS';
  results.reviewsAudit = 'PASS';

  assert.equal(networkCalls, 0);
  results.realProviderCalls = 0;
  results.status = 'PASS';
  console.log('\nREVIEWS_VERIFICATION = PASS');
  console.log(JSON.stringify(results, null, 2));
} catch (err) {
  console.error('\nREVIEWS_VERIFICATION = FAIL');
  console.error(err);
  process.exitCode = 1;
} finally {
  globalThis.fetch = realFetch;
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  // Capture every product touched BEFORE deleting order_items, so the
  // materialized aggregate can be recomputed back to a true (zero) state.
  const touchedProducts = new Set();
  for (const orderId of created.orders) {
    const pids = await query('SELECT DISTINCT product_id FROM order_items WHERE order_id=?', [orderId]).catch(() => []);
    for (const p of pids) touchedProducts.add(p.product_id);
  }
  for (const orderId of created.orders) {
    await safe(() => query('DELETE pe FROM product_review_events pe JOIN product_reviews pr ON pr.id=pe.review_id JOIN order_items oi ON oi.id=pr.order_item_id WHERE oi.order_id=?', [orderId]));
    await safe(() => query('DELETE pr FROM product_reviews pr JOIN order_items oi ON oi.id=pr.order_item_id WHERE oi.order_id=?', [orderId]));
    await safe(() => query('DELETE se FROM shipment_events se JOIN shipments s ON s.id=se.shipment_id JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE s FROM shipments s JOIN fulfillments f ON f.id=s.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fe FROM fulfillment_events fe JOIN fulfillments f ON f.id=fe.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE fi FROM fulfillment_items fi JOIN fulfillments f ON f.id=fi.fulfillment_id WHERE f.order_id=?', [orderId]));
    await safe(() => query('DELETE FROM fulfillments WHERE order_id=?', [orderId]));
    await safe(() => query('DELETE FROM order_items WHERE order_id=?', [orderId]));
    const chk = (await query('SELECT checkout_id, inventory_reservation_id FROM orders WHERE id=?', [orderId]))[0];
    await safe(() => query('DELETE FROM orders WHERE id=?', [orderId]));
    if (chk) {
      await safe(() => query('DELETE FROM checkout_sessions WHERE id=?', [chk.checkout_id]));
      await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id=?', [chk.inventory_reservation_id]));
      await safe(() => query('DELETE FROM inventory_reservations WHERE id=?', [chk.inventory_reservation_id]));
    }
  }
  for (const cid of created.customers) {
    await safe(() => query('DELETE FROM carts WHERE customer_id=?', [cid]));
    await safe(() => query('DELETE FROM customers WHERE id=?', [cid]));
  }
  for (const id of created.staff) await safe(() => query('DELETE FROM staff_users WHERE id=?', [id]));
  // Recompute every aggregate we perturbed from the (now review-free) truth.
  const { reviewRepository } = await import('../src/modules/reviews/repository.js');
  const { withTransaction } = await import('../src/database/connection/transaction.js');
  for (const pid of touchedProducts) {
    await safe(() => withTransaction((tx) => reviewRepository.recomputeAggregate(tx, pid)));
    await safe(() => query('DELETE FROM product_rating_aggregates WHERE product_id=? AND review_count=0', [pid]));
  }
  await pool.end();
}
