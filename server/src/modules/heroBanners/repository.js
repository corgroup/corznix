import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

// Every read and write is brand-scoped. A missing brandId is a programming
// error, not an empty result — it throws, matching the convention the tax and
// reporting modules settled on.
const needBrand = (brandId) => {
  if (!brandId) throw new AppError('BRAND_REQUIRED', 'brandId is required for hero banners.', 500);
  return brandId;
};

/** The look a slide has unless it says otherwise — the columns' defaults (migration 110). */
export const HERO_DEFAULTS = Object.freeze({
  textPosition: 'BOTTOM_LEFT', mobileTextPosition: 'BOTTOM_LEFT', textTheme: 'LIGHT', overlay: 55, durationSeconds: 6,
});

// The media joins are LEFT JOINs on purpose: a slide may be saved before its
// picture is chosen, and losing the row from the admin list because it has no
// asset yet would be worse than showing it without a thumbnail. A phone
// picture that is no longer live is simply not used.
const SELECT = `
  SELECT hb.*, m.url AS media_url, m.resource_type AS media_type, m.alt_text AS media_alt_text,
         mm.url AS mobile_media_url, mm.resource_type AS mobile_media_type
    FROM hero_banners hb
    LEFT JOIN media m ON m.id = hb.media_id
    LEFT JOIN media mm ON mm.id = hb.mobile_media_id AND mm.status = 'ACTIVE'`;

const COLUMNS = {
  mediaId: 'media_id', mobileMediaId: 'mobile_media_id', title: 'title', subtitle: 'subtitle', ctaLabel: 'cta_label',
  ctaHref: 'cta_href', altText: 'alt_text', status: 'status', displayOrder: 'display_order',
  startsAt: 'starts_at', endsAt: 'ends_at', textPosition: 'text_position', mobileTextPosition: 'mobile_text_position',
  textTheme: 'text_theme', overlay: 'overlay', durationSeconds: 'duration_seconds',
};

export const heroBannerRepository = {
  list(brandId) {
    needBrand(brandId);
    return query(`${SELECT} WHERE hb.brand_id = ? ORDER BY hb.display_order, hb.created_at`, [brandId]);
  },

  /**
   * What the storefront renders: switched on and inside its schedule. Status
   * and schedule are deliberately separate — a slide can be switched on ahead
   * of time and still be correctly invisible until it starts.
   */
  listLive(brandId) {
    needBrand(brandId);
    return query(
      `${SELECT}
        WHERE hb.brand_id = ?
          AND hb.status = 'ACTIVE'
          AND hb.media_id IS NOT NULL
          AND (hb.starts_at IS NULL OR hb.starts_at <= NOW(3))
          AND (hb.ends_at   IS NULL OR hb.ends_at   >= NOW(3))
        ORDER BY hb.display_order, hb.created_at`, [brandId]);
  },

  async count(brandId) {
    needBrand(brandId);
    const [row] = await query('SELECT COUNT(*) AS c FROM hero_banners WHERE brand_id = ?', [brandId]);
    return Number(row.c);
  },

  byId(id, brandId) {
    needBrand(brandId);
    return query(`${SELECT} WHERE hb.id = ? AND hb.brand_id = ? LIMIT 1`, [id, brandId]).then((r) => r[0] || null);
  },

  async create(brandId, input, staffId) {
    needBrand(brandId);
    const id = randomUUID();
    // New slides land at the end rather than fighting for position 0.
    const [{ next }] = await query(
      'SELECT COALESCE(MAX(display_order), -1) + 1 AS next FROM hero_banners WHERE brand_id = ?', [brandId]);
    const row = { ...HERO_DEFAULTS, status: 'INACTIVE', displayOrder: Number(next), ...stripUndefined(input) };
    const keys = Object.keys(COLUMNS);
    await query(
      `INSERT INTO hero_banners (id, brand_id, ${keys.map((k) => COLUMNS[k]).join(', ')}, created_by_staff_id, updated_by_staff_id)
       VALUES (?, ?, ${keys.map(() => '?').join(', ')}, ?, ?)`,
      [id, brandId, ...keys.map((k) => row[k] ?? null), staffId ?? null, staffId ?? null]);
    return this.byId(id, brandId);
  },

  async update(id, brandId, patch, staffId) {
    needBrand(brandId);
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(COLUMNS)) {
      if (patch[key] !== undefined) { sets.push(`${column} = ?`); params.push(patch[key]); }
    }
    if (!sets.length) return this.byId(id, brandId);
    sets.push('updated_by_staff_id = ?');
    params.push(staffId ?? null, id, brandId);
    const result = await query(`UPDATE hero_banners SET ${sets.join(', ')} WHERE id = ? AND brand_id = ?`, params);
    if (!result.affectedRows) return null;
    return this.byId(id, brandId);
  },

  async remove(id, brandId) {
    needBrand(brandId);
    const r = await query('DELETE FROM hero_banners WHERE id = ? AND brand_id = ?', [id, brandId]);
    return r.affectedRows > 0;
  },

  /**
   * Positions are rewritten from the supplied order. Ids that do not belong to
   * this brand are simply not matched by the UPDATE, so a tampered list cannot
   * reorder another company's banners.
   */
  async reorder(brandId, orderedIds) {
    needBrand(brandId);
    for (let i = 0; i < orderedIds.length; i += 1) {
      await query('UPDATE hero_banners SET display_order = ? WHERE id = ? AND brand_id = ?', [i, orderedIds[i], brandId]);
    }
    return this.list(brandId);
  },

  /** This company's built-in hero slots, when they hold its own live assets. */
  legacyMedia(brandId, keys) {
    needBrand(brandId);
    return query(
      `SELECT sm.media_key, sm.media_id, sm.alt_text
         FROM site_media sm
         JOIN media m ON m.id = sm.media_id AND m.status = 'ACTIVE' AND m.brand_id = sm.brand_id
        WHERE sm.brand_id = ? AND sm.media_key IN (${keys.map(() => '?').join(', ')})`, [brandId, ...keys]);
  },
};

function stripUndefined(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}
