export const PROVIDER_CODES = Object.freeze({ MOCK: 'MOCK', DELHIVERY: 'DELHIVERY', BLUE_DART: 'BLUE_DART', DTDC: 'DTDC' });
export const SERVICE_LEVELS = Object.freeze({ STANDARD: 'STANDARD', EXPRESS: 'EXPRESS' });
export const PROVIDER_CHOICE_MODES = Object.freeze({ BACKEND_SELECTED: 'BACKEND_SELECTED', CUSTOMER_VISIBLE: 'CUSTOMER_VISIBLE' });

// Phase 2 §31 — the stable provider-neutral logistics operation surface. Every
// adapter (Delhivery first, BlueDart / DTDC later) implements a subset; business
// code depends ONLY on these names + shapes, never on provider field names,
// status strings, endpoints or units. `quote` is the legacy name for the
// serviceability+rate probe the checkout orchestrator already calls.
export const SHIPPING_OPERATIONS = Object.freeze([
  'checkServiceability', 'getTat', 'getShippingQuote',
  'createShipment', 'getLabel', 'requestPickup',
  'editShipment', 'cancelShipment', 'trackShipment', 'getDocuments',
  'submitNdrAction', 'getNdrStatus',
]);

// A provider operation that this adapter does not implement / is not configured
// for. The orchestrator maps this to a 503 — it must NEVER be silently swapped
// for another provider or a mock (§3).
export class ShippingOperationError extends Error {
  constructor(code, providerCode, operation) {
    super(`${providerCode}:${operation}:${code}`);
    this.name = 'ShippingOperationError';
    this.code = code;
    this.providerCode = providerCode;
    this.operation = operation;
  }
}

export class ShippingProviderAdapter {
  constructor({ providerCode, implemented = true, configured = false, capabilities = [] }) {
    this.providerCode = providerCode;
    this.implemented = implemented;
    this.configured = configured;
    // Which SHIPPING_OPERATIONS this adapter can perform when configured.
    this.capabilities = new Set(capabilities);
  }

  supports(operation) {
    return this.capabilities.has(operation);
  }

  #unimplemented(operation) {
    return new ShippingOperationError('SHIPPING_PROVIDER_OPERATION_NOT_IMPLEMENTED', this.providerCode, operation);
  }

  // Adapters receive only normalized CORCOTTON input and return provider-neutral
  // data. The base throws for everything — a subclass overrides what it supports
  // and declares it in `capabilities`.
  //
  // eslint-disable-next-line no-unused-vars
  async quote(request, options = {}) { throw this.#unimplemented('checkServiceability'); }
  // eslint-disable-next-line no-unused-vars
  async checkServiceability(request, options = {}) { throw this.#unimplemented('checkServiceability'); }
  // eslint-disable-next-line no-unused-vars
  async getTat(request, options = {}) { throw this.#unimplemented('getTat'); }
  // eslint-disable-next-line no-unused-vars
  async getShippingQuote(request, options = {}) { throw this.#unimplemented('getShippingQuote'); }
  // eslint-disable-next-line no-unused-vars
  async createShipment(request, options = {}) { throw this.#unimplemented('createShipment'); }
  // eslint-disable-next-line no-unused-vars
  async getLabel(request, options = {}) { throw this.#unimplemented('getLabel'); }
  // eslint-disable-next-line no-unused-vars
  async requestPickup(request, options = {}) { throw this.#unimplemented('requestPickup'); }
  // eslint-disable-next-line no-unused-vars
  async editShipment(request, options = {}) { throw this.#unimplemented('editShipment'); }
  // eslint-disable-next-line no-unused-vars
  async cancelShipment(request, options = {}) { throw this.#unimplemented('cancelShipment'); }
  // eslint-disable-next-line no-unused-vars
  async trackShipment(request, options = {}) { throw this.#unimplemented('trackShipment'); }
  // eslint-disable-next-line no-unused-vars
  async getDocuments(request, options = {}) { throw this.#unimplemented('getDocuments'); }
  // eslint-disable-next-line no-unused-vars
  async submitNdrAction(request, options = {}) { throw this.#unimplemented('submitNdrAction'); }
  // eslint-disable-next-line no-unused-vars
  async getNdrStatus(request, options = {}) { throw this.#unimplemented('getNdrStatus'); }
}

export function assertNormalizedProviderResult(result, providerCode) {
  if (!result || result.providerCode !== providerCode || typeof result.serviceable !== 'boolean' || !Array.isArray(result.services)) {
    throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');
  }
  for (const service of result.services) {
    if (!service.providerServiceCode || !Number.isInteger(service.rateMinor) || service.rateMinor < 0) {
      throw new Error('SHIPPING_PROVIDER_RESPONSE_INVALID');
    }
  }
  return result;
}
