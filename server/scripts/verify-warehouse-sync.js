/**
 * verify:warehouse-sync — CMS warehouse <-> carrier pickup-location coupling.
 *
 * Proves BEHAVIOUR against a stub carrier, not configuration:
 *   1  create payload carries every field Delhivery marks mandatory
 *   2  the pickup-location `name` is passed through verbatim (case + spaces)
 *   3  a carrier rejection does NOT write a mapping row
 *   4  a successful register DOES write the mapping, with registered_at set
 *   5  an address edit is pushed to the carrier
 *   6  a carrier failure on edit surfaces loudly (never a silent divergence)
 *   7  the edit payload never tries to rename (`name` is immutable)
 *   8  drift detection flags a hand-entered identifier and a missing mapping
 */
import assert from 'node:assert/strict';
import { buildWarehouseCreatePayload, buildWarehouseEditPayload, parseWarehouseResponse } from '../src/modules/shipping/providers/delhiveryWarehouse.js';
import { WarehouseSyncService } from '../src/modules/shipping/warehouseSyncService.js';
import { PROVIDER_CODES } from '../src/modules/shipping/providerContract.js';

let pass = 0; const fail = [];
const check = (name, fn) => {
  try { fn(); pass += 1; console.log(`  PASS  ${name}`); }
  catch (err) { fail.push(name); console.log(`  FAIL  ${name} — ${err.message}`); }
};
const checkAsync = async (name, fn) => {
  try { await fn(); pass += 1; console.log(`  PASS  ${name}`); }
  catch (err) { fail.push(name); console.log(`  FAIL  ${name} — ${err.message}`); }
};

const WAREHOUSE = {
  id: 'wh-1',
  code: 'b0a806-MSCORCOTTON-do-B2C',
  name: 'CORCOTTON Parsu Pur Warehouse',
  addressLine1: 'Parsu Pur', addressLine2: 'Ghazipur',
  city: 'Ghazipur', state: 'Uttar Pradesh', country: 'India',
  postalCode: '233230', contactName: 'CORCOTTON', contactPhone: '9319987171',
  contactEmail: 'ops@corcotton.in', status: 'ACTIVE',
};

// ---- stub carrier + stub mapping store -------------------------------
function makeRegistry(adapter) {
  return { resolve: (code) => (code === PROVIDER_CODES.DELHIVERY ? adapter : null) };
}
function makeAdapter({ onCreate, onUpdate } = {}) {
  return {
    implemented: true, configured: true,
    supports: (op) => ['createPickupLocation', 'updatePickupLocation'].includes(op),
    createPickupLocation: onCreate ?? (async (w) => ({ providerLocationName: w.providerLocationName, registeredAt: new Date() })),
    updatePickupLocation: onUpdate ?? (async (name) => ({ providerLocationName: name })),
  };
}
function makeStore(seed = []) {
  const rows = [...seed];
  return {
    rows,
    async upsert(warehouseId, providerCode, patch) {
      const row = {
        warehouse_id: warehouseId, provider_code: providerCode,
        provider_location_identifier: patch.identifier,
        registered_at: patch.registeredAt ?? null, pickup_mode: patch.pickupMode,
        status: patch.status, notes: patch.notes,
      };
      rows.push(row); return row;
    },
    async find(warehouseId, providerCode) {
      return rows.find((r) => r.warehouse_id === warehouseId && r.provider_code === providerCode) ?? null;
    },
    async listForProvider(providerCode) { return rows.filter((r) => r.provider_code === providerCode); },
  };
}

console.log('\nverify:warehouse-sync');

// 1 — mandatory fields
check('create payload carries every carrier-mandatory field', () => {
  const p = buildWarehouseCreatePayload(WAREHOUSE);
  for (const f of ['name', 'phone', 'pin', 'return_address']) {
    assert.ok(p[f], `missing mandatory field ${f}`);
  }
  assert.equal(p.pin, '233230');
  // Every field the carrier's warehouse contract names, and no field renamed.
  for (const f of ['phone', 'city', 'name', 'pin', 'address', 'country', 'email',
    'registered_name', 'return_address', 'return_pin', 'return_city', 'return_state', 'return_country']) {
    assert.ok(f in p, `create payload is missing the contract field ${f}`);
  }
});

