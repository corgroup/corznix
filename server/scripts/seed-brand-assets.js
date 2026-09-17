// Wires each brand's real mark into `brands.icon_svg` (DESIGN.md §3.1 —
// "inline SVG mark for the CMS sidebar"), the field the multi-company
// Phase 2 sidebar/switcher/company-selection screen render as the small
// brand mark. Source files are the real master assets, copied into the
// repo (database/seeds/assets/) so this script is portable/repeatable
// rather than reading from a machine-local path outside the repo.
//
// The matching wordmarks (database/seeds/assets/{corcotton,corznix}-
// wordmark.svg) are NOT wired into any field here — the schema's
// `icon_svg` is specifically the small square mark; there is no wide-logo
// slot in the CMS UI yet, so forcing a wordmark somewhere it doesn't fit
// would just look wrong. They stay in the repo, ready for whenever a real
// "wide logo" spot exists (e.g. the Phase 6 Settings/branding page,
// uploaded via the media pipeline into `brands.logo_media_id` instead of
// inlined here).
//
// Idempotent — keyed on brands.slug. Run: npm run seed:brand-assets
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, query } from '../src/database/connection/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = path.join(__dirname, '..', 'database', 'seeds', 'assets');

const ICON_ASSETS = {
  corcotton: 'corcotton-icon.svg',
  corznix: 'corznix-icon.svg',
};

try {
  for (const [slug, file] of Object.entries(ICON_ASSETS)) {
    const svg = await readFile(path.join(ASSETS_DIR, file), 'utf8');
    const rows = await query('SELECT id, icon_svg FROM brands WHERE slug = ? LIMIT 1', [slug]);
    const brand = rows[0];
    if (!brand) {
      console.log(`skip     ${slug} (no brand row)`);
      continue;
    }
    if (brand.icon_svg === svg) {
      console.log(`skip     ${slug} (icon_svg already up to date)`);
      continue;
    }
    await query('UPDATE brands SET icon_svg = ? WHERE id = ?', [svg, brand.id]);
    console.log(`updated  ${slug} -> icon_svg (${svg.length} bytes, from ${file})`);
  }
  console.log('\nBrand assets seeded.');
} finally {
  await pool.end();
}
