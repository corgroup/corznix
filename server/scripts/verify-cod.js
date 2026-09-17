import assert from 'node:assert/strict';
import { evaluatePaymentEligibility } from '../src/modules/paymentEligibility/evaluator.js';
import { validateValueRule } from '../src/modules/paymentEligibility/validation.js';
process.env.SHIPPING_PROVIDER_MODE='MOCK';
const { PaymentEligibilityService } = await import('../src/modules/paymentEligibility/service.js');

const rule=(extra={})=>({id:'rule',min_amount_minor:0,max_amount_minor:null,cod_allowed:1,partial_cod_mode:'DISABLED',advance_type:null,advance_value:null,...extra});
const policy=(extra={})=>({settings:{cod_enabled:1,partial_cod_enabled:1},valueRules:[rule()],products:[],pin:null,provider:null,riskLevel:'LOW',riskRule:{action:'ALLOW_FULL_COD'},...extra});
const provider=(extra={})=>({serviceable:true,prepaidSupported:true,codSupported:true,minCodAmountMinor:null,maxCodAmountMinor:null,...extra});
const evaluate=(p=provider(),c=policy(),totalMinor=200000)=>evaluatePaymentEligibility({provider:p,policy:c,totalMinor});

assert.equal(evaluate(provider({serviceable:false}),policy()).decision,'DELIVERY_UNAVAILABLE');
assert.equal(evaluate(provider({codSupported:false}),policy()).decision,'PREPAID_ONLY');
assert.equal(evaluate(provider(),policy({settings:{cod_enabled:0,partial_cod_enabled:1}})).decision,'PREPAID_ONLY');
assert.equal(evaluate(provider(),policy({settings:{cod_enabled:1,partial_cod_enabled:0}})).decision,'FULL_COD_AVAILABLE');
const fixed=evaluate(provider(),policy({valueRules:[rule({partial_cod_mode:'REQUIRED',advance_type:'FIXED',advance_value:50000})]}));
assert.equal(fixed.decision,'PARTIAL_COD_REQUIRED'); assert.equal(fixed.partialCod.payNowMinor,50000); assert.equal(fixed.partialCod.payOnDeliveryMinor,150000);
const percent=evaluate(provider(),policy({valueRules:[rule({partial_cod_mode:'REQUIRED',advance_type:'PERCENTAGE',advance_value:2500})]}));
assert.equal(percent.partialCod.payNowMinor,50000); assert.equal(percent.partialCod.payNowMinor+percent.partialCod.payOnDeliveryMinor,200000);
assert.equal(evaluate(provider(),policy({products:[{prepaid_only:1,cod_policy:'INHERIT',partial_cod_policy:'INHERIT'}]})).decision,'PREPAID_ONLY');
assert.equal(evaluate(provider(),policy({pin:{cod_blocked:1}})).decision,'PREPAID_ONLY');
assert.equal(evaluate(provider(),policy({pin:{delivery_blocked:1}})).decision,'DELIVERY_UNAVAILABLE');
assert.equal(evaluate(provider(),policy({provider:{prepaid_allowed:1,cod_allowed:0,partial_cod_allowed:1}})).decision,'PREPAID_ONLY');
assert.equal(evaluate(provider(),policy({riskLevel:'MEDIUM',riskRule:{action:'REQUIRE_PARTIAL_COD'},valueRules:[rule({partial_cod_mode:'AVAILABLE',advance_type:'FIXED',advance_value:50000})]})).decision,'PARTIAL_COD_REQUIRED');
assert.equal(evaluate(provider(),policy({riskLevel:'HIGH',riskRule:{action:'PREPAID_ONLY'},valueRules:[rule({partial_cod_mode:'AVAILABLE',advance_type:'FIXED',advance_value:50000})]})).decision,'PREPAID_ONLY');
assert.equal(evaluate(provider({maxCodAmountMinor:100000}),policy({valueRules:[rule({partial_cod_mode:'REQUIRED',advance_type:'FIXED',advance_value:50000})]})).decision,'PREPAID_ONLY');
assert.equal(evaluate(provider(),policy({valueRules:[]})).decision,'PREPAID_ONLY');
assert.throws(()=>validateValueRule({minAmountMinor:500,maxAmountMinor:1500,advanceType:'FIXED',advanceValue:100},[{min_amount_minor:0,max_amount_minor:1000}]),/overlap/i);
// The admin COD surface: the CMS writes the four tables this evaluator reads.
// These assert the write side agrees with the read side, so a band saved in
// the CMS cannot mean something different by the time checkout consults it.
const { CodPolicyRepository } = await import('../src/modules/adminPayments/codPolicyRepository.js');
{
  const repo = new CodPolicyRepository();
  // "Offered" partial COD means the customer chooses between partial and full,
  // so full COD must be allowed. Without it the evaluator falls through to
  // PREPAID_ONLY while still computing a split and still accepting a
  // PARTIAL_COD selection — it would tell the customer one thing and the API
  // another. Refused at the point of configuration.
  await assert.rejects(
    () => repo.upsertValueRule(null, { minAmountMinor: 0, codAllowed: false, partialCodMode: 'AVAILABLE', advanceType: 'FIXED', advanceValue: 5000 }),
    (e) => /full COD allowed as the alternative/.test(e.message),
  );
  // Same shape, expressed the way the evaluator can represent it.
  assert.equal(
    evaluate(provider(), policy({ valueRules: [rule({ cod_allowed: 0, partial_cod_mode: 'REQUIRED', advance_type: 'FIXED', advance_value: 50000 })] })).decision,
    'PARTIAL_COD_REQUIRED',
  );
  // A percentage advance is stored in basis points; 2500 is 25%, not 2500%.
  await assert.rejects(
    () => repo.upsertValueRule(null, { minAmountMinor: 0, codAllowed: true, partialCodMode: 'REQUIRED', advanceType: 'PERCENTAGE', advanceValue: 20000 }),
    (e) => /basis points/.test(e.message),
  );
  await assert.rejects(
    () => repo.upsertValueRule(null, { minAmountMinor: 500000, maxAmountMinor: 100000, codAllowed: true }),
    (e) => /at or above the minimum/.test(e.message),
  );
  await assert.rejects(() => repo.setRiskRule(null, 'UNKNOWN', { action: 'NONSENSE' }), (e) => /Unknown risk action/.test(e.message));
  await assert.rejects(() => repo.setPin(null, '12345', { codBlocked: true }), (e) => /6 digits/.test(e.message));
}

