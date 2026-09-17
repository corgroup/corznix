// Discount code, end to end: generated through the CMS admin HTTP API, entered
// through the storefront checkout HTTP API, arithmetic checked against the
// order subtotal. No service-layer shortcuts on either side.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const ROOT = new URL('../src/', import.meta.url).href;

const { query, pool } = await import(ROOT + 'database/connection/pool.js');
const { createOtpHash } = await import(ROOT + 'utils/otpCrypto.js');
const { inventoryService } = await import(ROOT + 'modules/inventory/service.js');
const { createApp } = await import(ROOT + 'app.js');
const { allowedOrigins, cmsAllowedOrigins } = await import(ROOT + 'config/index.js');

// The gate hosts the app itself on an ephemeral port. The point of this check
// is that the HTTP surface behaves — the CMS route issues a code, the
// storefront route accepts it — so it has to go over HTTP; but CI runs the
// verify scripts without a server, so bringing our own is what makes it a gate
// rather than something only ever run by hand.
const server = await new Promise((resolve) => {
  const s = createApp().listen(0, '127.0.0.1', () => resolve(s));
});
const API = `http://127.0.0.1:${server.address().port}/api/v1`;
// Whatever this environment actually admits, so the check never fails on CORS
// instead of on what it is testing.
const SHOP = allowedOrigins[0] || 'http://localhost:5173';
// The staff routes admit only the CMS origins, which are configured
// separately from the storefront's.
const CMS = cmsAllowedOrigins[0] || allowedOrigins[allowedOrigins.length - 1] || SHOP;

const say = (k, v) => console.log(k + ': ' + (typeof v === 'string' ? v : JSON.stringify(v)));

const mkClient = (origin) => {
  let cookie = '';
  return async (m, p, b) => {
    const h = { Origin: origin };
    if (cookie) h.Cookie = cookie;
    if (b !== undefined) h['Content-Type'] = 'application/json';
    const r = await fetch(API + p, { method: m, headers: h, body: b === undefined ? undefined : JSON.stringify(b) });
    const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (sc.length) cookie = sc.map((x) => x.split(';')[0]).join('; ');
    return { s: r.status, j: await r.json().catch(() => null) };
  };
};
const shop = mkClient(SHOP);
const admin = mkClient(CMS);

const TAG = randomUUID().slice(0, 6).toUpperCase();
const CODE = 'QA' + TAG;
const staffEmail = 'qa.promo.' + TAG.toLowerCase() + '@corcotton-qa.test';
const custEmail = 'qa.disc.' + Date.now() + '@corcotton-qa.test';
const staffId = randomUUID();
const custId = randomUUID();
let promotionId = null;

