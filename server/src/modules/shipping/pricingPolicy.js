import { query } from '../../database/connection/pool.js';
import { defaultBrandId } from '../../utils/defaultBrand.js';

// Phase 2 · Slice 5/6 — the CORCOTTON shipping PRICING POLICY.
//
// Provider rate  ──►  ShippingPricingPolicy  ──►  customer-facing charge
//                └──►  actual logistics cost (what CORCOTTON pays the carrier)
//
// The policy NEVER lives in a provider adapter (brief §18/§19). Defaults:
//   Surface : customer charge = ₹0                (business absorbs the cost)
//   Express : customer charge = provider rate + ₹100 CORCOTTON surcharge
// All overridable via shipping_settings (CMS).

export const SURFACE_MODES = Object.freeze(['ZERO', 'PROVIDER_RATE', 'FLAT']);

const DEFAULT_POLICY = Object.freeze({
  surfaceCustomerChargeMode: 'ZERO',
  surfaceFlatChargeMinor: 0,
  expressAdditionalChargeMinor: 10000, // ₹100
});

/**
 * @param {{ serviceLevel: 'STANDARD'|'EXPRESS', providerRateMinor: number, policy?: object }} input
 * @returns {{
 *   customerChargeMinor: number,       // what the customer pays for shipping
 *   actualLogisticsCostMinor: number,  // what CORCOTTON pays the carrier (= provider rate)
 *   surchargeMinor: number,
 *   mode: string,
 * }}
 */
export function computeShippingCharge({ serviceLevel, providerRateMinor, policy = DEFAULT_POLICY }) {
  const p = { ...DEFAULT_POLICY, ...(policy || {}) };
  const rate = Math.max(0, Math.round(Number(providerRateMinor) || 0));
  const level = String(serviceLevel).toUpperCase() === 'EXPRESS' ? 'EXPRESS' : 'STANDARD';

  if (level === 'EXPRESS') {
    const surcharge = Math.max(0, Math.round(Number(p.expressAdditionalChargeMinor) || 0));
    return {
      customerChargeMinor: rate + surcharge,
      actualLogisticsCostMinor: rate,
      surchargeMinor: surcharge,
      mode: 'PROVIDER_RATE_PLUS_SURCHARGE',
    };
  }

  // STANDARD / Surface
  switch (p.surfaceCustomerChargeMode) {
    case 'PROVIDER_RATE':
      return { customerChargeMinor: rate, actualLogisticsCostMinor: rate, surchargeMinor: 0, mode: 'PROVIDER_RATE' };
    case 'FLAT': {
      const flat = Math.max(0, Math.round(Number(p.surfaceFlatChargeMinor) || 0));
      return { customerChargeMinor: flat, actualLogisticsCostMinor: rate, surchargeMinor: 0, mode: 'FLAT' };
    }
    case 'ZERO':
    default:
      return { customerChargeMinor: 0, actualLogisticsCostMinor: rate, surchargeMinor: 0, mode: 'ZERO_BUSINESS_ABSORBS' };
  }
}

// ---- settings ------------------------------------------------------------

export class ShippingPricingPolicyRepository {
  async get() {
    const rows = await query(
      `SELECT surface_customer_charge_mode, surface_flat_charge_minor, express_additional_charge_minor
         FROM shipping_settings WHERE id = 1 LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return { ...DEFAULT_POLICY };
    return {
      surfaceCustomerChargeMode: row.surface_customer_charge_mode || 'ZERO',
      surfaceFlatChargeMinor: Number(row.surface_flat_charge_minor || 0),
      expressAdditionalChargeMinor: Number(row.express_additional_charge_minor ?? 10000),
    };
  }

  async update(patch, actor = {}) {
    void actor;
    const fields = [];
    const params = [];
    if (patch.surfaceCustomerChargeMode !== undefined) {
      if (!SURFACE_MODES.includes(patch.surfaceCustomerChargeMode)) {
        const e = new Error('INVALID_SURFACE_MODE'); e.status = 422; throw e;
      }
      fields.push('surface_customer_charge_mode = ?'); params.push(patch.surfaceCustomerChargeMode);
    }
    if (patch.surfaceFlatChargeMinor !== undefined) {
      fields.push('surface_flat_charge_minor = ?'); params.push(Math.max(0, Math.round(patch.surfaceFlatChargeMinor)));
    }
    if (patch.expressAdditionalChargeMinor !== undefined) {
      fields.push('express_additional_charge_minor = ?'); params.push(Math.max(0, Math.round(patch.expressAdditionalChargeMinor)));
    }
    if (fields.length) {
      // shipping_settings is a genuine singleton (id = 1) — brand_id was
      // added by migration 082 but this row's real per-brand rewiring is
      // deliberately deferred (same boundary as return_policy/cod_settings).
      // It's only needed here so the INSERT half of this upsert is valid
      // SQL (brand_id is NOT NULL, no default); the row already exists in
      // every environment so the UPDATE half always fires in practice, and
      // brand_id is never touched by it.
      const brandId = await defaultBrandId();
      await query(
        `INSERT INTO shipping_settings (id, brand_id, ${fields.map((f) => f.split(' = ')[0]).join(', ')})
         VALUES (1, ?, ${fields.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${fields.join(', ')}, updated_at = NOW(3)`,
        [brandId, ...params, ...params],
      );
    }
    return this.get();
  }
}

export const shippingPricingPolicyRepository = new ShippingPricingPolicyRepository();