// ---- the non-refundable advance -----------------------------------------
// The advance a customer pays online to hold a COD order can be kept if the
// order comes back; what they hand over at the door never is. These freeze the
// evaluator's half — the amount is only marked when the matched band says so,
// and it is never larger than the advance actually charged.
{
  const advanceBand = (nonRefundable) => rule({
    partial_cod_mode: 'AVAILABLE', advance_type: 'FIXED', advance_value: 50000,
    advance_non_refundable: nonRefundable,
  });
  const withFlag = (nonRefundable, master = 1) => evaluate(provider(), policy({
    settings: { cod_enabled: 1, partial_cod_enabled: 1, advance_non_refundable_enabled: master },
    valueRules: [advanceBand(nonRefundable)], riskLevel: 'UNKNOWN', riskRule: { action: 'REQUIRE_PARTIAL_COD' },
  }));

  const marked = withFlag(1);
  assert.equal(marked.decision, 'PARTIAL_COD_REQUIRED');
  assert.equal(marked.partialCod.payNowMinor, 50000);
  assert.equal(marked.nonRefundableAdvanceMinor, 50000, 'the advance is marked non-refundable');
  assert.equal(marked.partialCod.nonRefundableAdvanceMinor, 50000);

  assert.equal(withFlag(0).nonRefundableAdvanceMinor, 0, 'nothing is withheld unless the band says so');

  // The master switch and the band flag must BOTH be on. The switch exists so
  // the whole policy can be stopped in one place without editing every band,
  // and turning it off must never take COD away with it — only the withholding.
  assert.equal(withFlag(1, 0).nonRefundableAdvanceMinor, 0, 'master off withholds nothing');
  assert.equal(withFlag(0, 0).nonRefundableAdvanceMinor, 0);
  assert.equal(withFlag(1, 0).decision, withFlag(1, 1).decision, 'the master switch does not change whether COD is offered');
  assert.equal(withFlag(1, 0).partialCod.payNowMinor, withFlag(1, 1).partialCod.payNowMinor, 'nor the advance charged');

  // Full COD takes no advance, so there is nothing that could be withheld.
  assert.equal(evaluate(provider(), policy()).nonRefundableAdvanceMinor, 0);
  // Neither does a prepaid-only outcome — a fully prepaid order is untouched.
  assert.equal(evaluate(provider(), policy({ pin: { cod_blocked: 1 } })).nonRefundableAdvanceMinor, 0);

  // The rule is "whatever advance was charged", NOT a particular kind of
  // advance. A change that reads the amount from advance_value directly, or
  // handles only one type, breaks here — a percentage is basis points and a
  // fixed amount is paise, and confusing the two would withhold the wrong sum.
  for (const [type, value] of [['PERCENTAGE', 3000], ['FIXED', 49900], ['PERCENTAGE', 10000], ['FIXED', 1]]) {
    for (const totalMinor of [129900, 180000, 229900]) {
      const r = evaluate(provider(), policy({
        settings: { cod_enabled: 1, partial_cod_enabled: 1, advance_non_refundable_enabled: 1 },
        valueRules: [rule({ partial_cod_mode: 'AVAILABLE', advance_type: type, advance_value: value, advance_non_refundable: 1 })],
        riskLevel: 'UNKNOWN', riskRule: { action: 'REQUIRE_PARTIAL_COD' },
      }), totalMinor);
      if (!r.partialCod.available) continue;
      assert.equal(r.nonRefundableAdvanceMinor, r.partialCod.payNowMinor,
        `${type} ${value} at ${totalMinor}: what is kept must equal the advance charged`);
      assert.ok(r.nonRefundableAdvanceMinor < totalMinor, 'never the whole order');
    }
  }
}

