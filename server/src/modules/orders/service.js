import { withTransaction } from '../../database/connection/transaction.js';
import { customerOrderStatus, customerTimeline, customerActivity, CUSTOMER_STATUS_LABEL } from '../orderOps/customerStatus.js';
import { orderActionFlags } from '../orderOps/orderActions.js';
import { returnEligibilityService } from '../returns/returnEligibilityService.js';
import { AppError } from '../../utils/errors.js';
import { bootstrapFulfillmentForOrder } from '../fulfillment/bootstrap.js';
import { fulfillmentService } from '../fulfillment/service.js';
import { inventoryService } from '../inventory/service.js';
import { checkoutStoreCreditService } from '../checkout/storeCreditService.js';
import { warehouseAllocationService } from '../warehouses/allocationService.js';
import { promotionService } from '../promotions/service.js';
import { notificationService } from '../notifications/service.js';
import { staffNotificationService } from '../staffNotifications/service.js';
import { shippingService } from '../shipping/service.js';
import { communicationService } from '../communications/service.js';
import { CustomerContactRepository } from '../customers/repositories.js';
import { query } from '../../database/connection/pool.js';
import { env } from '../../config/index.js';
import { orderRepository } from './repository.js';

const ownerDeliveryContacts = new CustomerContactRepository();

const parse=value=>typeof value==='string'?JSON.parse(value):value;
// The customer-facing shape of an order.
//
// This used to spread the whole database row, so every customer reading
// their own order list also received checkout_id, inventory_reservation_id,
// allocation_fingerprint, finalization_source, brand_id and the ids of the
// staff members who confirmed or cancelled it. None of that is theirs to
// see, and none of it is rendered anywhere. Listing the fields explicitly
// means a column added to `orders` later cannot quietly join them.
//
// Both spellings are emitted on purpose: the storefront has read
// order_number / order_status / payment_status / placed_at since Wave 5,
// and renaming those in the same change would be a second, unrelated risk.
const dto=async(order,repository)=>({
  id:order.id,
  order_number:order.order_number,orderNumber:order.order_number,
  order_status:order.order_status,orderStatus:order.order_status,
  payment_status:order.payment_status,paymentStatus:order.payment_status,
  fulfillment_status:order.fulfillment_status,fulfillmentStatus:order.fulfillment_status,
  payment_mode:order.payment_mode,paymentMode:order.payment_mode,
  currency:order.currency,
  subtotalMinor:Number(order.subtotal_minor),shippingMinor:Number(order.shipping_minor),totalMinor:Number(order.total_minor),
  discountMinor:Number(order.discount_minor||0),
  onlinePaidMinor:Number(order.online_paid_minor),codDueMinor:Number(order.cod_due_minor),
  // Disclosed at checkout before it is charged, so the customer keeps a
  // record of what was withheld if the order comes back.
  nonRefundableAdvanceMinor:Number(order.non_refundable_advance_minor||0),
  placed_at:order.placed_at,placedAt:order.placed_at,
  confirmedAt:order.confirmed_at??null,completedAt:order.completed_at??null,
  cancelledAt:order.cancelled_at??null,cancellationReason:order.cancellation_reason??null,
  isExchangeOrder:Boolean(order.is_exchange_order),exchangeType:order.exchange_type??null,
  exchangeCreditAppliedMinor:Number(order.exchange_credit_applied_minor||0),
  shippingAddress:parse(order.shipping_address_snapshot),shipping:parse(order.shipping_snapshot),
  items:(await repository.items(order.id)).map(item=>({
    id:item.id,
    // product_id is what the storefront links back to the catalogue with.
    product_id:item.product_id,productId:item.product_id,
    variantId:item.variant_id,skuId:item.sku_id,sku:item.sku,
    product_name:item.product_name,productName:item.product_name,
    selectedSize:item.selected_size,selectedColor:item.selected_color,
    quantity:Number(item.quantity),unitPriceMinor:Number(item.unit_price_minor),lineTotalMinor:Number(item.line_total_minor),
    media:parse(item.media_snapshot),
  })),
});

export class OrderFinalizationService {
  constructor({repository=orderRepository,inventory=inventoryService,transaction=withTransaction,bootstrapFulfillment=bootstrapFulfillmentForOrder,fulfillment=fulfillmentService}={}){this.repository=repository;this.inventory=inventory;this.transaction=transaction;this.bootstrapFulfillment=bootstrapFulfillment;this.fulfillment=fulfillment;}

