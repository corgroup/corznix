// Size Guide Studio (Wave 8D). Reusable named size guides — current
// reference data, not immutable snapshots: editing an ACTIVE guide affects
// every product mapped to it (the CMS makes that explicit). Product <-> guide
// is an EXPLICIT mapping only (products.size_guide_id, set via
// adminCatalogService.assignSizeGuide) — never inferred from title / category
// / SKU text.
//
// `values_json` holds the canonical measurements in the guide's `unit`
// (inches today); `values_cm_json` is the optional centimetre variant. The
// storefront PDP renders `columns` + `rows` exactly as today
// (SizeChartTable) — this wave only changes the data source.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// every method takes the caller's `brandId` (from `req.brandId`, resolved
// by `resolveBrandContext`) and scopes every query by it.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { slugify } from '../../utils/slug.js';
import { StaffAuditRepository } from '../staff/repositories.js';

const GUIDE_STATUS = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
const UNITS = ['in', 'cm'];

function parseJson(value) {
  if (value == null) return null;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

function guideRowDto(r) {
  return {
    id: r.id,
    size: r.size,
    displayOrder: r.display_order,
    values: parseJson(r.values_json) || {},
    valuesCm: parseJson(r.values_cm_json) || null,
  };
}

function guideDto(g, rows) {
  const columns = parseJson(g.columns_json) || ['size', 'chest', 'length', 'shoulder', 'sleeve'];
  return {
    id: g.id,
    name: g.name,
    title: g.title || g.name,
    description: g.description || null,
    notes: g.notes || null,
    slug: g.slug,
    unit: g.unit,
    status: g.status,
    columns,
    rows: (rows || []).map(guideRowDto),
    createdAt: g.created_at,
    updatedAt: g.updated_at,
  };
}

// ---- validation --------------------------------------------------------

function validateShape({ name, unit, columns, rows }, { partial = false } = {}) {
  if (!partial || name !== undefined) {
    if (!name || !String(name).trim()) throw new AppError('SIZE_GUIDE_INVALID', 'Size guide name is required.', 422);
  }
  if (!partial || unit !== undefined) {
    if (!UNITS.includes(unit)) throw new AppError('SIZE_GUIDE_INVALID', `unit must be one of: ${UNITS.join(', ')}.`, 422);
  }
  if (!partial || columns !== undefined) {
    if (!Array.isArray(columns) || columns.length < 2) throw new AppError('SIZE_GUIDE_INVALID', 'At least two columns are required (size + one measurement).', 422);
    if (!columns.includes('size')) throw new AppError('SIZE_GUIDE_INVALID', 'columns must include "size".', 422);
    if (new Set(columns).size !== columns.length) throw new AppError('SIZE_GUIDE_INVALID', 'Duplicate column keys.', 422);
    for (const col of columns) {
      if (!/^[a-z][a-z0-9_]*$/.test(col)) throw new AppError('SIZE_GUIDE_INVALID', `Column key "${col}" must be lowercase alphanumeric/underscore.`, 422);
    }
  }
  if (rows !== undefined) validateRows(rows, columns);
}

function validateRows(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError('SIZE_GUIDE_INVALID', 'A size guide needs at least one size row.', 422);
  const measurementKeys = (columns || []).filter((c) => c !== 'size');
  const sizes = new Set();
  const orders = new Set();
  for (const row of rows) {
    if (!row.size || !String(row.size).trim()) throw new AppError('SIZE_GUIDE_INVALID', 'Every row needs a size label.', 422);
    if (sizes.has(row.size)) throw new AppError('SIZE_GUIDE_INVALID', `Duplicate size label "${row.size}".`, 422);
    sizes.add(row.size);
    const order = Number(row.displayOrder ?? 0);
    if (!Number.isInteger(order) || order < 0) throw new AppError('SIZE_GUIDE_INVALID', 'displayOrder must be a non-negative integer.', 422);
    if (orders.has(order)) throw new AppError('SIZE_GUIDE_INVALID', `Duplicate displayOrder ${order}.`, 422);
    orders.add(order);
    for (const [key, value] of Object.entries(row.values || {})) {
      if (measurementKeys.length && !measurementKeys.includes(key)) {
        throw new AppError('SIZE_GUIDE_INVALID', `Row "${row.size}" has value for unknown column "${key}".`, 422);
      }
      if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) {
        throw new AppError('SIZE_GUIDE_INVALID', `Row "${row.size}" column "${key}" must be a finite number or null.`, 422);
      }
    }
    if (row.valuesCm != null) {
      for (const [key, value] of Object.entries(row.valuesCm)) {
        if (measurementKeys.length && !measurementKeys.includes(key)) {
          throw new AppError('SIZE_GUIDE_INVALID', `Row "${row.size}" valuesCm has unknown column "${key}".`, 422);
        }
        if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) {
          throw new AppError('SIZE_GUIDE_INVALID', `Row "${row.size}" valuesCm "${key}" must be a finite number or null.`, 422);
        }
      }
    }
  }
}

