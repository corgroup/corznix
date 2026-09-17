// The logo emails use, taken from the same place the CMS sets it.
//
// The brand's appearance (Settings -> Company) already holds a logo in the
// media registry; email had no idea it existed and set the wordmark in type.
// Reading it here means changing the logo in the CMS changes the emails, with
// nothing to redeploy.
//
// Three sources, in order:
//   1. the brand's own logo from brand appearance (what the CMS saves),
//   2. /email-logo.png on the storefront — the committed wordmark, so a brand
//      with no logo set still gets one,
//   3. null, and the layout sets the brand in type (a local run with no public
//      URL, where a remote image would only be a broken box).
//
// Cached for a few minutes: an email send must not turn into a database read
// per message, and a logo change reaching the next batch of emails is soon
// enough.
import { query } from '../../database/connection/pool.js';
import { storefrontBaseUrl } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

const log = logger('communications-brand-logo');
const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, url: undefined };

/** The committed wordmark, when this host has a public storefront. */
export function storefrontLogoUrl() {
  const base = String(storefrontBaseUrl || '').replace(/\/+$/, '');
  return /^https?:\/\//i.test(base) && !/localhost|127\.0\.0\.1/i.test(base) ? `${base}/email-logo.png` : null;
}

/**
 * @param {string|null} brandSlug defaults to the storefront's own brand
 * @returns {Promise<string|null>}
 */
export async function emailLogoUrl(brandSlug = 'corcotton') {
  if (cache.url !== undefined && Date.now() - cache.at < TTL_MS) return cache.url;
  let url = null;
  try {
    const [row] = await query(
      `SELECT m.url FROM brands b JOIN media m ON m.id = b.logo_media_id
        WHERE b.slug = ? AND m.status = 'ACTIVE' LIMIT 1`, [brandSlug]);
    // Only an http(s) image is usable in an email: a client cannot fetch a
    // local path, and an SVG is dropped by Gmail and Outlook entirely.
    const candidate = String(row?.url || '');
    if (/^https?:\/\//i.test(candidate) && !/\.svg(\?|$)/i.test(candidate)) url = candidate;
  } catch (error) {
    // Never fail a send over a logo.
    log.warn('brand_logo_lookup_failed', { error: error.message });
  }
  cache = { at: Date.now(), url: url || storefrontLogoUrl() };
  return cache.url;
}

/** Test seam — the cache is process-wide and would outlive a fixture. */
export function resetEmailLogoCache() { cache = { at: 0, url: undefined }; }
