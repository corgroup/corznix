// Placeholder shipping profiles for local development.
//
// A CHECKOUT quote refuses with SHIPPING_DIMENSION_DATA_MISSING when
// SHIPPING_PROVIDER_MODE=REAL and any item has no shipping profile, so without
// these a developer running against a real carrier cannot reach checkout at
// all. They were previously created by hand, which meant that when a
// verification script deleted them they were simply gone — and the symptom
// showed up two suites later as an unrelated-looking quote failure.
//
// THESE ARE NOT REAL MERCHANDISING DATA. Weight and dimensions determine what
// a carrier actually charges, so shipping fictitious ones would misprice every
// order. Real per-product weights are a business input that has to come from
// whoever packs the goods; this refuses to run outside development for that
// reason, and only ever fills in products that have no profile at all — it
// never overwrites a real one.
//
//   npm run seed:shipping-profiles --workspace=server
import { randomUUID } from 'node:crypto';

const { env } = await import('../src/config/index.js');

if (env.NODE_ENV === 'production') {
  throw new Error('seed:shipping-profiles creates placeholder weights and must never run against production');
}

const { pool, query } = await import('../src/database/connection/pool.js');

// A mid-weight folded cotton garment in a polybag. Deliberately uniform: these
// are placeholders, and pretending otherwise by varying them would make them
// look like measured data.
const PLACEHOLDER = { weightGrams: 300, lengthMm: 300, widthMm: 250, heightMm: 40 };

try {
  const missing = await query(
    `SELECT p.id, p.name
       FROM products p
      WHERE p.status = 'ACTIVE'
        AND NOT EXISTS (SELECT 1 FROM product_shipping_profiles s WHERE s.product_id = p.id)
      ORDER BY p.name`);

  for (const product of missing) {
    // eslint-disable-next-line no-await-in-loop
    await query(
      `INSERT INTO product_shipping_profiles (id, product_id, weight_grams, length_mm, width_mm, height_mm)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [randomUUID(), product.id, PLACEHOLDER.weightGrams, PLACEHOLDER.lengthMm, PLACEHOLDER.widthMm, PLACEHOLDER.heightMm]);
  }

  const [after] = await query(
    `SELECT COUNT(*) total,
            SUM(CASE WHEN EXISTS (SELECT 1 FROM product_shipping_profiles s WHERE s.product_id = p.id) THEN 1 ELSE 0 END) covered
       FROM products p WHERE p.status = 'ACTIVE'`);

  console.log(JSON.stringify({
    filledIn: missing.map((p) => p.name),
    activeProducts: Number(after.total),
    withShippingProfile: Number(after.covered),
    placeholder: PLACEHOLDER,
    note: 'placeholder dimensions for local development — real weights are a business input',
  }, null, 2));

  if (Number(after.covered) !== Number(after.total)) {
    throw new Error('some active products still have no shipping profile');
  }
} finally {
  await pool.end();
}