// 1b — the carrier wants a bare 10-digit number, we store E.164
check('pickup phone is sent in the format the carrier uses', () => {
  const e164 = buildWarehouseCreatePayload({ ...WAREHOUSE, contactPhone: '+919278092710' });
  assert.equal(e164.phone, '9278092710');
  assert.equal(buildWarehouseCreatePayload({ ...WAREHOUSE, contactPhone: '09319987171' }).phone, '9319987171');
  assert.equal(buildWarehouseCreatePayload({ ...WAREHOUSE, contactPhone: '9319987171' }).phone, '9319987171');
  assert.equal(buildWarehouseEditPayload('X', { postalCode: '233230', contactPhone: '+919278092710' }).phone, '9278092710');
  // Anything that is not recognisably an Indian number is passed through
  // rather than silently truncated into a different number.
  assert.equal(buildWarehouseCreatePayload({ ...WAREHOUSE, contactPhone: '+1 415 555 0134' }).phone, '+1 415 555 0134');
});

// 2 — the join key is sacred
check('pickup-location name is passed through verbatim', () => {
  const p = buildWarehouseCreatePayload({ ...WAREHOUSE, providerLocationName: '  Mixed Case Name  ' });
  // .trim() only strips the operator's stray padding; inner case/spaces stay.
  assert.equal(p.name, 'Mixed Case Name');
  const q = buildWarehouseCreatePayload(WAREHOUSE);
  assert.equal(q.name, 'b0a806-MSCORCOTTON-do-B2C');
});

// 3 — a rejection must not create a mapping
await checkAsync('carrier rejection writes NO mapping row', async () => {
  const store = makeStore();
  const svc = new WarehouseSyncService({
    registry: makeRegistry(makeAdapter({
      onCreate: async () => { const e = new Error('SHIPPING_PROVIDER_REJECTED'); e.providerMessage = 'ClientWarehouse with this name already exists'; throw e; },
    })),
    locations: store,
  });
  await assert.rejects(() => svc.register(WAREHOUSE), (e) => e.code === 'WAREHOUSE_SYNC_REJECTED');
  assert.equal(store.rows.length, 0, 'a mapping was written despite carrier rejection');
});

// 4 — success writes the mapping, proven registered
await checkAsync('successful register persists mapping with registered_at', async () => {
  const store = makeStore();
  const svc = new WarehouseSyncService({ registry: makeRegistry(makeAdapter()), locations: store });
  const row = await svc.register(WAREHOUSE);
  assert.equal(row.provider_location_identifier, 'b0a806-MSCORCOTTON-do-B2C');
  assert.ok(row.registered_at, 'registered_at not set');
  assert.equal(row.status, 'ACTIVE');
});

// 5 — address change reaches the carrier
await checkAsync('address change is pushed to the carrier', async () => {
  let sent = null;
  const store = makeStore([{
    warehouse_id: 'wh-1', provider_code: PROVIDER_CODES.DELHIVERY,
    provider_location_identifier: 'b0a806-MSCORCOTTON-do-B2C', status: 'ACTIVE', registered_at: new Date(),
  }]);
  const svc = new WarehouseSyncService({
    registry: makeRegistry(makeAdapter({ onUpdate: async (name, patch) => { sent = { name, patch }; return {}; } })),
    locations: store,
  });
  const out = await svc.pushAddressChange('wh-1', { addressLine1: 'New Road', postalCode: '233001' });
  assert.equal(out.pushed, true);
  assert.equal(sent.name, 'b0a806-MSCORCOTTON-do-B2C');
  assert.equal(sent.patch.addressLine1, 'New Road');
});

