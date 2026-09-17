import crypto from 'node:crypto';
import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { checkoutRepository } from '../checkout/repository.js';
import { CustomerContactRepository } from '../customers/repositories.js';
import { orderFinalizationService } from '../orders/service.js';
import { shippingService } from '../shipping/service.js';
import { paymentEligibilityRepository } from '../paymentEligibility/repository.js';
import { paymentEligibilityService } from '../paymentEligibility/service.js';
import { PaymentOrchestrator } from './orchestrator.js';
import { CashfreeProvider } from './providers/cashfreeProvider.js';
import { RazorpayProvider } from './providers/razorpayProvider.js';
import { MockPaymentProvider } from './providers/mockPaymentProvider.js';
import { paymentRepository } from './repository.js';
import { notificationService } from '../notifications/service.js';
import { query } from '../../database/connection/pool.js';
import { PaymentProviderRegistry } from './registry.js';
import { staffNotificationService } from '../staffNotifications/service.js';

const registry=new PaymentProviderRegistry([new MockPaymentProvider(),new CashfreeProvider(),new RazorpayProvider()]);
const orchestrator=new PaymentOrchestrator({repository:paymentRepository,registry});
const contacts=new CustomerContactRepository();
const parse=value=>typeof value==='string'?JSON.parse(value):value;
const providerEnvironment=code=>(code==='CASHFREE'?env.CASHFREE_ENVIRONMENT:code==='RAZORPAY'?env.RAZORPAY_ENVIRONMENT:null);
// RAZORPAY: Razorpay Standard Checkout — the storefront opens Razorpay's window
// for the server-created Order (`checkout`: the PUBLIC Key ID + order id; the
// Key Secret never leaves the server). An attempt created before that switch
// still carries a Payment Link URL (`paymentUrl`). CASHFREE keeps
// `paymentSessionId` for its client SDK.
const GATEWAY_LABELS={CASHFREE:'Cashfree',RAZORPAY:'Razorpay',MOCK_PAYMENT:'Test payment'};
const razorpayCheckout=attempt=>{const ref=String(attempt.provider_session_reference||'');return ref.startsWith('order_')?{keyId:env.RAZORPAY_KEY_ID,orderId:ref,amountMinor:Number(attempt.amount_minor),currency:attempt.currency,merchantReference:attempt.merchant_reference}:null;};
const publicAttempt=attempt=>{if(!attempt)return null;const checkout=attempt.provider_code==='RAZORPAY'?razorpayCheckout(attempt):null;return{attemptId:attempt.id,status:attempt.status,providerCode:attempt.provider_code,paymentSessionId:attempt.provider_code==='RAZORPAY'?null:attempt.provider_session_reference||null,paymentUrl:attempt.provider_code==='RAZORPAY'&&!checkout?attempt.provider_session_reference||null:null,checkout,providerEnvironment:providerEnvironment(attempt.provider_code),expiresAt:attempt.session_expires_at||null,failureMessage:attempt.failure_message_safe||null};};

export class PaymentService {
  constructor({payments=paymentRepository,eligibilityService=paymentEligibilityService,eligibilityRepo=paymentEligibilityRepository,paymentOrchestrator=orchestrator,providerRegistry=registry,contactRepo=contacts,checkouts=checkoutRepository,orders=orderFinalizationService,staffNotifications=staffNotificationService}={}){
    this.payments=payments;this.eligibilityService=eligibilityService;this.eligibilityRepo=eligibilityRepo;this.orchestrator=paymentOrchestrator;this.registry=providerRegistry;this.contacts=contactRepo;this.checkouts=checkouts;this.orders=orders;this.staffNotifications=staffNotifications;
  }

  async finalizeVerified(checkoutId,{customerId=null,source}){
    await this.orders.schedule(checkoutId);
    try{return await this.orders.finalize(checkoutId,{customerId,source});}
    catch(error){console.error('[order-finalization]',{checkoutId,source,category:error.code||'FAILED'});return null;}
  }

  /** Gateways the customer may choose right now, in CMS priority order. */
  async availableGateways(){return(await this.orchestrator.availableProviders()).map(provider=>({code:provider.code,label:GATEWAY_LABELS[provider.code]||provider.code}));}