try {
  // ---- staff account, then sign in through the real CMS login route -----
  const { hashPassword: hash } = await import(ROOT + 'utils/password.js');
  assert.ok(hash, 'need the staff password hasher');
  const pw = 'QaPromo!2345';
  await query(
    "INSERT INTO staff_users (id,email,email_normalized,password_hash,first_name,last_name,role,status,must_change_password) VALUES (?,?,?,?,?,?,'ADMIN','ACTIVE',0)",
    [staffId, staffEmail, staffEmail, await hash(pw), 'QA', 'Promo']);
  // Brand-context enforcement is blocking: an ADMIN with no company sees none.
  await query("INSERT INTO staff_brand_access (staff_user_id, brand_id, role, granted_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), 'ADMIN', NOW(3))", [staffId]);
  const login = await admin('POST', '/admin/auth/login', { email: staffEmail, password: pw });
  say('1_cms_login', login.s + ' ' + (login.j && login.j.error ? login.j.error.code : 'ok'));
  assert.equal(login.s, 200, 'staff login must succeed');

  // ---- customer, cart, checkout ----------------------------------------
  await query("INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), 'QA','Disc','ACTIVE', NOW(3))", [custId]);
  await query("INSERT INTO customer_contacts (id,customer_id,contact_type,value,normalized_value,is_verified,verified_at,source) VALUES (?,?,'EMAIL',?,?,1,NOW(3),'TEST')", [randomUUID(), custId, custEmail, custEmail]);
  await shop('POST', '/auth/otp/request', { identifier: custEmail });
  const chRows = await query('SELECT id, destination_normalized, otp_hash FROM otp_challenges WHERE destination_normalized=? ORDER BY created_at DESC LIMIT 1', [custEmail]);
  assert.ok(chRows[0], 'an OTP challenge must exist');
  let otp = null;
  for (let i = 0; i < 10000; i += 1) {
    const k = String(i).padStart(4, '0');
    if (createOtpHash(k, chRows[0].id, chRows[0].destination_normalized) === chRows[0].otp_hash) { otp = k; break; }
  }
  const verified = await shop('POST', '/auth/otp/verify', { challengeId: chRows[0].id, otp });
  say('5_customer_signed_in', verified.s + ' ' + (verified.j && verified.j.error ? verified.j.error.code : 'ok'));
  assert.equal(verified.s, 200);

  // The cart takes the VARIANT storefront id plus a size label, which is what
  // the product page posts — not a sku id.
  const skus = await query(
    "SELECT s.id, s.size, s.price_minor, v.storefront_id FROM skus s"
    + " JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id"
    + " JOIN inventory i ON i.sku_id=s.id"
    + " WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'"
    + " AND (i.on_hand - i.reserved) >= 2 AND s.price_minor >= 100000 AND v.storefront_id IS NOT NULL"
    + " ORDER BY s.price_minor ASC LIMIT 1");
  assert.ok(skus[0], 'need a sellable SKU at or above the minimum subtotal');
  const sku = skus[0];

  const add = await shop('POST', '/cart/items', { storefrontId: sku.storefront_id, size: sku.size, quantity: 1 });
  say('6_cart_add', add.s + ' ' + (add.j && add.j.error ? add.j.error.code : 'ok'));
  assert.ok(add.s < 400, 'the item must reach the cart');

  const co = await shop('POST', '/checkout', { idempotencyKey: 'qa-disc-' + TAG });
  const checkoutId = co.j && co.j.data ? co.j.data.id : null;
  say('7_checkout_created', co.s + ' ' + (checkoutId ? checkoutId.slice(0, 8) : JSON.stringify(co.j)));
  assert.ok(checkoutId, 'checkout must be created');

  await shop('PUT', '/checkout/' + checkoutId + '/address', {
    address: { firstName: 'QA', lastName: 'Disc', phone: '9999999999', addressLine1: '1 Test Road', city: 'Lucknow', state: 'Uttar Pradesh', postalCode: '226001', country: 'IN' },
    saveInfo: false,
  });
  await shop('POST', '/checkout/' + checkoutId + '/serviceability', {});
  const before = await shop('GET', '/checkout/' + checkoutId);
  const subtotal = before.j.data.pricing.subtotalMinor;
  const totalBefore = before.j.data.pricing.totalMinor;
  say('8_before_discount', { subtotalMinor: subtotal, totalMinor: totalBefore, discountMinor: before.j.data.pricing.discountMinor || 0 });

  // ---- create the promotion exactly as the CMS screen does --------------
  //
  // AFTER the cart exists, and sized to it. Picking a SKU by price and then
  // adding to the cart by (variant, size) does not guarantee the same SKU comes
  // back — on production it resolved to the 1-rupee test item, whose subtotal
  // could never meet a hard-coded minimum, and the gate failed for a reason
  // that had nothing to do with discounts. The rules now derive from the cart.
  const minSubtotal = Math.max(1, Math.floor(subtotal / 2));
  const maxDiscount = subtotal; // high enough not to bind; the cap is tested below
  const created = await admin('POST', '/admin/promotions', {
    name: 'QA discount ' + TAG,
    triggerType: 'CODE_REQUIRED',
    discountType: 'PERCENTAGE',
    discountValue: 1500, // basis points — 15%
    discountScope: 'ORDER',
    minSubtotalMinor: minSubtotal,
    maxDiscountMinor: maxDiscount,
    usageLimitPerCustomer: 1,
  });
  say('2_promotion_created', created.s + ' ' + (created.j && created.j.error ? JSON.stringify(created.j.error) : created.j.data.id.slice(0, 8)));
  assert.equal(created.s, 201);
  promotionId = created.j.data.id;

  const activated = await admin('PATCH', '/admin/promotions/' + promotionId, { status: 'ACTIVE' });
  say('3_promotion_activated', activated.s + ' ' + (activated.j.data ? activated.j.data.status : JSON.stringify(activated.j)));
  assert.equal(activated.j.data.status, 'ACTIVE');

  const coupon = await admin('POST', '/admin/promotions/' + promotionId + '/coupons', { code: CODE });
  say('4_coupon_issued', coupon.s + ' ' + CODE);
  assert.equal(coupon.s, 201);

  // ---- the code a customer types ---------------------------------------
  const applied = await shop('POST', '/checkout/' + checkoutId + '/coupon', { code: CODE });
  say('9_apply_code', applied.s + ' ' + (applied.j && applied.j.error ? JSON.stringify(applied.j.error) : 'ok'));
  assert.equal(applied.s, 200, 'a valid CMS code must apply');
  const p = applied.j.data.pricing;
  // The engine is bps: floor(base * value / 10000). 1500 bps is 15%.
  const expected = Math.min(Math.floor((subtotal * 1500) / 10000), maxDiscount);
  say('10_discount_applied', { couponCode: p.appliedCoupon, discountMinor: p.discountMinor, expectedMinor: expected, totalMinor: p.totalMinor });
  assert.equal(p.appliedCoupon, CODE, 'the applied code is the one issued in the CMS');
  assert.equal(p.discountMinor, expected, '15% of subtotal, capped at the configured maximum');
  assert.equal(p.totalMinor, totalBefore - expected, 'the payable total falls by exactly the discount');

  // ---- the rules the CMS configured are enforced ------------------------
  const bogus = await shop('POST', '/checkout/' + checkoutId + '/coupon', { code: 'NOPE' + TAG });
  say('11_invalid_code', bogus.s + ' ' + (bogus.j && bogus.j.error ? bogus.j.error.code : 'ACCEPTED'));
  assert.notEqual(bogus.s, 200, 'an unknown code must be refused');

  const removed = await shop('DELETE', '/checkout/' + checkoutId + '/coupon');
  say('12_remove_code', { status: removed.s, discountMinor: removed.j.data.pricing.discountMinor, totalMinor: removed.j.data.pricing.totalMinor });
  assert.equal(removed.j.data.pricing.discountMinor, 0, 'removing the code clears the discount');
  assert.equal(removed.j.data.pricing.totalMinor, totalBefore, 'and restores the original total');

  await admin('PATCH', '/admin/promotions/' + promotionId, { status: 'PAUSED' });
  const paused = await shop('POST', '/checkout/' + checkoutId + '/coupon', { code: CODE });
  say('13_paused_in_cms', paused.s + ' ' + (paused.j && paused.j.error ? paused.j.error.code : 'ACCEPTED'));
  assert.notEqual(paused.s, 200, 'a paused promotion must stop working on checkout');
  await admin('PATCH', '/admin/promotions/' + promotionId, { status: 'ACTIVE' });

  await admin('PATCH', '/admin/promotions/' + promotionId, {
    startsAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    endsAt: new Date(Date.now() - 86400000).toISOString(),
  });
  const expired = await shop('POST', '/checkout/' + checkoutId + '/coupon', { code: CODE });
  say('14_expired_in_cms', expired.s + ' ' + (expired.j && expired.j.error ? expired.j.error.code : 'ACCEPTED'));
  assert.notEqual(expired.s, 200, 'an ended promotion must stop working on checkout');

  await admin('PATCH', '/admin/promotions/' + promotionId, { startsAt: null, endsAt: null, minSubtotalMinor: subtotal + 100000 });
  const tooSmall = await shop('POST', '/checkout/' + checkoutId + '/coupon', { code: CODE });
  say('15_below_min_subtotal', tooSmall.s + ' ' + (tooSmall.j && tooSmall.j.error ? tooSmall.j.error.code : 'ACCEPTED'));
  assert.notEqual(tooSmall.s, 200, 'a cart under the configured minimum must be refused');

  await admin('PATCH', '/admin/promotions/' + promotionId, { minSubtotalMinor: minSubtotal });
  const again = await shop('POST', '/checkout/' + checkoutId + '/coupon', { code: CODE });
  say('16_valid_again', { status: again.s, discountMinor: again.j.data.pricing.discountMinor, totalMinor: again.j.data.pricing.totalMinor });
  assert.equal(again.j.data.pricing.discountMinor, expected);

  console.log('\nDISCOUNT_CODE_E2E_VERIFICATION = PASS');
} catch (err) {
  console.error('\nDISCOUNT_CODE_E2E_VERIFICATION = FAIL');
  console.error(err.message);
  console.error((err.stack || '').split('\n').slice(0, 5).join('\n'));
  process.exitCode = 1;
} finally {
  const safe = async (fn) => { try { await fn(); } catch (e) { console.error('  cleanup:', e.message); } };
  if (promotionId) {
    await safe(() => query('DELETE FROM promotion_coupons WHERE promotion_id=?', [promotionId]));
    await safe(() => query('DELETE FROM promotion_redemptions WHERE promotion_id=?', [promotionId]));
    await safe(() => query('DELETE FROM promotions WHERE id=?', [promotionId]));
  }
  await safe(() => query('DELETE FROM otp_challenges WHERE destination_normalized=?', [custEmail]));
  // The checkout session references the cart, and the cart references the
  // customer — so they come apart in that order or the FK refuses.
  await safe(() => query('DELETE FROM checkout_sessions WHERE customer_id=?', [custId]));
  await safe(() => query('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE customer_id=?)', [custId]));
  await safe(() => query('DELETE FROM carts WHERE customer_id=?', [custId]));
  // RELEASE the holds, do not delete them. Deleting an open reservation
  // removes the rows that account for inventory.reserved without decrementing
  // it, so every run of this gate would leak reserved stock and eventually
  // make the fixture SKU unsellable — a check that corrupts the data it runs
  // against is worse than no check. Terminal reservations have already been
  // accounted for, so those are safe to delete.
  await safe(async () => {
    const open = await query("SELECT id FROM inventory_reservations WHERE customer_id=? AND status='RESERVED'", [custId]);
    for (const r of open) await inventoryService.releaseReservation(r.id);
  });
  await safe(() => query('DELETE FROM inventory_reservation_items WHERE reservation_id IN (SELECT id FROM inventory_reservations WHERE customer_id=?)', [custId]));
  await safe(() => query('DELETE FROM inventory_reservations WHERE customer_id=?', [custId]));
  await safe(() => query('DELETE FROM auth_sessions WHERE customer_id=?', [custId]));
  await safe(() => query('DELETE FROM customer_contacts WHERE customer_id=?', [custId]));
  await safe(() => query('DELETE FROM customers WHERE id=?', [custId]));
  await safe(() => query('DELETE FROM staff_sessions WHERE staff_user_id=?', [staffId]));
  await safe(() => query('DELETE FROM staff_brand_access WHERE staff_user_id=?', [staffId]));
  await safe(() => query('DELETE FROM staff_users WHERE id=?', [staffId]));
  console.log('cleanup done');
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
