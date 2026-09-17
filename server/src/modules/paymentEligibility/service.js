import { AppError } from '../../utils/errors.js';
import { checkoutRepository } from '../checkout/repository.js';
import { shippingService } from '../shipping/service.js';
import { evaluatePaymentEligibility } from './evaluator.js';
import { paymentEligibilityRepository } from './repository.js';

const parse = (value, fallback=null) => value==null ? fallback : typeof value==='string' ? JSON.parse(value) : value;

export class PaymentEligibilityService {
  constructor({ shipping=shippingService, repository=paymentEligibilityRepository, checkouts=checkoutRepository }={}) {
    this.shipping=shipping; this.repository=repository; this.checkouts=checkouts;
  }

  async evaluate(customerId, checkoutId) {
    const row=await this.checkouts.findOwned(customerId,checkoutId);
    if (!row) throw new AppError('CHECKOUT_NOT_FOUND','Checkout session not found.',404);
    if (row.status!=='READY_FOR_PAYMENT' || row.reservation_status!=='RESERVED' || Number(row.reservation_is_expired)) throw new AppError('CHECKOUT_NOT_READY','Checkout is not ready for payment eligibility.',409);
    const address=parse(row.shipping_address_snapshot); const items=parse(row.items_snapshot,[]);
    if (!address || !row.selected_provider_code || !row.selected_provider_service_code) throw new AppError('SHIPPING_SELECTION_REQUIRED','Select a valid shipping method first.',409);

    // Provider truth is deliberately resolved before any business policy query.
    const current=await this.shipping.quote({postalCode:address.postalCode,contextType:'CHECKOUT',items,shipmentValueMinor:Number(row.subtotal_minor)});
    if (!current.serviceable) return this.persist(row, {serviceable:false,prepaidSupported:false,codSupported:false}, null);
    const option=current.methods.flatMap((method)=>method.options).find((candidate)=>candidate.providerCode===row.selected_provider_code && candidate.providerServiceCode===row.selected_provider_service_code);
    if (!option) return this.persist(row, {serviceable:false,prepaidSupported:false,codSupported:false}, null);
    const provider={serviceable:true,prepaidSupported:option.prepaidSupported!==false,codSupported:option.codSupported===true,minCodAmountMinor:option.minCodAmountMinor??null,maxCodAmountMinor:option.maxCodAmountMinor??null};
    const productIds=[...new Set(items.map((item)=>item.productId).filter(Boolean))];
    const policy=await this.repository.loadPolicy({productIds,postalCode:address.postalCode,providerCode:row.selected_provider_code,providerServiceCode:row.selected_provider_service_code,amountMinor:Number(row.total_minor)});
    return this.persist(row,provider,policy);
  }

  async persist(row,provider,policy) {
    const safePolicy=policy||{settings:null,valueRules:[],products:[],pin:null,provider:null,riskLevel:'UNKNOWN',riskRule:null};
    const result=evaluatePaymentEligibility({provider,policy:safePolicy,totalMinor:Number(row.total_minor)});
    result.providerCode=row.selected_provider_code; result.providerServiceCode=row.selected_provider_service_code;
    await this.repository.save(row.id,result);
    return {delivery:{available:result.decision!=='DELIVERY_UNAVAILABLE'},paymentEligibility:{decision:result.decision,prepaid:result.prepaid,cod:result.cod,partialCod:result.partialCod,nonRefundableAdvanceMinor:result.nonRefundableAdvanceMinor??0,eligibleAmountMinor:result.eligibleAmountMinor,message:result.decision==='PREPAID_ONLY'?'Cash on Delivery is unavailable for this order.':null}};
  }

  async selectMode(customerId,checkoutId,mode) {
    await this.evaluate(customerId,checkoutId);
    if (!await this.repository.selectMode(checkoutId,mode)) throw new AppError('PAYMENT_MODE_NOT_ELIGIBLE','The selected payment mode is not available.',409);
    return {selectedPaymentMode:mode};
  }
}

export const paymentEligibilityService=new PaymentEligibilityService();
