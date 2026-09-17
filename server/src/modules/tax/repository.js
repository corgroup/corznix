import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';

const toBand = (b) => ({
  position: Number(b.position),
  maxUnitTaxableMinor: b.max_unit_taxable_minor == null ? null : Number(b.max_unit_taxable_minor),
  gstRateBps: Number(b.gst_rate_bps),
});

const exec = async (c, sql, p = []) => (c ? await c.execute(sql, p) : [await query(sql, p)])[0];

// Multi-company (DESIGN.md §4.1) — Phase 4. Real gap left over from Phase 3
// (tax_profiles got `brand_id` in migration 078, but this repository was
// never actually wired to it — found while regression-testing this phase).
// brandId is required on list/create — admin-only surface, always has a
// real req.brandId from resolveBrandContext.
export class TaxRepository {
  async list(brandId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to list tax profiles.', 500);
    return this.#withBands(await query('SELECT * FROM tax_profiles WHERE brand_id = ? ORDER BY hsn_sac, effective_from DESC', [brandId]));
  }
  async get(id) {
    const rows = await query('SELECT * FROM tax_profiles WHERE id = ? LIMIT 1', [id]);
    return rows[0] ? (await this.#withBands(rows))[0] : null;
  }

  // Price bands (migration 113) travel with the profile as `rateBands`.
  async #withBands(rows) {
    if (!rows.length) return rows;
    const ids = rows.map((r) => r.id);
    const bands = await query(
      `SELECT tax_profile_id, position, max_unit_taxable_minor, gst_rate_bps FROM tax_profile_rate_bands
        WHERE tax_profile_id IN (${ids.map(() => '?').join(',')}) ORDER BY tax_profile_id, position`, ids);
    const byProfile = new Map();
    for (const b of bands) {
      if (!byProfile.has(b.tax_profile_id)) byProfile.set(b.tax_profile_id, []);
      byProfile.get(b.tax_profile_id).push(toBand(b));
    }
    return rows.map((r) => ({ ...r, rateBands: byProfile.get(r.id) || [] }));
  }

  bandsForProfile(connection, profileId) {
    return exec(connection,
      'SELECT position, max_unit_taxable_minor, gst_rate_bps FROM tax_profile_rate_bands WHERE tax_profile_id = ? ORDER BY position',
      [profileId]).then((rows) => rows.map(toBand));
  }

  /** Replace a profile's bands in one transaction ([] removes them). */
  replaceBands(profileId, bands) {
    return withTransaction(async (c) => {
      await c.execute('DELETE FROM tax_profile_rate_bands WHERE tax_profile_id = ?', [profileId]);
      for (const b of bands) {
        await c.execute(
          'INSERT INTO tax_profile_rate_bands (id, tax_profile_id, position, max_unit_taxable_minor, gst_rate_bps) VALUES (?, ?, ?, ?, ?)',
          [randomUUID(), profileId, b.position, b.maxUnitTaxableMinor, b.gstRateBps]);
      }
    });
  }

