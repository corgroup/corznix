// The `media` asset registry — one row per real provider-hosted asset,
// provider ownership recorded immutably (`provider_key` + `external_id`).
// Nothing here reads a provider-specific field: the normalized model comes
// from platform/media (see docs/MEDIA_ABSTRACTION.md / PROVIDER_PLATFORM_MIGRATION.md),
// and `metadata.provider` / `metadata.providerId` are the only bridge.
//
// Wave 8D: the Cloudinary-specific `cloudinary_public_id` column was renamed
// to `external_id` and `provider_key` added (migration 022). A future R2
// migration never rewrites an existing row's `provider_key`.
import { query } from '../../database/connection/pool.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '../../utils/errors.js';
import {
  uploadMedia as uploadViaProvider,
  removeMedia as removeViaProvider,
} from '../../platform/media/index.js';

function toDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    brandId: row.brand_id,
    providerKey: row.provider_key,
    externalId: row.external_id,
    url: row.url,
    resourceType: row.resource_type,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    format: row.format,
    altText: row.alt_text,
    originalFilename: row.original_filename,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * Upload a buffer through the provider boundary and persist the resulting
 * asset in the registry. The provider call happens OUTSIDE any DB
 * transaction (blueprint §54); if the INSERT then fails, the caller is
 * responsible for best-effort provider cleanup via `removeMediaAsset`.
 *
 * @param {Buffer} buffer
 * @param {{ brandId: string, uploadedBy?: string|null, folder?: string, originalFilename?: string|null }} params
 */
