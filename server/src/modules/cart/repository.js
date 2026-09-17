import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';

async function execute(connection, sql, params = []) {
  if (!connection) return query(sql, params);
  const [rows] = await connection.execute(sql, params);
  return rows;
}

export class CartRepository {
  async findLineForCustomer(customerId, lineId) {
    const rows = await query(
      `SELECT ci.id, ci.sku_id, ci.quantity FROM cart_items ci
       JOIN carts c ON c.id=ci.cart_id WHERE ci.id=? AND c.customer_id=? LIMIT 1`,
      [lineId, customerId]);
    return rows[0] || null;
  }

  async quantityForSku(customerId, skuId) {
    const rows = await query(
      `SELECT ci.quantity FROM cart_items ci JOIN carts c ON c.id=ci.cart_id
       WHERE c.customer_id=? AND ci.sku_id=? LIMIT 1`, [customerId, skuId]);
    return Number(rows[0]?.quantity || 0);
  }
  async getOrCreate(customerId) {
    return withTransaction(async (connection) => {
      await execute(connection, 'INSERT IGNORE INTO carts (id, brand_id, customer_id, currency) VALUES (?, (SELECT brand_id FROM customers WHERE id = ?), ?, \'INR\')', [randomUUID(), customerId, customerId]);
      const rows = await execute(connection, 'SELECT * FROM carts WHERE customer_id = ? LIMIT 1 FOR UPDATE', [customerId]);
      return rows[0];
    });
  }

  async findForCustomer(customerId, connection = null, { lock = false } = {}) {
    const rows = await execute(connection, `SELECT * FROM carts WHERE customer_id = ? LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [customerId]);
    return rows[0] || null;
  }

  async addItem(customerId, skuId, quantity) {
    return withTransaction(async (connection) => {
      await execute(connection, 'INSERT IGNORE INTO carts (id, brand_id, customer_id, currency) VALUES (?, (SELECT brand_id FROM customers WHERE id = ?), ?, \'INR\')', [randomUUID(), customerId, customerId]);
      const carts = await execute(connection, 'SELECT * FROM carts WHERE customer_id = ? LIMIT 1 FOR UPDATE', [customerId]);
      const cart = carts[0];
      const existingRows = await execute(connection, 'SELECT quantity FROM cart_items WHERE cart_id = ? AND sku_id = ? LIMIT 1 FOR UPDATE', [cart.id, skuId]);
      if (existingRows[0] && Number(existingRows[0].quantity) + quantity > 99) {
        throw new AppError('INVALID_QUANTITY', 'Cart quantity cannot exceed 99.', 400);
      }
      await execute(connection,
        `INSERT INTO cart_items (id, cart_id, sku_id, quantity) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE quantity = quantity + VALUES(quantity), updated_at = NOW(3)`,
        [randomUUID(), cart.id, skuId, quantity],
      );
      return cart;
    });
  }

  async updateQuantity(customerId, lineId, quantity) {
    const result = await query(
      `UPDATE cart_items ci JOIN carts c ON c.id = ci.cart_id
       SET ci.quantity = ?, ci.updated_at = NOW(3)
       WHERE ci.id = ? AND c.customer_id = ?`,
      [quantity, lineId, customerId],
    );
    return result.affectedRows > 0;
  }

  async removeItem(customerId, lineId) {
    const result = await query(
      `DELETE ci FROM cart_items ci JOIN carts c ON c.id = ci.cart_id
       WHERE ci.id = ? AND c.customer_id = ?`,
      [lineId, customerId],
    );
    return result.affectedRows > 0;
  }

  async loadRows(cartId, connection = null) {
    return execute(connection,
      `SELECT ci.id AS line_id, ci.quantity, ci.updated_at AS line_updated_at,
              s.id AS sku_id, s.sku, s.size, s.price_minor, s.sale_price_minor, s.currency,
              v.id AS variant_id, v.storefront_id, v.color_name, v.color_hex,
              p.id AS product_id, p.slug, p.name,
              i.on_hand AS inventory_on_hand, i.reserved AS inventory_reserved,
              -- media_type = 'IMAGE' matters: a GRADIENT row stores a CSS gradient
              -- string in its url column (the documented placeholder for a product with no
              -- photography), and without this filter one could win on position and
              -- be returned as the thumbnail. The storefront puts media.url straight
              -- into <img src>, so the cart drew a broken-image icon and the alt
              -- text for any product whose first media row was a gradient.
              (SELECT pm.url FROM product_media pm
               WHERE pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE' AND pm.product_id = p.id
                 AND (pm.variant_id = v.id OR pm.variant_id IS NULL)
               ORDER BY (pm.variant_id = v.id) DESC, pm.position ASC LIMIT 1) AS media_url,
              (SELECT pm.alt_text FROM product_media pm
               WHERE pm.status = 'ACTIVE' AND pm.media_type = 'IMAGE' AND pm.product_id = p.id
                 AND (pm.variant_id = v.id OR pm.variant_id IS NULL)
               ORDER BY (pm.variant_id = v.id) DESC, pm.position ASC LIMIT 1) AS media_alt
       FROM cart_items ci
       JOIN skus s ON s.id = ci.sku_id AND s.status = 'ACTIVE'
       JOIN product_variants v ON v.id = s.variant_id AND v.status = 'ACTIVE'
       JOIN products p ON p.id = v.product_id AND p.status = 'ACTIVE'
       -- Cross-warehouse aggregate: one row per SKU. A per-warehouse join here
       -- would fan a cart line out into one row per warehouse holding the SKU.
       LEFT JOIN (
         SELECT sku_id, SUM(on_hand) AS on_hand, SUM(reserved) AS reserved
         FROM inventory GROUP BY sku_id
       ) i ON i.sku_id = s.id
       WHERE ci.cart_id = ? ORDER BY ci.created_at ASC`,
      [cartId],
    );
  }
}