  /**
   * The customer switched gateway while an attempt was open on another one.
   * The old session is checked first — a payment that went through is kept and
   * the order created — and otherwise closed at its gateway before the attempt
   * is cancelled, so the same order can never be paid twice. When the gateway
   * cannot be reached or cannot close it, the switch is refused.
   */
  async releaseAttemptForSwitch(attempt){
    const unavailable=(message)=>new AppError('PAYMENT_SWITCH_UNAVAILABLE',message,409);
    if(attempt.provider_session_reference){
      const provider=this.registry.resolve(attempt.provider_code);
      if(!provider)throw unavailable('Your earlier payment could not be checked. Please try again shortly.');
      let remote;
      try{remote=await provider.getPaymentStatus({merchantReference:attempt.merchant_reference,providerSessionReference:attempt.provider_session_reference});}
      catch{throw unavailable('Your earlier payment could not be checked. Please try again shortly.');}
      if(remote.status==='SUCCEEDED'){
        if(Number(remote.amountMinor)!==Number(attempt.amount_minor))throw new AppError('PAYMENT_PROVIDER_AMOUNT_MISMATCH','Provider payment details could not be verified.',409);
        return{succeeded:true,attempt:await this.payments.transition(attempt,'SUCCEEDED',remote.rawStatus)};
      }
      if(typeof provider.cancelSession!=='function')throw unavailable('Please finish or wait for your earlier payment before choosing another method.');
      try{await provider.cancelSession({merchantReference:attempt.merchant_reference,providerSessionReference:attempt.provider_session_reference});}
      catch{throw unavailable('Your earlier payment could not be closed. Please try again shortly.');}
    }
    await this.payments.transition(attempt,'CANCELLED','SWITCHED_PAYMENT_METHOD');
    return{succeeded:false};
  }

