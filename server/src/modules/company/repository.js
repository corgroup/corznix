import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

// Multi-company (DESIGN.md §3.4/§9) — Phase 5. A real, standalone bug found
// while wiring this phase, not part of its original scope: Phase 1
// (migration 018 era per the old header comment below) already
// de-singletoned this into `company_profiles` (plural, PK = brand_id,
// Cor-Cotton's row fully backfilled, Cor-Znix's created blank per decision
// §5) — but this repository was NEVER rewired to it. It kept reading the
// OLD singleton `company_profile` table, so every invoice generated for
// ANY brand would have used Cor-Cotton's own legal name/GSTIN/address —
// exactly the "Invoice numbering / GST identity bleeds" risk DESIGN.md §9
// explicitly flagged. Fixed: brandId is now required on every method here.
export class CompanyRepository {
  async getProfile(brandId, connection = null) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to read a company profile.', 500);
    const exec = connection ? (sql, p) => connection.execute(sql, p).then((r) => r[0]) : query;
    const rows = await exec('SELECT * FROM company_profiles WHERE brand_id = ? LIMIT 1', [brandId]);
    return rows[0] || null;
  }

  async getOwner(brandId, connection = null) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to read a company owner.', 500);
    const exec = connection ? (sql, p) => connection.execute(sql, p).then((r) => r[0]) : query;
    const rows = await exec(
      `SELECT s.* FROM company_profiles c
         JOIN staff_users s ON s.id = c.owner_staff_user_id
        WHERE c.brand_id = ? LIMIT 1`, [brandId],
    );
    return rows[0] || null;
  }

  /** Set the owner. `connection` is required — this is always part of a larger transaction. */
  async setOwner(connection, brandId, staffUserId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to set a company owner.', 500);
    const [result] = await connection.execute(
      'UPDATE company_profiles SET owner_staff_user_id = ?, updated_at = NOW(3) WHERE brand_id = ?',
      [staffUserId, brandId],
    );
    return result.affectedRows === 1;
  }

  /** Set the default warehouse. `connection` is required — always part of a larger transaction (warehouses/service.js). */
  async setDefaultWarehouse(connection, brandId, warehouseId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to set a default warehouse.', 500);
    const [result] = await connection.execute(
      'UPDATE company_profiles SET default_warehouse_id = ?, updated_at = NOW(3) WHERE brand_id = ?',
      [warehouseId, brandId],
    );
    return result.affectedRows === 1;
  }

  // Legal-identity fields only — owner/default-warehouse have their own
  // dedicated, transaction-aware setters above (Settings > Company Profile,
  // Phase 6).
  static #EDITABLE_COLUMNS = Object.freeze([
    'legal_name', 'trade_name', 'constitution', 'gstin', 'gst_registration_type',
    'gst_state_code', 'gst_effective_from', 'principal_address_line1', 'principal_address_line2',
    'principal_city', 'principal_state', 'principal_postal_code', 'principal_country',
  ]);

  async updateProfile(brandId, fields) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to update a company profile.', 500);
    const entries = Object.entries(fields || {}).filter(([k, v]) => CompanyRepository.#EDITABLE_COLUMNS.includes(k) && v !== undefined);
    if (!entries.length) return this.getProfile(brandId);
    const sets = entries.map(([k]) => `${k} = ?`).join(', ');
    const params = entries.map(([, v]) => v);
    await query(`UPDATE company_profiles SET ${sets}, updated_at = NOW(3) WHERE brand_id = ?`, [...params, brandId]);
    return this.getProfile(brandId);
  }
}

export const companyRepository = new CompanyRepository();
