// The homepage Instagram section (type INSTAGRAM_VIDEOS) — "Real People. Real
// Style.".
//
// The posts come from the store's own Instagram account through the official
// API (modules/instagram): synced into instagram_media, each with a copy of
// its picture in our Media Library. The section decides which of them show:
//   mode LATEST  the newest `limit` posts, automatically;
//   mode PICKED  the posts an editor picked, in the editor's order, each shown
//                or hidden.
// Only live posts with a picture are ever shown — a post deleted on Instagram
// or one whose picture could not be copied simply drops out.
import { query } from '../../database/connection/pool.js';

export const INSTAGRAM_LIMITS = Object.freeze({ minSeconds: 3, maxSeconds: 20, minShown: 3, maxShown: 12, maxPicks: 24, defaultShown: 8 });
export const INSTAGRAM_MODES = Object.freeze(['LATEST', 'PICKED']);

const kindOf = (row) => (row.media_product_type === 'REELS' || row.media_type === 'VIDEO' ? 'reel' : 'post');

/** What a card needs, and nothing else. */
function toPublicPost(row) {
  return {
    id: row.ig_media_id,
    kind: kindOf(row),
    permalink: row.permalink,
    // Instagram's public player for the post, opened in a popup on play.
    embedUrl: row.shortcode ? `https://www.instagram.com/p/${row.shortcode}/embed/` : null,
    coverUrl: row.cover_url,
    caption: row.caption ? row.caption.trim().slice(0, 140) : null,
  };
}

const LIVE_POSTS = `
  SELECT im.ig_media_id, im.media_type, im.media_product_type, im.permalink, im.shortcode, im.caption, m.url AS cover_url
    FROM instagram_media im
    JOIN media m ON m.id = im.cover_media_id AND m.status = 'ACTIVE' AND m.resource_type = 'image'
   WHERE im.brand_id = ? AND im.status = 'ACTIVE'`;

export async function loadInstagramPosts(brandId, config = {}) {
  if (config.mode === 'PICKED') {
    const picked = (Array.isArray(config.picks) ? config.picks : []).filter((p) => p && p.enabled !== false && p.igMediaId);
    if (!picked.length) return [];
    const ids = picked.map((p) => String(p.igMediaId));
    const rows = await query(`${LIVE_POSTS} AND im.ig_media_id IN (${ids.map(() => '?').join(',')})`, [brandId, ...ids]);
    const byId = new Map(rows.map((r) => [r.ig_media_id, r]));
    return ids.map((id) => byId.get(id)).filter(Boolean).map(toPublicPost);
  }
  const limit = Math.min(Math.max(Number(config.limit) || INSTAGRAM_LIMITS.defaultShown, INSTAGRAM_LIMITS.minShown), INSTAGRAM_LIMITS.maxShown);
  const rows = await query(`${LIVE_POSTS} ORDER BY im.posted_at DESC LIMIT ${limit}`, [brandId]);
  return rows.map(toPublicPost);
}

async function storefrontBrandId() {
  const [row] = await query('SELECT id FROM brands ORDER BY is_default DESC LIMIT 1');
  return row?.id ?? null;
}

/**
 * Public shape of Instagram sections: the copy plus `posts`. The editing
 * settings (mode, limit, picks) are not part of the storefront contract.
 */
export async function resolveInstagramSections(sections, { brandId } = {}) {
  const list = sections || [];
  if (!list.some((s) => s.type === 'INSTAGRAM_VIDEOS')) return list;
  const brand = brandId || await storefrontBrandId();
  return Promise.all(list.map(async (s) => {
    if (s.type !== 'INSTAGRAM_VIDEOS') return s;
    const { mode, limit, picks, ...copy } = s.config || {};
    const posts = brand ? await loadInstagramPosts(brand, { mode, limit, picks }) : [];
    return { ...s, config: { ...copy, posts } };
  }));
}