  async createSession(customerId,checkoutId,{providerCode=null}={}){
    const previous=await this.eligibilityRepo.findForCheckout(checkoutId);const mode=previous?.selected_payment_mode;
    if(!mode)throw new AppError('PAYMENT_MODE_REQUIRED','Select a payment method first.',409);
    await this.eligibilityService.evaluate(customerId,checkoutId);
    const eligibility=await this.eligibilityRepo.findForCheckout(checkoutId);const checkout=await this.checkouts.findOwned(customerId,checkoutId);
    // Phase 2 · Slice 7 — re-check the frozen shipping quote before any money
    // moves. No-op in MOCK mode / when no quote is selected.
    const quoteSnap=checkout?.shipping_quote_snapshot?parse(checkout.shipping_quote_snapshot):null;
    if(quoteSnap){
      const revalidation=await shippingService.revalidateQuote({
        postalCode:parse(checkout.shipping_address_snapshot)?.postalCode,
        quoteSnapshot:{...quoteSnap,quoteExpiresAt:quoteSnap.quoteExpiresAt||checkout.shipping_quote_expires_at},
        items:parse(checkout.items_snapshot)?.map(i=>({skuId:i.skuId,quantity:Number(i.quantity)}))||[],
      });
      if(!revalidation.ok)throw new AppError('SHIPPING_REVALIDATION_REQUIRED',`The shipping quote is no longer valid (${revalidation.reason}). Please check delivery again.`,409,{reason:revalidation.reason,freshChargeMinor:revalidation.freshChargeMinor??null});
    }
    const total=Number(eligibility.eligible_amount_minor);let online=total,cod=0;
    if(mode==='FULL_COD'){if(!eligibility.cod_available)throw new AppError('PAYMENT_MODE_NOT_ELIGIBLE','Full COD is unavailable.',409);online=0;cod=total;}
    if(mode==='PARTIAL_COD'){if(!eligibility.partial_cod_available)throw new AppError('PAYMENT_MODE_NOT_ELIGIBLE','Partial COD is unavailable.',409);online=Number(eligibility.pay_now_minor);cod=Number(eligibility.pay_on_delivery_minor);}
    if(mode==='PREPAID'&&!eligibility.prepaid_available)throw new AppError('PAYMENT_MODE_NOT_ELIGIBLE','Prepaid is unavailable.',409);
    await this.eligibilityRepo.selectMode(checkoutId,mode);
    // Store credit the customer put towards this order pays part (or all) of
    // the ONLINE half. It never touches the COD half: that figure is printed on
    // the label and manifested with the carrier, and changing what the courier
    // collects after the fact is how a parcel is refused at the door. The
    // ledger is not debited here — that happens when the order is created, in
    // the same transaction, so two checkouts cannot spend the same rupee.
    const creditApplied=Math.min(Number(checkout?.store_credit_applied_minor||0),online);
    online-=creditApplied;
    if(online+cod+creditApplied!==total)throw new AppError('PAYMENT_PLAN_INVALID','Payment plan does not match Checkout total.',500);

    // An online session left open from an earlier choice must not stay payable
    // once the plan changes — Cash on Delivery now, or a different amount such as
    // a Partial COD advance. It used to stay open: a customer who switched to COD
    // could still pay it and be charged twice, and a Partial COD advance reused
    // the full-amount session. Money already taken keeps the order prepaid;
    // otherwise the session is closed at its gateway before re-planning.
    const earlierAttempt=await this.payments.openAttemptForCheckout(checkoutId);
    if(earlierAttempt?.status==='SUCCEEDED')return{status:'SUCCEEDED',paymentPlan:{onlineDueMinor:Number(earlierAttempt.amount_minor),codDueMinor:total-Number(earlierAttempt.amount_minor)},attempt:publicAttempt(earlierAttempt),order:await this.finalizeVerified(checkoutId,{customerId,source:'PAYMENT_RECONCILIATION'})};
    if(earlierAttempt&&(!online||Number(earlierAttempt.amount_minor)!==online)){
      const released=await this.releaseAttemptForSwitch(earlierAttempt);
      if(released.succeeded)return{status:'SUCCEEDED',paymentPlan:{onlineDueMinor:Number(released.attempt.amount_minor),codDueMinor:total-Number(released.attempt.amount_minor)},attempt:publicAttempt(released.attempt),order:await this.finalizeVerified(checkoutId,{customerId,source:'PAYMENT_RECONCILIATION'})};
    }

    const onlineObligation=await this.payments.upsertObligation({checkoutId,type:'ONLINE',amountMinor:online,currency:'INR',mode,status:online?'PENDING':'NOT_REQUIRED'});
    await this.payments.upsertObligation({checkoutId,type:'COD',amountMinor:cod,currency:'INR',mode,status:cod?'DUE':'NOT_REQUIRED'});
    if(!online)return{status:'ONLINE_PAYMENT_NOT_REQUIRED',paymentPlan:{onlineDueMinor:0,codDueMinor:cod},attempt:null};

    if(this.payments.extendReservationForPayment&&!await this.payments.extendReservationForPayment(checkoutId,env.PAYMENT_RESERVATION_TTL_SECONDS))throw new AppError('RESERVATION_EXPIRED','Inventory reservation is no longer active.',409);

    let attempt=await this.payments.reusableAttempt(onlineObligation.id);
    if(attempt?.status==='SUCCEEDED')return{status:'SUCCEEDED',paymentPlan:{onlineDueMinor:online,codDueMinor:cod},attempt:publicAttempt(attempt),order:await this.finalizeVerified(checkoutId,{customerId,source:'PAYMENT_RECONCILIATION'})};
    if(attempt&&providerCode&&attempt.provider_code!==providerCode){
      const released=await this.releaseAttemptForSwitch(attempt);
      if(released.succeeded)return{status:'SUCCEEDED',paymentPlan:{onlineDueMinor:online,codDueMinor:cod},attempt:publicAttempt(released.attempt),order:await this.finalizeVerified(checkoutId,{customerId,source:'PAYMENT_RECONCILIATION'})};
      attempt=null;
    }
    if(attempt?.provider_session_reference)return{status:attempt.status,paymentPlan:{onlineDueMinor:online,codDueMinor:cod},attempt:publicAttempt(attempt)};
    const provider=await this.orchestrator.selectProvider(providerCode||attempt?.provider_code||null);
    if(!attempt)attempt=await this.payments.createAttempt({obligation:onlineObligation,providerCode:provider.code});
    if(attempt.provider_session_reference)return{status:attempt.status,paymentPlan:{onlineDueMinor:online,codDueMinor:cod},attempt:publicAttempt(attempt)};

    const contactRows=await this.contacts.findForCustomer(customerId);const email=contactRows.find(value=>value.contact_type==='EMAIL'&&value.is_verified)?.normalized_value;const phone=contactRows.find(value=>value.contact_type==='PHONE'&&value.is_verified)?.normalized_value||parse(checkout.shipping_address_snapshot)?.phone;
    if(!phone)throw new AppError('PAYMENT_CUSTOMER_PHONE_REQUIRED','A verified or shipping phone number is required.',409);
    const result=await this.orchestrator.create(attempt,{paymentAttemptId:attempt.id,merchantReference:attempt.merchant_reference,amountMinor:online,currency:attempt.currency,idempotencyKey:attempt.idempotency_key,customer:{customerId,email,phone},returnUrl:`${env.PAYMENT_RETURN_BASE_URL}/checkout/payment?attempt=${attempt.id}`});
    attempt=await this.payments.attachSession(attempt.id,result);
    return{status:attempt.status,paymentPlan:{onlineDueMinor:online,codDueMinor:cod},attempt:publicAttempt(attempt)};
  }