  async finalize(checkoutId,{customerId=null,source='RECOVERY_WORKER'}={}){
    try{
      // Phase 2 · Slice 7 — a customer placing the order (FULL_COD path, before
      // any money moves) gets a fresh shipping-rate re-check. Online orders are
      // revalidated at payment-session creation instead (payments/service.js);
      // a recovery-worker / post-payment finalize is never blocked here.
      if(source==='CUSTOMER_PLACE_ORDER'){
        const pre=await this.repository.checkout(checkoutId,customerId);
        const snap=pre?.shipping_quote_snapshot?parse(pre.shipping_quote_snapshot):null;
        if(pre&&snap){
          const check=await shippingService.revalidateQuote({
            postalCode:parse(pre.shipping_address_snapshot)?.postalCode,
            quoteSnapshot:{...snap,quoteExpiresAt:snap.quoteExpiresAt||pre.shipping_quote_expires_at},
            items:parse(pre.items_snapshot)?.map(i=>({skuId:i.skuId,quantity:Number(i.quantity)}))||[],
          });
          if(!check.ok)throw new AppError('SHIPPING_REVALIDATION_REQUIRED',`The shipping quote is no longer valid (${check.reason}). Please check delivery again.`,409,{reason:check.reason,freshChargeMinor:check.freshChargeMinor??null});
        }
      }
      const order=await this.transaction(async connection=>{
        const checkout=await this.repository.checkout(checkoutId,customerId,connection,{lock:true});
        if(!checkout)throw new AppError('CHECKOUT_NOT_FOUND','Checkout session not found.',404);
        const existing=await this.repository.findByCheckout(checkoutId,connection);
        if(existing)return existing;
        if(!['READY_FOR_PAYMENT','EXPIRED'].includes(checkout.status))throw new AppError('CHECKOUT_NOT_FINALIZABLE','Checkout cannot be finalized.',409);

        const eligibility=await this.repository.eligibility(checkoutId,connection);
        if(!eligibility?.selected_payment_mode)throw new AppError('PAYMENT_PLAN_NOT_READY','Payment mode is not finalized.',409);
        const obligations=await this.repository.obligations(checkoutId,connection,{lock:true});
        const online=obligations.find(value=>value.obligation_type==='ONLINE');
        const cod=obligations.find(value=>value.obligation_type==='COD');
        if(!online||!cod)throw new AppError('PAYMENT_PLAN_NOT_READY','Payment obligations are missing.',409);
        const onlinePaid=online.status==='PAID'?Number(online.amount_minor):online.status==='NOT_REQUIRED'?0:null;
        const codDue=cod.status==='DUE'?Number(cod.amount_minor):cod.status==='NOT_REQUIRED'?0:null;
        // Store credit is the third part of the plan: what the customer paid
        // online, what the courier will collect, and what came out of their
        // balance must together be exactly the order. The invariant stays
        // absolute — it is the last line between a mispriced plan and a
        // customer being charged the wrong amount.
        const creditApplied=Math.min(Number(checkout.store_credit_applied_minor||0),Number(checkout.total_minor));
        if(online.currency!==checkout.currency||cod.currency!==checkout.currency||onlinePaid==null||codDue==null||onlinePaid+codDue+creditApplied!==Number(checkout.total_minor)){
          throw new AppError('FINANCIAL_READINESS_REQUIRED','Verified payment obligations are not ready.',409);
        }
        if(eligibility.selected_payment_mode==='FULL_COD'&&source!=='CUSTOMER_PLACE_ORDER')throw new AppError('FULL_COD_PLACE_ORDER_REQUIRED','Full COD requires explicit customer confirmation.',409);
        if(checkout.reservation_status!=='RESERVED'||Number(checkout.reservation_is_expired)){
          if(checkout.status!=='EXPIRED'||onlinePaid<=0)throw new AppError('RESERVATION_EXPIRED','Inventory reservation is no longer consumable.',409);
          const persistedAllocation=checkout.warehouse_allocation_json?parse(checkout.warehouse_allocation_json):null;
          const recoveryItems=persistedAllocation?.allocations?.length
            ?persistedAllocation.allocations.flatMap(a=>a.items.map(i=>({warehouseId:a.warehouseId,skuId:i.skuId,quantity:Number(i.quantity)})))
            :warehouseAllocationService.toReservationItems(await warehouseAllocationService.allocate({items:parse(checkout.items_snapshot).map(item=>({skuId:item.skuId,quantity:Number(item.quantity)}))}));
          const recovered=await this.inventory.reserve(recoveryItems,{customerId:checkout.customer_id,idempotencyKey:`payment-recovery:${checkout.id}`,connection});
          await this.repository.replaceExpiredReservation(connection,checkout.id,recovered);
          checkout.inventory_reservation_id=recovered.id;checkout.reservation_status='RESERVED';checkout.reservation_is_expired=0;
        }

        const created=await this.repository.create(connection,{checkout,eligibility,onlinePaid,codDue,source,storeCreditMinor:creditApplied});
        const createdItems=await this.repository.addItems(connection,created.id,parse(checkout.items_snapshot));
        // Promotions (Wave 8G-6): CONSUME the reserved redemption(s) exactly
        // once and freeze the immutable per-order + per-line discount snapshot.
        // Idempotent against duplicate finalization / duplicate payment webhook.
        const promoContext=checkout.promotion_context_json?parse(checkout.promotion_context_json):null;
        if(promoContext&&Array.isArray(promoContext.appliedPromotions)&&promoContext.appliedPromotions.length){
          await promotionService.consumeForOrder({checkoutId:checkout.id,orderId:created.id,context:promoContext,orderItems:createdItems},connection);
        }
        await this.inventory.consumeReservation(checkout.inventory_reservation_id,{connection});
        // Store credit is spent HERE, not when the customer chose the amount:
        // the debit and the order are one fact. A balance that moved in between
        // (another order, an expiry) fails the placement rather than quietly
        // charging the customer the difference.
        // The amount is written with the order row itself (the database's own
        // total invariant counts it), so this only moves the ledger.
        await checkoutStoreCreditService.spendForOrder(connection,{order:created,checkout});
        // The purchased lines leave the cart in the SAME transaction that
        // creates the order, so an order can never exist alongside a cart that
        // still holds what it bought, and a rolled-back finalize does not lose
        // the customer's cart either.
        await this.repository.clearPurchasedCartLines(connection,checkout.cart_id,parse(checkout.items_snapshot));
        await this.repository.finish(connection,checkoutId,created.id);
        return created;
      });
      const result=await dto(order,this.repository);
      // Post-commit forward-fulfillment bootstrap (§7/§36): runs OUTSIDE the
      // Order transaction, never throws, and never blocks Order validity.
      await this.bootstrapFulfillment(order.id);
      // WP-05 — "order placed" customer notification. Post-commit, isolated,
      // deduped on order_placed:<id> (a recovery-worker re-finalize is a no-op).
      await notificationService.emit('ORDER_PLACED',{customerId:order.customer_id,orderId:order.id,orderNumber:order.order_number,shippingAddressSnapshot:order.shipping_address_snapshot}).catch(()=>{});
      // The order contact for THIS order drives every transactional message —
      // see notifications/recipients.js. Passed once here so ORDER_PLACED and
      // PAYMENT_SUCCESSFUL both reach the number the customer typed at checkout.
      const orderNotifyContext={
        customerId:order.customer_id,orderId:order.id,orderNumber:order.order_number,
        shippingAddressSnapshot:order.shipping_address_snapshot,
      };
      // WP — payment confirmation. ONLY for money actually received online: a
      // COD order has taken no payment at finalisation, and telling that
      // customer "payment received" would be false.
      if(Number(order.online_paid_minor)>0){
        const snap=parse(order.shipping_address_snapshot);
        await notificationService.emit('PAYMENT_SUCCESSFUL',{
          ...orderNotifyContext,
          customerName:[snap?.firstName,snap?.lastName].filter(Boolean).join(' ')||null,
          paymentReference:order.order_number,
          amount:`₹${(Number(order.online_paid_minor)/100).toLocaleString('en-IN')}`,
          paymentDate:new Date().toLocaleDateString('en-IN',{day:'numeric',month:'short',year:'numeric'}),
        }).catch(()=>{});
      }
      // Staff feed — a new order needs someone to confirm it. Deduped on the order.
      await staffNotificationService.record({
        category:'ORDER',eventKey:'ORDER_PLACED',severity:'INFO',
        title:`New order ${order.order_number}`,
        body:`${result.items.length} item${result.items.length===1?'':'s'} · ₹${(Number(order.total_minor)/100).toLocaleString('en-IN')}`,
        link:`/orders/${order.id}`,entityType:'order',entityId:order.id,
        dedupeKey:`order_placed:${order.id}`,
      }).catch(()=>{});
      // Owner Delivery — the store delivers this one itself: ops mailbox email,
      // customer confirmation, and a warehouse-scoped staff notification so the
      // store manager sees it in Communications. Never blocks order validity.
      if (result.shipping?.serviceLevel === 'OWNER_DELIVERY') {
        await this.#notifyOwnerDelivery(order, result).catch(() => {});
      }
      return result;
    }catch(error){
      if(['RESERVATION_EXPIRED','INVENTORY_INVARIANT_VIOLATION','RESERVATION_NOT_ACTIVE'].includes(error.code))await this.repository.reconciliation(checkoutId,error.code);
      else if(!['CHECKOUT_NOT_FOUND','CHECKOUT_NOT_FINALIZABLE','FULL_COD_PLACE_ORDER_REQUIRED','FINANCIAL_READINESS_REQUIRED','PAYMENT_PLAN_NOT_READY','SHIPPING_REVALIDATION_REQUIRED'].includes(error.code))await this.repository.enqueue(checkoutId,error.code||'FINALIZATION_FAILED');
      throw error;
    }
  }

