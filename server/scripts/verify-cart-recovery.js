// The "Return to Cart" link in abandoned-cart marketing, end to end.
//
// What this exists to stop reaching a customer:
//   * the reminder pointing at a shared /cart URL that is empty when the
//     recipient is signed out (what it did before migration 118);
//   * a forwarded or guessed link touching somebody else's cart;
//   * a restore that brings back a different variant, or the price the item
//     had at abandonment rather than the price it has now.
//
// Drives the real CartRecoveryService against the real database with the real
// CartService. Everything it creates is removed again.
//
//   npm run verify:cart-recovery
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { pool, query } = await import('../src/database/connection/pool.js');
const { cartService } = await import('../src/modules/cart/service.js');
const { cartRecoveryService } = await import('../src/modules/cart/recoveryService.js');
const { storefrontBaseUrl } = await import('../src/config/index.js');
const { readFileSync, readdirSync, statSync } = await import('node:fs');
const path = await import('node:path');
const { fileURLToPath } = await import('node:url');

const results = {};
const pass = (n, d) => { results[n] = d ? `PASS (${d})` : 'PASS'; console.log(`  PASS  ${n}${d ? ` — ${d}` : ''}`); };
const one = async (sql, p) => (await query(sql, p))[0];

const customerId = randomUUID();
const strangerId = randomUUID();

async function cleanup() {
  for (const id of [customerId, strangerId]) {
    await query('DELETE FROM cart_recovery_tokens WHERE customer_id = ?', [id]).catch(() => {});
    await query('DELETE FROM cart_items WHERE cart_id IN (SELECT id FROM carts WHERE customer_id = ?)', [id]).catch(() => {});
    await query('DELETE FROM carts WHERE customer_id = ?', [id]).catch(() => {});
    await query('DELETE FROM customers WHERE id = ?', [id]).catch(() => {});
  }
}

