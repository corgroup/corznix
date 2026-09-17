import { randomUUID } from 'node:crypto';
import { isProduction } from '../../../config/index.js';
import { PaymentProvider, PAYMENT_STATES } from '../providerContract.js';
export class MockPaymentProvider extends PaymentProvider { constructor(){super({code:'MOCK_PAYMENT',configured:!isProduction()});this.calls=0;} async createPaymentSession(request){this.calls++;return{providerPaymentId:`mock-${request.paymentAttemptId}`,providerSessionReference:`mock_session_${randomUUID()}`,status:PAYMENT_STATES.PENDING,rawStatus:'MOCK_PENDING',expiresAt:null};} async getPaymentStatus(){return{status:PAYMENT_STATES.PENDING,rawStatus:'MOCK_PENDING'};} async cancelSession(){return{cancelled:true};} verifyWebhook(){return true;} normalizeWebhook(payload){return payload;}
  /**
   * MOCK refund — deterministic, never touches the network. Simulation hooks
   * (driven by the normalised request): `simulate:'FAIL'` -> provider error,
   * `simulate:'AMBIGUOUS'` -> the refund may have been created but the response
   * was lost (UNKNOWN outcome).
   */
  async refund(request){this.calls++;if(request?.simulate==='FAIL')throw Object.assign(new Error('MOCK_REFUND_DECLINED'),{retryable:true});if(request?.simulate==='AMBIGUOUS')throw Object.assign(new Error('MOCK_REFUND_TIMEOUT'),{ambiguous:true,providerRefundId:`mock-rfnd-${request.paymentRefundId}`});return{providerRefundId:`mock-rfnd-${request.paymentRefundId}`,status:'SUCCEEDED',rawStatus:'MOCK_REFUNDED'};}
  supportsRefund(){return true;} }
