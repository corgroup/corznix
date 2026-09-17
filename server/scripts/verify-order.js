import assert from 'node:assert/strict';
process.env.SHIPPING_PROVIDER_MODE='MOCK';
process.env.ORDER_FINALIZATION_WORKER_ENABLED='false';
const {OrderFinalizationService}=await import('../src/modules/orders/service.js');
const {finalizeOrderBatch}=await import('../src/modules/orders/finalizationWorker.js');
const {query,pool}=await import('../src/database/connection/pool.js');

const item={productId:'product',variantId:'variant',skuId:'sku',name:'Snapshot Tee',sku:'TEE-1',selectedSize:'M',selectedColor:'Black',quantity:1,unitPriceMinor:200000,lineTotalMinor:200000,media:{url:'snapshot.jpg'}};
function harness(mode,{onlineStatus=mode==='FULL_COD'?'NOT_REQUIRED':'PAID',onlineAmount=mode==='PARTIAL_COD'?50000:mode==='PREPAID'?200000:0,codStatus=mode==='PREPAID'?'NOT_REQUIRED':'DUE',codAmount=mode==='PARTIAL_COD'?150000:mode==='FULL_COD'?200000:0,expired=false,consumeFails=false}={}){
  const state={order:null,items:[],consumes:0,finished:0,reconciliation:null,retries:0,cartCleared:null};let gate=Promise.resolve();
  const checkout={id:'checkout',cart_id:'cart',customer_id:'customer-a',inventory_reservation_id:'reservation',status:'READY_FOR_PAYMENT',reservation_status:'RESERVED',reservation_is_expired:expired?1:0,currency:'INR',subtotal_minor:200000,shipping_minor:0,total_minor:200000,items_snapshot:[item],shipping_address_snapshot:{city:'Delhi',postalCode:'110001'},shipping_quote_snapshot:{estimatedDays:3},selected_shipping_method_code:'STANDARD',selected_provider_code:'MOCK',selected_provider_service_code:'STANDARD',shipping_quote_reference:'quote'};
  const repository={
    checkout:async(_id,customerId)=>!customerId||customerId===checkout.customer_id?checkout:null,
    findByCheckout:async()=>state.order,eligibility:async()=>({selected_payment_mode:mode}),
    obligations:async()=>[{obligation_type:'ONLINE',status:onlineStatus,amount_minor:onlineAmount,currency:'INR'},{obligation_type:'COD',status:codStatus,amount_minor:codAmount,currency:'INR'}],
    create:async(_connection,{onlinePaid,codDue,source})=>state.order={id:'order',order_number:'COR-TEST',subtotal_minor:200000,shipping_minor:0,total_minor:200000,online_paid_minor:onlinePaid,cod_due_minor:codDue,shipping_address_snapshot:structuredClone(checkout.shipping_address_snapshot),shipping_snapshot:{providerCode:'MOCK'},payment_status:codDue?onlinePaid?'PARTIALLY_PAID':'COD_DUE':'PAID',finalization_source:source},
    addItems:async(_connection,_orderId,items)=>{state.items=structuredClone(items).map((value,index)=>({id:String(index),product_name:value.name,...value,unit_price_minor:value.unitPriceMinor,line_total_minor:value.lineTotalMinor,media_snapshot:value.media}));},
    // Mirrors the real repository: the purchased lines leave the cart inside
    // the same transaction. Counted so a finalize that stops clearing fails
    // here too, not only in verify:cart-clear.
    clearPurchasedCartLines:async(_connection,cartId,items)=>{state.cartCleared={cartId,lines:(items||[]).length};return(items||[]).length;},
    finish:async()=>{state.finished++;},items:async()=>state.items,
    enqueue:async()=>{state.retries++;},reconciliation:async(_id,code)=>{state.reconciliation=code;},
    findOwned:async(customerId)=>customerId==='customer-a'?state.order:null,listOwned:async()=>state.order?[state.order]:[],
  };
  const transaction=callback=>{const run=async()=>{const before=structuredClone(state);try{return await callback({});}catch(error){Object.assign(state,before);throw error;}};const result=gate.then(run);gate=result.catch(()=>{});return result;};
  const inventory={consumeReservation:async()=>{if(consumeFails){const error=new Error('consume failed');error.code='INVENTORY_INVARIANT_VIOLATION';throw error;}state.consumes++;}};
  const bootstrapFulfillment=async id=>{state.bootstrapped=id;};
  return{service:new OrderFinalizationService({repository,inventory,transaction,bootstrapFulfillment}),state,checkout};
}

