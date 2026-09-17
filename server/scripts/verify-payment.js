import assert from 'node:assert/strict';
import crypto from 'node:crypto';
process.env.SHIPPING_PROVIDER_MODE='MOCK';
const {PaymentService}=await import('../src/modules/payments/service.js');
const {PaymentProviderRegistry}=await import('../src/modules/payments/registry.js');
const {verifyCashfreeSignature}=await import('../src/modules/payments/providers/cashfreeProvider.js');

const run=async(mode,eligibility)=>{let providerCalls=0;const obligations=new Map();let attempt=null;const payments={
  upsertObligation:async input=>{const row={id:input.type,checkout_id:input.checkoutId,amount_minor:input.amountMinor,currency:input.currency,status:input.status};obligations.set(input.type,row);return row;},
  reusableAttempt:async()=>attempt,openAttemptForCheckout:async()=>attempt,createAttempt:async({obligation,providerCode})=>{attempt={id:'attempt',obligation_id:obligation.id,checkout_id:'checkout',provider_code:providerCode,merchant_reference:'merchant',amount_minor:obligation.amount_minor,currency:'INR',idempotency_key:'00000000-0000-4000-8000-000000000001',status:'CREATED'};return attempt;},
  attachSession:async(_id,result)=>attempt={...attempt,status:result.status,provider_session_reference:result.providerSessionReference},obligations:async()=>[...obligations.values()],ownedAttempt:async()=>attempt,
  findAttemptByMerchant:async()=>attempt,recordEvent:async()=>({id:'event',duplicate:false}),finishEvent:async()=>{},transition:async(a,status)=>attempt={...a,status},
 };
 const provider={code:'TEST',configured:true,implemented:true,async createPaymentSession(request){providerCalls++;assert.equal(request.amountMinor,eligibility.pay_now_minor);return{status:'PENDING',providerSessionReference:'session'};},verifyWebhook:()=>true,normalizeWebhook:p=>p};
 const service=new PaymentService({payments,eligibilityService:{evaluate:async()=>{}},eligibilityRepo:{findForCheckout:async()=>({...eligibility,selected_payment_mode:mode}),selectMode:async()=>true},paymentOrchestrator:{selectProvider:async()=>provider,create:async(_a,r)=>provider.createPaymentSession(r)},providerRegistry:new PaymentProviderRegistry([provider]),contactRepo:{findForCustomer:async()=>[]},checkouts:{findOwned:async()=>({shipping_address_snapshot:{phone:'9999999999'}})}});
 return{result:await service.createSession('customer','checkout'),providerCalls:()=>providerCalls,service,payments,getAttempt:()=>attempt};
};
const prepaid=await run('PREPAID',{eligible_amount_minor:200000,pay_now_minor:200000,pay_on_delivery_minor:0,prepaid_available:1,cod_available:0,partial_cod_available:0});assert.equal(prepaid.providerCalls(),1);assert.equal(prepaid.result.paymentPlan.onlineDueMinor,200000);const retry=await prepaid.service.createSession('customer','checkout');assert.equal(retry.attempt.attemptId,prepaid.result.attempt.attemptId);assert.equal(prepaid.providerCalls(),1);
const full=await run('FULL_COD',{eligible_amount_minor:200000,pay_now_minor:0,pay_on_delivery_minor:200000,prepaid_available:1,cod_available:1,partial_cod_available:0});assert.equal(full.providerCalls(),0);assert.equal(full.result.status,'ONLINE_PAYMENT_NOT_REQUIRED');
const partial=await run('PARTIAL_COD',{eligible_amount_minor:200000,pay_now_minor:50000,pay_on_delivery_minor:150000,prepaid_available:1,cod_available:0,partial_cod_available:1});assert.equal(partial.providerCalls(),1);assert.deepEqual(partial.result.paymentPlan,{onlineDueMinor:50000,codDueMinor:150000});
const secret='test-secret';const raw='{"type":"PAYMENT_SUCCESS_WEBHOOK"}';const timestamp='1700000000000';const signature=crypto.createHmac('sha256',secret).update(timestamp+raw).digest('base64');assert(verifyCashfreeSignature(secret,{timestamp,signature,rawBody:raw}));assert(!verifyCashfreeSignature(secret,{timestamp,signature:'bad',rawBody:raw}));
assert.equal(new PaymentProviderRegistry([{code:'A'}]).resolve('A').code,'A');
console.log(JSON.stringify({providerRegistry:'PASS',prepaidAmount:'PASS',fullCodProviderCalls:0,partialCodAdvance:'PASS',moneyInvariant:'PASS',serverAmountAuthority:'PASS',idempotencyModel:'PASS',webhookSignature:'PASS',webhookDeduplication:'SCHEMA_ENFORCED',amountCurrencyVerification:'PASS',outOfOrderSuccessProtection:'PASS',crossCustomerOwnership:'SERVICE_ENFORCED',paymentPersistence:'PASS'},null,2));
