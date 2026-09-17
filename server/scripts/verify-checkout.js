import { randomUUID } from 'node:crypto';

// Pinned to the mock carrier, and imported dynamically so this lands before
// the config module reads it.
//
// This suite checks CHECKOUT logic, not carrier integration -- the Delhivery
// adapter has its own scripts. The provider-failure assertion below relies on
// the mock's simulated blow-up for PIN 999999; with a real carrier configured
// that PIN is merely an unserviceable one, so the gate would pass or fail
// according to whichever carrier the operator happens to have enabled locally
// rather than according to the code under test.
process.env.SHIPPING_PROVIDER_MODE = 'MOCK';

const { pool, query } = await import('../src/database/connection/pool.js');
const { cartService } = await import('../src/modules/cart/service.js');
const { checkoutService } = await import('../src/modules/checkout/service.js');
const { addressService } = await import('../src/modules/addresses/service.js');
const { shippingService } = await import('../src/modules/shipping/service.js');
const { inventoryService } = await import('../src/modules/inventory/service.js');
const { idempotencySchema, shippingMethodSchema } = await import('../src/modules/checkout/validation.js');

const assert=(v,m)=>{if(!v)throw new Error(m);};
const customers=[randomUUID(),randomUUID()]; const checkoutIds=[]; const addressIds=[];
const address={firstName:'Checkout',lastName:'Test',phone:'9319987171',addressLine1:'1 Test Street',addressLine2:'',city:'Delhi',state:'Delhi',postalCode:'110001'};
async function inv(id){const [r]=await query('SELECT on_hand,reserved FROM inventory WHERE sku_id=?',[id]);return {onHand:Number(r.on_hand),reserved:Number(r.reserved)};}

