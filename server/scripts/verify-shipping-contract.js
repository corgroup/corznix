// Phase 2 · Slice 2 — provider-neutral logistics contract + ProviderResolver.
//   * the full operation surface (§31) exists on the adapter base and throws a
//     typed ShippingOperationError until a subclass implements it
//   * capabilities are declared, not guessed
//   * ProviderResolver: MOCK->MOCK, REAL->configured default, NO silent fallback
//   * a booked shipment stays owned by its original provider (§2)
//
// Pure unit test — no DB, REAL_PROVIDER_CALLS = 0.
import assert from 'node:assert/strict';
import {
  ShippingProviderAdapter, ShippingOperationError, SHIPPING_OPERATIONS, PROVIDER_CODES,
} from '../src/modules/shipping/providerContract.js';
import { ShippingProviderRegistry } from '../src/modules/shipping/registry.js';
import { ProviderResolver } from '../src/modules/shipping/providerResolver.js';
import { MockShippingAdapter } from '../src/modules/shipping/providers/mockAdapter.js';
import { DelhiveryShippingAdapter } from '../src/modules/shipping/providers/delhiveryAdapter.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};

await acheck('operation_surface_exists', async () => {
  const base = new ShippingProviderAdapter({ providerCode: 'X' });
  for (const op of SHIPPING_OPERATIONS) {
    assert.equal(typeof base[op], 'function', `${op} missing on base adapter`);
    await assert.rejects(() => base[op]({}), (e) => e instanceof ShippingOperationError && e.code === 'SHIPPING_PROVIDER_OPERATION_NOT_IMPLEMENTED');
  }
});

await acheck('mock_declares_full_surface', () => {
  const mock = new MockShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' }, production: false });
  assert.equal(mock.configured, true);
  for (const op of SHIPPING_OPERATIONS) assert.equal(mock.supports(op), true, `mock should support ${op}`);
});

await acheck('delhivery_declares_implemented_ops', () => {
  const d = new DelhiveryShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' } });
  assert.equal(d.supports('checkServiceability'), true);
  assert.equal(d.supports('getTat'), true);
  assert.equal(d.supports('getShippingQuote'), true);
  assert.equal(d.supports('createShipment'), true);  // slice 10
  assert.equal(d.supports('getLabel'), true);        // slice 11
  assert.equal(d.supports('requestPickup'), true);   // slice 12
  assert.equal(d.supports('cancelShipment'), true);  // slice 15
  assert.equal(d.supports('editShipment'), true);    // slice 15
  assert.equal(d.supports('trackShipment'), true);   // slice 13
  assert.equal(d.supports('getDocuments'), true);    // slice 17
  // Delhivery adapter now implements the full SHIPPING_OPERATIONS surface.
  for (const op of SHIPPING_OPERATIONS) assert.equal(d.supports(op), true, `delhivery should support ${op}`);
});

const registry = (mode, delhiveryConfigured) => new ShippingProviderRegistry([
  new MockShippingAdapter({ runtimeEnv: { SHIPPING_PROVIDER_MODE: mode }, production: false }),
  new DelhiveryShippingAdapter({ runtimeEnv: {
    SHIPPING_PROVIDER_MODE: mode,
    DELHIVERY_API_BASE_URL: delhiveryConfigured ? 'https://staging-express.delhivery.com' : '',
    DELHIVERY_API_TOKEN: delhiveryConfigured ? 'x' : '',
  } }),
]);
const config = (providers) => ({ async getConfiguration() { return { providers }; } });
const delhiveryProvider = { providerCode: 'DELHIVERY', enabled: true, isDefault: true, priority: 1, eligibleForZone: true };

