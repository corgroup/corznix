// Phase 2 · Slice 5/6 — shipping PRICING POLICY.
//   Surface : customer sees ₹0 (business absorbs the real cost)
//   Express : customer pays provider rate + ₹100 surcharge
//   customer-facing charge is ALWAYS kept separate from the actual logistics cost
//
// migration 061 + pure policy + settings round-trip. Self-cleaning.
import assert from 'node:assert/strict';
import { pool, query } from '../src/database/connection/pool.js';
import { computeShippingCharge, ShippingPricingPolicyRepository } from '../src/modules/shipping/pricingPolicy.js';

const results = {};
const acheck = async (name, fn) => {
  try { const v = await fn(); results[name] = v === undefined ? 'PASS' : v; }
  catch (e) { results[name] = `FAIL ${e.message}`; }
  console.log(`  ${String(results[name]).startsWith('FAIL') ? 'FAIL' : 'PASS'}  ${name}`);
};
const check = (n, fn) => acheck(n, async () => fn());

check('surface_zero_default', () => {
  const r = computeShippingCharge({ serviceLevel: 'STANDARD', providerRateMinor: 6900 }); // real Delhivery Surface ₹69
  assert.equal(r.customerChargeMinor, 0);
  assert.equal(r.actualLogisticsCostMinor, 6900); // business still owes the carrier
  assert.equal(r.mode, 'ZERO_BUSINESS_ABSORBS');
});

check('express_rate_plus_surcharge', () => {
  const r = computeShippingCharge({ serviceLevel: 'EXPRESS', providerRateMinor: 9710 }); // real Delhivery Express ₹97.10
  assert.equal(r.customerChargeMinor, 9710 + 10000); // + ₹100
  assert.equal(r.actualLogisticsCostMinor, 9710);
  assert.equal(r.surchargeMinor, 10000);
});

check('mock_zero_rate', () => {
  assert.equal(computeShippingCharge({ serviceLevel: 'STANDARD', providerRateMinor: 0 }).customerChargeMinor, 0);
  assert.equal(computeShippingCharge({ serviceLevel: 'EXPRESS', providerRateMinor: 0 }).customerChargeMinor, 10000);
});

check('surface_provider_rate_mode', () => {
  const r = computeShippingCharge({ serviceLevel: 'STANDARD', providerRateMinor: 6900, policy: { surfaceCustomerChargeMode: 'PROVIDER_RATE' } });
  assert.equal(r.customerChargeMinor, 6900);
});

check('surface_flat_mode', () => {
  const r = computeShippingCharge({ serviceLevel: 'STANDARD', providerRateMinor: 6900, policy: { surfaceCustomerChargeMode: 'FLAT', surfaceFlatChargeMinor: 4900 } });
  assert.equal(r.customerChargeMinor, 4900);
  assert.equal(r.actualLogisticsCostMinor, 6900);
});

check('custom_express_surcharge', () => {
  const r = computeShippingCharge({ serviceLevel: 'EXPRESS', providerRateMinor: 5000, policy: { expressAdditionalChargeMinor: 0 } });
  assert.equal(r.customerChargeMinor, 5000);
});

check('bad_rate_is_zero', () => {
  assert.equal(computeShippingCharge({ serviceLevel: 'STANDARD', providerRateMinor: -50 }).actualLogisticsCostMinor, 0);
  assert.equal(computeShippingCharge({ serviceLevel: 'EXPRESS', providerRateMinor: NaN }).customerChargeMinor, 10000);
});

await acheck('migration_061_columns', async () => {
  const s = await query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='shipping_settings'`);
  for (const c of ['surface_customer_charge_mode', 'surface_flat_charge_minor', 'express_additional_charge_minor']) {
    assert.ok(s.map((r) => r.COLUMN_NAME).includes(c), `shipping_settings.${c} missing`);
  }
  const sh = await query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='shipments'`);
  for (const c of ['customer_shipping_charge_minor', 'actual_logistics_cost_minor', 'shipping_cost_source']) {
    assert.ok(sh.map((r) => r.COLUMN_NAME).includes(c), `shipments.${c} missing`);
  }
});

await acheck('settings_round_trip', async () => {
  const repo = new ShippingPricingPolicyRepository();
  const before = await repo.get();
  assert.ok(['ZERO', 'PROVIDER_RATE', 'FLAT'].includes(before.surfaceCustomerChargeMode));
  await repo.update({ expressAdditionalChargeMinor: 12500, surfaceCustomerChargeMode: 'ZERO' });
  const after = await repo.get();
  assert.equal(after.expressAdditionalChargeMinor, 12500);
  // policy flows through compute
  assert.equal(computeShippingCharge({ serviceLevel: 'EXPRESS', providerRateMinor: 9710, policy: after }).customerChargeMinor, 9710 + 12500);
  // restore
  await repo.update({ expressAdditionalChargeMinor: before.expressAdditionalChargeMinor, surfaceCustomerChargeMode: before.surfaceCustomerChargeMode, surfaceFlatChargeMinor: before.surfaceFlatChargeMinor });
});

await acheck('invalid_surface_mode_rejected', async () => {
  const repo = new ShippingPricingPolicyRepository();
  await assert.rejects(() => repo.update({ surfaceCustomerChargeMode: 'NEGATIVE' }), (e) => e.status === 422);
});

console.log('\n──── Phase 2 · Slice 5/6 — shipping pricing ────');
const failed = Object.entries(results).filter(([, v]) => String(v).startsWith('FAIL'));
console.log(`\nSHIPPING_PRICING = ${failed.length === 0 ? 'PASS' : `FAIL (${failed.length})`}`);
await pool.end();
process.exitCode = failed.length === 0 ? 0 : 1;
