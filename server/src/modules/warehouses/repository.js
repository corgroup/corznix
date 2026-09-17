import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';
import { resolveBrandId } from '../../utils/defaultBrand.js';

const COLUMN_MAP = {
  code: 'code', name: 'name',
  addressLine1: 'address_line1', addressLine2: 'address_line2',
  city: 'city', state: 'state', postalCode: 'postal_code', country: 'country',
  contactName: 'contact_name', contactPhone: 'contact_phone', contactPhoneAlt: 'contact_phone_alt', contactEmail: 'contact_email',
  priority: 'priority', status: 'status',
};

// Multi-company (DESIGN.md §4.1) — Phase 5. Decision §7.3: warehouses are
// strictly per-company, no shared pool. `create`/`list`/`findByCode`/
// `findDefault`/`setDefault` take an explicit `brandId` (this module's
// direct admin-facing surface, cheap to thread from `req.brandId`).
// `activeOrderedByPriority` — the real order-fulfillment allocation
// candidate set, called from ~6 places across checkout/orders/returns/
// exchange — takes an OPTIONAL brandId and falls back to the `is_default`
// brand (utils/defaultBrand.js), same safe-default principle as Phase 4's
// deep system-triggered chains, rather than threading through every one of
// those call sites. Safe today: Cor-Znix has zero warehouses, so there is
// nothing to mis-allocate to yet — but this is exactly the query that must
// be scoped for real before Cor-Znix ever gets its own warehouse (Phase 7).
export class WarehouseRepository {
  async create(input) {
    if (!input.brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to create a warehouse.', 500);
    const id = randomUUID();
    const keys = Object.keys(input).filter((k) => k in COLUMN_MAP && input[k] !== undefined);
    const cols = keys.map((k) => COLUMN_MAP[k]);
    try {
      await query(
        `INSERT INTO warehouses (id, brand_id, ${cols.join(', ')}, created_at, updated_at)
         VALUES (?, ?, ${cols.map(() => '?').join(', ')}, NOW(3), NOW(3))`,
        [id, input.brandId, ...keys.map((k) => input[k])],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('WAREHOUSE_CODE_EXISTS', 'A warehouse with this code already exists.', 409);
      throw err;
    }
    return this.findById(id);
  }

  async update(id, patch) {
    const entries = Object.entries(patch).filter(([k, v]) => k in COLUMN_MAP && v !== undefined);
    if (!entries.length) return this.findById(id);
    const sets = entries.map(([k]) => `${COLUMN_MAP[k]} = ?`).join(', ');
    try {
      await query(`UPDATE warehouses SET ${sets}, updated_at = NOW(3) WHERE id = ?`, [...entries.map(([, v]) => v), id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('WAREHOUSE_CODE_EXISTS', 'A warehouse with this code already exists.', 409);
      throw err;
    }
    return this.findById(id);
  }

  async findById(id, connection = null) {
    const exec = connection ? (sql, p) => connection.execute(sql, p).then((r) => r[0]) : query;
    const rows = await exec('SELECT * FROM warehouses WHERE id = ? LIMIT 1', [id]);
    return rows[0] || null;
  }

  async findByCode(code, brandId) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to look up a warehouse by code.', 500);
    const rows = await query('SELECT * FROM warehouses WHERE code = ? AND brand_id = ? LIMIT 1', [code, brandId]);
    return rows[0] || null;
  }

  /**
   * The default dispatch-origin warehouse (`is_default = 1`) for a company,
   * or null. brandId is optional here (unlike list/create/findByCode) —
   * this has no real production caller today (only ~6 verify-script
   * fixtures reaching for "the" default warehouse), so it defaults to the
   * `is_default` brand rather than requiring every one of those to thread
   * one through, matching the same fallback principle as
   * activeOrderedByPriority above.
   */
  async findDefault(brandId = null, connection = null) {
    const resolvedBrandId = await resolveBrandId(brandId);
    const exec = connection ? (sql, p) => connection.execute(sql, p).then((r) => r[0]) : query;
    const rows = await exec('SELECT * FROM warehouses WHERE brand_id = ? AND is_default = 1 LIMIT 1', [resolvedBrandId]);
    return rows[0] || null;
  }

  /**
   * Make `id` the single default warehouse FOR ITS OWN COMPANY. Clears that
   * company's current default first so `uk_warehouses_brand_single_default`
   * is never briefly doubled — scoped by brand_id so promoting a Cor-Cotton
   * warehouse never touches Cor-Znix's own default. Runs inside the given
   * transaction connection.
   */
  async setDefault(connection, brandId, id) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to set a default warehouse.', 500);
    await connection.execute('UPDATE warehouses SET is_default = 0, updated_at = NOW(3) WHERE brand_id = ? AND is_default = 1', [brandId]);
    const [result] = await connection.execute(
      'UPDATE warehouses SET is_default = 1, updated_at = NOW(3) WHERE id = ? AND brand_id = ?', [id, brandId],
    );
    return result.affectedRows === 1;
  }

  async list({ status = null, brandId } = {}) {
    if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required to list warehouses.', 500);
    return status
      ? query('SELECT * FROM warehouses WHERE brand_id = ? AND status = ? ORDER BY priority ASC, name ASC', [brandId, status])
      : query('SELECT * FROM warehouses WHERE brand_id = ? ORDER BY priority ASC, name ASC', [brandId]);
  }

  /** Active warehouses, priority order — the allocation candidate set. */
  async activeOrderedByPriority(brandId = null) {
    const resolvedBrandId = await resolveBrandId(brandId);
    return query("SELECT * FROM warehouses WHERE brand_id = ? AND status = 'ACTIVE' ORDER BY priority ASC, id ASC", [resolvedBrandId]);
  }
}

export const warehouseRepository = new WarehouseRepository();
