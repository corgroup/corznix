import { query } from '../../database/connection/pool.js';

export class PricingRepository {
  async findSellableByStorefrontIdAndSize(storefrontId, size) {
    const rows = await query(
      `SELECT s.id AS sku_id, s.sku, s.size, s.price_minor, s.sale_price_minor, s.currency,
              v.id AS variant_id, v.storefront_id, v.color_name, v.color_hex,
              p.id AS product_id, p.slug, p.name
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id AND v.status = 'ACTIVE'
       JOIN products p ON p.id = v.product_id AND p.status = 'ACTIVE'
       WHERE v.storefront_id = ? AND UPPER(s.size) = ? AND s.status = 'ACTIVE'
       LIMIT 1`,
      [storefrontId, size],
    );
    return rows[0] || null;
  }
}
