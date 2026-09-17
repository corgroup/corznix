export const DECISIONS = Object.freeze({ DELIVERY_UNAVAILABLE:'DELIVERY_UNAVAILABLE', PREPAID_ONLY:'PREPAID_ONLY', FULL_COD:'FULL_COD_AVAILABLE', PARTIAL_OPTIONAL:'PARTIAL_COD_OPTIONAL', PARTIAL_REQUIRED:'PARTIAL_COD_REQUIRED' });

const enabled = (value) => Boolean(Number(value));
const advance = (rule, total) => {
  if (!rule || rule.partial_cod_mode === 'DISABLED') return null;
  if (rule.advance_type === 'FIXED') return Number(rule.advance_value);
  if (rule.advance_type === 'PERCENTAGE') return Number((BigInt(total) * BigInt(rule.advance_value)) / 10000n);
  return null;
};

export function evaluatePaymentEligibility({ provider, policy, totalMinor }) {
  const reasons=[]; const appliedRuleIds=[]; const total=Number(totalMinor);
  if (!provider.serviceable) return { decision:DECISIONS.DELIVERY_UNAVAILABLE,prepaid:{available:false},cod:{available:false},partialCod:{available:false,required:false},payNowMinor:total,payOnDeliveryMinor:0,eligibleAmountMinor:total,internalReasonCodes:['PROVIDER_UNSERVICEABLE'],appliedRuleIds,riskLevel:'UNKNOWN' };
  let prepaid = provider.prepaidSupported !== false;
  let cod = provider.codSupported === true;
  let partial = cod;
  let required = false;
  if (!cod) reasons.push('PROVIDER_COD_UNSUPPORTED');
  if (!policy.settings || !enabled(policy.settings.cod_enabled)) { cod=false; partial=false; reasons.push('GLOBAL_COD_DISABLED'); }
  else if (!enabled(policy.settings.partial_cod_enabled)) { partial=false; reasons.push('GLOBAL_PARTIAL_COD_DISABLED'); }
  if (policy.pin?.delivery_blocked) return { decision:DECISIONS.DELIVERY_UNAVAILABLE,prepaid:{available:false},cod:{available:false},partialCod:{available:false,required:false},payNowMinor:total,payOnDeliveryMinor:0,eligibleAmountMinor:total,internalReasonCodes:[...reasons,'PIN_DELIVERY_BLOCKED'],appliedRuleIds,riskLevel:policy.riskLevel };
  for (const product of policy.products || []) {
    if (product.prepaid_only || product.cod_policy === 'BLOCK') { cod=false; partial=false; reasons.push('PRODUCT_PREPAID_ONLY'); }
    if (product.partial_cod_policy === 'BLOCK') partial=false;
    if (product.partial_cod_policy === 'REQUIRE') required=true;
  }
  if (policy.pin?.cod_blocked) { cod=false; partial=false; reasons.push('PIN_COD_BLOCKED'); }
  if (policy.pin?.partial_cod_blocked) partial=false;
  if (policy.provider) {
    prepaid = prepaid && enabled(policy.provider.prepaid_allowed);
    if (!enabled(policy.provider.cod_allowed)) { cod=false; partial=false; reasons.push('PROVIDER_COD_BLOCKED_BY_POLICY'); }
    if (!enabled(policy.provider.partial_cod_allowed)) partial=false;
  }
  const rule = policy.valueRules?.length === 1 ? policy.valueRules[0] : null;
  if (!rule) { cod=false; partial=false; reasons.push('COD_VALUE_RULE_NOT_MATCHED'); }
  else {
    appliedRuleIds.push(rule.id);
    cod = cod && enabled(rule.cod_allowed);
    partial = partial && rule.partial_cod_mode !== 'DISABLED';
    required = required || rule.partial_cod_mode === 'REQUIRED';
  }
  const riskAction = policy.riskRule?.action;
  if (!riskAction) { cod=false; partial=false; reasons.push('RTO_POLICY_NOT_CONFIGURED'); }
  else if (riskAction === 'PREPAID_ONLY') { cod=false; partial=false; reasons.push('RTO_COD_BLOCKED'); }
  else if (riskAction === 'REQUIRE_PARTIAL_COD') { required=true; reasons.push('RTO_PARTIAL_REQUIRED'); }
  if (required) cod=false;
  if (required && !partial) reasons.push('PARTIAL_COD_REQUIRED_UNAVAILABLE');
  let payNow=0; let payOnDelivery=total;
  if (partial) {
    payNow=advance(rule,total);
    if (!Number.isInteger(payNow) || payNow<=0 || payNow>=total) { partial=false; payNow=0; reasons.push('PARTIAL_COD_ADVANCE_INVALID'); }
    else payOnDelivery=total-payNow;
  }
  const min=provider.minCodAmountMinor; const max=provider.maxCodAmountMinor;
  const fullWithin=(min==null||total>=min)&&(max==null||total<=max);
  const partialWithin=(min==null||payOnDelivery>=min)&&(max==null||payOnDelivery<=max);
  cod=cod&&fullWithin; partial=partial&&partialWithin;
  if (!partial) { payNow=0; payOnDelivery=total; }
  // What the business keeps if this order comes back. Only ever the advance
  // that was actually charged, and only when the matched band says so — never
  // inferred, and zero unless somebody deliberately configured it.
  const nonRefundableAdvanceMinor = partial && rule
    && enabled(policy.settings?.advance_non_refundable_enabled)
    && enabled(rule.advance_non_refundable)
    ? payNow : 0;
  let decision=DECISIONS.PREPAID_ONLY;
  if (partial&&required) decision=DECISIONS.PARTIAL_REQUIRED;
  else if (partial&&cod) decision=DECISIONS.PARTIAL_OPTIONAL;
  else if (cod) decision=DECISIONS.FULL_COD;
  const authoritativePayNow=partial?payNow:cod?0:total;
  return { decision,prepaid:{available:prepaid},cod:{available:cod,payNowMinor:0,payOnDeliveryMinor:total},partialCod:{available:partial,required:partial&&required,payNowMinor:partial?payNow:null,payOnDeliveryMinor:partial?payOnDelivery:null,nonRefundableAdvanceMinor},payNowMinor:authoritativePayNow,payOnDeliveryMinor:total-authoritativePayNow,nonRefundableAdvanceMinor,eligibleAmountMinor:total,internalReasonCodes:reasons,appliedRuleIds,riskLevel:policy.riskLevel };
}
