import { query } from '../../database/connection/pool.js';

export class FulfillmentRepository {
  async resolveItems(items) {
    if (!items.length) return [];
    const ids = [...new Set(items.map((item) => item.skuId).filter(Boolean))];
    if (!ids.length) return items.map((item) => ({ ...item, fulfillment: null }));
    const placeholders = ids.map(() => '?').join(',');
    const rows = await query(
      `SELECT s.id AS sku_id, p.id AS product_id, psp.weight_grams, psp.length_mm, psp.width_mm, psp.height_mm
       FROM skus s
       JOIN product_variants v ON v.id=s.variant_id
       JOIN products p ON p.id=v.product_id
       LEFT JOIN product_shipping_profiles psp ON psp.product_id=p.id
       WHERE s.id IN (${placeholders})`, ids,
    );
    const bySku = new Map(rows.map((row) => [row.sku_id, row]));
    return items.map((item) => {
      const row = bySku.get(item.skuId);
      const complete = Boolean(row?.weight_grams && row?.length_mm && row?.width_mm && row?.height_mm);
      return { skuId: item.skuId, quantity: Number(item.quantity), productId: row?.product_id || null,
        fulfillment: complete ? { weightGrams: Number(row.weight_grams), lengthMm: Number(row.length_mm), widthMm: Number(row.width_mm), heightMm: Number(row.height_mm) } : null };
    });
  }
}

export const fulfillmentRepository = new FulfillmentRepository();
