// Seeds the canonical "Oversized T-Shirt" size guide (real measurements
// supplied by the business) and assigns it — via the EXPLICIT
// products.size_guide_id mapping, never inference — to products that are
// actually oversized t-shirts.
//
// Idempotent: upserts by slug, replaces its rows, (re)assigns only the
// listed products. Safe to re-run.
//
//   npm run seed:size-guides
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';

const GUIDE = {
  slug: 'oversized-tshirt',
  name: 'Oversized T-Shirt',
  title: 'Oversized T-Shirt — Size Guide',
  description: 'Garment measurements for the CORCOTTON oversized t-shirt block. Lay the t-shirt flat and measure edge to edge.',
  notes: 'Chest and Width are measured at different points and are not interchangeable. Measurements have a tolerance of ±0.5 in.',
  unit: 'in',
  columns: ['size', 'chest', 'width', 'length', 'shoulder', 'sleeve'],
  rows: [
    { size: 'XS', in: { chest: 39, width: 19.5, length: 27.5, shoulder: 19.5, sleeve: 9 }, cm: { chest: 99, width: 50, length: 70, shoulder: 50, sleeve: 23 } },
    { size: 'S', in: { chest: 42, width: 21, length: 28, shoulder: 20, sleeve: 9 }, cm: { chest: 107, width: 53, length: 71, shoulder: 51, sleeve: 23 } },
    { size: 'M', in: { chest: 44, width: 22, length: 28.5, shoulder: 20.5, sleeve: 9.25 }, cm: { chest: 112, width: 56, length: 72, shoulder: 52, sleeve: 23.5 } },
    { size: 'L', in: { chest: 46, width: 23, length: 29, shoulder: 21, sleeve: 9.5 }, cm: { chest: 117, width: 58, length: 74, shoulder: 53, sleeve: 24 } },
    { size: 'XL', in: { chest: 48, width: 24, length: 29.5, shoulder: 21.5, sleeve: 9.75 }, cm: { chest: 122, width: 61, length: 75, shoulder: 55, sleeve: 25 } },
    { size: 'XXL', in: { chest: 50, width: 25, length: 30, shoulder: 22, sleeve: 10 }, cm: { chest: 127, width: 64, length: 76, shoulder: 56, sleeve: 25.5 } },
    { size: 'XXXL', in: { chest: 52, width: 26, length: 30.5, shoulder: 22.5, sleeve: 10.25 }, cm: { chest: 132, width: 66, length: 77, shoulder: 57, sleeve: 26 } },
  ],
};

// Explicit mapping — these product slugs, and only these. No title / category
// / SKU inference.
const ASSIGN_TO_SLUGS = ['oversized-cotton-tee'];

async function main() {
  // Multi-company (Phase 3) — size_guides is brand-scoped now; this is
  // Cor-Cotton's real size guide.
  const [cotton] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  const brandId = cotton.id;
  let guide = (await query('SELECT * FROM size_guides WHERE slug = ? AND brand_id = ? LIMIT 1', [GUIDE.slug, brandId]))[0];
  const id = guide?.id || randomUUID();

  if (guide) {
    await query(
      `UPDATE size_guides SET name = ?, title = ?, description = ?, notes = ?, unit = ?, columns_json = ?, status = 'ACTIVE', updated_at = NOW(3) WHERE id = ?`,
      [GUIDE.name, GUIDE.title, GUIDE.description, GUIDE.notes, GUIDE.unit, JSON.stringify(GUIDE.columns), id],
    );
    await query('DELETE FROM size_guide_rows WHERE size_guide_id = ?', [id]);
    console.log(`updated size guide ${GUIDE.slug} (${id})`);
  } else {
    await query(
      `INSERT INTO size_guides (id, brand_id, name, title, description, notes, slug, unit, columns_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW(3), NOW(3))`,
      [id, brandId, GUIDE.name, GUIDE.title, GUIDE.description, GUIDE.notes, GUIDE.slug, GUIDE.unit, JSON.stringify(GUIDE.columns)],
    );
    console.log(`created size guide ${GUIDE.slug} (${id})`);
  }

  for (let i = 0; i < GUIDE.rows.length; i += 1) {
    const row = GUIDE.rows[i];
    await query(
      `INSERT INTO size_guide_rows (id, size_guide_id, size, values_json, values_cm_json, display_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), id, row.size, JSON.stringify(row.in), JSON.stringify(row.cm), i],
    );
  }
  console.log(`  ${GUIDE.rows.length} rows`);

  for (const slug of ASSIGN_TO_SLUGS) {
    const product = (await query('SELECT id, name FROM products WHERE slug = ? LIMIT 1', [slug]))[0];
    if (!product) { console.log(`  SKIP assign: no product "${slug}"`); continue; }
    await query('UPDATE products SET size_guide_id = ?, updated_at = NOW(3) WHERE id = ?', [id, product.id]);
    console.log(`  assigned to "${product.name}" (${slug})`);
  }

  const assigned = await query('SELECT slug FROM products WHERE size_guide_id = ?', [id]);
  console.log(`\nOK — "${GUIDE.name}" mapped to: ${assigned.map((r) => r.slug).join(', ') || '(none)'}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
