// Phase 2 · Slice 3 — WarehouseResolver + carrier pickup-location mapping.
//   * migration 059: warehouse_provider_locations
//   * resolveOrigin picks the default / highest-priority ACTIVE warehouse,
//     nothing hardcoded; surfaces a missing origin PIN, never invents one
//   * providerLocation is null until a real identifier is mapped; stored verbatim
//   * NO_ELIGIBLE_WAREHOUSE when nothing is active
//
// Self-cleaning. REAL_PROVIDER_CALLS = 0.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, query } from '../src/database/connection/pool.js';
import { WarehouseResolver } from '../src/modules/shipping/warehouseResolver.js';
import { warehouseProviderLocationRepository } from '../src/modules/shipping/warehouseProviderRepository.js';
import { AppError } from '../src/utils/errors.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

const resolver = new WarehouseResolver();
let whId; let whNoPinId;

await acheck('migration_059_table', async () => {
  const rows = await query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'warehouse_provider_locations'`,
  );
  const cols = rows.map((r) => r.COLUMN_NAME);
  for (const c of ['warehouse_id', 'provider_code', 'provider_location_identifier', 'provider_return_identifier', 'registered_at', 'status']) {
    assert.ok(cols.includes(c), `column ${c} missing`);
  }
});

await acheck('setup_fixture', async () => {
  whId = randomUUID();
  await query(
    `INSERT INTO warehouses (id, brand_id, code, name, postal_code, city, state, priority, status, is_default, created_at, updated_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?, 'P2 Resolver WH', '201301', 'Noida', 'Uttar Pradesh', 1, 'ACTIVE', 0, NOW(3), NOW(3))`,
    [whId, `P2WH-${Date.now()}`],
  );
  whNoPinId = randomUUID();
  await query(
    `INSERT INTO warehouses (id, brand_id, code, name, postal_code, priority, status, is_default, created_at, updated_at)
     VALUES (?, (SELECT id FROM brands WHERE slug=\'corcotton\'), ?, 'P2 No-PIN WH', NULL, 2, 'ACTIVE', 0, NOW(3), NOW(3))`,
    [whNoPinId, `P2WHNP-${Date.now()}`],
  );
});

await acheck('resolve_origin_returns_a_real_warehouse', async () => {
  const origin = await resolver.resolveOrigin();
  assert.ok(origin.warehouseId, 'must resolve a warehouse id');
  assert.equal(typeof origin.originPincodeMissing, 'boolean');
  // explicit warehouseId path
  const explicit = await resolver.resolveOrigin({ warehouseId: whId });
  assert.equal(explicit.warehouseId, whId);
  assert.equal(explicit.postalCode, '201301');
  assert.equal(explicit.originPincodeMissing, false);
});

await acheck('missing_origin_pin_is_surfaced_not_faked', async () => {
  const origin = await resolver.resolveOrigin({ warehouseId: whNoPinId });
  assert.equal(origin.postalCode, null);
  assert.equal(origin.originPincodeMissing, true);
});

await acheck('provider_location_null_until_mapped', async () => {
  assert.equal(await resolver.providerLocation(whId, 'DELHIVERY'), null);
});

await acheck('provider_location_stored_verbatim', async () => {
  await warehouseProviderLocationRepository.upsert(whId, 'DELHIVERY', { identifier: 'CORCOTTON ND 01' });
  const loc = await resolver.providerLocation(whId, 'DELHIVERY');
  assert.equal(loc.identifier, 'CORCOTTON ND 01'); // spaces + case preserved exactly
  assert.equal(loc.returnIdentifier, 'CORCOTTON ND 01'); // falls back to pickup identifier
});

await acheck('provider_location_upsert_is_unique_per_pair', async () => {
  await warehouseProviderLocationRepository.upsert(whId, 'DELHIVERY', { identifier: 'CORCOTTON_ND_02', returnIdentifier: 'CORCOTTON_RET_01' });
  const rows = await query('SELECT COUNT(*) c FROM warehouse_provider_locations WHERE warehouse_id = ? AND provider_code = ?', [whId, 'DELHIVERY']);
  assert.equal(Number(rows[0].c), 1);
  const loc = await resolver.providerLocation(whId, 'DELHIVERY');
  assert.equal(loc.identifier, 'CORCOTTON_ND_02');
  assert.equal(loc.returnIdentifier, 'CORCOTTON_RET_01');
});

await acheck('disabled_location_is_not_returned', async () => {
  await warehouseProviderLocationRepository.upsert(whId, 'DELHIVERY', { identifier: 'CORCOTTON_ND_02', status: 'DISABLED' });
  assert.equal(await resolver.providerLocation(whId, 'DELHIVERY'), null);
});

await acheck('no_eligible_warehouse_throws', async () => {
  const stub = new WarehouseResolver({
    warehouses: { async activeOrderedByPriority() { return []; }, async findById() { return null; } },
    providerLocations: warehouseProviderLocationRepository,
  });
  await assert.rejects(() => stub.resolveOrigin(), (e) => e instanceof AppError && e.code === 'NO_ELIGIBLE_WAREHOUSE' && e.status === 409);
});

await acheck('cleanup', async () => {
  await query('DELETE FROM warehouse_provider_locations WHERE warehouse_id IN (?, ?)', [whId, whNoPinId]);
  await query('DELETE FROM warehouses WHERE id IN (?, ?)', [whId, whNoPinId]);
  const left = await query('SELECT COUNT(*) c FROM warehouses WHERE id = ?', [whId]);
  assert.equal(Number(left[0].c), 0);
});

console.log('\n──── Phase 2 · Slice 3 — warehouse resolver ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nWAREHOUSE_RESOLVER = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
await pool.end();
process.exitCode = failed.length === 0 ? 0 : 1;
