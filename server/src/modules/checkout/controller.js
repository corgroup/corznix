import { checkoutService } from './service.js';
import { addressIntentSchema, idempotencySchema, shippingMethodSchema } from './validation.js';
import { paymentModeSchema, paymentSessionSchema, razorpayVerifySchema, storeCreditApplySchema } from './validation.js';
import { paymentEligibilityService } from '../paymentEligibility/service.js';
import { paymentService } from '../payments/service.js';
import { orderFinalizationService } from '../orders/service.js';
import { checkoutStoreCreditService } from './storeCreditService.js';

const send = (res, data, status = 200) => res.status(status).json({ data });
export async function create(req,res,next) { try { send(res, await checkoutService.create(req.customer.id, idempotencySchema.parse(req.body).idempotencyKey), 201); } catch (e) { next(e); } }
export async function current(req,res,next) { try { send(res, await checkoutService.current(req.customer.id)); } catch (e) { next(e); } }
export async function get(req,res,next) { try { send(res, await checkoutService.get(req.customer.id, req.params.id)); } catch (e) { next(e); } }
export async function address(req,res,next) { try { send(res, await checkoutService.setAddress(req.customer.id, req.params.id, addressIntentSchema.parse(req.body))); } catch (e) { next(e); } }
export async function serviceability(req,res,next) { try { send(res, await checkoutService.checkServiceability(req.customer.id, req.params.id)); } catch (e) { next(e); } }
export async function refreshShippingQuote(req,res,next) { try { send(res, await checkoutService.refreshShippingQuote(req.customer.id, req.params.id)); } catch (e) { next(e); } }
export async function shipping(req,res,next) { try { send(res, await checkoutService.selectShipping(req.customer.id, req.params.id, shippingMethodSchema.parse(req.body).quoteId)); } catch (e) { next(e); } }
export async function cancel(req,res,next) { try { send(res, await checkoutService.cancel(req.customer.id, req.params.id)); } catch (e) { next(e); } }
export async function applyCoupon(req,res,next) { try { const code = String(req.body?.code ?? '').trim(); if (code.length < 3 || code.length > 64) { const err = new Error('A coupon code is required.'); err.status = 400; err.code = 'VALIDATION_ERROR'; throw err; } send(res, await checkoutService.applyCoupon(req.customer.id, req.params.id, code)); } catch (e) { next(e); } }
export async function removeCoupon(req,res,next) { try { send(res, await checkoutService.removeCoupon(req.customer.id, req.params.id)); } catch (e) { next(e); } }
export async function keepAlive(req,res,next) { try { send(res, await checkoutService.keepAlive(req.customer.id, req.params.id)); } catch (e) { next(e); } }
export async function renew(req,res,next) { try { send(res, await checkoutService.renew(req.customer.id, req.params.id)); } catch (e) { next(e); } }
export async function revalidate(req,res,next) { try { send(res, await checkoutService.revalidate(req.customer.id, req.params.id, idempotencySchema.parse(req.body).idempotencyKey)); } catch (e) { next(e); } }
export async function paymentEligibility(req,res,next) { try {
  const result=await paymentEligibilityService.evaluate(req.customer.id,req.params.id);
  // The customer picks the gateway, so only ones that can take a payment right
  // now are offered — never one that would fail after it is chosen.
  const prepaid=result.paymentEligibility?.prepaid;
  if (prepaid) { const gateways=await paymentService.availableGateways(); result.paymentEligibility.prepaid={...prepaid,available:Boolean(prepaid.available)&&gateways.length>0,gateways}; }
  send(res,result);
} catch(e){ next(e); } }
export async function paymentMode(req,res,next) { try { send(res,await paymentEligibilityService.selectMode(req.customer.id,req.params.id,paymentModeSchema.parse(req.body).mode)); } catch(e){ next(e); } }
export async function paymentSession(req,res,next){try{const{providerCode}=paymentSessionSchema.parse(req.body??{});send(res,await paymentService.createSession(req.customer.id,req.params.id,{providerCode:providerCode??null}),201);}catch(e){next(e);}}
export async function razorpayVerify(req,res,next){try{const input=razorpayVerifySchema.parse(req.body??{});send(res,await paymentService.verifyRazorpayCheckout(req.customer.id,req.params.id,{orderId:input.razorpayOrderId,paymentId:input.razorpayPaymentId,signature:input.razorpaySignature}));}catch(e){next(e);}}
export async function paymentStatus(req,res,next){try{send(res,await paymentService.status(req.customer.id,req.params.id));}catch(e){next(e);}}
export async function reconcilePayment(req,res,next){try{send(res,await paymentService.status(req.customer.id,req.params.id,{reconcile:true}));}catch(e){next(e);}}
export async function placeOrder(req,res,next){try{send(res,await orderFinalizationService.finalize(req.params.id,{customerId:req.customer.id,source:'CUSTOMER_PLACE_ORDER'}),201);}catch(e){next(e);}}

// ---- store credit at checkout ----
//
// The amount is the customer's choice and is validated server-side against
// their live balance and this order's total: a client asking for more than
// either is refused, never silently capped.
export async function storeCreditAvailability(req, res, next) {
  try { send(res, await checkoutStoreCreditService.availability(req.customer.id, req.params.id)); } catch (e) { next(e); }
}
export async function applyStoreCredit(req, res, next) {
  try {
    const { amountMinor } = storeCreditApplySchema.parse(req.body ?? {});
    send(res, await checkoutStoreCreditService.apply(req.customer.id, req.params.id, amountMinor));
  } catch (e) { next(e); }
}
export async function removeStoreCredit(req, res, next) {
  try { send(res, await checkoutStoreCreditService.remove(req.customer.id, req.params.id)); } catch (e) { next(e); }
}
