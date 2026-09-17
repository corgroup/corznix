import crypto from 'node:crypto';
import { env } from '../../../config/index.js';
import { PaymentProvider, PAYMENT_STATES } from '../providerContract.js';

const base=()=>env.CASHFREE_API_BASE_URL.replace(/\/+$/,'');
const headers=(idempotencyKey)=>({'Content-Type':'application/json','x-api-version':env.CASHFREE_API_VERSION,'x-client-id':env.CASHFREE_CLIENT_ID,'x-client-secret':env.CASHFREE_CLIENT_SECRET,'x-idempotency-key':idempotencyKey});
const amountToMajor=(minor)=>Number((Number(minor)/100).toFixed(2));

// Cashfree wants a plain national number for India. CORCOTTON stores contacts
// in E.164 (+919319987171), and sending that verbatim is rejected as an invalid
// phone — the customer then sees "an unexpected error" on the payment page with
// nothing in our logs to say why. Reduced only when it is recognisably Indian;
// anything else goes through untouched rather than being turned into a
// different number.
const customerPhone=(value)=>{
  const raw=value==null?'':String(value).trim();
  if(!raw)return raw;
  const digits=raw.replace(/\D/g,'');
  if(digits.length===10)return digits;
  if(digits.length===12&&digits.startsWith('91'))return digits.slice(2);
  if(digits.length===11&&digits.startsWith('0'))return digits.slice(1);
  return raw;
};

// Cashfree explains every rejection in the body. Throwing that away left a
// failed payment with no recorded cause at all, which is how a live checkout
// outage becomes undiagnosable.
const rejected=(operation,response,data)=>{
  const detail=data?.message||data?.error?.message||data?.error_description||(Array.isArray(data?.errors)?data.errors.map((e)=>e?.message||String(e)).join('; '):null);
  const err=new Error('PAYMENT_PROVIDER_REJECTED');
  err.providerStatus=response?.status??null;
  err.providerCode=data?.code||data?.type||null;
  err.providerMessage=detail||null;
  console.warn(`[payments/cashfree] ${operation} rejected status=${err.providerStatus} code=${err.providerCode||'-'} message=${err.providerMessage||'-'}`);
  return err;
};
export function verifyCashfreeSignature(secret,{timestamp,signature,rawBody}){if(!timestamp||!signature||!rawBody||!secret)return false;const expected=crypto.createHmac('sha256',secret).update(String(timestamp)+rawBody).digest('base64');const a=Buffer.from(expected);const b=Buffer.from(String(signature));return a.length===b.length&&crypto.timingSafeEqual(a,b);}

