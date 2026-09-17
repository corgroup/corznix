export const PAYMENT_STATES=Object.freeze({CREATED:'CREATED',PENDING:'PENDING',AUTHORIZED:'AUTHORIZED',SUCCEEDED:'SUCCEEDED',FAILED:'FAILED',CANCELLED:'CANCELLED',EXPIRED:'EXPIRED'});
export class PaymentProvider { constructor({code,configured=false,implemented=true}){this.code=code;this.configured=configured;this.implemented=implemented;} }