// 6 — never diverge silently
await checkAsync('carrier failure on edit surfaces loudly', async () => {
  const store = makeStore([{
    warehouse_id: 'wh-1', provider_code: PROVIDER_CODES.DELHIVERY,
    provider_location_identifier: 'b0a806-MSCORCOTTON-do-B2C', status: 'ACTIVE', registered_at: new Date(),
  }]);
  const svc = new WarehouseSyncService({
    registry: makeRegistry(makeAdapter({ onUpdate: async () => { throw new Error('SHIPPING_PROVIDER_UNAVAILABLE'); } })),
    locations: store,
  });
  await assert.rejects(
    () => svc.pushAddressChange('wh-1', { addressLine1: 'New Road' }),
    (e) => e.code === 'WAREHOUSE_SYNC_UNCONFIRMED',
  );
});

// 7 — name is immutable at the carrier
check('edit payload never carries a renamed pickup location', () => {
  const body = buildWarehouseEditPayload('b0a806-MSCORCOTTON-do-B2C', {
    addressLine1: 'New Road', postalCode: '233001', code: 'WH-RENAMED', name: 'Renamed',
  });
  assert.equal(body.name, 'b0a806-MSCORCOTTON-do-B2C', 'edit payload changed the immutable name');
  assert.ok(!('code' in body));
});

// 8 — drift we can actually prove
await checkAsync('drift flags hand-entered identifier and missing mapping', async () => {
  const store = makeStore([{
    warehouse_id: 'wh-1', provider_code: PROVIDER_CODES.DELHIVERY,
    provider_location_identifier: 'typed-by-hand', status: 'ACTIVE', registered_at: null,
  }]);
  const svc = new WarehouseSyncService({ registry: makeRegistry(makeAdapter()), locations: store });
  const { findings } = await svc.detectDrift([
    { id: 'wh-1', code: 'WH-A', status: 'ACTIVE' },
    { id: 'wh-2', code: 'WH-B', status: 'ACTIVE' },
    { id: 'wh-3', code: 'WH-C', status: 'DISABLED' },
  ]);
  assert.ok(findings.some((f) => f.issue === 'NEVER_REGISTERED_VIA_API' && f.warehouseId === 'wh-1'));
  assert.ok(findings.some((f) => f.issue === 'NO_PICKUP_MAPPING' && f.warehouseId === 'wh-2' && f.severity === 'BLOCKING'));
  // A disabled warehouse with no mapping is still reported, at INFO. Silence
  // here is what let the CMS list show "Registered" for a warehouse that had
  // no carrier mapping at all.
  assert.ok(findings.some((f) => f.issue === 'NO_PICKUP_MAPPING' && f.warehouseId === 'wh-3' && f.severity === 'INFO'));
});

// 8b — a panel-verified link is reported, but not as loudly as an unchecked one
await checkAsync('panel-verified link downgrades the warning without claiming registration', async () => {
  const store = makeStore([{
    warehouse_id: 'wh-1', provider_code: PROVIDER_CODES.DELHIVERY,
    provider_location_identifier: 'Parsupur Warehouse', status: 'ACTIVE',
    registered_at: null, panel_verified_at: new Date('2026-09-09T00:00:00Z'),
  }]);
  const svc = new WarehouseSyncService({ registry: makeRegistry(makeAdapter()), locations: store });
  const { findings } = await svc.detectDrift([{ id: 'wh-1', code: 'WH-A', status: 'ACTIVE' }]);
  const f = findings.find((x) => x.warehouseId === 'wh-1');
  assert.equal(f.issue, 'PANEL_VERIFIED_NOT_API_REGISTERED');
  assert.equal(f.severity, 'INFO');
  // It must never read as registered — the carrier confirmed nothing to us.
  assert.ok(!findings.some((x) => x.issue === 'NEVER_REGISTERED_VIA_API' && x.warehouseId === 'wh-1'));
});

