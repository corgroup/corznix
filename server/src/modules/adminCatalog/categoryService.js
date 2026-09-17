// Category management + product<->category mapping (Wave 8D).
//
// The taxonomy stays 2 levels deep (root -> leaf) — the same shape the
// storefront's category filtering already assumes (catalog/service.js
// selfAndDescendantIds). `product_categories` is the real membership table;
// `products.category_id` is kept in sync with the is_primary row so the
// storefront (which reads products.category_id) is unaffected.
//
// Deletion is never a blind cascade (§39/§74): a category with children or
// any product membership is refused — archive it instead.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// every method takes the caller's `brandId` (from `req.brandId`, resolved
// by `resolveBrandContext`) and scopes every query by it — reads never see
// another company's categories, writes can never create/touch one.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { slugify, isValidSlug } from '../../utils/slug.js';
import { findEntityReferences, recordSlugHistory } from '../content/entityLinks.js';
import { StaffAuditRepository } from '../staff/repositories.js';

const STATUS = ['ACTIVE', 'ARCHIVED'];

function categoryDto(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || null,
    parentId: row.parent_id,
    displayOrder: row.display_order,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CategoryService {
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

  async #find(id, brandId) {
    const rows = await query('SELECT * FROM categories WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]);
    if (!rows[0]) throw new AppError('CATEGORY_NOT_FOUND', 'Category not found.', 404);
    return rows[0];
  }

  async #resolveSlug(name, provided, brandId, currentId = null) {
    let slug = provided ? provided : slugify(name);
    if (!slug || !isValidSlug(slug)) throw new AppError('CATEGORY_INVALID', 'Could not derive a valid slug.', 422);
    const clash = await query('SELECT id FROM categories WHERE slug = ? AND brand_id = ? AND id <> ? LIMIT 1', [slug, brandId, currentId || '']);
    if (clash[0]) throw new AppError('CATEGORY_SLUG_CONFLICT', `The slug "${slug}" is already in use.`, 409);
    return slug;
  }

  // parentId must be an existing root (parent_id IS NULL) IN THE SAME
  // COMPANY; a category that itself has children cannot be reparented under
  // another (keeps depth <= 2).
  async #validateParent(parentId, brandId, childId = null) {
    if (parentId == null) return null;
    if (parentId === childId) throw new AppError('CATEGORY_INVALID', 'A category cannot be its own parent.', 422);
    const parent = (await query('SELECT id, parent_id FROM categories WHERE id = ? AND brand_id = ? LIMIT 1', [parentId, brandId]))[0];
    if (!parent) throw new AppError('CATEGORY_INVALID', 'Parent category not found.', 422);
    if (parent.parent_id != null) throw new AppError('CATEGORY_INVALID', 'The taxonomy is two levels deep — a parent must be a top-level category.', 422);
    if (childId) {
      const kids = await query('SELECT COUNT(*) c FROM categories WHERE parent_id = ? AND brand_id = ?', [childId, brandId]);
      if (Number(kids[0].c) > 0) throw new AppError('CATEGORY_INVALID', 'This category has sub-categories and cannot become a sub-category itself.', 422);
    }
    return parentId;
  }

  async list(brandId) {
    const rows = await query('SELECT * FROM categories WHERE brand_id = ? ORDER BY (parent_id IS NOT NULL), display_order ASC, name ASC', [brandId]);
    const counts = await query(
      `SELECT pc.category_id, COUNT(*) AS c
         FROM product_categories pc
         JOIN products p ON p.id = pc.product_id
        WHERE p.brand_id = ?
        GROUP BY pc.category_id`,
      [brandId],
    );
    const countBy = new Map(counts.map((r) => [r.category_id, Number(r.c)]));
    const nameById = new Map(rows.map((r) => [r.id, r.name]));
    return {
      categories: rows.map((r) => ({
        ...categoryDto(r),
        parentName: r.parent_id ? nameById.get(r.parent_id) || null : null,
        productCount: countBy.get(r.id) || 0,
      })),
    };
  }

  // Summary counts for the Categories workbench insight strip. All real:
  // `productsMapped` is the count of DISTINCT products with at least one
  // category membership (never a sum of per-category counts).
  async facets(brandId) {
    const [[tot], [act], [roots], [mapped]] = await Promise.all([
      query('SELECT COUNT(*) c FROM categories WHERE brand_id = ?', [brandId]),
      query("SELECT COUNT(*) c FROM categories WHERE brand_id = ? AND status = 'ACTIVE'", [brandId]),
      query('SELECT COUNT(*) c FROM categories WHERE brand_id = ? AND parent_id IS NULL', [brandId]),
      query(
        `SELECT COUNT(DISTINCT pc.product_id) c
           FROM product_categories pc JOIN products p ON p.id = pc.product_id
          WHERE p.brand_id = ?`,
        [brandId],
      ),
    ]);
    const total = Number(tot.c);
    const rootCount = Number(roots.c);
    return {
      total,
      active: Number(act.c),
      roots: rootCount,
      children: total - rootCount,
      productsMapped: Number(mapped.c),
    };
  }

  // Flat CSV rows for export — the full tree, parents before their children,
  // in storefront display order. Returns { headers, rows }.
  async exportRows(brandId) {
    const { categories } = await this.list(brandId);
    const headers = ['Name', 'Slug', 'Parent', 'Display order', 'Product count', 'Status', 'Created', 'Updated'];
    const rows = categories.map((c) => [
      c.name, c.slug, c.parentName || '', c.displayOrder, c.productCount, c.status,
      c.createdAt ? new Date(c.createdAt).toISOString() : '',
      c.updatedAt ? new Date(c.updatedAt).toISOString() : '',
    ]);
    return { headers, rows };
  }

  async get(id, brandId) {
    const row = await this.#find(id, brandId);
    const children = await query('SELECT * FROM categories WHERE parent_id = ? AND brand_id = ? ORDER BY display_order ASC, name ASC', [id, brandId]);
    const productCount = Number((await query('SELECT COUNT(*) c FROM product_categories WHERE category_id = ?', [id]))[0].c);
    return { ...categoryDto(row), children: children.map(categoryDto), productCount };
  }

  async create(input, actor, brandId) {
    if (!input.name || !input.name.trim()) throw new AppError('CATEGORY_INVALID', 'Category name is required.', 422);
    const slug = await this.#resolveSlug(input.name, input.slug, brandId);
    await this.#validateParent(input.parentId ?? null, brandId);
    const status = STATUS.includes(input.status) ? input.status : 'ACTIVE';
    const id = randomUUID();
    await query(
      `INSERT INTO categories (id, brand_id, name, slug, description, parent_id, display_order, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      [id, brandId, input.name.trim(), slug, input.description ?? null, input.parentId ?? null, Number(input.displayOrder ?? 0), status],
    );
    await this.audit_(actor, { action: 'CATEGORY_CREATED', resourceType: 'category', resourceId: id, metadata: { name: input.name, slug } });
    return this.get(id, brandId);
  }

  async update(id, patch, actor, brandId) {
    const existing = await this.#find(id, brandId);
    const sets = [];
    const params = [];

    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw new AppError('CATEGORY_INVALID', 'Category name cannot be empty.', 422);
      sets.push('name = ?'); params.push(patch.name.trim());
    }
    let nextSlug = null;
    if (patch.slug !== undefined) {
      const slug = await this.#resolveSlug(patch.name || existing.name, patch.slug, brandId, id);
      sets.push('slug = ?'); params.push(slug);
      nextSlug = slug;
    }
    if (patch.description !== undefined) { sets.push('description = ?'); params.push(patch.description || null); }
    if (patch.displayOrder !== undefined) { sets.push('display_order = ?'); params.push(Number(patch.displayOrder)); }
    if (patch.status !== undefined) {
      if (!STATUS.includes(patch.status)) throw new AppError('CATEGORY_INVALID', 'Invalid status.', 422);
      sets.push('status = ?'); params.push(patch.status);
    }
    if (patch.parentId !== undefined) {
      await this.#validateParent(patch.parentId, brandId, id);
      sets.push('parent_id = ?'); params.push(patch.parentId ?? null);
    }
    if (!sets.length) throw new AppError('CATEGORY_INVALID', 'No fields to update.', 422);

    params.push(id, brandId);
    await query(`UPDATE categories SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ? AND brand_id = ?`, params);
    // Links written with the old URL keep finding this category.
    if (nextSlug && nextSlug !== existing.slug) await recordSlugHistory('CATEGORY', id, existing.slug, brandId);
    await this.audit_(actor, { action: 'CATEGORY_UPDATED', resourceType: 'category', resourceId: id, metadata: { fields: Object.keys(patch) } });
    return this.get(id, brandId);
  }

  async setStatus(id, status, actor, brandId) {
    await this.#find(id, brandId);
    if (!STATUS.includes(status)) throw new AppError('CATEGORY_INVALID', 'Invalid status.', 422);
    await query('UPDATE categories SET status = ?, updated_at = NOW(3) WHERE id = ? AND brand_id = ?', [status, id, brandId]);
    await this.audit_(actor, { action: 'CATEGORY_STATUS_CHANGED', resourceType: 'category', resourceId: id, metadata: { to: status } });
    return this.get(id, brandId);
  }

  async remove(id, actor, brandId, { confirmReferences = false } = {}) {
    const existing = await this.#find(id, brandId);
    const children = Number((await query('SELECT COUNT(*) c FROM categories WHERE parent_id = ? AND brand_id = ?', [id, brandId]))[0].c);
    if (children > 0) throw new AppError('CATEGORY_HAS_CHILDREN', 'Archive or reassign the sub-categories first.', 409);
    const mapped = Number((await query('SELECT COUNT(*) c FROM product_categories WHERE category_id = ?', [id]))[0].c);
    const legacy = Number((await query('SELECT COUNT(*) c FROM products WHERE category_id = ? AND brand_id = ?', [id, brandId]))[0].c);
    if (mapped + legacy > 0) throw new AppError('CATEGORY_IN_USE', `This category is still assigned to ${mapped || legacy} product(s). Reassign or archive it instead.`, 409);
    // Deleting an entity the website links to removes those links everywhere.
    // Refuse until the caller has seen where it is used and confirmed.
    const { references } = await findEntityReferences('CATEGORY', id, brandId);
    if (references.length && !confirmReferences) {
      throw new AppError('ENTITY_REFERENCED',
        `"${existing.name}" is used in ${references.length} place${references.length === 1 ? '' : 's'} on the website. Deleting it removes those links everywhere.`,
        409, { references });
    }
    await recordSlugHistory('CATEGORY', id, existing.slug, brandId);
    await query('DELETE FROM categories WHERE id = ? AND brand_id = ?', [id, brandId]);
    await this.audit_(actor, { action: 'CATEGORY_DELETED', resourceType: 'category', resourceId: id, metadata: {} });
    return { deleted: true };
  }

  // ---- product <-> category mapping ---------------------------------

  async getProductCategories(productId, brandId) {
    const product = (await query('SELECT id FROM products WHERE id = ? AND brand_id = ? LIMIT 1', [productId, brandId]))[0];
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);
    const rows = await query(
      `SELECT c.*, pc.is_primary, pc.position
       FROM product_categories pc JOIN categories c ON c.id = pc.category_id
       WHERE pc.product_id = ?
       ORDER BY pc.is_primary DESC, pc.position ASC`,
      [productId],
    );
    return { categories: rows.map((r) => ({ ...categoryDto(r), isPrimary: Boolean(r.is_primary), position: r.position })) };
  }

  /**
   * Transactional bulk replace. `items` = [{ categoryId, isPrimary? }, ...].
   * Exactly one primary (the flagged one, else the first). An empty list
   * clears every membership and nulls products.category_id.
   */
  async setProductCategories(productId, items, actor, brandId) {
    const product = (await query('SELECT id FROM products WHERE id = ? AND brand_id = ? LIMIT 1', [productId, brandId]))[0];
    if (!product) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);

    const ids = items.map((i) => i.categoryId);
    if (new Set(ids).size !== ids.length) throw new AppError('PRODUCT_MAPPING_INVALID', 'Duplicate category in the mapping.', 422);

    let primaryId = null;
    if (ids.length) {
      // Scoped by brand_id too — this is also what stops an admin from
      // mapping a product to another company's category id.
      const found = await query(
        `SELECT id, status FROM categories WHERE id IN (${ids.map(() => '?').join(',')}) AND brand_id = ?`,
        [...ids, brandId],
      );
      if (found.length !== ids.length) throw new AppError('PRODUCT_MAPPING_INVALID', 'One or more categories do not exist.', 422);
      const inactive = found.filter((c) => c.status !== 'ACTIVE');
      if (inactive.length) throw new AppError('PRODUCT_MAPPING_INVALID', 'Cannot map a product to an archived category.', 422);
      const flagged = items.find((i) => i.isPrimary);
      primaryId = flagged ? flagged.categoryId : ids[0];
    }

    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM product_categories WHERE product_id = ?', [productId]);
      for (let i = 0; i < items.length; i += 1) {
        await conn.execute(
          'INSERT INTO product_categories (product_id, category_id, is_primary, position, created_at) VALUES (?, ?, ?, ?, NOW(3))',
          [productId, items[i].categoryId, items[i].categoryId === primaryId ? 1 : 0, i],
        );
      }
      await conn.execute('UPDATE products SET category_id = ?, updated_at = NOW(3) WHERE id = ?', [primaryId, productId]);
    });

    await this.audit_(actor, { action: 'PRODUCT_CATEGORIES_SET', resourceType: 'product', resourceId: productId, metadata: { categoryIds: ids, primaryId } });
    return this.getProductCategories(productId, brandId);
  }
}


export const categoryService = new CategoryService();
