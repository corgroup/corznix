// Local development fixture: a small set of extra warehouses so the
// multi-warehouse allocation / fulfillment paths can be exercised by hand
// and in the CMS. TEST DATA ONLY — these names are not wired into any
// business logic; the allocation engine reads whatever warehouses exist.
//
// Idempotent. Optionally spreads a little stock across the new warehouses
// with --distribute (moves nothing off the default warehouse; just sets small
// on-hand so a split allocation is reachable).
//
//   node scripts/seed-warehouses.js [--distribute]
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { warehouseService } from '../src/modules/warehouses/service.js';

const distribute = process.argv.includes('--distribute');

const FIXTURES = [
  { code: 'WH-LUCKNOW', name: 'Lucknow Fulfilment Centre', city: 'Lucknow', state: 'Uttar Pradesh', postalCode: '226001', priority: 10 },
  { code: 'WH-GHAZIPUR', name: 'Ghazipur Fulfilment Centre', city: 'Ghazipur', state: 'Uttar Pradesh', postalCode: '233001', priority: 20 },
  { code: 'WH-VARANASI', name: 'Varanasi Fulfilment Centre', city: 'Varanasi', state: 'Uttar Pradesh', postalCode: '221001', priority: 30 },
];

async function main() {
  const [cottonBrand] = await query("SELECT id FROM brands WHERE slug='corcotton'");
  const summary = [];
  for (const fixture of FIXTURES) {
    const existing = await query('SELECT id FROM warehouses WHERE brand_id = ? AND code=? LIMIT 1', [cottonBrand.id, fixture.code]);
    let id;
    if (existing[0]) {
      id = existing[0].id;
      summary.push({ code: fixture.code, action: 'exists', id });
    } else {
      const created = await warehouseService.create({ ...fixture, country: 'IN', contactName: 'Ops', contactPhone: '9000000000', brandId: cottonBrand.id });
      id = created.id;
      summary.push({ code: fixture.code, action: 'created', id });
    }

    if (distribute) {
      const skus = await query("SELECT id FROM skus WHERE status='ACTIVE' ORDER BY id LIMIT 10");
      for (const sku of skus) {
        await query(
          `INSERT INTO inventory (id, brand_id,warehouse_id,sku_id,on_hand,reserved,created_at,updated_at)
           VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'),?,?,?,0,NOW(3),NOW(3))
           ON DUPLICATE KEY UPDATE updated_at=NOW(3)`,
          [randomUUID(), id, sku.id, 5],
        );
      }
    }
  }
  console.log(JSON.stringify({ warehouses: summary, distributedStock: distribute }, null, 2));
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => pool.end());
