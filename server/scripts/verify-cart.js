import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { env } from '../src/config/index.js';
import { createAccessToken } from '../src/utils/jwt.js';

const baseUrl = `http://localhost:${env.PORT}/api/v1/cart`;
const customerIds = [randomUUID(), randomUUID()];
const sessionIds = [randomUUID(), randomUUID()];

async function api(path, { method = 'GET', body, token, origin = 'http://localhost:5173', cookie = false } = {}) {
  const headers = { Origin: origin, Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = `${env.SESSION_COOKIE_NAME}=${token}`;
  else headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function main() {
  const schemaRows = await query(
    `SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS columns_list
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('carts', 'cart_items')
     GROUP BY TABLE_NAME, INDEX_NAME`,
  );
  assert(schemaRows.some((row) => row.TABLE_NAME === 'carts' && row.columns_list === 'customer_id'), 'Missing carts customer ownership index.');
  assert(schemaRows.some((row) => row.TABLE_NAME === 'cart_items' && row.columns_list === 'cart_id,sku_id'), 'Missing canonical cart line uniqueness index.');

  const skuRows = await query(
    `SELECT s.id, s.size, s.price_minor, s.sale_price_minor, v.storefront_id
     FROM skus s JOIN product_variants v ON v.id=s.variant_id
     JOIN products p ON p.id=v.product_id
     WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE'
     ORDER BY v.storefront_id, s.display_order LIMIT 2`,
  );
  assert(skuRows.length >= 1, 'No active SKU available for verification.');

  for (let index = 0; index < 2; index += 1) {
    await query('INSERT INTO customers (id, brand_id, first_name, last_name, status, profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?, ?, \'ACTIVE\', NOW(3))', [customerIds[index], 'CartTest', `Test${index + 1}`]);
    await query(`INSERT INTO auth_sessions (id, customer_id, token_hash, status, expires_at, user_agent, ip_address)
                 VALUES (?, ?, ?, 'ACTIVE', DATE_ADD(NOW(3), INTERVAL 1 DAY), 'cart-verify', '127.0.0.1')`, [sessionIds[index], customerIds[index], randomUUID()]);
  }
  const tokens = sessionIds.map((sessionId, index) => createAccessToken({ customerId: customerIds[index], sessionId }));
  let originalPrice;
  try {
    const empty = await api('', { token: tokens[0] });
    assert(empty.status === 200 && empty.body.data.items.length === 0, 'GET empty cart failed.');

    const tamper = await api('/items', { method: 'POST', token: tokens[0], body: { storefrontId: skuRows[0].storefront_id, size: skuRows[0].size, quantity: 1, price: 1 } });
    assert(tamper.status === 400, 'Browser price field was not rejected.');

    const added = await api('/items', { method: 'POST', token: tokens[0], body: { storefrontId: skuRows[0].storefront_id, size: skuRows[0].size, quantity: 2 } });
    assert(added.status === 201 && added.body.data.items.length === 1, 'Normal add failed.');
    const expectedUnit = Number(skuRows[0].sale_price_minor ?? skuRows[0].price_minor);
    assert(added.body.data.items[0].unitPriceMinor === expectedUnit, 'Catalog price was not authoritative.');
    assert(added.body.data.items[0].lineTotalMinor === expectedUnit * 2, 'Line total is incorrect.');

    const duplicate = await api('/items', { method: 'POST', token: tokens[0], body: { storefrontId: skuRows[0].storefront_id, size: skuRows[0].size, quantity: 1 } });
    assert(duplicate.body.data.items.length === 1 && duplicate.body.data.items[0].quantity === 3, 'Duplicate line was not coalesced.');
    const lineId = duplicate.body.data.items[0].lineId;

    // Sibling SKUs must have stock: the cart rightly refuses an out-of-stock
    // size (409 OUT_OF_STOCK), and picking one made this gate fail whenever
    // the local catalog ran out — testing stock, not cart line identity.
    const siblingSizeRows = await query(
      `SELECT s.size, v.storefront_id FROM skus s
       JOIN product_variants v ON v.id=s.variant_id
       WHERE v.storefront_id=? AND s.status='ACTIVE' AND s.size<>?
         AND (SELECT COALESCE(SUM(i.on_hand - i.reserved), 0) FROM inventory i WHERE i.sku_id = s.id) > 0
       LIMIT 1`,
      [skuRows[0].storefront_id, skuRows[0].size],
    );
    assert(siblingSizeRows.length === 1, 'Catalog lacks a second size needed for SKU identity verification.');
    const secondSize = await api('/items', { method: 'POST', token: tokens[0], body: { storefrontId: siblingSizeRows[0].storefront_id, size: siblingSizeRows[0].size, quantity: 1 } });
    assert(secondSize.status === 201 && secondSize.body.data.items.length === 2, 'Two sizes did not remain distinct cart lines.');

    const siblingColorRows = await query(
      `SELECT s.size, v.storefront_id FROM skus s
       JOIN product_variants v ON v.id=s.variant_id
       JOIN product_variants source_variant ON source_variant.storefront_id=?
       WHERE v.product_id=source_variant.product_id AND v.id<>source_variant.id
         AND v.status='ACTIVE' AND s.status='ACTIVE' AND s.size=?
         AND (SELECT COALESCE(SUM(i.on_hand - i.reserved), 0) FROM inventory i WHERE i.sku_id = s.id) > 0
       LIMIT 1`,
      [skuRows[0].storefront_id, skuRows[0].size],
    );
    assert(siblingColorRows.length === 1, 'Catalog lacks a second color needed for SKU identity verification.');
    const secondColor = await api('/items', { method: 'POST', token: tokens[0], body: { storefrontId: siblingColorRows[0].storefront_id, size: siblingColorRows[0].size, quantity: 1 } });
    assert(secondColor.status === 201 && secondColor.body.data.items.length === 3, 'Two colors did not remain distinct cart lines.');

    const crossCustomer = await api(`/items/${lineId}`, { method: 'PATCH', token: tokens[1], body: { quantity: 4 } });
    assert(crossCustomer.status === 404 && crossCustomer.body.error.code === 'CART_ITEM_NOT_FOUND', 'Cross-customer mutation was not isolated.');

    originalPrice = Number(skuRows[0].price_minor);
    const changedPrice = originalPrice + 100;
    await query('UPDATE skus SET price_minor = ?, sale_price_minor = NULL WHERE id = ?', [changedPrice, skuRows[0].id]);
    const repriced = await api('', { token: tokens[0] });
    assert(repriced.body.data.items[0].unitPriceMinor === changedPrice, 'Cart did not reprice from catalog.');
    await query('UPDATE skus SET price_minor = ?, sale_price_minor = ? WHERE id = ?', [originalPrice, skuRows[0].sale_price_minor, skuRows[0].id]);
    originalPrice = null;

    const updated = await api(`/items/${lineId}`, { method: 'PATCH', token: tokens[0], body: { quantity: 4 } });
    assert(updated.status === 200 && updated.body.data.items[0].quantity === 4, 'Quantity update failed.');

    const badOrigin = await api('/items', { method: 'POST', token: tokens[0], origin: 'http://evil.invalid', cookie: true, body: { storefrontId: skuRows[0].storefront_id, size: skuRows[0].size, quantity: 1 } });
    assert(badOrigin.status === 403 && badOrigin.body.error.code === 'ORIGIN_FORBIDDEN', 'Cookie mutation origin guard failed.');

    const removed = await api(`/items/${lineId}`, { method: 'DELETE', token: tokens[0] });
    assert(removed.status === 200 && removed.body.data.items.length === 2, 'Remove failed.');
    for (const item of removed.body.data.items) {
      await api(`/items/${item.lineId}`, { method: 'DELETE', token: tokens[0] });
    }

    console.log(JSON.stringify({
      migration: '004_cart.sql', schemaIndexes: 'PASS', priceTampering: 'REJECTED_400', catalogPriceAuthority: 'PASS',
      priceChangeRevalidation: 'PASS', duplicateLineCoalescing: 'PASS', quantity: 'PASS', remove: 'PASS',
      distinctSizes: 'PASS', distinctColors: 'PASS', crossCustomerIsolation: 'PASS', originGuard: 'PASS', canonicalIdentity: 'sku_id',
    }, null, 2));
  } finally {
    if (originalPrice != null) await query('UPDATE skus SET price_minor = ? WHERE id = ?', [originalPrice, skuRows[0].id]);
    await query('DELETE FROM customers WHERE id IN (?, ?)', customerIds);
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