export async function uploadMedia(buffer, { brandId, uploadedBy = null, folder, originalFilename = null }) {
  const asset = await uploadViaProvider(buffer, { folder: folder || `brand/${brandId}` });

  const id = randomUUID();
  try {
    await query(
      `INSERT INTO media
         (id, brand_id, provider_key, external_id, url, resource_type, width, height, bytes, format, original_filename, uploaded_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
      [
        id, brandId,
        asset.metadata.provider, asset.metadata.providerId,
        asset.url, asset.mediaType,
        asset.width, asset.height, asset.size, asset.format,
        originalFilename, uploadedBy,
      ],
    );
  } catch (err) {
    // The provider asset now exists but is not persisted — orphan it back.
    await removeViaProvider(asset.metadata.providerId).catch(() => {});
    throw err;
  }

  return findMediaById(id);
}

export async function findMediaById(id) {
  const rows = await query('SELECT * FROM media WHERE id = ? LIMIT 1', [id]);
  return toDto(rows[0]);
}

export async function findMediaByUrl(url) {
  const rows = await query('SELECT * FROM media WHERE url = ? LIMIT 1', [url]);
  return toDto(rows[0]);
}

/**
 * How many protected references point at this asset — product_media mappings
 * plus site_media keys. Both block a reference-safe delete.
 */
export async function referenceCount(mediaId) {
  const [pm, sm, ig, hero] = await Promise.all([
    query('SELECT COUNT(*) AS c FROM product_media WHERE media_id = ?', [mediaId]),
    query('SELECT COUNT(*) AS c FROM site_media WHERE media_id = ?', [mediaId]),
    // An Instagram post's copied picture, shown on the homepage.
    query('SELECT COUNT(*) AS c FROM instagram_media WHERE cover_media_id = ?', [mediaId]),
    // A hero slide's desktop or phone picture.
    query('SELECT COUNT(*) AS c FROM hero_banners WHERE media_id = ? OR mobile_media_id = ?', [mediaId, mediaId]),
  ]);
  return Number(pm[0].c) + Number(sm[0].c) + Number(ig[0].c) + Number(hero[0].c);
}

/**
 * Confirm the provider really serves this asset before the registry claims it
 * does. A HEAD on the delivery URL is provider-neutral (any CDN-backed
 * provider answers it) and costs nothing, unlike a Cloudinary-specific Admin
 * API call which would leak provider detail into this boundary.
 */
async function assertAssetReachable(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let response;
  try {
    response = await fetch(url, { method: 'HEAD', signal: controller.signal });
  } catch {
    // Unreachable is not "absent" — but we still must not write an ACTIVE row
    // asserting an asset we could not confirm.
    throw new AppError('MEDIA_ASSET_UNVERIFIABLE', `Could not reach the media provider to confirm ${url}.`, 503);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new AppError('MEDIA_ASSET_NOT_AT_PROVIDER', `The provider does not serve ${url} (HTTP ${response.status}).`, 422);
  }
}

/**
 * Persist a registry row for an asset that ALREADY exists at the provider
 * (no upload). Used when a provider URL is supplied directly (e.g. an
 * existing hero video). Idempotent on URL.
 *
 * The asset is VERIFIED before the row is written. This function previously
 * took the caller's word for it, which is how the catalog ended up with ACTIVE
 * media rows pointing at assets the provider does not serve — the storefront
 * then renders a broken <img> with no way to tell that the row was never
 * backed by anything. `verify: false` exists only for callers that have
 * already confirmed existence by other means (e.g. an upload they just made).
 */
export async function registerExistingAsset({
  url, brandId, providerKey = 'cloudinary', externalId = null,
  resourceType = 'image', width = null, height = null, bytes = null, format = null, altText = null,
  verify = true,
}) {
  const existing = await findMediaByUrl(url);
  if (existing) return existing;
  if (verify) await assertAssetReachable(url);
  const id = randomUUID();
  await query(
    `INSERT INTO media
       (id, brand_id, provider_key, external_id, url, resource_type, width, height, bytes, format, alt_text, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    [id, brandId, providerKey, externalId, url, resourceType, width, height, bytes, format, altText],
  );
  return findMediaById(id);
}

/**
 * Reference-safe asset removal (blueprint §24). Refuses while any
 * product_media row still points at the asset unless `force` is set. On a
 * real removal the provider asset is deleted best-effort and the registry
 * row is ARCHIVED (never hard-deleted — provider ownership is history).
 *
 * @returns {Promise<{ removed: boolean, reason?: string, references?: number }>}
 */
export async function removeMediaAsset(mediaId, { force = false } = {}) {
  const asset = await findMediaById(mediaId);
  if (!asset) return { removed: false, reason: 'MEDIA_NOT_FOUND' };

  const refs = await referenceCount(mediaId);
  if (refs > 0 && !force) {
    return { removed: false, reason: 'MEDIA_ASSET_IN_USE', references: refs };
  }

  // Detach any remaining mappings first (force path) so the RESTRICT FK does
  // not block the archive, then archive + best-effort provider delete.
  if (refs > 0) {
    await query('UPDATE product_media SET media_id = NULL WHERE media_id = ?', [mediaId]);
  }
  await query("UPDATE media SET status = 'ARCHIVED' WHERE id = ?", [mediaId]);
  let providerRemoved = true;
  try {
    await removeViaProvider(asset.externalId);
  } catch {
    providerRemoved = false; // registry is already ARCHIVED; provider cleanup can be retried
  }
  return { removed: true, providerRemoved, detached: refs };
}

/** Paginated Media Library listing with per-asset usage count. */
export async function listMedia({ brandId = null, status = 'ACTIVE', q = null, page = 1, limit = 24 } = {}) {
  const where = [];
  const params = [];
  if (brandId) { where.push('m.brand_id = ?'); params.push(brandId); }
  if (status) { where.push('m.status = ?'); params.push(status); }
  if (q) { where.push('(m.external_id LIKE ? OR m.original_filename LIKE ? OR m.url LIKE ?)'); params.push(`%${q}%`, `%${q}%`, `%${q}%`); }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const total = Number((await query(`SELECT COUNT(*) AS c FROM media m ${whereSql}`, params))[0].c);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const offset = (safePage - 1) * limit;

  const rows = await query(
    `SELECT m.*, (SELECT COUNT(*) FROM product_media pm WHERE pm.media_id = m.id) AS usage_count
     FROM media m ${whereSql}
     ORDER BY m.created_at DESC
     LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)],
  );

  return {
    assets: rows.map((r) => ({ ...toDto(r), usageCount: Number(r.usage_count) })),
    total, page: safePage, totalPages,
  };
}