const calls=[]; const checkout={id:'checkout',status:'READY_FOR_PAYMENT',reservation_status:'RESERVED',reservation_is_expired:0,shipping_address_snapshot:{postalCode:'110001'},items_snapshot:[{skuId:'sku',productId:'product',quantity:1}],subtotal_minor:200000,total_minor:200000,selected_provider_code:'MOCK',selected_provider_service_code:'MOCK_STANDARD'};
const integrated=new PaymentEligibilityService({checkouts:{findOwned:async(customer)=>customer==='owner'?checkout:null},shipping:{quote:async()=>{calls.push('shipping');return {serviceable:true,methods:[{options:[{providerCode:'MOCK',providerServiceCode:'MOCK_STANDARD',codSupported:true}]}]};}},repository:{loadPolicy:async()=>{calls.push('policy');return policy();},save:async()=>calls.push('persist'),selectMode:async(_id,mode)=>mode==='PREPAID'}});
await integrated.evaluate('owner','checkout'); assert.deepEqual(calls,['shipping','policy','persist']);
await assert.rejects(integrated.evaluate('other','checkout'),(error)=>error.code==='CHECKOUT_NOT_FOUND');
await assert.rejects(integrated.selectMode('owner','checkout','FULL_COD'),(error)=>error.code==='PAYMENT_MODE_NOT_ELIGIBLE');
console.log(JSON.stringify({providerFirst:'PASS',providerUpperBound:'PASS',globalControls:'PASS',fixedAdvance:'PASS',percentageAdvance:'PASS',moneyInvariant:'PASS',productRestriction:'PASS',pinRestriction:'PASS',providerRestriction:'PASS',riskRestriction:'PASS',carrierAmountLimit:'PASS',rangeOverlap:'REJECTED',missingRuleFailClosed:'PASS',persistence:'PASS',crossCustomerIsolation:'PASS',tampering:'REJECTED',adminIncoherentBand:'REJECTED',adminBadPercentage:'REJECTED',adminInvertedRange:'REJECTED',adminBadRiskAction:'REJECTED',adminBadPin:'REJECTED',nonRefundableAdvanceMarked:'PASS',nonRefundableOffByDefault:'PASS',prepaidUnaffected:'PASS',nonRefundableWorksForBothAdvanceTypes:'PASS',nonRefundableMasterSwitch:'PASS'},null,2));
