import { randomUUID } from 'node:crypto';
import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { assertNormalizedProviderResult, PROVIDER_CHOICE_MODES, SERVICE_LEVELS } from './providerContract.js';
import { computeShippingCharge, shippingPricingPolicyRepository } from './pricingPolicy.js';

const LABELS = { [SERVICE_LEVELS.STANDARD]: 'Standard Shipping', [SERVICE_LEVELS.EXPRESS]: 'Express Shipping' };
const errorCategory = (error) => error?.message === 'SHIPPING_PROVIDER_TIMEOUT' || error?.name === 'AbortError' ? 'TIMEOUT' : 'ERROR';

async function withTimeout(adapter, request, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      adapter.quote(request, { signal: controller.signal }),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('SHIPPING_PROVIDER_TIMEOUT')); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export class LogisticsOrchestrator {
  constructor({ configurationService, registry, timeoutMs = env.SHIPPING_PROVIDER_TIMEOUT_MS, now = () => new Date(), logger = console, pricingPolicy = shippingPricingPolicyRepository } = {}) {
    this.configurationService = configurationService;
    this.registry = registry;
    this.timeoutMs = Number(timeoutMs);
    this.now = now;
    this.logger = logger;
    this.pricingPolicy = pricingPolicy;
  }

  /**
   * Provider-neutral shipment booking. In MOCK mode (the only mode this wave
   * supports) it resolves the MOCK adapter; a real provider plugs in here
   * unchanged. Returns the adapter's normalised booking result.
   */
  async book(request) {
    // MOCK mode always books via MOCK (never a real carrier). REAL mode uses the
    // provider the caller resolved (ProviderResolver) — no silent fallback.
    const providerCode = env.SHIPPING_PROVIDER_MODE === 'MOCK' ? 'MOCK' : (request.providerCode || null);
    const adapter = providerCode ? this.registry.resolve(providerCode) : null;
    const bookFn = adapter && (adapter.createShipment || adapter.book);
    if (!adapter || typeof bookFn !== 'function' || !adapter.configured) {
      throw new AppError('SHIPPING_PROVIDER_UNAVAILABLE', 'No shipping provider is available for booking.', 503);
    }
    const started = Date.now();
    try {
      const result = await bookFn.call(adapter, request);
      if (!result?.providerShipmentId || !result?.awbNumber) throw new AppError('PROVIDER_RESPONSE_INVALID', 'Provider booking response was incomplete.', 502);
      this.logger.info?.(`[shipping] operation=BOOK provider=${providerCode} ref=${request.clientReference} latencyMs=${Date.now() - started} result=SUCCESS`);
      return { ...result, providerCode };
    } catch (error) {
      this.logger.warn?.(`[shipping] operation=BOOK provider=${providerCode} ref=${request.clientReference} latencyMs=${Date.now() - started} result=${error?.ambiguous ? 'AMBIGUOUS' : 'ERROR'}`);
      throw error;
    }
  }

  // Phase 2 §31 — provider-neutral operation passthrough for an EXISTING
  // shipment. `request.providerCode` is the provider that owns the shipment
  // (ProviderResolver.resolveForShipment). No fallback — an unavailable
  // operation is a 503 the operator sees.
  async #operation(name, request) {
    const providerCode = env.SHIPPING_PROVIDER_MODE === 'MOCK' ? 'MOCK' : (request.providerCode || null);
    const adapter = providerCode ? this.registry.resolve(providerCode) : null;
    if (!adapter || typeof adapter[name] !== 'function' || !adapter.configured || !adapter.supports(name)) {
      throw new AppError('SHIPPING_PROVIDER_OPERATION_UNAVAILABLE', `Provider ${providerCode || 'NONE'} cannot perform "${name}".`, 503);
    }
    const started = Date.now();
    try {
      const result = await adapter[name](request);
      this.logger.info?.(`[shipping] operation=${name} provider=${providerCode} ref=${request.clientReference || request.awb || ''} latencyMs=${Date.now() - started} result=SUCCESS`);
      return { ...result, providerCode };
    } catch (error) {
      this.logger.warn?.(`[shipping] operation=${name} provider=${providerCode} latencyMs=${Date.now() - started} result=${error?.ambiguous ? 'AMBIGUOUS' : 'ERROR'}`);
      throw error;
    }
  }

  getTat(request) { return this.#operation('getTat', request); }
  getLabel(request) { return this.#operation('getLabel', request); }
  requestPickup(request) { return this.#operation('requestPickup', request); }
  editShipment(request) { return this.#operation('editShipment', request); }
  cancelShipment(request) { return this.#operation('cancelShipment', request); }
  trackShipment(request) { return this.#operation('trackShipment', request); }
  getDocuments(request) { return this.#operation('getDocuments', request); }
  submitNdrAction(request) { return this.#operation('submitNdrAction', request); }
  getNdrStatus(request) { return this.#operation('getNdrStatus', request); }

  async quote(request) {
    const shippingRequestId = randomUUID();
    const configuration = await this.configurationService.getConfiguration(request.destinationPostalCode);
    const eligible = configuration.providers.filter((provider) => {
      if (!provider.enabled || !provider.eligibleForZone) return false;
      const adapter = this.registry.resolve(provider.providerCode);
      return Boolean(adapter?.implemented && adapter.configured);
    });
    if (!eligible.length) throw new AppError('SHIPPING_PROVIDER_UNAVAILABLE', 'No configured shipping provider is currently available.', 503);

    const settled = await Promise.allSettled(eligible.map(async (provider) => {
      const started = Date.now();
      try {
        const adapter = this.registry.resolve(provider.providerCode);
        const result = assertNormalizedProviderResult(await withTimeout(adapter, request, this.timeoutMs), provider.providerCode);
        this.logger.info?.(`[shipping] request=${shippingRequestId} provider=${provider.providerCode} operation=QUOTE latencyMs=${Date.now()-started} result=SUCCESS services=${result.services.length}`);
        return { provider, result };
      } catch (error) {
        this.logger.warn?.(`[shipping] request=${shippingRequestId} provider=${provider.providerCode} operation=QUOTE latencyMs=${Date.now()-started} result=${errorCategory(error)}`);
        throw error;
      }
    }));
    const successes = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
    if (!successes.length) throw new AppError('SHIPPING_PROVIDER_UNAVAILABLE', 'Shipping providers could not be reached.', 503);
    if (!successes.some(({ result }) => result.serviceable)) {
      return { shippingRequestId, postalCode: request.destinationPostalCode, serviceable: false, status: 'UNSERVICEABLE', providerChoiceMode: configuration.providerChoiceMode, quoteIssuedAt: null, quoteExpiresAt: null, methods: [], failures: settled.length-successes.length };
    }

    const issuedAt = this.now();
    const expiresAt = new Date(issuedAt.getTime() + configuration.quoteTtlSeconds * 1000);
    // Phase 2 §18/§19 — the CORCOTTON pricing policy turns a provider rate into
    // the customer-facing charge (Surface ₹0, Express rate + surcharge). The
    // provider rate is retained separately as the actual logistics cost basis.
    const pricingPolicy = await this.pricingPolicy.get().catch(() => null);
    const grouped = new Map();
    for (const { provider, result } of successes) {
      if (!result.serviceable) continue;
      for (const service of result.services) {
        const mapping = provider.services.find((candidate) => candidate.providerServiceCode === service.providerServiceCode && candidate.enabled);
        if (!mapping) continue;
        // Provider rate (business override wins) = the actual logistics cost basis.
        const providerRateMinor = mapping.rateOverrideMinor ?? service.rateMinor;
        const priced = computeShippingCharge({
          serviceLevel: mapping.normalizedServiceLevel,
          providerRateMinor,
          policy: pricingPolicy || undefined,
        });
        const option = {
          quoteId: randomUUID(), providerCode: provider.providerCode, providerName: provider.displayName,
          providerServiceCode: service.providerServiceCode, serviceLevel: mapping.normalizedServiceLevel,
          name: mapping.displayName || LABELS[mapping.normalizedServiceLevel],
          // Customer-facing charge (after the pricing policy).
          rateMinor: priced.customerChargeMinor,
          chargeMinor: priced.customerChargeMinor,
          // Kept separate — never shown to the customer as "the price".
          providerRateMinor,
          actualLogisticsCostMinor: priced.actualLogisticsCostMinor,
          surchargeMinor: priced.surchargeMinor,
          pricingMode: priced.mode,
          estimatedDeliveryAt: service.estimatedDeliveryAt || null, estimatedDays: service.estimatedDays ?? null,
          codSupported: service.codSupported ?? null, providerPriority: provider.priority,
          prepaidSupported: service.prepaidSupported ?? true,
          minCodAmountMinor: service.minCodAmountMinor ?? null, maxCodAmountMinor: service.maxCodAmountMinor ?? null,
          customerVisible: provider.customerVisible && mapping.customerVisible,
          rateSource: mapping.rateOverrideMinor == null ? (service.metadata?.rateSource || 'PROVIDER') : 'BUSINESS_OVERRIDE',
          quoteIssuedAt: issuedAt.toISOString(), quoteExpiresAt: expiresAt.toISOString(),
        };
        const list = grouped.get(mapping.normalizedServiceLevel) || [];
        list.push(option); grouped.set(mapping.normalizedServiceLevel, list);
      }
    }
    const levels = [SERVICE_LEVELS.STANDARD, SERVICE_LEVELS.EXPRESS];
    const methods = levels.flatMap((level) => {
      const options = (grouped.get(level) || []).sort((a,b) => a.providerPriority-b.providerPriority || a.rateMinor-b.rateMinor || a.providerCode.localeCompare(b.providerCode));
      const visible = configuration.providerChoiceMode === PROVIDER_CHOICE_MODES.BACKEND_SELECTED ? options.slice(0,1) : options.filter((option) => option.customerVisible);
      return visible.length ? [{ code: level, name: LABELS[level], options: visible }] : [];
    });
    if (!methods.length) throw new AppError('NO_SHIPPING_METHOD_AVAILABLE', 'No configured shipping method is available.', 409);
    // Whichever carrier answered can also name the place the PIN belongs to.
    // Optional by construction: a provider that does not report it leaves this
    // null and the storefront shows the PIN alone.
    const locality = successes.find(({ result }) => result.serviceable && result.locality)?.result.locality || null;
    return { shippingRequestId, postalCode: request.destinationPostalCode, serviceable: true, status: 'SERVICEABLE', locality, providerChoiceMode: configuration.providerChoiceMode, quoteIssuedAt: issuedAt.toISOString(), quoteExpiresAt: expiresAt.toISOString(), methods, failures: settled.length-successes.length };
  }
}