for(const [mode,source,expected] of [['PREPAID','PAYMENT_WEBHOOK',[200000,0]],['FULL_COD','CUSTOMER_PLACE_ORDER',[0,200000]],['PARTIAL_COD','PAYMENT_WEBHOOK',[50000,150000]]]){
  const test=harness(mode);const [a,b,c]=await Promise.all([test.service.finalize('checkout',{source}),test.service.finalize('checkout',{source}),test.service.finalize('checkout',{source})]);
  assert.equal(new Set([a.id,b.id,c.id]).size,1);assert.equal(test.state.consumes,1);assert.equal(test.state.finished,1);
  // The purchased lines leave the cart in the same transaction, exactly once —
  // a duplicate webhook must not decrement the cart a second time.
  assert.deepEqual(test.state.cartCleared,{cartId:'cart',lines:1},'finalize must clear the purchased cart lines once');assert.deepEqual([a.onlinePaidMinor,a.codDueMinor],expected);assert.equal(a.onlinePaidMinor+a.codDueMinor,a.totalMinor);
}
await assert.rejects(()=>harness('FULL_COD').service.finalize('checkout',{source:'RECOVERY_WORKER'}),error=>error.code==='FULL_COD_PLACE_ORDER_REQUIRED');
for(const status of ['PENDING','FAILED'])await assert.rejects(()=>harness('PREPAID',{onlineStatus:status}).service.finalize('checkout',{source:'CUSTOMER_PLACE_ORDER'}),error=>error.code==='FINANCIAL_READINESS_REQUIRED');
const expired=harness('PREPAID',{expired:true});await assert.rejects(()=>expired.service.finalize('checkout',{source:'PAYMENT_WEBHOOK'}),error=>error.code==='RESERVATION_EXPIRED');assert.equal(expired.state.reconciliation,'RESERVATION_EXPIRED');assert.equal(expired.state.order,null);
const rollback=harness('PREPAID',{consumeFails:true});await assert.rejects(()=>rollback.service.finalize('checkout',{source:'PAYMENT_WEBHOOK'}));assert.equal(rollback.state.order,null);assert.equal(rollback.state.finished,0);assert.equal(rollback.state.cartCleared,null,'a rolled-back finalize must not have cleared the cart');assert.equal(rollback.state.reconciliation,'INVENTORY_INVARIANT_VIOLATION');
const isolated=harness('FULL_COD');await assert.rejects(()=>isolated.service.finalize('checkout',{customerId:'customer-b',source:'CUSTOMER_PLACE_ORDER'}),error=>error.code==='CHECKOUT_NOT_FOUND');
// Asserts productName, not name: order_items has a product_name column and
// no name column, so `name` only ever existed because the DTO spread the
// whole row and this harness happens to fabricate one. Reading it here meant
// the gate was checking a field production never returns.
const snapshot=harness('FULL_COD');const order=await snapshot.service.finalize('checkout',{source:'CUSTOMER_PLACE_ORDER'});snapshot.checkout.items_snapshot[0].name='Changed';snapshot.checkout.shipping_address_snapshot.city='Mumbai';assert.equal(order.items[0].productName,'Snapshot Tee','the item snapshot is frozen at finalisation');assert.equal(order.shippingAddress.city,'Delhi');
let recovered=0;assert.equal(await finalizeOrderBatch({repository:{claim:async()=>['paid-checkout']},service:{finalize:async(id,{source})=>{assert.equal(id,'paid-checkout');assert.equal(source,'RECOVERY_WORKER');recovered++;}},batchSize:1}),1);assert.equal(recovered,1);

const uniqueRows=await query(`SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='orders' AND NON_UNIQUE=0`);
assert(uniqueRows.some(row=>row.INDEX_NAME==='uk_orders_checkout'));assert(uniqueRows.some(row=>row.INDEX_NAME==='uk_orders_brand_number'));
const linkColumn=await query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='payment_obligations' AND COLUMN_NAME='order_id'`);assert.equal(linkColumn.length,1);
console.log(JSON.stringify({prepaid:'PASS',fullCod:'PASS',partialCod:'PASS',fullCodExplicitIntent:'PASS',pendingFailedBlocked:'PASS',concurrentExactlyOnce:'PASS',inventoryConsumeOnce:'PASS',transactionRollback:'PASS',paidExpiredReconciliation:'PASS',recoveryWorker:'PASS',crossCustomerIsolation:'PASS',snapshotImmutability:'PASS',financialInvariant:'PASS',checkoutUniqueConstraint:'PASS',orderNumberUniqueConstraint:'PASS',paymentOrderLink:'PASS'},null,2));
await pool.end();
