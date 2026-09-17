// Seed the two standard GST tax profiles the admin selects per product:
//   GST 5%   — 5% of the taxable amount   (gst_rate_bps 500)
//   GST 12%  — 12% of the taxable amount  (gst_rate_bps 1200)
//
// Idempotent — keyed on the profile name. Run:  npm run seed:tax-profiles
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';

const PROFILES = [
  { name: 'GST 5%', description: '5% GST on the applicable taxable amount (apparel / garments).', hsn: '6109', bps: 500 },
  { name: 'GST 12%', description: '12% GST on the applicable taxable amount (apparel / garments).', hsn: '6103', bps: 1200 },
];

try {
  const today = new Date().toISOString().slice(0, 10);
  // Multi-company (Phase 3) — tax_profiles is brand-scoped now; this seed
  // is Cor-Cotton's real GST configuration.
  const [cotton] = await query("SELECT id FROM brands WHERE slug = 'corcotton' LIMIT 1");
  const brandId = cotton.id;
  for (const p of PROFILES) {
    const existing = await query('SELECT id, gst_rate_bps FROM tax_profiles WHERE name = ? AND brand_id = ? LIMIT 1', [p.name, brandId]);
    if (existing[0]) {
      if (Number(existing[0].gst_rate_bps) !== p.bps) {
        await query('UPDATE tax_profiles SET gst_rate_bps = ?, description = ?, status = ? WHERE id = ?', [p.bps, p.description, 'ACTIVE', existing[0].id]);
        console.log(`updated  ${p.name} -> ${p.bps} bps`);
      } else {
        console.log(`skip     ${p.name} (already ${p.bps} bps)`);
      }
      continue;
    }
    await query(
      `INSERT INTO tax_profiles (id, brand_id, name, description, hsn_sac, taxability, gst_rate_bps, effective_from, status)
       VALUES (?, ?, ?, ?, ?, 'TAXABLE', ?, ?, 'ACTIVE')`,
      [randomUUID(), brandId, p.name, p.description, p.hsn, p.bps, today],
    );
    console.log(`created  ${p.name} — ${p.bps} bps, HSN ${p.hsn}`);
  }
  console.log('\nTax profiles seeded.');
} finally {
  await pool.end();
}
