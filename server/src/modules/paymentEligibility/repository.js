import { query } from '../../database/connection/pool.js';

export class PaymentEligibilityRepository {
  async findForCheckout(checkoutId) { return (await query('SELECT * FROM checkout_payment_eligibility WHERE checkout_id=? LIMIT 1',[checkoutId]))[0]||null; }
  async loadPolicy({ productIds, postalCode, providerCode, providerServiceCode, amountMinor }) {
    const settings = (await query('SELECT * FROM cod_settings WHERE id=1 LIMIT 1'))[0] || null;
    const valueRules = await query(`SELECT * FROM cod_value_rules WHERE status='ACTIVE' AND min_amount_minor<=? AND (max_amount_minor IS NULL OR max_amount_minor>=?) ORDER BY min_amount_minor DESC`, [amountMinor, amountMinor]);
    const products = productIds.length ? await query(`SELECT * FROM product_payment_policies WHERE product_id IN (${productIds.map(() => '?').join(',')})`, productIds) : [];
    const pin = (await query('SELECT * FROM pin_payment_restrictions WHERE postal_code=? LIMIT 1', [postalCode]))[0] || null;
    const providers = await query(`SELECT * FROM shipping_provider_payment_policies WHERE provider_code=? AND (provider_service_code=? OR provider_service_code IS NULL) ORDER BY provider_service_code IS NULL ASC LIMIT 1`, [providerCode, providerServiceCode]);
    const riskLevels = [pin?.risk_level, ...products.map((row) => row.risk_level)].filter(Boolean);
    const rank = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3, CUSTOM: 4 };
    const riskLevel = riskLevels.sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] || 'UNKNOWN';
    const riskRule = (await query(`SELECT * FROM rto_risk_rules WHERE risk_level=? AND status='ACTIVE' LIMIT 1`, [riskLevel]))[0] || null;
    return { settings, valueRules, products, pin, provider: providers[0] || null, riskLevel, riskRule };
  }

  async save(checkoutId, result) {
    await query(`INSERT INTO checkout_payment_eligibility
      (checkout_id,decision,prepaid_available,cod_available,partial_cod_available,partial_cod_required,pay_now_minor,advance_non_refundable_minor,pay_on_delivery_minor,eligible_amount_minor,provider_code,provider_service_code,risk_level,reason_codes,applied_rule_ids,evaluated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW(3))
      ON DUPLICATE KEY UPDATE decision=VALUES(decision),prepaid_available=VALUES(prepaid_available),cod_available=VALUES(cod_available),partial_cod_available=VALUES(partial_cod_available),partial_cod_required=VALUES(partial_cod_required),pay_now_minor=VALUES(pay_now_minor),advance_non_refundable_minor=VALUES(advance_non_refundable_minor),pay_on_delivery_minor=VALUES(pay_on_delivery_minor),eligible_amount_minor=VALUES(eligible_amount_minor),provider_code=VALUES(provider_code),provider_service_code=VALUES(provider_service_code),risk_level=VALUES(risk_level),reason_codes=VALUES(reason_codes),applied_rule_ids=VALUES(applied_rule_ids),selected_payment_mode=NULL,evaluated_at=NOW(3)`,
    [checkoutId,result.decision,result.prepaid.available,result.cod.available,result.partialCod.available,result.partialCod.required,result.payNowMinor,result.nonRefundableAdvanceMinor??0,result.payOnDeliveryMinor,result.eligibleAmountMinor,result.providerCode,result.providerServiceCode,result.riskLevel,JSON.stringify(result.internalReasonCodes),JSON.stringify(result.appliedRuleIds)]);
  }

  async selectMode(checkoutId, mode) {
    const rows = await query('SELECT * FROM checkout_payment_eligibility WHERE checkout_id=? LIMIT 1', [checkoutId]);
    const row = rows[0];
    const allowed = row && ((mode==='PREPAID' && row.prepaid_available) || (mode==='FULL_COD' && row.cod_available) || (mode==='PARTIAL_COD' && row.partial_cod_available));
    if (!allowed) return false;
    await query('UPDATE checkout_payment_eligibility SET selected_payment_mode=? WHERE checkout_id=?', [mode, checkoutId]);
    return true;
  }
}

export const paymentEligibilityRepository = new PaymentEligibilityRepository();