export class SizeGuideService {
  constructor(deps = {}) {
    this.audit = deps.audit || new StaffAuditRepository();
  }

  audit_(actor, entry) {
    return this.audit.log({
      staffUserId: actor?.id || null,
      actorEmail: actor?.email || null,
      ipAddress: actor?.ip || null,
      requestId: actor?.requestId || null,
      ...entry,
    });
  }

  async #findGuide(id, brandId) {
    const rows = await query('SELECT * FROM size_guides WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]);
    if (!rows[0]) throw new AppError('SIZE_GUIDE_NOT_FOUND', 'Size guide not found.', 404);
    return rows[0];
  }

  async #rows(guideId) {
    return query('SELECT * FROM size_guide_rows WHERE size_guide_id = ? ORDER BY display_order ASC', [guideId]);
  }

  async usageCount(guideId, brandId) {
    const rows = await query('SELECT COUNT(*) AS c FROM products WHERE size_guide_id = ? AND brand_id = ?', [guideId, brandId]);
    return Number(rows[0].c);
  }

  async list(brandId) {
    const guides = await query('SELECT * FROM size_guides WHERE brand_id = ? ORDER BY name ASC', [brandId]);
    return {
      sizeGuides: await Promise.all(guides.map(async (g) => {
        const columns = parseJson(g.columns_json) || [];
        return {
          id: g.id,
          name: g.name,
          title: g.title || g.name,
          description: g.description || null,
          slug: g.slug,
          unit: g.unit,
          status: g.status,
          columns,
          format: 'Table',
          rowCount: Number((await query('SELECT COUNT(*) AS c FROM size_guide_rows WHERE size_guide_id = ?', [g.id]))[0].c),
          usageCount: await this.usageCount(g.id, brandId),
          updatedAt: g.updated_at,
        };
      })),
    };
  }

  // Insight-strip counts for the Size Guides workbench. `usedByProducts` is
  // the count of DISTINCT products with a size_guide_id set; `formats` lists
  // the distinct measurement units actually in use.
  async facets(brandId) {
    const [[tot], [act], [used], units] = await Promise.all([
      query('SELECT COUNT(*) c FROM size_guides WHERE brand_id = ?', [brandId]),
      query("SELECT COUNT(*) c FROM size_guides WHERE brand_id = ? AND status = 'ACTIVE'", [brandId]),
      query('SELECT COUNT(*) c FROM products WHERE brand_id = ? AND size_guide_id IS NOT NULL', [brandId]),
      query("SELECT DISTINCT unit FROM size_guides WHERE brand_id = ? AND unit IS NOT NULL ORDER BY unit", [brandId]),
    ]);
    const total = Number(tot.c);
    const active = Number(act.c);
    return {
      total,
      active,
      inactive: total - active,
      usedByProducts: Number(used.c),
      formats: units.map((u) => String(u.unit).toUpperCase()),
    };
  }

  async exportRows(brandId) {
    const { sizeGuides } = await this.list(brandId);
    const headers = ['Name', 'Slug', 'Unit', 'Columns', 'Rows', 'Used by products', 'Status', 'Updated'];
    const rows = sizeGuides.map((g) => [
      g.name, g.slug, g.unit, g.columns.join(' | '), g.rowCount, g.usageCount, g.status,
      g.updatedAt ? new Date(g.updatedAt).toISOString() : '',
    ]);
    return { headers, rows };
  }

  async get(id, brandId) {
    const g = await this.#findGuide(id, brandId);
    const dto = guideDto(g, await this.#rows(id));
    dto.usageCount = await this.usageCount(id, brandId);
    return dto;
  }

  async #insertRows(conn, guideId, rows) {
    for (const row of rows) {
      await conn.execute(
        `INSERT INTO size_guide_rows (id, size_guide_id, size, values_json, values_cm_json, display_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [randomUUID(), guideId, row.size, JSON.stringify(row.values || {}),
          row.valuesCm ? JSON.stringify(row.valuesCm) : null, Number(row.displayOrder ?? 0)],
      );
    }
  }

  async create(input, actor, brandId) {
    validateShape(input);
    const slug = input.slug || slugify(input.name);
    if (!slug) throw new AppError('SIZE_GUIDE_INVALID', 'Could not derive a slug from the name.', 422);

    const id = randomUUID();
    try {
      await withTransaction(async (conn) => {
        await conn.execute(
          `INSERT INTO size_guides (id, brand_id, name, title, description, notes, slug, unit, columns_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
          [id, brandId, input.name.trim(), input.title ?? null, input.description ?? null, input.notes ?? null,
            slug, input.unit, JSON.stringify(input.columns), input.status && GUIDE_STATUS.includes(input.status) ? input.status : 'DRAFT'],
        );
        await this.#insertRows(conn, id, input.rows);
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw new AppError('SIZE_GUIDE_SLUG_CONFLICT', 'A size guide with this slug already exists.', 409);
      throw err;
    }
    await this.audit_(actor, { action: 'SIZE_GUIDE_CREATED', resourceType: 'size_guide', resourceId: id, metadata: { name: input.name, slug } });
    return this.get(id, brandId);
  }

  async update(id, patch, actor, brandId) {
    await this.#findGuide(id, brandId);
    validateShape(patch, { partial: true });
    const map = { name: 'name', title: 'title', description: 'description', notes: 'notes', unit: 'unit' };
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(map)) {
      if (patch[key] !== undefined) { sets.push(`${col} = ?`); params.push(patch[key] === '' ? null : patch[key]); }
    }
    if (patch.columns !== undefined) { sets.push('columns_json = ?'); params.push(JSON.stringify(patch.columns)); }
    if (patch.slug !== undefined) { sets.push('slug = ?'); params.push(patch.slug); }

    if (sets.length) {
      params.push(id, brandId);
      try {
        await query(`UPDATE size_guides SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ? AND brand_id = ?`, params);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw new AppError('SIZE_GUIDE_SLUG_CONFLICT', 'A size guide with this slug already exists.', 409);
        throw err;
      }
    }
    await this.audit_(actor, { action: 'SIZE_GUIDE_UPDATED', resourceType: 'size_guide', resourceId: id, metadata: { fields: Object.keys(patch) } });
    return this.get(id, brandId);
  }

  async setRows(id, rows, actor, brandId) {
    const g = await this.#findGuide(id, brandId);
    const columns = parseJson(g.columns_json) || ['size', 'chest', 'length', 'shoulder', 'sleeve'];
    validateRows(rows, columns);
    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM size_guide_rows WHERE size_guide_id = ?', [id]);
      await this.#insertRows(conn, id, rows);
    });
    await this.audit_(actor, { action: 'SIZE_GUIDE_ROWS_REPLACED', resourceType: 'size_guide', resourceId: id, metadata: { rowCount: rows.length } });
    return this.get(id, brandId);
  }

  async setStatus(id, status, actor, brandId) {
    await this.#findGuide(id, brandId);
    if (!GUIDE_STATUS.includes(status)) throw new AppError('SIZE_GUIDE_INVALID', 'Invalid status.', 422);
    await query('UPDATE size_guides SET status = ?, updated_at = NOW(3) WHERE id = ? AND brand_id = ?', [status, id, brandId]);
    await this.audit_(actor, { action: 'SIZE_GUIDE_STATUS_CHANGED', resourceType: 'size_guide', resourceId: id, metadata: { to: status } });
    return this.get(id, brandId);
  }

  async remove(id, actor, brandId) {
    await this.#findGuide(id, brandId);
    const used = await this.usageCount(id, brandId);
    if (used > 0) {
      throw new AppError('SIZE_GUIDE_IN_USE', `This size guide is mapped to ${used} product(s). Reassign or archive it instead.`, 409);
    }
    await query('DELETE FROM size_guides WHERE id = ? AND brand_id = ?', [id, brandId]); // rows cascade
    await this.audit_(actor, { action: 'SIZE_GUIDE_DELETED', resourceType: 'size_guide', resourceId: id, metadata: {} });
    return { deleted: true };
  }
}

export const sizeGuideService = new SizeGuideService();
