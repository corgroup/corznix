import { PROVIDER_CODES, ShippingProviderAdapter } from '../providerContract.js';

export class BlueDartShippingAdapter extends ShippingProviderAdapter {
  constructor() { super({ providerCode: PROVIDER_CODES.BLUE_DART, implemented: false, configured: false }); }
}