// 9 — a 200 that is not a success must not read as one
check('ambiguous carrier response is not treated as success', () => {
  assert.throws(() => parseWarehouseResponse({ error: ['pin is not serviceable'] }), /SHIPPING_PROVIDER_REJECTED/);
  assert.throws(() => parseWarehouseResponse(null), /SHIPPING_PROVIDER_RESPONSE_INVALID/);
  const okRes = parseWarehouseResponse({ success: true, data: { name: 'X' } });
  assert.equal(okRes.providerLocationName, 'X');
});


// ---- 10/11/12 — the CMS service layer, with real code paths --------------
// AdminWarehouseService is exercised directly: the rename guard and the
// address push are the two behaviours that actually prevent a CMS/carrier
// divergence, so they are tested, not assumed.
const { AdminWarehouseService } = await import('../src/modules/adminWarehouses/service.js');

const ACTOR = { id: 'staff-1', role: 'SUPER_ADMIN', brandId: 'brand-1' };
const MAPPED = {
  warehouse_id: 'wh-1', provider_code: PROVIDER_CODES.DELHIVERY,
  provider_location_identifier: 'b0a806-MSCORCOTTON-do-B2C', status: 'ACTIVE', registered_at: new Date(),
};

function makeAdminService({ mapping = MAPPED, onPush } = {}) {
  const updated = [];
  return {
    updated,
    svc: new AdminWarehouseService({
      warehouses: {
        get: async () => ({ ...WAREHOUSE }),
        getRow: async () => ({ id: 'wh-1', brand_id: 'brand-1' }),
        update: async (id, patch) => { updated.push(patch); return { id, ...WAREHOUSE, ...patch }; },
        list: async () => [{ id: 'wh-1', code: WAREHOUSE.code, status: 'ACTIVE' }],
      },
      audit: { log: async () => {} },
      assignments: { listForStaff: async () => [] },
      providerLocations: { find: async () => mapping, listForProvider: async () => (mapping ? [mapping] : []) },
      sync: async () => ({
        pushAddressChange: onPush ?? (async () => ({ pushed: true, identifier: MAPPED.provider_location_identifier })),
        detectDrift: async () => ({ providerCode: PROVIDER_CODES.DELHIVERY, findings: [] }),
      }),
    }),
  };
}

await checkAsync('renaming a carrier-registered warehouse is refused', async () => {
  const { svc, updated } = makeAdminService();
  await assert.rejects(
    () => svc.update(ACTOR, 'wh-1', { code: 'WH-RENAMED' }),
    (e) => e.code === 'WAREHOUSE_CODE_LOCKED',
  );
  assert.equal(updated.length, 0, 'the rename was written locally despite the guard');
});

await checkAsync('address edit is written locally AND pushed to the carrier', async () => {
  let pushed = null;
  const { svc, updated } = makeAdminService({ onPush: async (id, patch) => { pushed = patch; return { pushed: true }; } });
  const out = await svc.update(ACTOR, 'wh-1', { addressLine1: 'New Road', postalCode: '233001' });
  assert.equal(updated.length, 1, 'local write did not happen');
  assert.equal(pushed.addressLine1, 'New Road', 'carrier was not told about the change');
  assert.equal(out.providerSync.pushed, true);
});

await checkAsync('unmapped warehouse renames freely and pushes nothing', async () => {
  let pushed = false;
  const { svc, updated } = makeAdminService({ mapping: null, onPush: async () => { pushed = true; return {}; } });
  const out = await svc.update(ACTOR, 'wh-1', { code: 'WH-RENAMED' });
  assert.equal(updated.length, 1);
  assert.equal(pushed, false, 'pushed to the carrier without a mapping');
  assert.equal(out.providerSync.pushed, false);
});

console.log(`\n  final: ${pass} passed, ${fail.length} failed`);
if (fail.length) { console.error('FAILED: ' + fail.join(', ')); process.exit(1); }
console.log('verify:warehouse-sync OK\n');