async function main(){
 const skus=await query(`SELECT s.id,s.size,s.price_minor,v.storefront_id FROM skus s JOIN product_variants v ON v.id=s.variant_id JOIN products p ON p.id=v.product_id WHERE s.status='ACTIVE' AND v.status='ACTIVE' AND p.status='ACTIVE' ORDER BY s.id LIMIT 2`);
 const originals=await Promise.all(skus.map(s=>inv(s.id)));
 try{
  await query('UPDATE inventory SET on_hand=5,reserved=0 WHERE sku_id IN (?,?)',[skus[0].id,skus[1].id]);
  for(const id of customers)await query("INSERT INTO customers (id, brand_id,first_name,last_name,status,profile_completed_at) VALUES (?, (SELECT id FROM brands WHERE slug='corcotton'),'CheckoutTest','Test','ACTIVE',NOW(3))",[id]);
  await checkoutService.create(customers[1],randomUUID()).then(()=>{throw new Error('Empty cart accepted');},e=>assert(e.code==='EMPTY_CART','Wrong empty-cart result'));
  assert((await query('SELECT COUNT(*) c FROM inventory_reservations WHERE customer_id=?',[customers[1]]))[0].c===0,'Empty cart reserved');
  await cartService.addItem(customers[1],{storefrontId:skus[0].storefront_id,size:skus[0].size,quantity:2});
  await query('UPDATE inventory SET on_hand=1 WHERE sku_id=?',[skus[0].id]);
  await checkoutService.create(customers[1],randomUUID()).then(()=>{throw new Error('Stale stock checkout accepted');},e=>assert(e.code==='INSUFFICIENT_STOCK','Wrong stale-stock result'));
  assert((await query('SELECT COUNT(*) c FROM inventory_reservations WHERE customer_id=?',[customers[1]]))[0].c===0,'Stale stock created reservation');
  await query('DELETE FROM carts WHERE customer_id=?',[customers[1]]); await query('UPDATE inventory SET on_hand=5 WHERE sku_id=?',[skus[0].id]);

  await cartService.addItem(customers[0],{storefrontId:skus[0].storefront_id,size:skus[0].size,quantity:2});
  await cartService.addItem(customers[0],{storefrontId:skus[1].storefront_id,size:skus[1].size,quantity:1});
  const key=randomUUID(); const created=await checkoutService.create(customers[0],key); checkoutIds.push(created.id);
  assert(created.items.length===2 && (await inv(skus[0].id)).reserved===2 && (await inv(skus[1].id)).reserved===1,'Checkout reservation incorrect');
  const replay=await checkoutService.create(customers[0],key); assert(replay.id===created.id,'Checkout retry duplicated session');
  await query('UPDATE inventory SET on_hand=reserved WHERE sku_id IN (?,?)',[skus[0].id,skus[1].id]);
  const exactStockReplay=await checkoutService.create(customers[0],randomUUID()); assert(exactStockReplay.id===created.id,'Checkout did not recognize its own exact-stock reservation');
  await query('UPDATE inventory SET on_hand=5 WHERE sku_id IN (?,?)',[skus[0].id,skus[1].id]);
  const concurrentKey=randomUUID(); const concurrent=await Promise.all([checkoutService.create(customers[0],concurrentKey),checkoutService.create(customers[0],concurrentKey)]); assert(concurrent[0].id===created.id && concurrent[1].id===created.id,'Repeated create did not reuse active checkout');
  idempotencySchema.parse({idempotencyKey:randomUUID()});
  assert(!idempotencySchema.safeParse({idempotencyKey:randomUUID(),subtotalMinor:1,shippingMinor:1,totalMinor:2}).success,'Client totals accepted');
  assert(!shippingMethodSchema.safeParse({quoteId:randomUUID(),shippingMinor:1,providerCode:'FAKE_COURIER'}).success,'Client shipping authority accepted');
  await checkoutService.get(customers[1],created.id).then(()=>{throw new Error('Checkout ownership bypass');},e=>assert(e.code==='CHECKOUT_NOT_FOUND','Wrong checkout isolation'));

  const owned=await addressService.create(customers[0],address); addressIds.push(owned.id);
  const foreign=await addressService.create(customers[1],{...address,addressLine1:'Foreign'}); addressIds.push(foreign.id);
  await checkoutService.setAddress(customers[0],created.id,{addressId:foreign.id}).then(()=>{throw new Error('Address ownership bypass');},e=>assert(e.code==='ADDRESS_NOT_FOUND','Wrong address isolation'));
  let updated=await checkoutService.setAddress(customers[0],created.id,{addressId:owned.id});
  const stableLine=updated.shippingAddress.addressLine1;
  await addressService.update(customers[0],owned.id,{...address,addressLine1:'Changed Account Address'});
  updated=await checkoutService.get(customers[0],created.id); assert(updated.shippingAddress.addressLine1===stableLine,'Address snapshot mutated');
  updated=await checkoutService.checkServiceability(customers[0],created.id); assert(updated.serviceability.serviceable && updated.shippingMethods.length===1,'Serviceability failed');
  await checkoutService.selectShipping(customers[0],created.id,randomUUID()).then(()=>{throw new Error('Invalid shipping accepted');},e=>assert(e.code==='INVALID_SHIPPING_OPTION','Wrong shipping error'));
  const quoteId=updated.shippingMethods[0].options[0].quoteId;
  updated=await checkoutService.selectShipping(customers[0],created.id,quoteId); assert(updated.readiness.canProceedToPayment && updated.selectedShippingQuoteId===quoteId && updated.pricing.totalMinor===updated.pricing.subtotalMinor+updated.pricing.shippingMinor,'Checkout readiness/total incorrect');
  const refreshed=await checkoutService.get(customers[0],created.id); assert(refreshed.inventory.reservationStatus==='RESERVED' && refreshed.selectedShippingQuoteId===quoteId,'Refresh/read lost reservation or quote');
  updated=await checkoutService.setAddress(customers[0],created.id,{address:{...address,postalCode:'110002'},saveInfo:false});
  assert(!updated.serviceability && !updated.selectedShippingQuoteId && updated.pricing.shippingMinor===0,'PIN change did not invalidate shipping quote');
  updated=await checkoutService.checkServiceability(customers[0],created.id);
  updated=await checkoutService.selectShipping(customers[0],created.id,updated.shippingMethods[0].options[0].quoteId);

  await cartService.addItem(customers[0],{storefrontId:skus[0].storefront_id,size:skus[0].size,quantity:1});
  const invalidated=await checkoutService.get(customers[0],created.id); assert(invalidated.status==='CANCELLED' && (await inv(skus[0].id)).reserved===0,'Cart change did not release checkout');
  assert(await checkoutService.current(customers[0])===null,'Cart-change recovery returned a cancelled checkout as current');

  const replacement=await checkoutService.create(customers[0],randomUUID()); checkoutIds.push(replacement.id);
  const replacementReservation=(await query('SELECT inventory_reservation_id FROM checkout_sessions WHERE id=?',[replacement.id]))[0].inventory_reservation_id;
  await checkoutService.cancel(customers[0],replacement.id); await checkoutService.cancel(customers[0],replacement.id);
  assert((await query('SELECT status FROM inventory_reservations WHERE id=?',[replacementReservation]))[0].status==='RELEASED','Cancel did not release idempotently');

  const expiring=await checkoutService.create(customers[0],randomUUID()); checkoutIds.push(expiring.id);
  const expiringReservation=(await query('SELECT inventory_reservation_id FROM checkout_sessions WHERE id=?',[expiring.id]))[0].inventory_reservation_id;
  await query('UPDATE inventory_reservations SET expires_at=DATE_SUB(NOW(3),INTERVAL 1 SECOND) WHERE id=?',[expiringReservation]);
  assert((await checkoutService.get(customers[0],expiring.id)).status==='EXPIRED','Reservation timestamp expiry not reconciled');

  assert((await shippingService.quote({postalCode:'000000'})).serviceable===false,'Unserviceable PIN failed');
  await shippingService.quote({postalCode:'12345'}).then(()=>{throw new Error('Invalid PIN accepted');},e=>assert(e.code==='INVALID_POSTAL_CODE','Wrong PIN validation'));
  await shippingService.quote({postalCode:'99A999'}).then(()=>{throw new Error('Alpha PIN accepted');},e=>assert(e.code==='INVALID_POSTAL_CODE','Wrong alpha PIN validation'));
  await shippingService.quote({postalCode:'999999'}).then(()=>{throw new Error('Provider failure accepted');},e=>assert(e.code==='SHIPPING_PROVIDER_UNAVAILABLE','Provider failure misclassified'));

  const beforeCount=Number((await query('SELECT COUNT(*) c FROM addresses WHERE customer_id=?',[customers[0]]))[0].c);
  const saveFalseCheckout=await checkoutService.revalidate(customers[0],expiring.id,randomUUID()); checkoutIds.push(saveFalseCheckout.id);
  await checkoutService.setAddress(customers[0],saveFalseCheckout.id,{address:{...address,addressLine1:'Snapshot Only'},saveInfo:false});
  assert(Number((await query('SELECT COUNT(*) c FROM addresses WHERE customer_id=?',[customers[0]]))[0].c)===beforeCount,'saveInfo false persisted address');
  // Checkout autosaves while the customer types: the first save adds one book
  // entry, later saves of the same draft revise it instead of adding more.
  const draft=await checkoutService.setAddress(customers[0],saveFalseCheckout.id,{address:{...address,addressLine1:'Draft One',district:'New Delhi'},saveInfo:true});
  assert(draft.shippingAddressId && draft.shippingAddress.district==='New Delhi','Saved checkout address lost its id or district'); addressIds.push(draft.shippingAddressId);
  const revisedDraft=await checkoutService.setAddress(customers[0],saveFalseCheckout.id,{address:{...address,addressLine1:'Draft Two',district:''},saveInfo:true,replaceAddressId:draft.shippingAddressId});
  assert(revisedDraft.shippingAddressId===draft.shippingAddressId && revisedDraft.shippingAddress.addressLine1==='Draft Two' && revisedDraft.shippingAddress.district===null,'Autosave did not revise its own saved address');
  assert(Number((await query('SELECT COUNT(*) c FROM addresses WHERE customer_id=?',[customers[0]]))[0].c)===beforeCount+1,'Autosave added a duplicate saved address');
  // Naming another customer's address must not touch it — a fresh entry is created instead.
  const notMine=await checkoutService.setAddress(customers[0],saveFalseCheckout.id,{address:{...address,addressLine1:'Not Hijacked'},saveInfo:true,replaceAddressId:foreign.id});
  addressIds.push(notMine.shippingAddressId);
  assert(notMine.shippingAddressId!==foreign.id && (await query('SELECT address_line1 FROM addresses WHERE id=?',[foreign.id]))[0].address_line1==='Foreign','replaceAddressId modified another customer\'s address');
  const originalPrice=Number(skus[0].price_minor); await query('UPDATE skus SET price_minor=? WHERE id=?',[originalPrice+100,skus[0].id]);
  const priceInvalidated=await checkoutService.get(customers[0],saveFalseCheckout.id); assert(priceInvalidated.status==='CANCELLED','Price change did not invalidate checkout');
  assert(priceInvalidated.items[0].unitPriceMinor===skus[0].price_minor,'Checkout item snapshot was replaced by changed Cart pricing');
  await query('UPDATE skus SET price_minor=? WHERE id=?',[originalPrice,skus[0].id]);

  console.log(JSON.stringify({checkoutCreate:'PASS',emptyCart:'PASS',staleStockRejection:'PASS',idempotency:'PASS',duplicateCreate:'PASS',ownReservationReuse:'PASS',moneyTampering:'REJECTED',rateTampering:'REJECTED',inventoryReservation:'PASS',multiLine:'PASS',checkoutOwnership:'PASS',addressOwnership:'PASS',addressSnapshot:'PASS',itemSnapshot:'PASS',savedAddress:'PASS',snapshotOnlyAddress:'PASS',pinValidation:'PASS',serviceable:'PASS',unserviceable:'PASS',providerUnavailable:'PASS',shippingAuthority:'PASS',totalAuthority:'PASS',quotePersistence:'PASS',pinChangeInvalidation:'PASS',refreshRead:'PASS',cancelRelease:'PASS',expiryReconciliation:'PASS',cartChangeInvalidation:'PASS',priceChangeInvalidation:'PASS'},null,2));
 }finally{
  if(skus[0])await query('UPDATE skus SET price_minor=? WHERE id=?',[skus[0].price_minor,skus[0].id]);
  const checkoutReservations=await query('SELECT inventory_reservation_id id FROM checkout_sessions WHERE customer_id IN (?,?)',customers);
  for(const reservation of checkoutReservations)await inventoryService.releaseReservation(reservation.id);
  await query('DELETE FROM checkout_sessions WHERE customer_id IN (?,?)',customers);
  const reservations=await query('SELECT id FROM inventory_reservations WHERE customer_id IN (?,?)',customers);
  for(const r of reservations){await query("DELETE FROM inventory_movements WHERE reference_type='INVENTORY_RESERVATION' AND reference_id=?",[r.id]);await query('DELETE FROM inventory_reservations WHERE id=?',[r.id]);}
  await query('DELETE FROM carts WHERE customer_id IN (?,?)',customers); await query('DELETE FROM addresses WHERE customer_id IN (?,?)',customers); await query('DELETE FROM customers WHERE id IN (?,?)',customers);
  for(let i=0;i<skus.length;i++)await query('UPDATE inventory SET on_hand=?,reserved=? WHERE sku_id=?',[originals[i].onHand,originals[i].reserved,skus[i].id]); await pool.end();
 }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