try {
  // A stocked, active SKU. Preferring one that has an ACTIVE IMAGE row lets
  // the image assertion below be meaningful; the CI seed has no product
  // photography, so its absence is reported rather than failed.
  const sku = await one(
    `SELECT s.id, s.size, v.storefront_id, p.id AS product_id,
            EXISTS (SELECT 1 FROM product_media pm
                     WHERE pm.product_id = p.id AND pm.status='ACTIVE' AND pm.media_type='IMAGE') AS has_image
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id
       JOIN products p ON p.id = v.product_id
       JOIN inventory i ON i.sku_id = s.id
      WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'
      GROUP BY s.id HAVING SUM(i.on_hand - i.reserved) > 2
      ORDER BY has_image DESC LIMIT 1`);
  assert(sku, 'need one stocked, active SKU — run npm run seed && seed:warehouses');

  for (const [id, first] of [[customerId, 'Recovery'], [strangerId, 'Stranger']]) {
    // eslint-disable-next-line no-await-in-loop
    await query(`INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at)
      VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'), ?, 'Test', 'ACTIVE', NOW(3))`, [id, first]);
  }

  // The customer abandons a cart: 2 of one SKU.
  await cartService.addItem(customerId, { storefrontId: sku.storefront_id, size: sku.size, quantity: 2 });
  const abandoned = await cartService.getCart(customerId);
  assert.equal(abandoned.items.length, 1);
  assert.equal(abandoned.items[0].quantity, 2);

  const issued = await cartRecoveryService.issue({
    customerId,
    cartId: abandoned.id,
    cartActivityAt: abandoned.updatedAt || new Date(),
    items: abandoned.items.map((i) => ({ skuId: i.skuId, quantity: i.quantity })),
  });

  // 1 — the link is a per-customer secret, and only its hash is stored. A dump
  //     of the table must not be redeemable.
  assert.ok(issued.token && issued.token.length >= 30, 'a token was minted');
  assert.ok(issued.url.endsWith(`/cart/recover/${issued.token}`), `url carries the token: ${issued.url}`);
  // Production sent reminders linking to http://localhost:5173 because the
  // link read env.STOREFRONT_BASE_URL, which no deployment sets. The link must
  // use the resolved storefront URL, and no module may read the raw variable.
  assert.ok(issued.url.startsWith(`${storefrontBaseUrl}/cart/recover/`), `link uses the resolved storefront URL: ${issued.url}`);
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.js') && readFileSync(full, 'utf8').includes('env.STOREFRONT_BASE_URL')) offenders.push(full);
    }
  };
  walk(fileURLToPath(new URL('../src/modules', import.meta.url)));
  assert.deepEqual(offenders, [], `modules must use storefrontBaseUrl, not env.STOREFRONT_BASE_URL: ${offenders.join(', ')}`);
  pass('RECOVERY_LINK_USES_RESOLVED_STOREFRONT_URL', storefrontBaseUrl);
  const stored = await one('SELECT token_hash, customer_id FROM cart_recovery_tokens WHERE customer_id = ?', [customerId]);
  assert.notEqual(stored.token_hash, issued.token, 'the plaintext token is NOT stored');
  assert.match(stored.token_hash, /^[0-9a-f]{64}$/, 'what is stored is a sha-256 hex digest');
  pass('TOKEN_IS_STORED_ONLY_AS_A_HASH');

  // 2 — the preview is public (the recipient is usually signed out) and shows
  //     THIS cart's product, at today's price, with no customer information.
  const preview = await cartRecoveryService.preview(issued.token);
  assert.equal(preview.items.length, 1);
  assert.equal(preview.items[0].quantity, 2, 'the abandoned quantity');
  assert.equal(preview.items[0].size, sku.size, 'the abandoned variant, not another one');
  assert.ok(preview.items[0].priceMinor > 0, 'priced from the catalogue now');
  // Assert on the SHAPE, not on substrings of the serialized JSON: "null," is
  // what any null field looks like once stringified, so the old substring
  // check failed on a database with no product photography rather than on a
  // real leak.
  const serialized = JSON.stringify(preview);
  for (const secret of ['customer_id', 'customerId', 'cart_id', 'cartId', 'token_hash', issued.token]) {
    assert.ok(!serialized.includes(secret), `preview leaks "${secret}"`);
  }
  for (const item of preview.items) {
    for (const [key, value] of Object.entries(item)) {
      // These are what the customer would actually read on the page. `null`
      // is deliberately allowed: imageUrl is null for a product with no
      // photograph and the page renders a blank tile instead of an <img>.
      assert.ok(!['undefined', 'NaN', '[object Object]'].includes(String(value)),
        `preview item field "${key}" would render as "${value}"`);
    }
    assert.ok(item.imageUrl === null || /^https:\/\//.test(item.imageUrl),
      `imageUrl must be null or an https URL, got ${item.imageUrl}`);
  }
  if (Number(sku.has_image)) {
    assert.ok(/^https:\/\//.test(preview.items[0].imageUrl || ''), 'a real https product image');
    pass('PREVIEW_CARRIES_THE_REAL_PRODUCT_IMAGE', preview.items[0].imageUrl.slice(0, 48));
  } else {
    // Not a pass and not a failure: this database has no product photography.
    console.log('  NOTE  no ACTIVE IMAGE media in this database — image assertion skipped');
    results.PREVIEW_CARRIES_THE_REAL_PRODUCT_IMAGE = 'SKIPPED (no product photography in this database)';
  }
  pass('PREVIEW_IS_PUBLIC_AND_LEAKS_NOTHING');

  // 3 — somebody else's link restores nothing into their cart.
  await assert.rejects(
    () => cartRecoveryService.redeem(issued.token, strangerId),
    (err) => err.code === 'CART_RECOVERY_INVALID',
    'a forwarded link must not restore into another account',
  );
  const strangerCart = await cartService.getCart(strangerId);
  assert.equal(strangerCart.items.length, 0, "the stranger's cart was not touched");
  pass('ANOTHER_CUSTOMER_CANNOT_REDEEM');

  // 4 — the owner empties the cart, then the link puts it back: same SKU,
  //     same quantity, re-priced from the catalogue.
  await cartService.removeItem(customerId, abandoned.items[0].lineId);
  assert.equal((await cartService.getCart(customerId)).items.length, 0, 'cart emptied');

  const redeemed = await cartRecoveryService.redeem(issued.token, customerId);
  assert.equal(redeemed.cart.items.length, 1, 'the line came back');
  assert.equal(redeemed.cart.items[0].skuId, abandoned.items[0].skuId, 'the same SKU');
  assert.equal(redeemed.cart.items[0].quantity, 2, 'the same quantity');
  assert.equal(redeemed.unavailable.length, 0);
  pass('REDEEM_RESTORES_THE_SAME_SKU_AND_QUANTITY');

  // 5 — redeeming twice is safe (phone then laptop) and does not double the
  //     quantity, and the first redemption is recorded for attribution.
  const again = await cartRecoveryService.redeem(issued.token, customerId);
  assert.equal(again.cart.items[0].quantity, 2, 'a second click does not double the line');
  const row = await one('SELECT redeemed_at FROM cart_recovery_tokens WHERE customer_id = ?', [customerId]);
  assert.ok(row.redeemed_at, 'the redemption is recorded');
  pass('REDEEM_IS_IDEMPOTENT');

  // 6 — an expired link says so, and says it without confirming anything about
  //     the customer it belonged to.
  await query('UPDATE cart_recovery_tokens SET expires_at = NOW(3) - INTERVAL 1 SECOND WHERE customer_id = ?', [customerId]);
  await assert.rejects(
    () => cartRecoveryService.preview(issued.token),
    (err) => err.code === 'CART_RECOVERY_EXPIRED',
    'an expired link is refused',
  );
  await assert.rejects(
    () => cartRecoveryService.preview('not-a-real-token-at-all'),
    (err) => err.code === 'CART_RECOVERY_INVALID',
    'a made-up token is refused',
  );
  pass('EXPIRED_AND_UNKNOWN_LINKS_ARE_REFUSED');

  console.log('\nCart recovery — ALL CHECKS PASSED\n');
  console.log(JSON.stringify(results, null, 2));
} catch (error) {
  console.error('\nCART_RECOVERY_VERIFICATION = FAIL');
  console.error(error?.code ? `${error.code}: ${error.message}` : error);
  if (error?.stack) console.error(error.stack.split('\n').slice(0, 8).join('\n'));
  process.exitCode = 1;
} finally {
  await cleanup();
  await pool.end();
}
