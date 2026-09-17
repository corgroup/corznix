import { randomUUID } from 'node:crypto';
import { query } from '../../database/connection/pool.js';
const exec=async(connection,sql,params=[])=>connection?(await connection.execute(sql,params))[0]:query(sql,params);
const parse=v=>typeof v==='string'?JSON.parse(v):v;

export class OrderRepository {
  async checkout(checkoutId,customerId=null,connection=null,{lock=false}={}){const params=[checkoutId];let owner='';if(customerId){owner=' AND cs.customer_id=?';params.push(customerId);}const rows=await exec(connection,`SELECT cs.*,ir.status reservation_status,(ir.expires_at<=NOW(3)) reservation_is_expired FROM checkout_sessions cs JOIN inventory_reservations ir ON ir.id=cs.inventory_reservation_id WHERE cs.id=?${owner} LIMIT 1${lock?' FOR UPDATE':''}`,params);return rows[0]||null;}
  async findByCheckout(checkoutId,connection=null){return(await exec(connection,'SELECT * FROM orders WHERE checkout_id=? LIMIT 1',[checkoutId]))[0]||null;}
  async replaceExpiredReservation(connection,checkoutId,reservation){await exec(connection,`UPDATE checkout_sessions SET inventory_reservation_id=?,reservation_expires_at=?,expires_at=?,status='READY_FOR_PAYMENT',updated_at=NOW(3) WHERE id=?`,[reservation.id,reservation.expiresAt,reservation.expiresAt,checkoutId]);}
  async findOwned(customerId,idOrNumber,connection=null){return(await exec(connection,'SELECT * FROM orders WHERE customer_id=? AND (id=? OR order_number=?) LIMIT 1',[customerId,idOrNumber,idOrNumber]))[0]||null;}
  async listOwned(customerId){return query('SELECT * FROM orders WHERE customer_id=? ORDER BY placed_at DESC',[customerId]);}
  async eligibility(checkoutId,connection){return(await exec(connection,'SELECT * FROM checkout_payment_eligibility WHERE checkout_id=? LIMIT 1 FOR UPDATE',[checkoutId]))[0]||null;}
  obligations(checkoutId,connection,{lock=false}={}){return exec(connection,`SELECT * FROM payment_obligations WHERE checkout_id=? ORDER BY obligation_type${lock?' FOR UPDATE':''}`,[checkoutId]);}
  // Multi-company (DESIGN.md §4.1) — Phase 4. brand_id comes from
  // `checkout.brand_id` (checkout_sessions is itself brand-scoped, resolved
  // at checkout creation from the storefront's own host) — never passed
  // separately, so an order can never disagree with its own checkout's
  // brand. order_number's prefix is looked up from `brands.order_prefix`
  // (migration 081) instead of a hardcoded "COR-", so Cor-Znix orders read
  // distinctly from Cor-Cotton's.
  async create(connection,{checkout,eligibility,onlinePaid,codDue,source,storeCreditMinor=0}){const id=randomUUID();const brandRow=(await exec(connection,'SELECT order_prefix FROM brands WHERE id=?',[checkout.brand_id]))[0];const prefix=brandRow?.order_prefix||'ORD';const orderNumber=`${prefix}-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${id.replaceAll('-','').slice(0,12).toUpperCase()}`;const paymentStatus=codDue===0?'PAID':onlinePaid===0?'COD_DUE':'PARTIALLY_PAID';const selected=parse(checkout.shipping_quote_snapshot)||{};const discountMinor=Number(checkout.discount_minor||0);await exec(connection,`INSERT INTO orders (id,brand_id,order_number,checkout_id,customer_id,inventory_reservation_id,payment_status,payment_mode,currency,subtotal_minor,shipping_minor,total_minor,discount_minor,store_credit_applied_minor,online_paid_minor,non_refundable_advance_minor,cod_due_minor,shipping_address_snapshot,shipping_snapshot,finalization_source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,checkout.brand_id,orderNumber,checkout.id,checkout.customer_id,checkout.inventory_reservation_id,paymentStatus,eligibility.selected_payment_mode,checkout.currency,checkout.subtotal_minor,checkout.shipping_minor,checkout.total_minor,discountMinor,storeCreditMinor,onlinePaid,Math.min(Number(eligibility.advance_non_refundable_minor||0),Number(onlinePaid||0)),codDue,JSON.stringify(parse(checkout.shipping_address_snapshot)),JSON.stringify({serviceLevel:checkout.selected_shipping_method_code,providerCode:checkout.selected_provider_code,providerServiceCode:checkout.selected_provider_service_code,shippingChargeMinor:Number(checkout.shipping_minor),customerShippingChargeMinor:Number(checkout.shipping_minor),providerRateMinor:selected.providerRateMinor??null,actualLogisticsCostMinor:selected.actualLogisticsCostMinor??selected.providerRateMinor??null,surchargeMinor:selected.surchargeMinor??null,pricingMode:selected.pricingMode??null,ownerDeliveryZone:selected.ownerDeliveryZone??null,estimatedDays:selected.estimatedDays??null,quoteReference:checkout.shipping_quote_reference}),source]);return this.findByCheckout(checkout.id,connection);}
  async addItems(connection,orderId,items){const created=[];for(const item of items){const id=randomUUID();await exec(connection,`INSERT INTO order_items (id,order_id,product_id,variant_id,sku_id,product_name,sku,selected_size,selected_color,quantity,unit_price_minor,line_total_minor,media_snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[id,orderId,item.productId,item.variantId,item.skuId,item.name,item.sku,item.selectedSize||null,item.selectedColor||null,item.quantity,item.unitPriceMinor,item.lineTotalMinor,JSON.stringify(item.media||null)]);created.push({id,skuId:item.skuId,lineKey:item.skuId});}return created;}
  /**
   * Take the purchased quantities out of the cart, inside the order
   * transaction. Nothing did this before, so a customer who paid still had the
   * items they had just bought sitting in their cart — and adding anything
   * afterwards built a checkout on top of them.
   *
   * Decrements rather than truncating, because the cart is not a copy of the
   * order: anything added after this checkout was created was not bought and
   * must survive, and if the quantity was raised afterwards only the purchased
   * part goes. A line that reaches zero is deleted.
   *
   * The cart ROW is kept: checkout_sessions.cart_id is ON DELETE RESTRICT, and
   * the row is the customer's cart identity, not this order's basket.
   *
   * Idempotent — a recovery-worker re-finalize finds the lines already gone
   * and removes nothing.
   */
  /** What the customer paid with store credit, frozen on the order. */
  async recordStoreCreditSpent(connection,orderId,amountMinor){
    await exec(connection,'UPDATE orders SET store_credit_applied_minor=? WHERE id=?',[amountMinor,orderId]);
  }