  /**
   * Owner-Delivery order side-effects (post-commit, best-effort, never throws
   * back into finalization):
   *   - one warehouse-scoped staff notification per allocated warehouse so the
   *     store manager sees it in Communications, linked to the order;
   *   - a transactional email to the ops mailbox (OWNER_DELIVERY_NOTIFY_EMAIL,
   *     default orders@corcotton.in);
   *   - a transactional email to the customer confirming Owner Delivery.
   * The emails degrade silently if their template isn't ACTIVE yet.
   */
  async #notifyOwnerDelivery(order, result) {
    const address = result.shippingAddress || {};
    const pincode = address.postalCode || address.postal_code || '—';
    const chargeMinor = Number(result.shipping?.customerShippingChargeMinor ?? result.shipping?.shippingChargeMinor ?? order.shipping_minor ?? 0);
    const zone = result.shipping?.ownerDeliveryZone || null;
    const rupees = (m) => `₹${(Number(m) / 100).toLocaleString('en-IN')}`;

    // allocated warehouse(s) for a targeted staff notification
    const whRows = await query(
      'SELECT DISTINCT f.warehouse_id, w.name FROM fulfillments f JOIN warehouses w ON w.id = f.warehouse_id WHERE f.order_id = ? AND f.warehouse_id IS NOT NULL',
      [order.id],
    ).catch(() => []);
    const warehouses = whRows.length ? whRows : [{ warehouse_id: null, name: null }];
    for (const wh of warehouses) {
      // eslint-disable-next-line no-await-in-loop
      await staffNotificationService.record({
        category: 'ORDER', eventKey: 'OWNER_DELIVERY_ORDER', severity: 'WARNING',
        title: `Owner Delivery order ${order.order_number}`,
        body: `${zone ? `${zone} · ` : ''}PIN ${pincode} · delivery charge ${rupees(chargeMinor)}. Deliver this order yourself — do not book a carrier.`,
        link: `/orders/${order.id}`, entityType: 'order', entityId: order.id,
        warehouseId: wh.warehouse_id || null,
        dedupeKey: `owner_delivery:${order.id}:${wh.warehouse_id || 'all'}`,
      }).catch(() => {});
    }

