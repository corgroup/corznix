// Phase 1B — read access to the canonical SKU master data + SKU identity
// state. Reads only; the reference tables are business configuration seeded by
// migration 057 (brief §11/§12 — not casually operator-editable).
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3): the
// master code tables (catalog_product_type_codes/fit_codes/color_codes) and
// skus/products/product_variants all carry brand_id now. Every method here
// is admin-only (no storefront caller), so `brandId` is threaded through
// directly rather than optionally.
import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';

// Identity reads must be able to run INSIDE the caller's transaction. A
// recode updates product_variants and then regenerates the SKUs from the new
// identity; reading that identity on a fresh pool connection cannot see the
// uncommitted UPDATE, so the regeneration silently rebuilt the OLD sku string,
// found it unchanged, and reported nothing to do.
const read = async (connection, sql, params) => (
  connection ? (await connection.execute(sql, params))[0] : query(sql, params)
);

// A SKU has "operational history" (brief §20) once it is referenced by any of
// these — i.e. it has been transacted, not merely stocked. An inventory
// balance row alone is NOT operational history (every configured SKU has one).
const OPERATIONAL_TABLES = [
  'order_items',
  'fulfillment_items',
  'return_request_items',
  'warehouse_transfer_items',
  'inventory_quarantine',
  'inventory_reservation_items',
];