await acheck('resolver_mock_mode', async () => {
  const r = new ProviderResolver({ registry: registry('MOCK', false), configurationService: config([delhiveryProvider]), runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' } });
  assert.equal(await r.resolveForNewShipment(), PROVIDER_CODES.MOCK);
});

await acheck('resolver_real_mode_configured', async () => {
  const r = new ProviderResolver({ registry: registry('REAL', true), configurationService: config([delhiveryProvider]), runtimeEnv: { SHIPPING_PROVIDER_MODE: 'REAL' } });
  assert.equal(await r.resolveForNewShipment(), 'DELHIVERY');
});

await acheck('resolver_real_mode_unconfigured_no_fallback', async () => {
  const r = new ProviderResolver({ registry: registry('REAL', false), configurationService: config([delhiveryProvider]), runtimeEnv: { SHIPPING_PROVIDER_MODE: 'REAL' } });
  await assert.rejects(() => r.resolveForNewShipment(), (e) => e.code === 'SHIPPING_PROVIDER_UNAVAILABLE' && e.status === 503);
});

await acheck('booked_shipment_keeps_its_provider', async () => {
  // Even in MOCK mode, an already-booked DELHIVERY shipment resolves to DELHIVERY (§2).
  const r = new ProviderResolver({ registry: registry('MOCK', false), configurationService: config([delhiveryProvider]), runtimeEnv: { SHIPPING_PROVIDER_MODE: 'MOCK' } });
  assert.equal(await r.resolveForShipment({ provider_code: 'DELHIVERY' }), 'DELHIVERY');
});

await acheck('assert_can_perform_rejects_unsupported', async () => {
  const r = new ProviderResolver({ registry: registry('REAL', true), configurationService: config([delhiveryProvider]), runtimeEnv: { SHIPPING_PROVIDER_MODE: 'REAL' } });
  // BLUE_DART is a registered stub — implemented=false, supports nothing.
  await assert.rejects(
    () => r.assertCanPerform({ provider_code: 'BLUE_DART' }, 'checkServiceability'),
    (e) => e.code === 'SHIPPING_PROVIDER_OPERATION_UNAVAILABLE' && e.status === 503,
  );
  assert.equal(await r.assertCanPerform({ provider_code: 'DELHIVERY' }, 'checkServiceability'), 'DELHIVERY');
  assert.equal(await r.assertCanPerform({ provider_code: 'DELHIVERY' }, 'getDocuments'), 'DELHIVERY');
});

await acheck('registry_supports', () => {
  const reg = registry('REAL', true);
  assert.equal(reg.supports('DELHIVERY', 'getTat'), true);
  assert.equal(reg.supports('DELHIVERY', 'trackShipment'), true);
  assert.equal(reg.supports('DELHIVERY', 'getDocuments'), true);
  assert.equal(reg.supports('BLUE_DART', 'checkServiceability'), false); // stub, not implemented
});

// A non-production process must not be able to book real freight, however its
// base URL is configured. This is a regression guard for an actual incident:
// a local QA run with DELHIVERY_API_BASE_URL=https://track.delhivery.com
// manifested AWB 54729910000151 on the live account. Reads are deliberately
// left open — they cost nothing and local work needs them.
const LIVE_HOST = 'https://track.delhivery.com';
const UAT_HOST = 'https://staging-express.delhivery.com';
const delhivery = (extra) => new DelhiveryShippingAdapter({
  runtimeEnv: { SHIPPING_PROVIDER_MODE: 'REAL', DELHIVERY_API_TOKEN: 'not-a-real-token', ...extra },
});
const MUTATIONS = [
  ['createShipment', [{}]],
  ['editShipment', [{ awb: '1' }]],
  ['cancelShipment', [{ awb: '1' }]],
  ['requestPickup', [{ pickupLocationName: 'W', pickupDate: '2030-01-01', expectedPackageCount: 1 }]],
  ['createPickupLocation', [{}]],
  ['updatePickupLocation', ['W', {}]],
];
const isBlocked = (e) => e.message === 'SHIPPING_PROVIDER_LIVE_WRITE_BLOCKED';

await acheck('live_writes_blocked_outside_production', async () => {
  for (const nodeEnv of ['development', 'test', undefined]) {
    const a = delhivery({ NODE_ENV: nodeEnv, DELHIVERY_API_BASE_URL: LIVE_HOST });
    for (const [op, args] of MUTATIONS) {
      await assert.rejects(() => a[op](...args), isBlocked, `${op} was not blocked under NODE_ENV=${nodeEnv}`);
    }
  }
});

await acheck('live_reads_stay_open', () => {
  // Enforced structurally: no read method carries the guard. Calling them here
  // would leave the machine, which this suite never does.
  const READS = ['checkServiceability', 'getTat', 'getShippingQuote', 'trackShipment', 'getLabel', 'getDocuments', 'getNdrStatus'];
  for (const op of READS) {
    const src = String(DelhiveryShippingAdapter.prototype[op]);
    assert.equal(/assertWritesAllowed/.test(src), false, `${op} must not be guarded — reads are free`);
  }
});

await acheck('live_writes_allowed_where_they_should_be', async () => {
  // Past the guard, an empty request fails payload assembly — which is exactly
  // how we know control reached the method body without leaving the machine.
  const permitted = [
    { NODE_ENV: 'production', DELHIVERY_API_BASE_URL: LIVE_HOST },
    { NODE_ENV: 'development', DELHIVERY_API_BASE_URL: UAT_HOST },
    { NODE_ENV: 'development', DELHIVERY_API_BASE_URL: LIVE_HOST, DELHIVERY_ALLOW_LIVE_WRITES: 'true' },
  ];
  for (const envPatch of permitted) {
    await assert.rejects(
      () => delhivery(envPatch).createShipment({}),
      (e) => !isBlocked(e),
      `booking must not be blocked for ${JSON.stringify(envPatch)}`,
    );
  }
});

console.log('\n──── Phase 2 · Slice 2 — provider-neutral contract ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSHIPPING_CONTRACT = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
process.exitCode = failed.length === 0 ? 0 : 1;
