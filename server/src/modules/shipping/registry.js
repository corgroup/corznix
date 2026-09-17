export class ShippingProviderRegistry {
  constructor(adapters = []) {
    this.adapters = new Map();
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    if (!adapter?.providerCode || typeof adapter.quote !== 'function') throw new Error('INVALID_SHIPPING_PROVIDER_ADAPTER');
    this.adapters.set(adapter.providerCode, adapter);
    return this;
  }

  resolve(providerCode) {
    return this.adapters.get(providerCode) || null;
  }

  status(providerCode) {
    const adapter = this.resolve(providerCode);
    if (!adapter) return 'NOT_IMPLEMENTED';
    if (!adapter.implemented) return 'NOT_IMPLEMENTED';
    return adapter.configured ? 'CONFIGURED' : 'NOT_CONFIGURED';
  }

  // Phase 2 §31 — which provider-neutral operations an adapter can perform.
  capabilitiesOf(providerCode) {
    const adapter = this.resolve(providerCode);
    return adapter ? [...adapter.capabilities] : [];
  }

  supports(providerCode, operation) {
    const adapter = this.resolve(providerCode);
    return Boolean(adapter?.implemented && adapter.configured && adapter.supports(operation));
  }
}
