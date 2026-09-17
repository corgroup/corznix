// Product <-> media mapping operations for Product Studio (Wave 8D).
//
// Owns everything under /api/v1/admin/products/:id/media plus the Media
// Library surface. Reference-safe: detaching a mapping never deletes the
// provider asset; deleting an asset is refused while any product still maps
// it (see modules/media/service.js removeMediaAsset). Ordering is
// deterministic — a reorder rewrites positions inside one transaction using
// a temporary offset so the unique (product, variant, position) key never
// transiently collides.
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import * as mediaRegistry from '../media/service.js';

const POSITION_OFFSET = 100000; // transient space during a reorder

function mappingDto(row) {
  return {
    id: row.id,
    mediaId: row.media_id,
    variantId: row.variant_id,
    mediaType: row.media_type,
    url: row.url,
    altText: row.alt_text,
    position: row.position,
    isPrimary: Boolean(row.is_primary),
    status: row.status,
    asset: row.asset_provider_key ? {
      id: row.media_id,
      providerKey: row.asset_provider_key,
      externalId: row.asset_external_id,
      width: row.asset_width,
      height: row.asset_height,
      bytes: row.asset_bytes,
      format: row.asset_format,
      status: row.asset_status,
    } : null,
  };
}

const MAPPING_SELECT = `
  SELECT pm.*,
    m.provider_key AS asset_provider_key, m.external_id AS asset_external_id,
    m.width AS asset_width, m.height AS asset_height, m.bytes AS asset_bytes,
    m.format AS asset_format, m.status AS asset_status
  FROM product_media pm
  LEFT JOIN media m ON m.id = pm.media_id
`;

export class AdminCatalogMediaService {
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