  async create(input) {
    if (!input.brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to create a tax profile.', 500);
    const id = randomUUID();
    await query(
      `INSERT INTO tax_profiles (id, brand_id, name, description, hsn_sac, taxability, gst_rate_bps, effective_from, effective_to, created_by_staff_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.brandId, input.name, input.description || null, input.hsnSac, input.taxability || 'TAXABLE', input.gstRateBps, input.effectiveFrom, input.effectiveTo || null, input.createdByStaffId || null]);
    return this.get(id);
  }

  update(id, fields) {
    const map = { name: 'name', description: 'description', hsnSac: 'hsn_sac', taxability: 'taxability', gstRateBps: 'gst_rate_bps', effectiveFrom: 'effective_from', effectiveTo: 'effective_to', status: 'status' };
    const entries = Object.entries(fields).filter(([k, v]) => k in map && v !== undefined);
    if (!entries.length) return this.get(id);
    return query(`UPDATE tax_profiles SET ${entries.map(([k]) => `${map[k]} = ?`).join(', ')}, updated_at = NOW(3) WHERE id = ?`,
      [...entries.map(([, v]) => v), id]).then(() => this.get(id));
  }

  profileForProduct(connection, productId) {
    return exec(connection,
      `SELECT tp.* FROM product_tax_profiles ptp JOIN tax_profiles tp ON tp.id = ptp.tax_profile_id WHERE ptp.product_id = ? LIMIT 1`,
      [productId]).then((r) => r[0] || null);
  }

  /** Active profiles sharing an HSN and covering `onDate` — used to detect config conflicts. */
  activeForHsnOnDate(connection, hsn, onDate) {
    return exec(connection,
      `SELECT * FROM tax_profiles WHERE hsn_sac = ? AND status = 'ACTIVE' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?)`,
      [hsn, onDate, onDate]);
  }

  async assignProduct(productId, taxProfileId, staffId) {
    await query(
      `INSERT INTO product_tax_profiles (product_id, tax_profile_id, assigned_by_staff_id) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE tax_profile_id = VALUES(tax_profile_id), assigned_by_staff_id = VALUES(assigned_by_staff_id), updated_at = NOW(3)`,
      [productId, taxProfileId, staffId || null]);
  }

  unassignProduct(productId) { return query('DELETE FROM product_tax_profiles WHERE product_id = ?', [productId]); }
  assignmentsFor(profileId) { return query('SELECT product_id FROM product_tax_profiles WHERE tax_profile_id = ?', [profileId]); }

  /** Products that appear on a CONFIRMED/PROCESSING order but have no tax mapping. */
  async configurationGaps(brandId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to list tax configuration gaps.', 500);
    const orderGaps = await query(
      // Two fixes here. (1) o.placed_at must appear in the SELECT list: MySQL
      // rejects an ORDER BY on a column absent from a SELECT DISTINCT (3065),
      // so this endpoint was a hard 500. It is functionally dependent on o.id,
      // which is already selected, so the row count is unchanged. (2) The query
      // had no brand filter at all, so it returned every company's orders and
      // products to any staff member holding tax.read.
      `SELECT DISTINCT oi.product_id, oi.product_name, oi.sku, o.id AS order_id, o.order_number, o.placed_at
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id AND o.order_status IN ('CONFIRMED','PROCESSING')
         LEFT JOIN product_tax_profiles ptp ON ptp.product_id = oi.product_id
        WHERE ptp.product_id IS NULL
          AND o.brand_id = ?
        ORDER BY o.placed_at DESC`, [brandId]);

    // The list above only sees products that already sit in a confirmed order,
    // so a live product with no usable tax profile stayed invisible ("No
    // configuration gaps") until a customer bought it and its invoice was
    // blocked. Every ACTIVE product whose profile is missing, inactive or not
    // effective today is listed too, before any order exists.
    const productGaps = await query(
      `SELECT p.id AS product_id, p.name AS product_name, NULL AS sku, NULL AS order_id, NULL AS order_number, NULL AS placed_at,
              CASE WHEN tp.id IS NULL THEN 'NO_TAX_PROFILE' ELSE 'TAX_PROFILE_NOT_EFFECTIVE' END AS reason
         FROM products p
         LEFT JOIN product_tax_profiles ptp ON ptp.product_id = p.id
         LEFT JOIN tax_profiles tp ON tp.id = ptp.tax_profile_id
        WHERE p.brand_id = ? AND p.status = 'ACTIVE'
          AND (tp.id IS NULL OR tp.status <> 'ACTIVE' OR tp.effective_from > CURDATE()
               OR (tp.effective_to IS NOT NULL AND tp.effective_to < CURDATE()))
        ORDER BY p.name`, [brandId]);

    return [...orderGaps.map((g) => ({ ...g, reason: 'NO_TAX_PROFILE' })), ...productGaps];
  }
}

export const taxRepository = new TaxRepository();
