// Site media — the key -> media-asset map behind the storefront's hero /
// banner slots. Data-ownership boundary only (Wave 8D): the storefront reads
// normalized URLs from here instead of bundling local files. A Home/Banner
// CMS (Wave 8E) would own the editing surface; this wave just moves the
// asset authority to the media registry.
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';
import { findMediaById } from '../media/service.js';

// The fixed vocabulary the storefront knows about. Adding a key here + a
// seed row is all it takes; nothing infers keys.
export const SITE_MEDIA_KEYS = Object.freeze([
  'home_hero_1',
  'home_hero_2',
  'promo_banner',
  'auth_banner',
  // The newsletter popup used to borrow auth_banner, so changing the popup's
  // artwork also changed the sign-in page. They are separate campaigns run by
  // separate people; they get separate slots.
  'newsletter_banner',
]);

function publicEntry(row) {
  return {
    key: row.media_key,
    url: row.url,
    mediaType: row.resource_type === 'video' ? 'video' : 'image',
    width: row.width,
    height: row.height,
    altText: row.alt_text || null,
  };
}

/** Storefront-facing map: { key: { url, mediaType, width, height, altText } }.
 * Public, unscoped by brand (implementation/multi-company/DESIGN.md — the
 * storefront host->brand mapping is Phase 4; safe today since Cor-Znix has
 * zero site_media rows). */
export async function getSiteMedia() {
  const rows = await query(
    `SELECT sm.media_key, sm.alt_text, m.url, m.resource_type, m.width, m.height
     FROM site_media sm
     JOIN media m ON m.id = sm.media_id
     WHERE m.status = 'ACTIVE'`,
  );
  const out = {};
  for (const row of rows) out[row.media_key] = publicEntry(row);
  return out;
}

/** Admin view — every key, whether set or not. Multi-company Phase 3: scoped
 * by the caller's brandId. */
export async function listSiteMedia(brandId) {
  const rows = await query(
    `SELECT sm.media_key, sm.alt_text, sm.updated_at, m.id AS media_id, m.url, m.resource_type, m.width, m.height, m.status
     FROM site_media sm JOIN media m ON m.id = sm.media_id
     WHERE sm.brand_id = ?`,
    [brandId],
  );
  const bound = new Map(rows.map((r) => [r.media_key, r]));
  return {
    siteMedia: SITE_MEDIA_KEYS.map((key) => {
      const r = bound.get(key);
      return {
        key,
        assigned: Boolean(r),
        mediaId: r?.media_id || null,
        url: r?.url || null,
        mediaType: r ? (r.resource_type === 'video' ? 'video' : 'image') : null,
        altText: r?.alt_text || null,
        assetStatus: r?.status || null,
        updatedAt: r?.updated_at || null,
      };
    }),
  };
}

/** Bind a key to an existing media asset. Multi-company Phase 3: `brandId`
 * is part of the primary key now (a key is per-company). */
export async function setSiteMedia(key, mediaId, { altText = null, staffId = null, brandId } = {}) {
  if (!SITE_MEDIA_KEYS.includes(key)) throw new AppError('SITE_MEDIA_KEY_INVALID', `Unknown site media key "${key}".`, 422);
  // brand_id is part of site_media's primary key. Without this guard an
  // omitting caller passes undefined straight into the bind array and gets a
  // driver-level TypeError instead of a usable error.
  if (!brandId) throw new AppError('BRAND_CONTEXT_REQUIRED', 'A brand context is required to set site media.', 400);
  const asset = await findMediaById(mediaId);
  if (!asset || asset.status !== 'ACTIVE') throw new AppError('MEDIA_NOT_FOUND', 'Media asset not found.', 404);
  await query(
    `INSERT INTO site_media (brand_id, media_key, media_id, alt_text, updated_by_staff_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NOW(3), NOW(3))
     ON DUPLICATE KEY UPDATE media_id = VALUES(media_id), alt_text = VALUES(alt_text),
       updated_by_staff_id = VALUES(updated_by_staff_id), updated_at = NOW(3)`,
    [brandId, key, mediaId, altText, staffId],
  );
  return listSiteMedia(brandId);
}
