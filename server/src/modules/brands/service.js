import { query } from '../../database/connection/pool.js';
import { AppError } from '../../utils/errors.js';

/** @returns {Promise<import('@cor-group/shared-types').Brand[]>} */
export async function listBrands() {
  return query('SELECT id, name, slug, status, configuration, created_at, updated_at FROM brands ORDER BY name ASC');
}

/**
 * @param {string} slug
 * @returns {Promise<import('@cor-group/shared-types').Brand>}
 */
export async function getBrandBySlug(slug) {
  const rows = await query(
    'SELECT id, name, slug, status, configuration, created_at, updated_at FROM brands WHERE slug = ? LIMIT 1',
    [slug]
  );
  const brand = rows[0];
  if (!brand) {
    throw new AppError('BRAND_NOT_FOUND', `No brand found with slug "${slug}".`, 404);
  }
  return brand;
}