export const catalogSkuMasterRepository = {
  async productTypeCodes(brandId) {
    return query(
      `SELECT t.id, t.label, t.code, t.size_family AS sizeFamily, t.status,
              (SELECT COUNT(*) FROM products p WHERE p.product_type_code_id = t.id) AS usage_count
       FROM catalog_product_type_codes t WHERE t.brand_id = ? ORDER BY t.code`,
      [brandId],
    );
  },
  async fitCodes(brandId) {
    return query(
      `SELECT f.id, f.label, f.code, f.status,
              (SELECT COUNT(*) FROM products p WHERE p.fit_code_id = f.id) AS usage_count
       FROM catalog_fit_codes f WHERE f.brand_id = ? ORDER BY f.code`,
      [brandId],
    );
  },
  async colorCodes(brandId) {
    return query(
      `SELECT c.id, c.label, c.code, c.display_hex AS displayHex, c.status,
              (SELECT COUNT(*) FROM product_variants v WHERE v.color_code_id = c.id) AS usage_count
       FROM catalog_color_codes c WHERE c.brand_id = ? ORDER BY c.label`,
      [brandId],
    );
  },

  // Operator-created master codes (governed extension of the migration-057
  // seed — `catalog.write` + audit in the service). Uniqueness on code/label
  // is enforced by the DB unique keys (now per-brand); the service maps
  // ER_DUP_ENTRY to 409.
  async createProductTypeCode({ label, code, sizeFamily = 'APPAREL', brandId }) {
    const id = randomUUID();
    await query(
      `INSERT INTO catalog_product_type_codes (id, brand_id, label, code, size_family, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'ACTIVE', NOW(), NOW())`,
      [id, brandId, label, code, sizeFamily],
    );
    return this.productTypeById(id, brandId);
  },
  async createFitCode({ label, code, brandId }) {
    const id = randomUUID();
    await query(
      `INSERT INTO catalog_fit_codes (id, brand_id, label, code, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'ACTIVE', NOW(), NOW())`,
      [id, brandId, label, code],
    );
    return this.fitById(id, brandId);
  },

  async productTypeById(id, brandId) {
    const [r] = await query('SELECT * FROM catalog_product_type_codes WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]);
    return r || null;
  },
  async fitById(id, brandId) {
    const [r] = await query('SELECT * FROM catalog_fit_codes WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]);
    return r || null;
  },
  async colorById(id, brandId) {
    const [r] = await query('SELECT * FROM catalog_color_codes WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]);
    return r || null;
  },

  // The identity context for one SKU: product/variant codes + the size + the
  // sku string + kind + whether the string is already taken elsewhere.
  // Scoped by brand_id so a caller can never resolve another company's SKU
  // by guessing its id.
  async skuIdentityContext(skuId, brandId, connection = null) {
    const rows = await read(connection, 
      `SELECT s.id AS sku_id, s.sku, s.sku_kind, s.size, s.variant_id,
              v.product_id, v.color_name, v.color_code_id, v.design_name, v.design_code,
              cc.code AS color_code,
              p.name AS product_name, p.product_type, p.fit, p.product_type_code_id, p.fit_code_id,
              ptc.code AS product_type_code, ptc.size_family, fc.code AS fit_code
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN catalog_color_codes cc ON cc.id = v.color_code_id
       LEFT JOIN catalog_product_type_codes ptc ON ptc.id = p.product_type_code_id
       LEFT JOIN catalog_fit_codes fc ON fc.id = p.fit_code_id
       WHERE s.id = ? AND s.brand_id = ? LIMIT 1`,
      [skuId, brandId],
    );
    return rows[0] || null;
  },

  async variantIdentityContext(variantId, brandId, connection = null) {
    const rows = await read(connection,
      `SELECT v.id AS variant_id, v.product_id, v.color_name, v.color_code_id, v.design_name, v.design_code,
              cc.code AS color_code,
              p.name AS product_name, p.product_type_code_id, p.fit_code_id,
              ptc.code AS product_type_code, ptc.size_family, fc.code AS fit_code
       FROM product_variants v
       JOIN products p ON p.id = v.product_id
       LEFT JOIN catalog_color_codes cc ON cc.id = v.color_code_id
       LEFT JOIN catalog_product_type_codes ptc ON ptc.id = p.product_type_code_id
       LEFT JOIN catalog_fit_codes fc ON fc.id = p.fit_code_id
       WHERE v.id = ? AND v.brand_id = ? LIMIT 1`,
      [variantId, brandId],
    );
    return rows[0] || null;
  },

  // Does this exact SKU string exist on a DIFFERENT sku row IN THIS COMPANY?
  // Scoped by brand_id — `skus.sku` uniqueness is now (brand_id, sku), so
  // this check must match that scope exactly, or it would report a false
  // collision with another company's identical SKU string. Returns a safe
  // reference (product + variant colour + size), never inaccessible data.
  async skuStringOwner(skuString, brandId, exceptSkuId = null) {
    const rows = await query(
      `SELECT s.id, s.size, v.color_name, p.id AS product_id, p.name AS product_name, p.slug
       FROM skus s JOIN product_variants v ON v.id = s.variant_id JOIN products p ON p.id = v.product_id
       WHERE s.sku = ? AND s.brand_id = ? ${exceptSkuId ? 'AND s.id <> ?' : ''} LIMIT 1`,
      exceptSkuId ? [skuString, brandId, exceptSkuId] : [skuString, brandId],
    );
    return rows[0] || null;
  },

  // Operational-history check for one or many SKUs. Returns a Set of sku_ids
  // that have history. Unscoped by brand_id on purpose — the caller always
  // passes ids it has already resolved within one company, and the
  // operational tables themselves aren't in Phase 3's scope.
  async skusWithOperationalHistory(skuIds) {
    if (!skuIds || skuIds.length === 0) return new Set();
    const ph = skuIds.map(() => '?').join(',');
    const union = OPERATIONAL_TABLES
      .map((t) => `SELECT DISTINCT sku_id FROM ${t} WHERE sku_id IN (${ph})`)
      .join(' UNION ');
    const params = OPERATIONAL_TABLES.flatMap(() => skuIds);
    const rows = await query(union, params);
    return new Set(rows.map((r) => r.sku_id));
  },

  async legacySkuRows(brandId) {
    return query(
      `SELECT s.id AS sku_id, s.sku, s.sku_kind, s.size, s.variant_id,
              v.product_id, v.color_name, v.color_code_id, v.design_name, v.design_code,
              cc.code AS color_code,
              p.name AS product_name, p.slug, p.product_type, p.fit,
              p.product_type_code_id, p.fit_code_id,
              ptc.code AS product_type_code, ptc.size_family, fc.code AS fit_code
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN catalog_color_codes cc ON cc.id = v.color_code_id
       LEFT JOIN catalog_product_type_codes ptc ON ptc.id = p.product_type_code_id
       LEFT JOIN catalog_fit_codes fc ON fc.id = p.fit_code_id
       WHERE s.sku_kind = 'LEGACY' AND s.brand_id = ?
       ORDER BY p.name, v.color_name, s.size`,
      [brandId],
    );
  },
};

export default catalogSkuMasterRepository;