export class CashfreeProvider extends PaymentProvider {
  constructor(){super({code:'CASHFREE',configured:Boolean(env.CASHFREE_CLIENT_ID&&env.CASHFREE_CLIENT_SECRET&&env.CASHFREE_API_BASE_URL)});}
  async createPaymentSession(request){
    if(!this.configured)throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
    const response=await fetch(`${base()}/orders`,{method:'POST',headers:headers(request.idempotencyKey),body:JSON.stringify({order_id:request.merchantReference,order_amount:amountToMajor(request.amountMinor),order_currency:request.currency,customer_details:{customer_id:request.customer.customerId,customer_phone:customerPhone(request.customer.phone),customer_email:request.customer.email||undefined},order_meta:{return_url:request.returnUrl}})});
    const data=await response.json().catch(()=>null); if(!response.ok||!data?.payment_session_id)throw rejected('createPaymentSession',response,data);
    return {providerPaymentId:String(data.cf_order_id||data.order_id),providerSessionReference:data.payment_session_id,rawStatus:data.order_status,status:PAYMENT_STATES.PENDING,expiresAt:data.order_expiry_time||null};
  }
  async getPaymentStatus({merchantReference}){
    const requestHeaders=headers(crypto.randomUUID());
    const [orderResponse,paymentsResponse]=await Promise.all([
      fetch(`${base()}/orders/${encodeURIComponent(merchantReference)}`,{headers:requestHeaders}),
      fetch(`${base()}/orders/${encodeURIComponent(merchantReference)}/payments`,{headers:requestHeaders}),
    ]);
    const order=await orderResponse.json().catch(()=>null);const payments=await paymentsResponse.json().catch(()=>null);
    if(!orderResponse.ok||!order)throw rejected('getPaymentStatus.order',orderResponse,order);
    if(!paymentsResponse.ok||!Array.isArray(payments))throw rejected('getPaymentStatus.payments',paymentsResponse,payments);
    const latest=[...payments].sort((a,b)=>new Date(b.payment_completion_time||b.payment_time||0)-new Date(a.payment_completion_time||a.payment_time||0))[0];
    const paymentMap={SUCCESS:PAYMENT_STATES.SUCCEEDED,FAILED:PAYMENT_STATES.FAILED,PENDING:PAYMENT_STATES.PENDING,USER_DROPPED:PAYMENT_STATES.CANCELLED,CANCELLED:PAYMENT_STATES.CANCELLED};
    const orderMap={PAID:PAYMENT_STATES.SUCCEEDED,ACTIVE:PAYMENT_STATES.PENDING,EXPIRED:PAYMENT_STATES.EXPIRED,TERMINATED:PAYMENT_STATES.CANCELLED,TERMINATION_REQUESTED:PAYMENT_STATES.CANCELLED};
    // What the customer actually paid with. Cashfree gives the family in
    // `payment_group` (upi / credit_card / debit_card / net_banking / wallet)
    // and the detail under `payment_method`, whose shape varies by family — an
    // object keyed by the family for cards/UPI, a bare string for some others.
    // Both are recorded verbatim; nothing is inferred when they are absent.
    const group=latest?.payment_group?String(latest.payment_group).trim().toLowerCase():null;
    const rawMethod=latest?.payment_method;
    const method=typeof rawMethod==='string'?rawMethod.trim():(rawMethod&&typeof rawMethod==='object'?Object.keys(rawMethod)[0]||null:null);
    return {status:latest?paymentMap[latest.payment_status]||PAYMENT_STATES.PENDING:orderMap[order.order_status]||PAYMENT_STATES.PENDING,rawStatus:latest?.payment_status||order.order_status,amountMinor:Math.round(Number(latest?.payment_amount??order.order_amount)*100),currency:latest?.payment_currency||order.order_currency,providerPaymentId:String(latest?.cf_payment_id||order.cf_order_id||''),paymentGroup:group||null,paymentMethod:method?String(method).slice(0,64):null,failureCode:latest?.error_details?.error_code||null,failureMessage:latest?.payment_status==='FAILED'?'Payment was not completed.':null};
  }
  // Terminates an unpaid order so its session can no longer be paid — the customer chose another gateway.
  async cancelSession({merchantReference}){
    if(!this.configured)throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
    const response=await fetch(`${base()}/orders/${encodeURIComponent(merchantReference)}`,{method:'PATCH',headers:headers(crypto.randomUUID()),body:JSON.stringify({order_status:'TERMINATED'})});
    const data=await response.json().catch(()=>null);
    if(!response.ok)throw rejected('cancelSession',response,data);
    return{cancelled:true};
  }
  // Refunds. Cashfree had none at all here, so a cancelled Cashfree order
  // could never be paid back by the system — the refund was BLOCKED with
  // "provider not enabled" and someone had to do it by hand in the dashboard,
  // where nothing of it reaches our records.
  supportsRefund(){return this.configured;}

