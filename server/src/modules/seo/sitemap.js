import { Router } from 'express';
import { query } from '../../database/connection/pool.js';

// GET /api/v1/sitemap.xml — the storefront sitemap, generated from live
// catalog data for the requesting brand.
//
// The storefront is a static SPA bundle, so it cannot enumerate its own
// products at build time. Generating here keeps the sitemap correct as the
// catalog changes, with no build step and nothing to regenerate on publish.
//
// DEPLOYMENT: search engines only accept a sitemap that lives on the same host
// as the pages it lists, so the edge must proxy the storefront's /sitemap.xml
// to this endpoint. See docs/SEO.md.
//
// Only genuinely public, indexable URLs appear here: ACTIVE products and
// collections, PUBLISHED content pages. Account, cart, checkout and search are
// excluded — robots.txt disallows them and listing them would contradict it.

const router = Router();

const escapeXml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

const urlEntry = ({ loc, lastmod, changefreq, priority }) => [
  '  <url>',
  `    <loc>${escapeXml(loc)}</loc>`,
  lastmod ? `    <lastmod>${lastmod}</lastmod>` : null,
  changefreq ? `    <changefreq>${changefreq}</changefreq>` : null,
  priority ? `    <priority>${priority}</priority>` : null,
  '  </url>',
].filter(Boolean).join('\n');

/**
 * The public origin of the storefront this sitemap describes. Prefers the
 * brand's configured storefront_url (set in the CMS) — the API's own host is
 * NOT the site being indexed, so it must never leak into <loc>.
 */
async function storefrontOrigin(req) {
  if (req.brand?.storefrontUrl) return String(req.brand.storefrontUrl).replace(/\/+$/, '');
  const [row] = await query('SELECT storefront_url FROM brands WHERE id = ? LIMIT 1', [req.brandId]);
  if (row?.storefront_url) return String(row.storefront_url).replace(/\/+$/, '');
  return null;
}

router.get('/sitemap.xml', async (req, res, next) => {
  try {
    if (!req.brandId) { res.status(404).type('text/plain').send('No brand resolved for this host.'); return; }
    const origin = await storefrontOrigin(req);
    if (!origin) {
      // Refusing beats emitting a sitemap full of wrong-host URLs, which is
      // actively harmful — Google would treat every entry as uncrawlable.
      res.status(503).type('text/plain')
        .send('This brand has no storefront_url configured; a sitemap cannot be generated without it.');
      return;
    }

    const [products, collections, pages] = await Promise.all([
      query(
        `SELECT p.slug, v.storefront_id, GREATEST(p.updated_at, COALESCE(v.updated_at, p.updated_at)) AS updated_at
           FROM products p
           JOIN product_variants v ON v.product_id = p.id AND v.status = 'ACTIVE'
          WHERE p.status = 'ACTIVE' AND p.brand_id = ?
          ORDER BY v.storefront_id`, [req.brandId]),
      query("SELECT slug, updated_at FROM collections WHERE status = 'ACTIVE' AND brand_id = ? ORDER BY display_order", [req.brandId]),
      query("SELECT slug, updated_at FROM content_pages WHERE status = 'PUBLISHED' AND brand_id = ? ORDER BY slug", [req.brandId]),
    ]);

    const entries = [
      urlEntry({ loc: `${origin}/`, changefreq: 'daily', priority: '1.0' }),
      urlEntry({ loc: `${origin}/collections`, changefreq: 'weekly', priority: '0.8' }),
      ...collections.map((c) => urlEntry({
        loc: `${origin}/collections/${c.slug}`, lastmod: iso(c.updated_at), changefreq: 'weekly', priority: '0.8',
      })),
      ...products.filter((p) => p.storefront_id != null).map((p) => urlEntry({
        loc: `${origin}/products/${p.storefront_id}`, lastmod: iso(p.updated_at), changefreq: 'weekly', priority: '0.7',
      })),
      ...pages.map((p) => urlEntry({
        loc: `${origin}/pages/${p.slug}`, lastmod: iso(p.updated_at), changefreq: 'monthly', priority: '0.4',
      })),
    ];

    res.type('application/xml').send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>\n`,
    );
  } catch (err) { next(err); }
});

export default router;
