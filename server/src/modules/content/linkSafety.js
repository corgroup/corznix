// Link validation for CMS content (Wave 8E §24/§25/§101/§102/§143).
//
// Internal links reference an entity/route by type + target and are resolved
// to a path at snapshot time — a typo that points at a nonexistent
// collection/page is caught here, not silently published. External links
// must be http(s) only.
import { AppError } from '../../utils/errors.js';
import { query } from '../../database/connection/pool.js';

const DANGEROUS_SCHEME = /^\s*(javascript|data|vbscript|file):/i;

/** @throws {AppError} CONTENT_LINK_INVALID */
export function assertSafeExternalUrl(url) {
  if (!url || typeof url !== 'string') throw new AppError('CONTENT_LINK_INVALID', 'External link URL is required.', 422);
  if (DANGEROUS_SCHEME.test(url)) throw new AppError('CONTENT_LINK_INVALID', 'External links must not use javascript:/data:/file: schemes.', 422);
  let parsed;
  try { parsed = new URL(url); } catch { throw new AppError('CONTENT_LINK_INVALID', `"${url}" is not a valid URL.`, 422); }
  if (!/^https?:$/.test(parsed.protocol)) throw new AppError('CONTENT_LINK_INVALID', 'External links must be http(s).', 422);
}

/**
 * Href used inside page content (CONTACT rows, inline paragraph links).
 * Allows internal paths, mailto:, tel:, and http(s) — nothing else.
 * @throws {AppError} CONTENT_LINK_INVALID
 */
export function assertSafeHref(href) {
  if (!href || typeof href !== 'string') throw new AppError('CONTENT_LINK_INVALID', 'A link href is required.', 422);
  const h = href.trim();
  if (DANGEROUS_SCHEME.test(h)) throw new AppError('CONTENT_LINK_INVALID', 'Links must not use javascript:/data:/file: schemes.', 422);
  if (h.startsWith('/')) {
    if (h.includes('//')) throw new AppError('CONTENT_LINK_INVALID', `Invalid internal path "${href}".`, 422);
    return;
  }
  if (/^(mailto:[^\s]+@[^\s]+|tel:\+?[0-9()\-\s]+)$/i.test(h)) return;
  if (/^https?:\/\//i.test(h)) { assertSafeExternalUrl(h); return; }
  throw new AppError('CONTENT_LINK_INVALID', `Unsupported link "${href}" (use /path, mailto:, tel:, or https://).`, 422);
}

/** @throws {AppError} CONTENT_LINK_INVALID when the referenced entity does not exist */
export async function validateInternalTarget(linkType, target) {
  switch (linkType) {
    case 'HOME':
    case 'SEARCH':
    case 'ACCOUNT':
      return; // no target
    case 'COLLECTION':
    case 'CATEGORY': {
      if (!target) throw new AppError('CONTENT_LINK_INVALID', `${linkType} link needs a slug.`, 422);
      const [row] = linkType === 'CATEGORY'
        ? await query('SELECT 1 FROM categories WHERE slug = ? LIMIT 1', [target])
        : await query('SELECT 1 FROM collections WHERE slug = ? UNION SELECT 1 FROM categories WHERE slug = ? LIMIT 1', [target, target]);
      if (!row) throw new AppError('CONTENT_LINK_INVALID', `No ${linkType.toLowerCase()} with slug "${target}".`, 422);
      return;
    }
    case 'PRODUCT': {
      if (!target) throw new AppError('CONTENT_LINK_INVALID', 'PRODUCT link needs a slug.', 422);
      const [row] = await query('SELECT 1 FROM products WHERE slug = ? LIMIT 1', [target]);
      if (!row) throw new AppError('CONTENT_LINK_INVALID', `No product with slug "${target}".`, 422);
      return;
    }
    case 'CONTENT_PAGE': {
      if (!target) throw new AppError('CONTENT_LINK_INVALID', 'CONTENT_PAGE link needs a slug.', 422);
      // content_pages arrives in Phase 5; until then a page link is allowed
      // but flagged (the CMS surfaces "unpublished dependency", §159).
      const pageTable = await query("SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'content_pages' LIMIT 1");
      if (pageTable[0]) {
        const [row] = await query('SELECT 1 FROM content_pages WHERE slug = ? LIMIT 1', [target]);
        if (!row) throw new AppError('CONTENT_LINK_INVALID', `No content page with slug "${target}".`, 422);
      }
      return;
    }
    case 'CUSTOM_INTERNAL': {
      if (!target || !target.startsWith('/')) throw new AppError('CONTENT_LINK_INVALID', 'A custom internal link must start with "/".', 422);
      if (DANGEROUS_SCHEME.test(target) || target.includes('//')) throw new AppError('CONTENT_LINK_INVALID', 'Invalid internal path.', 422);
      return;
    }
    default:
      throw new AppError('CONTENT_LINK_INVALID', `Unknown link type "${linkType}".`, 422);
  }
}