  /** Customer-safe: the gateway's own description, never a code or raw body. */
  async #notifyPaymentFailed(attempt,event){
    try{
      // A webhook has no customer in hand — the attempt's checkout carries it.
      const [checkout]=await query('SELECT customer_id, shipping_address_snapshot FROM checkout_sessions WHERE id = ? LIMIT 1',[attempt.checkout_id]);
      if(!checkout?.customer_id)return;
      const amountMinor=Number(attempt.amount_minor||event?.amountMinor||0);
      await notificationService.emit('PAYMENT_FAILED',{
        customerId:checkout.customer_id,
        paymentAttemptId:attempt.id,
        amount:`₹${(amountMinor/100).toLocaleString('en-IN',{minimumFractionDigits:2})}`,
        reason:attempt.failure_message_safe||event?.failureMessage||'your bank declined the payment',
        shippingAddressSnapshot:checkout.shipping_address_snapshot||null,
      });
    }catch{/* isolated — a message must never fail a payment webhook */}
  }

  async status(customerId,checkoutId,{reconcile=false}={}){
    if(!await this.checkouts.findOwned(customerId,checkoutId))throw new AppError('CHECKOUT_NOT_FOUND','Checkout session not found.',404);
    let attempt=await this.payments.ownedAttempt(customerId,checkoutId);
    if(!attempt)return{status:'NOT_STARTED',attempt:null,obligations:await this.payments.obligations(checkoutId)};
    if(reconcile&&!['SUCCEEDED','FAILED','CANCELLED','EXPIRED'].includes(attempt.status)){
      const provider=this.registry.resolve(attempt.provider_code);const remote=await provider.getPaymentStatus({merchantReference:attempt.merchant_reference,providerSessionReference:attempt.provider_session_reference});
      if(remote.amountMinor!=null&&(remote.amountMinor!==Number(attempt.amount_minor)||remote.currency!==attempt.currency))throw new AppError('PAYMENT_PROVIDER_AMOUNT_MISMATCH','Provider payment details could not be verified.',409);
      attempt=await this.payments.transition(attempt,remote.status,remote.rawStatus,{failureCode:remote.failureCode||null,failureMessage:remote.failureMessage||null,paymentGroup:remote.paymentGroup||null,paymentMethod:remote.paymentMethod||null});
    }
    const order=attempt.status==='SUCCEEDED'?await this.finalizeVerified(checkoutId,{customerId,source:'PAYMENT_RECONCILIATION'}):null;
    return{status:attempt.status,attempt:publicAttempt(attempt),obligations:await this.payments.obligations(checkoutId),order};
  }

  async webhook(providerCode,{headers,rawBody}){
    const provider=this.registry.resolve(providerCode);if(!provider)throw new AppError('PAYMENT_PROVIDER_NOT_FOUND','Unknown payment provider.',404);
    // Each gateway signs with its own headers. Every webhook used to be read as
    // Cashfree's (x-webhook-signature), so a genuine Razorpay webhook
    // (x-razorpay-signature) was always rejected and a paid order was only
    // created if the customer came back to the site.
    const input=provider.webhookInput?provider.webhookInput(headers):{timestamp:headers['x-webhook-timestamp'],signature:headers['x-webhook-signature'],eventId:headers['x-idempotency-key']||null};
    if(!provider.verifyWebhook({timestamp:input.timestamp,signature:input.signature,rawBody}))throw new AppError('PAYMENT_WEBHOOK_INVALID','Invalid payment webhook signature.',400);
    const event=provider.normalizeWebhook(JSON.parse(rawBody));const attempt=await this.payments.findAttemptByMerchant(event.merchantReference);
    const payloadHash=crypto.createHash('sha256').update(rawBody).digest('hex');const eventId=input.eventId||payloadHash;
    const recorded=await this.payments.recordEvent({providerCode,eventId,attemptId:attempt?.id||null,eventType:event.eventType,payloadHash,verified:true});
    if(recorded.duplicate){if(attempt?.status==='SUCCEEDED')await this.finalizeVerified(attempt.checkout_id,{source:'PAYMENT_WEBHOOK'});return{duplicate:true};}
    if(!attempt){await this.payments.finishEvent(recorded.id,'IGNORED');return{accepted:true};}
    if(event.amountMinor!==Number(attempt.amount_minor)||event.currency!==attempt.currency){await this.payments.finishEvent(recorded.id,'REJECTED');throw new AppError('PAYMENT_PROVIDER_AMOUNT_MISMATCH','Provider payment details could not be verified.',409);}
    // Money arrived on an attempt this checkout had already closed — the
    // customer switched gateway or the session lapsed, and an old window was
    // paid anyway (a Razorpay Order cannot be cancelled). It must not quietly
    // become a second paid order: the event stays RECEIVED for reconciliation
    // and staff are told to check for a duplicate charge and refund it.
    if(['CANCELLED','EXPIRED'].includes(attempt.status)&&event.status==='SUCCEEDED'){
      await this.staffNotifications.record({category:'SYSTEM',eventKey:'PAYMENT_ON_CLOSED_ATTEMPT',severity:'CRITICAL',title:`Payment received on a closed ${providerCode} session`,body:`Checkout ${attempt.checkout_id} · ${event.currency} ${(Number(event.amountMinor)/100).toFixed(2)} · the attempt was ${attempt.status}. Check for a duplicate charge and refund it if needed.`,link:'/payments',entityType:'payment_attempt',entityId:attempt.id,dedupeKey:`payment_on_closed_attempt:${attempt.id}:${event.providerPaymentId||eventId}`}).catch(()=>{});
      console.error('[payments] payment on closed attempt',{attemptId:attempt.id,checkoutId:attempt.checkout_id,providerCode,attemptStatus:attempt.status});
      return{accepted:true,reviewRequired:true};
    }
    const transitioned=await this.payments.transition(attempt,event.status,event.rawStatus,{paymentGroup:event.paymentGroup||null,paymentMethod:event.paymentMethod||null});await this.payments.finishEvent(recorded.id,'PROCESSED');
    if(transitioned.status==='SUCCEEDED')await this.finalizeVerified(attempt.checkout_id,{source:'PAYMENT_WEBHOOK'});
    // A declined payment left the customer with nothing: no order, and no word
    // from us either — they only saw the gateway's own screen, which is gone
    // the moment they close the tab. Told once per attempt (a duplicate
    // webhook for the same failure is deduped on it), and told the two things
    // that matter: no money was taken, and the bag is still there.
    if(transitioned.status==='FAILED')await this.#notifyPaymentFailed(transitioned,event);
    return{accepted:true};
  }

  /**
   * Razorpay Checkout's success callback, passed on by the browser. It is not
   * taken as confirmation: the order must be this customer's own current
   * attempt, the signature must match (HMAC of order|payment with the Key
   * Secret), and the payment is then read back from Razorpay itself (status
   * reconcile) before anything moves. A forged, replayed or foreign callback
   * changes nothing.
   */
  async verifyRazorpayCheckout(customerId,checkoutId,{orderId,paymentId,signature}){
    const attempt=await this.payments.ownedAttempt(customerId,checkoutId);
    if(!attempt||attempt.provider_code!=='RAZORPAY'||attempt.provider_session_reference!==orderId)throw new AppError('PAYMENT_ATTEMPT_MISMATCH','This payment does not belong to your current checkout.',409);
    const provider=this.registry.resolve('RAZORPAY');
    if(!provider?.verifyCheckoutSignature?.({orderId,paymentId,signature}))throw new AppError('PAYMENT_SIGNATURE_INVALID','The payment could not be verified.',400);
    return this.status(customerId,checkoutId,{reconcile:true});
  }

  async returnStatus(customerId,attemptId){const attempt=await this.payments.ownedAttemptById(customerId,attemptId);if(!attempt)throw new AppError('PAYMENT_ATTEMPT_NOT_FOUND','Payment attempt not found.',404);return{checkoutId:attempt.checkout_id,...await this.status(customerId,attempt.checkout_id,{reconcile:true})};}
}

export const paymentService=new PaymentService();
