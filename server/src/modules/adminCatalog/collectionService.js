// Collection management + manual membership + product ordering (Wave 8D).
//
// Manual, curated collections only — no rule engine, no smart-collection DSL,
// no scheduler (§41). `product_collections.position` is the product's slot
// within the collection; a reorder rewrites the slots inside one transaction
// with a temporary offset so the unique (collection, position) key never
// transiently collides. An archived collection is hidden from the storefront
// (status = ARCHIVED); its membership is retained.
//
// Multi-company (implementation/multi-company/DESIGN.md §4.1, Phase 3):
// every method takes the caller's `brandId` (from `req.brandId`, resolved
// by `resolveBrandContext`) and scopes every query by it.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { slugify, isValidSlug } from '../../utils/slug.js';
import { findEntityReferences, recordSlugHistory } from '../content/entityLinks.js';
import { StaffAuditRepository } from '../staff/repositories.js';

const STATUS = ['ACTIVE', 'ARCHIVED'];
const POSITION_OFFSET = 100000;

function collectionDto(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description || null,
    status: row.status,
    displayOrder: row.display_order,
    publishedAt: row.published_at ? new Date(row.published_at).toISOString() : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class CollectionService {
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
    const rows = await query('SELECT * FROM collections WHERE id = ? AND brand_id = ? LIMIT 1', [id, brandId]);
    if (!rows[0]) throw new AppError('COLLECTION_NOT_FOUND', 'Collection not found.', 404);
    return rows[0];
  }

  async #resolveSlug(name, provided, brandId, currentId = null) {
    const slug = provided ? provided : slugify(name);
    if (!slug || !isValidSlug(slug)) throw new AppError('COLLECTION_INVALID', 'Could not derive a valid slug.', 422);
    const clash = await query('SELECT id FROM collections WHERE slug = ? AND brand_id = ? AND id <> ? LIMIT 1', [slug, brandId, currentId || '']);
    if (clash[0]) throw new AppError('COLLECTION_SLUG_CONFLICT', `The slug "${slug}" is already in use.`, 409);
    return slug;
  }

  async #members(collectionId) {
    return query(
      `SELECT pc.position, p.id, p.name, p.slug, p.status,
        -- media_type = 'IMAGE': a GRADIENT row holds a CSS gradient string in
        -- the url column, and this column is rendered as a photo.
        (SELECT pm.url FROM product_media pm WHERE pm.product_id = p.id AND pm.status = 'ACTIVE'
           AND pm.media_type = 'IMAGE'
         ORDER BY pm.is_primary DESC, pm.position ASC LIMIT 1) AS image_url
       FROM product_collections pc JOIN products p ON p.id = pc.product_id
       WHERE pc.collection_id = ?
       ORDER BY pc.position ASC`,
      [collectionId],
    );
  }

  async list(brandId) {
    const rows = await query('SELECT * FROM collections WHERE brand_id = ? ORDER BY display_order ASC, name ASC', [brandId]);
    const counts = await query(
      `SELECT pc.collection_id, COUNT(*) all_c,
        SUM(EXISTS (SELECT 1 FROM products p WHERE p.id = pc.product_id AND p.status = 'ACTIVE')) active_c
       FROM product_collections pc
       JOIN collections c ON c.id = pc.collection_id
       WHERE c.brand_id = ?
       GROUP BY pc.collection_id`,
      [brandId],
    );
    const by = new Map(counts.map((r) => [r.collection_id, r]));
    // Up to 4 member thumbnails per collection for the list view (real
    // product media, primary first), in membership order.
    const thumbs = rows.length
      ? await query(
          `SELECT t.collection_id, t.url FROM (
             SELECT pc.collection_id, pc.position,
               (SELECT pm.url FROM product_media pm
                 WHERE pm.product_id = pc.product_id AND pm.status = 'ACTIVE'
                   AND pm.media_type = 'IMAGE'
                 ORDER BY pm.is_primary DESC, pm.position ASC LIMIT 1) AS url
             FROM product_collections pc
             JOIN collections c ON c.id = pc.collection_id
             WHERE c.brand_id = ?
           ) t
           WHERE t.url IS NOT NULL
           ORDER BY t.collection_id, t.position ASC`,
          [brandId],
        )
      : [];
    const thumbsBy = new Map();
    for (const t of thumbs) {
      const list = thumbsBy.get(t.collection_id) || [];
      if (list.length < 4) { list.push(t.url); thumbsBy.set(t.collection_id, list); }
    }
    return {
      collections: rows.map((r) => {
        const cc = by.get(r.id);
        return {
          ...collectionDto(r),
          productCount: cc ? Number(cc.all_c) : 0,
          activeProductCount: cc ? Number(cc.active_c) : 0,
          thumbnails: thumbsBy.get(r.id) || [],
        };
      }),
    };
  }

  // Insight-strip counts for the Collections workbench. `productsAssigned` is
  // the count of DISTINCT products in at least one collection.
  async facets(brandId) {
    const [[tot], [act], [assigned]] = await Promise.all([
      query('SELECT COUNT(*) c FROM collections WHERE brand_id = ?', [brandId]),
      query("SELECT COUNT(*) c FROM collections WHERE brand_id = ? AND status = 'ACTIVE'", [brandId]),
      query(
        `SELECT COUNT(DISTINCT pc.product_id) c
           FROM product_collections pc JOIN collections c ON c.id = pc.collection_id
          WHERE c.brand_id = ?`,
        [brandId],
      ),
    ]);
    return {
      total: Number(tot.c),
      active: Number(act.c),
      productsAssigned: Number(assigned.c),
      // Collections are always manually merchandised (membership + order set
      // by staff, honoured by the storefront via ?sort=manual).
      manualOrder: true,
    };
  }

  async exportRows(brandId) {
    const { collections } = await this.list(brandId);
    const headers = ['Name', 'Slug', 'Products', 'Active products', 'Display order', 'Status', 'Created', 'Updated'];
    const rows = collections.map((c) => [
      c.name, c.slug, c.productCount, c.activeProductCount, c.displayOrder, c.status,
      c.createdAt ? new Date(c.createdAt).toISOString() : '',
      c.updatedAt ? new Date(c.updatedAt).toISOString() : '',
    ]);
    return { headers, rows };
  }

  async get(id, brandId) {
    const row = await this.#find(id, brandId);
    const members = await this.#members(id);
    return {
      ...collectionDto(row),
      productCount: members.length,
      members: members.map((m) => ({
        id: m.id, name: m.name, slug: m.slug, status: m.status,
        position: m.position, imageUrl: m.image_url || null,
      })),
    };
  }

  async create(input, actor, brandId) {
    if (!input.name || !input.name.trim()) throw new AppError('COLLECTION_INVALID', 'Collection name is required.', 422);
    const slug = await this.#resolveSlug(input.name, input.slug, brandId);
    const status = STATUS.includes(input.status) ? input.status : 'ACTIVE';
    const id = randomUUID();
    await query(
      `INSERT INTO collections (id, brand_id, name, slug, description, status, display_order, published_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3), NOW(3))`,
      [id, brandId, input.name.trim(), slug, input.description ?? null, status, Number(input.displayOrder ?? 0),
        status === 'ACTIVE' ? new Date() : null],
    );
    await this.audit_(actor, { action: 'COLLECTION_CREATED', resourceType: 'collection', resourceId: id, metadata: { name: input.name, slug } });
    return this.get(id, brandId);
  }

  async update(id, patch, actor, brandId) {
    const existing = await this.#find(id, brandId);
    const sets = [];
    const params = [];
    if (patch.name !== undefined) {
      if (!patch.name || !patch.name.trim()) throw new AppError('COLLECTION_INVALID', 'Collection name cannot be empty.', 422);
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
      if (!STATUS.includes(patch.status)) throw new AppError('COLLECTION_INVALID', 'Invalid status.', 422);
      sets.push('status = ?'); params.push(patch.status);
      if (patch.status === 'ACTIVE' && !existing.published_at) { sets.push('published_at = ?'); params.push(new Date()); }
    }
    if (!sets.length) throw new AppError('COLLECTION_INVALID', 'No fields to update.', 422);
    params.push(id, brandId);
    await query(`UPDATE collections SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ? AND brand_id = ?`, params);
    // Links written with the old URL keep finding this collection.
    if (nextSlug && nextSlug !== existing.slug) await recordSlugHistory('COLLECTION', id, existing.slug, brandId);
    await this.audit_(actor, { action: 'COLLECTION_UPDATED', resourceType: 'collection', resourceId: id, metadata: { fields: Object.keys(patch) } });
    return this.get(id, brandId);
  }

  async setStatus(id, status, actor, brandId) {
    return this.update(id, { status }, actor, brandId);
  }

  async remove(id, actor, brandId, { confirmReferences = false } = {}) {
    const existing = await this.#find(id, brandId);
    const members = Number((await query('SELECT COUNT(*) c FROM product_collections WHERE collection_id = ?', [id]))[0].c);
    if (members > 0) throw new AppError('COLLECTION_IN_USE', `This collection has ${members} product(s). Empty or archive it instead.`, 409);
    // Deleting an entity the website links to removes those links everywhere.
    // Refuse until the caller has seen where it is used and confirmed.
    const { references } = await findEntityReferences('COLLECTION', id, brandId);
    if (references.length && !confirmReferences) {
      throw new AppError('ENTITY_REFERENCED',
        `"${existing.name}" is used in ${references.length} place${references.length === 1 ? '' : 's'} on the website. Deleting it removes those links everywhere.`,
        409, { references });
    }
    await recordSlugHistory('COLLECTION', id, existing.slug, brandId);
    await query('DELETE FROM collections WHERE id = ? AND brand_id = ?', [id, brandId]);
    await this.audit_(actor, { action: 'COLLECTION_DELETED', resourceType: 'collection', resourceId: id, metadata: {} });
    return { deleted: true };
  }

  // ---- membership ---------------------------------------------------

  async #resequence(conn, collectionId, orderedProductIds) {
    for (let i = 0; i < orderedProductIds.length; i += 1) {
      await conn.execute('UPDATE product_collections SET position = ? WHERE collection_id = ? AND product_id = ?',
        [POSITION_OFFSET + i, collectionId, orderedProductIds[i]]);
    }
    for (let i = 0; i < orderedProductIds.length; i += 1) {
      await conn.execute('UPDATE product_collections SET position = ? WHERE collection_id = ? AND product_id = ?',
        [i, collectionId, orderedProductIds[i]]);
    }
  }

  async #validateProducts(productIds, brandId) {
    if (productIds.length === 0) return;
    if (new Set(productIds).size !== productIds.length) throw new AppError('PRODUCT_MAPPING_INVALID', 'Duplicate product in the membership list.', 422);
    // Scoped by brand_id — this is also what stops an admin from adding
    // another company's product to a collection.
    const found = await query(`SELECT id FROM products WHERE id IN (${productIds.map(() => '?').join(',')}) AND brand_id = ?`, [...productIds, brandId]);
    if (found.length !== productIds.length) throw new AppError('PRODUCT_MAPPING_INVALID', 'One or more products do not exist.', 422);
  }

  async setMembers(collectionId, productIds, actor, brandId) {
    await this.#find(collectionId, brandId);
    await this.#validateProducts(productIds, brandId);
    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM product_collections WHERE collection_id = ?', [collectionId]);
      for (let i = 0; i < productIds.length; i += 1) {
        await conn.execute(
          'INSERT INTO product_collections (product_id, collection_id, position, created_at) VALUES (?, ?, ?, NOW(3))',
          [productIds[i], collectionId, i],
        );
      }
    });
    await this.audit_(actor, { action: 'COLLECTION_MEMBERS_SET', resourceType: 'collection', resourceId: collectionId, metadata: { count: productIds.length } });
    return this.get(collectionId, brandId);
  }

  async addMember(collectionId, productId, actor, brandId) {
    await this.#find(collectionId, brandId);
    await this.#validateProducts([productId], brandId);
    const exists = await query('SELECT 1 FROM product_collections WHERE collection_id = ? AND product_id = ? LIMIT 1', [collectionId, productId]);
    if (exists[0]) return this.get(collectionId, brandId); // idempotent
    const nextPos = Number((await query('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM product_collections WHERE collection_id = ?', [collectionId]))[0].p);
    await query('INSERT INTO product_collections (product_id, collection_id, position, created_at) VALUES (?, ?, ?, NOW(3))', [productId, collectionId, nextPos]);
    await this.audit_(actor, { action: 'COLLECTION_MEMBER_ADDED', resourceType: 'collection', resourceId: collectionId, metadata: { productId } });
    return this.get(collectionId, brandId);
  }

  async removeMember(collectionId, productId, actor, brandId) {
    await this.#find(collectionId, brandId);
    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM product_collections WHERE collection_id = ? AND product_id = ?', [collectionId, productId]);
      const [remaining] = await conn.execute(
        'SELECT product_id FROM product_collections WHERE collection_id = ? ORDER BY position ASC', [collectionId],
      );
      await this.#resequence(conn, collectionId, remaining.map((r) => r.product_id));
    });
    await this.audit_(actor, { action: 'COLLECTION_MEMBER_REMOVED', resourceType: 'collection', resourceId: collectionId, metadata: { productId } });
    return this.get(collectionId, brandId);
  }

  async reorder(collectionId, orderedProductIds, actor, brandId) {
    await this.#find(collectionId, brandId);
    await withTransaction(async (conn) => {
      const [current] = await conn.execute('SELECT product_id FROM product_collections WHERE collection_id = ?', [collectionId]);
      const ids = new Set(current.map((r) => r.product_id));
      if (orderedProductIds.length !== ids.size || !orderedProductIds.every((id) => ids.has(id))) {
        throw new AppError('PRODUCT_MAPPING_INVALID', 'The reorder list must contain exactly the current members.', 422);
      }
      await this.#resequence(conn, collectionId, orderedProductIds);
    });
    await this.audit_(actor, { action: 'COLLECTION_REORDERED', resourceType: 'collection', resourceId: collectionId, metadata: { count: orderedProductIds.length } });
    return this.get(collectionId, brandId);
  }
}

export const collectionService = new CollectionService();