  async clearPurchasedCartLines(connection,cartId,items){
    if(!cartId||!Array.isArray(items)||!items.length)return 0;
    let removed=0;
    for(const item of items){
      const skuId=item.skuId||item.sku_id;
      const quantity=Number(item.quantity);
      if(!skuId||!Number.isFinite(quantity)||quantity<=0)continue;
      const rows=await exec(connection,'SELECT id,quantity FROM cart_items WHERE cart_id=? AND sku_id=? LIMIT 1 FOR UPDATE',[cartId,skuId]);
      const line=rows[0];
      if(!line)continue;
      const remaining=Number(line.quantity)-quantity;
      if(remaining>0)await exec(connection,'UPDATE cart_items SET quantity=?,updated_at=NOW(3) WHERE id=?',[remaining,line.id]);
      else await exec(connection,'DELETE FROM cart_items WHERE id=?',[line.id]);
      removed+=1;
    }
    return removed;
  }

  async finish(connection,checkoutId,orderId){await exec(connection,'UPDATE payment_obligations SET order_id=? WHERE checkout_id=?',[orderId,checkoutId]);await exec(connection,"UPDATE checkout_sessions SET status='FINALIZED',finalized_at=NOW(3),updated_at=NOW(3) WHERE id=?",[checkoutId]);await exec(connection,"UPDATE order_finalization_jobs SET status='COMPLETED',completed_at=NOW(3),locked_at=NULL WHERE checkout_id=?",[checkoutId]);}
  items(orderId){return query('SELECT * FROM order_items WHERE order_id=? ORDER BY created_at',[orderId]);}
  async enqueue(checkoutId,errorCode='FINALIZATION_RETRY'){await query(`INSERT INTO order_finalization_jobs (checkout_id,status,last_error_code,next_attempt_at) VALUES (?,'PENDING',?,NOW(3)) ON DUPLICATE KEY UPDATE status=IF(status='COMPLETED',status,'RETRY'),last_error_code=VALUES(last_error_code),next_attempt_at=DATE_ADD(NOW(3),INTERVAL LEAST(300,POW(2,attempt_count)) SECOND),locked_at=NULL`,[checkoutId,errorCode]);}
  async reconciliation(checkoutId,errorCode){await query(`INSERT INTO order_finalization_jobs (checkout_id,status,last_error_code,next_attempt_at) VALUES (?,'RECONCILIATION_REQUIRED',?,NOW(3)) ON DUPLICATE KEY UPDATE status='RECONCILIATION_REQUIRED',last_error_code=VALUES(last_error_code),locked_at=NULL`,[checkoutId,errorCode]);}
  async claim(limit=10){const connection=await (await import('../../database/connection/pool.js')).pool.getConnection();try{await connection.beginTransaction();const rows=(await connection.execute(`SELECT checkout_id FROM order_finalization_jobs WHERE status IN ('PENDING','RETRY') AND next_attempt_at<=NOW(3) ORDER BY next_attempt_at LIMIT ? FOR UPDATE SKIP LOCKED`,[Number(limit)]))[0];for(const row of rows)await connection.execute("UPDATE order_finalization_jobs SET status='PROCESSING',attempt_count=attempt_count+1,locked_at=NOW(3) WHERE checkout_id=?",[row.checkout_id]);await connection.commit();return rows.map(r=>r.checkout_id);}catch(error){await connection.rollback();throw error;}finally{connection.release();}}
}
export const orderRepository=new OrderRepository();