  /**
   * POST /orders/{order_id}/refunds. Addressed by the MERCHANT order id (the
   * reference we created the order with), not the cf_payment_id.
   * `refund_id` is ours and unique per attempt, which is what makes a retry
   * after a timeout return the existing refund instead of paying twice.
   */
  async refund({paymentRefundId,merchantReference,amountMinor,idempotencyKey}){
    if(!this.configured)throw new Error('PAYMENT_PROVIDER_NOT_CONFIGURED');
    if(!merchantReference)throw new Error('CASHFREE_ORDER_REFERENCE_MISSING');
    const refundId=`rfnd_${String(paymentRefundId).replaceAll('-','')}`.slice(0,40);
    let response;
    try{
      response=await fetch(`${base()}/orders/${encodeURIComponent(merchantReference)}/refunds`,{
        method:'POST',headers:headers(idempotencyKey||refundId),
        body:JSON.stringify({refund_amount:amountToMajor(amountMinor),refund_id:refundId,refund_note:'Order cancelled'}),
      });
    }catch(cause){
      // Never seen by Cashfree, or seen and unanswered — we cannot tell which,
      // and a blind retry is how a customer is paid twice.
      throw Object.assign(new Error('CASHFREE_UNREACHABLE'),{ambiguous:true,cause});
    }
    const data=await response.json().catch(()=>null);
    if(response.status===409||data?.code==='refund_already_exists'){
      // The refund for this id is already on their side: read it back rather
      // than creating a second one.
      const existing=await this.#refundByIds(merchantReference,refundId);
      if(existing)return existing;
    }
    if(response.status>=500)throw Object.assign(rejected('refund',response,data),{ambiguous:true});
    if(!response.ok||!data)throw rejected('refund',response,data);
    return this.#refundResult(data);
  }

  async #refundByIds(merchantReference,refundId){
    const response=await fetch(`${base()}/orders/${encodeURIComponent(merchantReference)}/refunds/${encodeURIComponent(refundId)}`,{headers:headers(crypto.randomUUID())});
    const data=await response.json().catch(()=>null);
    return response.ok&&data?this.#refundResult(data):null;
  }

  // SUCCESS is the only state where the money has actually left. PENDING and
  // ONHOLD are in flight; anything else is a failure, and saying "refunded"
  // for them is how a refund is marked done and never lands.
  #refundResult(data){
    const raw=String(data.refund_status||'').toUpperCase();
    if(['CANCELLED','FAILED'].includes(raw)){
      const err=new Error(`CASHFREE_REFUND_${raw}`);err.providerMessage=data.status_description||null;throw err;
    }
    return{providerRefundId:String(data.cf_refund_id||data.refund_id||''),status:raw==='SUCCESS'?'SUCCEEDED':'PENDING',rawStatus:raw||null};
  }

  webhookInput(headers){return{timestamp:headers['x-webhook-timestamp'],signature:headers['x-webhook-signature'],eventId:headers['x-idempotency-key']||null};}
  verifyWebhook({timestamp,signature,rawBody}){
    return verifyCashfreeSignature(env.CASHFREE_CLIENT_SECRET,{timestamp,signature,rawBody});
  }
  normalizeWebhook(payload){const payment=payload?.data?.payment||{};const order=payload?.data?.order||{};const map={SUCCESS:PAYMENT_STATES.SUCCEEDED,FAILED:PAYMENT_STATES.FAILED,PENDING:PAYMENT_STATES.PENDING,USER_DROPPED:PAYMENT_STATES.CANCELLED,CANCELLED:PAYMENT_STATES.CANCELLED};
    // The webhook carries the instrument in the same shape the status endpoint
    // does, and it usually arrives BEFORE any reconcile — so this is where the
    // instrument is normally learned.
    const group=payment.payment_group?String(payment.payment_group).trim().toLowerCase():null;
    const rawMethod=payment.payment_method;
    const method=typeof rawMethod==='string'?rawMethod.trim():(rawMethod&&typeof rawMethod==='object'?Object.keys(rawMethod)[0]||null:null);
    return {merchantReference:order.order_id,providerPaymentId:String(payment.cf_payment_id||''),status:map[payment.payment_status]||PAYMENT_STATES.PENDING,rawStatus:payment.payment_status,amountMinor:Math.round(Number(payment.payment_amount)*100),currency:payment.payment_currency||order.order_currency,paymentGroup:group||null,paymentMethod:method?String(method).slice(0,64):null,eventType:payload.type||payload.event_type||'UNKNOWN'};}
}