  async #product(productId) {
    const rows = await query('SELECT id FROM products WHERE id = ? LIMIT 1', [productId]);
    if (!rows[0]) throw new AppError('PRODUCT_NOT_FOUND', 'Product not found.', 404);
    return rows[0];
  }

  async #assertVariantScope(productId, variantId) {
    if (variantId == null) return null;
    const rows = await query('SELECT id FROM product_variants WHERE id = ? AND product_id = ? LIMIT 1', [variantId, productId]);
    if (!rows[0]) throw new AppError('PRODUCT_MAPPING_INVALID', 'Variant does not belong to this product.', 422);
    return variantId;
  }

  async #mapping(productId, mappingId) {
    const rows = await query(`${MAPPING_SELECT} WHERE pm.id = ? AND pm.product_id = ? LIMIT 1`, [mappingId, productId]);
    if (!rows[0]) throw new AppError('MEDIA_NOT_FOUND', 'Media mapping not found on this product.', 404);
    return rows[0];
  }

  // Rows in one (product, variant) scope, active, ordered. Always runs on a
  // transaction connection.
  async #scopeRows(conn, productId, variantId) {
    const [rows] = await conn.execute(
      `SELECT id, position, is_primary, media_type FROM product_media
       WHERE product_id = ? AND status = 'ACTIVE' AND ${variantId == null ? 'variant_id IS NULL' : 'variant_id = ?'}
       ORDER BY position ASC`,
      variantId == null ? [productId] : [productId, variantId],
    );
    return rows;
  }

  async listForProduct(productId) {
    await this.#product(productId);
    const rows = await query(`${MAPPING_SELECT} WHERE pm.product_id = ? AND pm.status = 'ACTIVE' ORDER BY pm.variant_id IS NULL DESC, pm.variant_id, pm.position`, [productId]);
    return { media: rows.map(mappingDto) };
  }

  async attach(productId, input, actor) {
    await this.#product(productId);
    const variantId = await this.#assertVariantScope(productId, input.variantId ?? null);

    const asset = await mediaRegistry.findMediaById(input.mediaId);
    if (!asset || asset.status !== 'ACTIVE') throw new AppError('MEDIA_NOT_FOUND', 'Media asset not found.', 404);

    const id = randomUUID();
    const mediaType = asset.resourceType === 'video' ? 'VIDEO' : 'IMAGE';
    await withTransaction(async (conn) => {
      const scope = await this.#scopeRows(conn, productId, variantId);
      const nextPos = scope.length ? Math.max(...scope.map((r) => r.position)) + 1 : 0;
      const makePrimary = input.isPrimary || scope.length === 0;
      if (makePrimary && scope.length) {
        await conn.execute('UPDATE product_media SET is_primary = 0 WHERE product_id = ? AND status = \'ACTIVE\' AND ' + (variantId == null ? 'variant_id IS NULL' : 'variant_id = ?'), variantId == null ? [productId] : [productId, variantId]);
      }
      await conn.execute(
        `INSERT INTO product_media (id, product_id, variant_id, media_id, media_type, url, alt_text, position, is_primary, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))`,
        [id, productId, variantId, asset.id, mediaType, asset.url, input.altText ?? asset.altText ?? null, nextPos, makePrimary ? 1 : 0],
      );
    });

    await this.audit_(actor, { action: 'PRODUCT_MEDIA_ATTACHED', resourceType: 'product', resourceId: productId, metadata: { mappingId: id, mediaId: asset.id, variantId } });
    return this.#mapping(productId, id).then(mappingDto);
  }

  async updateMapping(productId, mappingId, patch, actor) {
    const row = await this.#mapping(productId, mappingId);
    const sets = [];
    const params = [];
    if (patch.altText !== undefined) { sets.push('alt_text = ?'); params.push(patch.altText); }
    if (sets.length) {
      params.push(mappingId);
      await query(`UPDATE product_media SET ${sets.join(', ')}, updated_at = NOW(3) WHERE id = ?`, params);
    }
    if (patch.isPrimary === true) return this.setPrimary(productId, mappingId, actor);

    if (sets.length) {
      await this.audit_(actor, { action: 'PRODUCT_MEDIA_UPDATED', resourceType: 'product', resourceId: productId, metadata: { mappingId, fields: Object.keys(patch) } });
    }
    return this.#mapping(productId, mappingId).then(mappingDto);
  }

  async setPrimary(productId, mappingId, actor) {
    const row = await this.#mapping(productId, mappingId);
    await withTransaction(async (conn) => {
      const scopeClause = row.variant_id == null ? 'variant_id IS NULL' : 'variant_id = ?';
      const scopeParams = row.variant_id == null ? [productId] : [productId, row.variant_id];
      await conn.execute(`UPDATE product_media SET is_primary = 0 WHERE product_id = ? AND status = 'ACTIVE' AND ${scopeClause}`, scopeParams);
      await conn.execute('UPDATE product_media SET is_primary = 1, updated_at = NOW(3) WHERE id = ?', [mappingId]);
    });
    await this.audit_(actor, { action: 'PRODUCT_MEDIA_PRIMARY_SET', resourceType: 'product', resourceId: productId, metadata: { mappingId, variantId: row.variant_id } });
    return this.#mapping(productId, mappingId).then(mappingDto);
  }

  async detach(productId, mappingId, actor) {
    const row = await this.#mapping(productId, mappingId);
    await withTransaction(async (conn) => {
      await conn.execute('DELETE FROM product_media WHERE id = ?', [mappingId]);
      // Re-close the position gap and re-seat primary if we removed it.
      const scopeClause = row.variant_id == null ? 'variant_id IS NULL' : 'variant_id = ?';
      const scopeParams = row.variant_id == null ? [productId] : [productId, row.variant_id];
      const [remaining] = await conn.execute(
        `SELECT id, is_primary FROM product_media WHERE product_id = ? AND status = 'ACTIVE' AND ${scopeClause} ORDER BY position ASC`,
        scopeParams,
      );
      await this.#resequence(conn, remaining.map((r) => r.id));
      if (row.is_primary && remaining.length && !remaining.some((r) => r.is_primary)) {
        await conn.execute('UPDATE product_media SET is_primary = 1 WHERE id = ?', [remaining[0].id]);
      }
    });
    await this.audit_(actor, { action: 'PRODUCT_MEDIA_DETACHED', resourceType: 'product', resourceId: productId, metadata: { mappingId, mediaId: row.media_id, assetRetained: true } });
    return { detached: true, assetRetained: true };
  }

  // Two-phase position rewrite so uk_product_media_position never collides
  // mid-update (offset every row, then set final 0..n-1).
  async #resequence(conn, orderedIds) {
    for (let i = 0; i < orderedIds.length; i += 1) {
      await conn.execute('UPDATE product_media SET position = ? WHERE id = ?', [POSITION_OFFSET + i, orderedIds[i]]);
    }
    for (let i = 0; i < orderedIds.length; i += 1) {
      await conn.execute('UPDATE product_media SET position = ?, updated_at = NOW(3) WHERE id = ?', [i, orderedIds[i]]);
    }
  }

  async reorder(productId, { variantId = null, orderedMappingIds }, actor) {
    await this.#product(productId);
    const scopeVariant = await this.#assertVariantScope(productId, variantId);
    await withTransaction(async (conn) => {
      const scope = await this.#scopeRows(conn, productId, scopeVariant);
      const scopeIds = new Set(scope.map((r) => r.id));
      if (orderedMappingIds.length !== scopeIds.size || !orderedMappingIds.every((id) => scopeIds.has(id))) {
        throw new AppError('PRODUCT_MAPPING_INVALID', 'The reorder list must contain exactly the current media of this scope.', 422);
      }
      await this.#resequence(conn, orderedMappingIds);
    });
    await this.audit_(actor, { action: 'PRODUCT_MEDIA_REORDERED', resourceType: 'product', resourceId: productId, metadata: { variantId: scopeVariant, count: orderedMappingIds.length } });
    return this.listForProduct(productId);
  }

  // Safe replace (blueprint §25): new asset persisted first, mapping switched
  // atomically, old asset cleaned up only if now unreferenced. A provider
  // cleanup failure never corrupts product state.
  async replace(productId, mappingId, { buffer, brandId, uploadedBy, originalFilename }, actor) {
    const row = await this.#mapping(productId, mappingId);
    const newAsset = await mediaRegistry.uploadMedia(buffer, { brandId, uploadedBy, originalFilename });
    const oldMediaId = row.media_id;
    const mediaType = newAsset.resourceType === 'video' ? 'VIDEO' : 'IMAGE';

    await query(
      'UPDATE product_media SET media_id = ?, url = ?, media_type = ?, updated_at = NOW(3) WHERE id = ?',
      [newAsset.id, newAsset.url, mediaType, mappingId],
    );

    let oldAssetRemoved = false;
    if (oldMediaId && oldMediaId !== newAsset.id) {
      const stillUsed = await mediaRegistry.referenceCount(oldMediaId);
      if (stillUsed === 0) {
        const res = await mediaRegistry.removeMediaAsset(oldMediaId);
        oldAssetRemoved = res.removed;
      }
    }
    await this.audit_(actor, { action: 'PRODUCT_MEDIA_REPLACED', resourceType: 'product', resourceId: productId, metadata: { mappingId, oldMediaId, newMediaId: newAsset.id, oldAssetRemoved } });
    return this.#mapping(productId, mappingId).then(mappingDto);
  }
}

export const adminCatalogMediaService = new AdminCatalogMediaService();