    const vars = {
      orderNumber: order.order_number,
      pincode: String(pincode),
      ownerDeliveryZone: zone || 'Owner Delivery',
      shippingChargeMinor: chargeMinor,
      totalMinor: Number(order.total_minor),
    };

    // ops mailbox
    const opsEmail = (env.OWNER_DELIVERY_NOTIFY_EMAIL || 'orders@corcotton.in').trim().toLowerCase();
    await communicationService.enqueue({
      businessEventId: `owner_delivery_ops:${order.id}`, policyKey: 'owner_delivery.ops',
      classification: 'TRANSACTIONAL', channel: 'EMAIL', templateKey: 'owner_delivery.ops',
      recipient: { customerId: null, contactKey: opsEmail }, variables: vars,
    }).catch(() => {});

    // customer confirmation
    const contacts = await ownerDeliveryContacts.findForCustomer(order.customer_id).catch(() => []);
    const email = (contacts || []).find((c) => c.contact_type === 'EMAIL' && c.is_verified);
    if (email) {
      await communicationService.enqueue({
        businessEventId: `owner_delivery_customer:${order.id}`, policyKey: 'owner_delivery.customer',
        classification: 'TRANSACTIONAL', channel: 'EMAIL', templateKey: 'owner_delivery.customer',
        recipient: { customerId: order.customer_id, contactKey: email.normalized_value }, variables: vars,
      }).catch(() => {});
    }
  }

  async getOwned(customerId,idOrNumber){const order=await this.repository.findOwned(customerId,idOrNumber);if(!order)throw new AppError('ORDER_NOT_FOUND','Order not found.',404);const base=await dto(order,this.repository);const {fulfillments,shipments}=await this.fulfillment.summaryForOrder(order.id);
    // WP-10 — customer tracking surface. `estimatedDelivery` is the transit-time
    // estimate captured on the chosen shipping quote at checkout, projected from
    // placement. A firmer promise (Delhivery EDD vs per-warehouse dispatch SLA)
    // is GAP-TRK-05 [BUSINESS_DECISION_REQUIRED]; the field is null until then.
    const estDays=Number(base.shipping?.estimatedDays);
    const estimatedDelivery=(Number.isFinite(estDays)&&estDays>0&&order.placed_at)
      ?new Date(new Date(order.placed_at).getTime()+estDays*86400000).toISOString():null;
    // The customer sees the six meaningful statuses, never the warehouse's
    // internal ones. orders.order_status alone cannot express this: it stays
    // PROCESSING from picking right through to out-for-delivery, so a shopper
    // saw "Being prepared" while the parcel was already on a van.
    const customerStatus=customerOrderStatus({status:order.order_status},shipments||[]);
    // The times on the customer's steps and activity come from the order's own
    // timestamps and applied carrier events — nothing is estimated.
    const facts={status:order.order_status,placedAt:order.placed_at,confirmedAt:order.confirmed_at,
      processingStartedAt:order.processing_started_at,completedAt:order.completed_at,cancelledAt:order.cancelled_at};
    // Courier names come from the company's own carrier list, never the raw code.
    const codes=[...new Set((shipments||[]).map((s)=>s.providerCode).filter(Boolean))];
    const carriers=codes.length?await query(
      `SELECT provider_code,display_name FROM shipping_providers WHERE brand_id=? AND provider_code IN (${codes.map(()=>'?').join(',')})`,
      [order.brand_id,...codes]):[];
    const carrierName=new Map(carriers.map((c)=>[c.provider_code,c.display_name]));
    return {...base,estimatedDelivery,customerStatus,
      customerStatusLabel:CUSTOMER_STATUS_LABEL[customerStatus]||customerStatus,
      customerTimeline:customerTimeline(facts,shipments||[]),
      customerActivity:customerActivity(facts,shipments||[]),
      // Backend-authoritative: the storefront renders these, it does not infer
      // them from a status. Return/exchange come from the per-line eligibility
      // engine; cancel additionally reads whether a parcel has physically left.
      actions:orderActionFlags({
        order:{status:order.order_status},
        shipments:shipments||[],
        returnEligibility:await returnEligibilityService
          .evaluateOrder({customerId,orderId:order.id}).catch(()=>null),
      }),
      fulfillmentSummary:fulfillments,
      shipmentSummary:(shipments||[]).map((s)=>({...s,carrierName:carrierName.get(s.providerCode)||null}))};}
  async getOwnedFulfillment(customerId,idOrNumber){const order=await this.repository.findOwned(customerId,idOrNumber);if(!order)throw new AppError('ORDER_NOT_FOUND','Order not found.',404);return {orderId:order.id,orderNumber:order.order_number,...await this.fulfillment.summaryForOrder(order.id)};}
  async listOwned(customerId){
    const orders=await this.repository.listOwned(customerId);
    return Promise.all(orders.map(async(order)=>{
      const base=await dto(order,this.repository);
      // Same mapper as the detail view — a list row must never disagree with
      // the order it opens.
      const {shipments}=await this.fulfillment.summaryForOrder(order.id).catch(()=>({shipments:[]}));
      const customerStatus=customerOrderStatus({status:order.order_status},shipments||[]);
      return {...base,customerStatus,customerStatusLabel:CUSTOMER_STATUS_LABEL[customerStatus]||customerStatus};
    }));
  }
  schedule(checkoutId){return this.repository.enqueue(checkoutId,'PAYMENT_VERIFIED');}
}

export const orderFinalizationService=new OrderFinalizationService();
