export class PaymentProviderRegistry {
  constructor(providers=[]){this.providers=new Map(providers.map((provider)=>[provider.code,provider]));}
  resolve(code){return this.providers.get(code)||null;}
}
