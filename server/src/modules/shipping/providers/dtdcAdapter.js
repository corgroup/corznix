import { PROVIDER_CODES, ShippingProviderAdapter } from '../providerContract.js';

export class DtdcShippingAdapter extends ShippingProviderAdapter {
  constructor() { super({ providerCode: PROVIDER_CODES.DTDC, implemented: false, configured: false }); }
}
