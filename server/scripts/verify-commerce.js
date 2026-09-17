import assert from 'node:assert/strict';
process.env.SHIPPING_PROVIDER_MODE='MOCK';process.env.ORDER_FINALIZATION_WORKER_ENABLED='false';
const {PaymentService}=await import('../src/modules/payments/service.js');
const {PaymentProviderRegistry}=await import('../src/modules/payments/registry.js');
const {query,pool}=await import('../src/database/connection/pool.js');

async function sessionHarness(mode,{total=200000,advance=50000}={}){
  let providerCalls=0;const obligations=new Map();let attempt=null;
  const eligibility={selected_payment_mode:mode,eligible_amount_minor:total,pay_now_minor:mode==='PARTIAL_COD'?advance:mode==='FULL_COD'?0:total,pay_on_delivery_minor:mode==='PARTIAL_COD'?total-advance:mode==='FULL_COD'?total:0,prepaid_available:1,cod_available:1,partial_cod_available:1};
  const payments={upsertObligation:async value=>{const row={id:value.type,checkout_id:'checkout',amount_minor:value.amountMinor,currency:'INR',status:value.status};obligations.set(value.type,row);return row;},reusableAttempt:async()=>attempt,openAttemptForCheckout:async()=>attempt,createAttempt:async({obligation,providerCode})=>attempt={id:'attempt',checkout_id:'checkout',obligation_id:obligation.id,provider_code:providerCode,merchant_reference:'merchant',amount_minor:obligation.amount_minor,currency:'INR',idempotency_key:'idempotency',status:'CREATED'},attachSession:async(_id,result)=>attempt={...attempt,status:result.status,provider_session_reference:result.providerSessionReference}};
  const provider={code:'TEST',configured:true,implemented:true,createPaymentSession:async request=>{providerCalls++;return{status:'PENDING',providerSessionReference:'one-session',amount:request.amountMinor};}};
  const service=new PaymentService({payments,eligibilityService:{evaluate:async()=>{}},eligibilityRepo:{findForCheckout:async()=>eligibility,selectMode:async()=>true},paymentOrchestrator:{selectProvider:async()=>provider,create:async(_attempt,request)=>provider.createPaymentSession(request)},providerRegistry:new PaymentProviderRegistry([provider]),contactRepo:{findForCustomer:async()=>[]},checkouts:{findOwned:async()=>({shipping_address_snapshot:{phone:'9999999999'}})},orders:{schedule:async()=>{},finalize:async()=>null}});
  return{result:await service.createSession('customer','checkout'),providerCalls,obligations};
}

const prepaid=await sessionHarness('PREPAID');assert.equal(prepaid.providerCalls,1);assert.equal(prepaid.obligations.get('ONLINE').amount_minor,200000);
const full=await sessionHarness('FULL_COD');assert.equal(full.providerCalls,0);assert.equal(full.result.status,'ONLINE_PAYMENT_NOT_REQUIRED');assert.equal(full.obligations.get('COD').amount_minor,200000);
const partial=await sessionHarness('PARTIAL_COD');assert.equal(partial.providerCalls,1);assert.equal(partial.obligations.get('ONLINE').amount_minor,50000);assert.equal(partial.obligations.get('COD').amount_minor,150000);

let attempt={id:'attempt',checkout_id:'checkout',merchant_reference:'merchant',obligation_id:'online',amount_minor:50000,currency:'INR',status:'PENDING'};let duplicate=false;let orders=0;let consumed=0;
const webhookPayments={findAttemptByMerchant:async()=>attempt,recordEvent:async()=>duplicate?{duplicate:true}:{id:'event',duplicate:false},finishEvent:async()=>{},transition:async(value,status)=>attempt={...value,status}};
const provider={code:'CASHFREE',configured:true,implemented:true,verifyWebhook:()=>true,normalizeWebhook:()=>({merchantReference:'merchant',amountMinor:50000,currency:'INR',status:'SUCCEEDED',rawStatus:'SUCCESS',eventType:'PAYMENT_SUCCESS_WEBHOOK'})};
const service=new PaymentService({payments:webhookPayments,providerRegistry:new PaymentProviderRegistry([provider]),orders:{schedule:async()=>{},finalize:async()=>{if(!orders){orders=1;consumed=1;}return{id:'order'};}}});
await service.webhook('CASHFREE',{headers:{'x-idempotency-key':'event'},rawBody:'{}'});duplicate=true;await Promise.all([service.webhook('CASHFREE',{headers:{'x-idempotency-key':'event'},rawBody:'{}'}),service.finalizeVerified('checkout',{source:'PAYMENT_RECONCILIATION'})]);assert.equal(orders,1);assert.equal(consumed,1);
attempt={...attempt,status:'PENDING'};orders=0;duplicate=false;provider.normalizeWebhook=()=>({merchantReference:'merchant',amountMinor:50000,currency:'INR',status:'FAILED',rawStatus:'FAILED',eventType:'PAYMENT_FAILED_WEBHOOK'});await service.webhook('CASHFREE',{headers:{},rawBody:'{}'});assert.equal(orders,0);

const unique=await query(`SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_attempts' AND NON_UNIQUE=0`);assert(unique.some(row=>row.INDEX_NAME==='uk_payment_attempt_active_obligation'));
// Two of these invariants predate exchange orders and misread them.
//
//   duplicate_orders   — an exchange order has NO checkout, and MySQL groups
//                        every NULL together, so any two exchange orders look
//                        like duplicates of one another. seed-orders.js already
//                        documents this hazard and dodges it by always giving
//                        its orders a checkout; a real exchange cannot.
//   invalid_order_splits — an exchange order is paid by exchange CREDIT, a
//                        third bucket alongside online and COD. Ignoring it
//                        makes every fully-credit-funded exchange look like an
//                        order whose money does not add up.
//
// Both would have fired on production the first time a customer completed a
// different-style exchange, and read as data corruption rather than as a stale
// invariant.
const [audit]=await query(`SELECT (SELECT COUNT(*) FROM (SELECT checkout_id FROM orders WHERE checkout_id IS NOT NULL GROUP BY checkout_id HAVING COUNT(*)>1) d) duplicate_orders,(SELECT COUNT(*) FROM order_items oi LEFT JOIN orders o ON o.id=oi.order_id WHERE o.id IS NULL) orphan_items,(SELECT COUNT(*) FROM inventory WHERE on_hand<0 OR reserved<0 OR reserved>on_hand) invalid_inventory,(SELECT COUNT(*) FROM orders WHERE online_paid_minor+cod_due_minor+COALESCE(exchange_credit_applied_minor,0)<>total_minor) invalid_order_splits,(SELECT COUNT(*) FROM payment_obligations po WHERE po.order_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.id=po.order_id)) orphan_payment_links`);
assert.deepEqual(Object.values(audit).map(Number),[0,0,0,0,0]);
console.log(JSON.stringify({prepaidIntegration:'PASS',fullCodNoGateway:'PASS',partialCodAdvanceOnly:'PASS',webhookBrowserWorkerConvergence:'PASS',failedPaymentNoOrder:'PASS',activeAttemptUniqueness:'PASS',databasePostRunAudit:audit},null,2));await pool.end();
