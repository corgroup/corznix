import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { ShippingConfigurationService, shippingConfigurationService } from './configurationService.js';
import { LogisticsOrchestrator } from './orchestrator.js';
import { PROVIDER_CHOICE_MODES } from './providerContract.js';
import { ProviderResolver } from './providerResolver.js';
import { WarehouseResolver, warehouseResolver } from './warehouseResolver.js';
import { computeDeliveryWindow } from './deliveryWindow.js';
import { SERVICE_LEVELS } from './providerContract.js';
import { ownerDeliveryRepository, buildOwnerDeliveryMethod, OWNER_DELIVERY_METHOD } from './ownerDelivery.js';
import { ShippingProviderRegistry } from './registry.js';
import { BlueDartShippingAdapter } from './providers/blueDartAdapter.js';
import { DelhiveryShippingAdapter } from './providers/delhiveryAdapter.js';
import { DtdcShippingAdapter } from './providers/dtdcAdapter.js';
import { MockShippingAdapter } from './providers/mockAdapter.js';
import { fulfillmentRepository } from './fulfillmentRepository.js';

const PIN_RE = /^\d{6}$/;

/**
 * Phase 2 · Slice 7 — pure comparison of a frozen quote snapshot to a fresh
 * orchestrator quote result. Surface is always ₹0 to the customer, so only an
 * Express rate can actually move.
 */
/** The option in a fresh quote that is the same method as a frozen one, or null. */
export function matchingShippingOption(quoteSnapshot, fresh) {
  const want = quoteSnapshot?.serviceLevel || quoteSnapshot?.serviceLevelCode;
  return (fresh?.methods || []).flatMap((m) => m.options || [])
    .find((o) => o.serviceLevel === want && (!quoteSnapshot.providerServiceCode || o.providerServiceCode === quoteSnapshot.providerServiceCode)) || null;
}

export function compareQuoteToFresh(quoteSnapshot, fresh, { toleranceMinor = 0 } = {}) {
  if (!fresh?.serviceable) return { ok: false, reason: 'PIN_UNSERVICEABLE' };
  const match = matchingShippingOption(quoteSnapshot, fresh);
  if (!match) return { ok: false, reason: 'METHOD_UNAVAILABLE' };

  const before = Number(quoteSnapshot.customerShippingChargeMinor ?? quoteSnapshot.chargeMinor ?? quoteSnapshot.rateMinor ?? 0);
  const after = Number(match.chargeMinor ?? match.rateMinor ?? 0);
  if (Math.abs(after - before) > Math.max(0, toleranceMinor)) {
    return { ok: false, reason: 'RATE_CHANGED', freshChargeMinor: after, priorChargeMinor: before };
  }
  return { ok: true };
}

export function createDefaultShippingRegistry() {
  return new ShippingProviderRegistry([new MockShippingAdapter(), new DelhiveryShippingAdapter(), new BlueDartShippingAdapter(), new DtdcShippingAdapter()]);
}

const publicOption = (option, visible) => ({
  quoteId: option.quoteId, name: option.name, rateMinor: option.rateMinor, chargeMinor: option.rateMinor,
  estimatedDeliveryAt: option.estimatedDeliveryAt, estimatedDays: option.estimatedDays, codSupported: option.codSupported,
  deliveryWindow: option.deliveryWindow ?? null,
  ...(option.ownerDeliveryZone ? { ownerDeliveryZone: option.ownerDeliveryZone, providerName: 'CORCOTTON' } : {}),
  ...(visible ? { providerCode: option.providerCode, providerName: option.providerName, providerServiceCode: option.providerServiceCode } : {}),
});

export class ShippingService {
  constructor({ orchestrator = null, configurationService = shippingConfigurationService, registry = createDefaultShippingRegistry(), fulfillment = fulfillmentRepository, resolver = null, warehouses = warehouseResolver } = {}) {
    this.registry = registry;
    this.configurationService = configurationService instanceof ShippingConfigurationService ? configurationService : configurationService;
    this.orchestrator = orchestrator || new LogisticsOrchestrator({ configurationService, registry });
    this.fulfillment = fulfillment;
    // Phase 2 §32 — provider selection for new shipments + operation routing
    // for existing ones. No silent fallback.
    this.resolver = resolver || new ProviderResolver({ registry, configurationService });
    // Phase 2 §11 — dispatch-origin warehouse resolution (single seam).
    this.warehouses = warehouses instanceof WarehouseResolver ? warehouses : warehouseResolver;
  }

  async quote({ postalCode, contextType = 'PRODUCT', items = [], shipmentValueMinor = null }) {
    if (!PIN_RE.test(String(postalCode || ''))) throw new AppError('INVALID_POSTAL_CODE', 'PIN code must be exactly 6 digits.', 400);
    const normalizedItems = await this.fulfillment.resolveItems(items);
    const missingFulfillment = normalizedItems.filter((item) => !item.fulfillment).map((item) => item.skuId);
    if (contextType === 'CHECKOUT' && env.SHIPPING_PROVIDER_MODE === 'REAL' && missingFulfillment.length) {
      throw new AppError('SHIPPING_DIMENSION_DATA_MISSING', 'Product shipping weight or dimensions are not configured.', 409);
    }

    // Owner Delivery (migration 071) is a CORCOTTON-operated option offered at
    // checkout only, alongside (or instead of) carrier methods when the
    // destination PIN matches an enabled zone. It does not depend on a carrier,
    // so a carrier outage / unserviceable PIN must not hide it.
    const ownerMatch = contextType === 'CHECKOUT'
      ? await ownerDeliveryRepository.matchForPincode(postalCode).catch(() => null)
      : null;

    // The dispatch warehouse is the real origin — the env PIN is only a
    // deployment-wide default, and is often unset. The TAT probe that splits
    // Surface from Express needs a genuine origin, so resolve it the same way
    // the PDP delivery card does and fall back to the env value.
    let originPostalCode = env.SHIPPING_ORIGIN_POSTAL_CODE || null;
    try {
      const origin = await this.warehouses.resolveOrigin({ destinationPostalCode: String(postalCode) });
      if (!origin.originPincodeMissing && origin.postalCode) originPostalCode = origin.postalCode;
    } catch { /* no warehouse resolved — the env default still applies */ }

    let result;
    try {
      result = await this.orchestrator.quote({
        originPostalCode,
        destinationPostalCode: String(postalCode), items: normalizedItems,
        shipmentValueMinor: shipmentValueMinor == null ? null : Number(shipmentValueMinor), contextType,
        // Ask carriers to split their serviceable modes (Surface / Express)
        // rather than answering "this PIN works" once. Only this path wants it;
        // a bare serviceability screen stays a single call.
        quoteServiceLevels: true,
      });
    } catch (err) {
      if (!ownerMatch) throw err;
      // Carriers unreachable, but Owner Delivery covers this PIN.
      result = {
        shippingRequestId: null, postalCode: String(postalCode), serviceable: false, status: 'UNSERVICEABLE',
        providerChoiceMode: 'BACKEND_SELECTED', quoteIssuedAt: null, quoteExpiresAt: null, methods: [], failures: 1,
      };
    }

    // A carrier transit count is not a date a customer can plan around. Run it
    // through the SAME window maths the PDP "check delivery" card uses, so one
    // PIN cannot promise one date on the product page and another at checkout.
    result = {
      ...result,
      methods: (result.methods || []).map((method) => ({
        ...method,
        options: method.options.map((option) => ({
          ...option,
          deliveryWindow: computeDeliveryWindow(
            { transitDays: option.estimatedDays, estimatedDeliveryDate: option.estimatedDeliveryAt },
            { bufferDays: env.PDP_DELIVERY_RANGE_BUFFER_DAYS, dispatchLagDays: env.PDP_DISPATCH_LAG_DAYS },
          ),
        })),
      })),
    };

    if (ownerMatch) {
      const issuedAt = result.quoteIssuedAt || new Date().toISOString();
      const expiresAt = result.quoteExpiresAt || new Date(Date.now() + 15 * 60 * 1000).toISOString();
      const method = buildOwnerDeliveryMethod(ownerMatch, { issuedAt, expiresAt });
      result = {
        ...result,
        serviceable: true,
        status: 'SERVICEABLE',
        quoteIssuedAt: issuedAt,
        quoteExpiresAt: expiresAt,
        methods: [...(result.methods || []).filter((m) => m.code !== OWNER_DELIVERY_METHOD), method],
        ownerDeliveryAvailable: true,
        ownerDeliveryZone: ownerMatch.zoneName,
      };
    }

    return { ...result, contextType, informational: contextType === 'PRODUCT', shippingDataGap: missingFulfillment.length ? 'PRODUCT_SHIPPING_DATA_INCOMPLETE' : null };
  }

  /** Provider-neutral shipment booking (MOCK this wave). @see LogisticsOrchestrator.book */
  bookShipment(request) {
    return this.orchestrator.book(request);
  }

  /**
   * Phase 2 · Slice 4 — the PDP "check delivery" widget: real serviceability +
   * a real EDD turned into a customer-facing date window. Standalone — does not
   * touch the checkout quote/cart flow.
   */
  async checkDelivery({ postalCode, skuId = null, quantity = 1 }) {
    if (!PIN_RE.test(String(postalCode || ''))) throw new AppError('INVALID_POSTAL_CODE', 'PIN code must be exactly 6 digits.', 400);
    const pin = String(postalCode);
    const items = skuId ? await this.fulfillment.resolveItems([{ skuId, quantity }]) : [];

    // Owner Delivery is CORCOTTON's own last-mile, so it does not depend on a
    // carrier answering. The checkout quote has always honoured it; this card
    // did not, which let a PIN CORCOTTON delivers to itself read "we do not
    // deliver here" on the product page and then offer delivery at checkout.
    const ownerMatch = await ownerDeliveryRepository.matchForPincode(pin).catch(() => null);

    let quote;
    try {
      quote = await this.orchestrator.quote({
        originPostalCode: env.SHIPPING_ORIGIN_POSTAL_CODE || null,
        destinationPostalCode: pin, items, shipmentValueMinor: null, contextType: 'PRODUCT',
      });
    } catch (error) {
      if (!ownerMatch) throw error;
      quote = { serviceable: false, status: 'UNSERVICEABLE' };
    }
    if (!quote.serviceable) {
      if (!ownerMatch) {
        return { postalCode: pin, serviceable: false, temporary: quote.status === 'TEMPORARY_NSZ', deliveryWindow: null };
      }
      // No carrier, so no carrier TAT — the window is genuinely unknown and is
      // reported as such rather than invented for an in-house route.
      return {
        postalCode: pin,
        serviceable: true,
        locality: null,
        methodName: 'Owner Delivery',
        codAvailable: false,
        deliveryWindow: null,
        deliveryEstimateGap: 'OWNER_DELIVERY_NO_CARRIER_TAT',
        checkedAt: new Date().toISOString(),
      };
    }

    // Cheapest customer-visible method is what the estimate is quoted against
    // (Surface = the ₹0 default).
    const opt = quote.methods.flatMap((m) => m.options).find((o) => o.serviceLevel === SERVICE_LEVELS.STANDARD)
      || quote.methods.flatMap((m) => m.options)[0] || null;
    const codAvailable = opt?.codSupported ?? null;

    // Origin PIN + a real TAT. Any gap => serviceable, but no promised window.
    let deliveryWindow = null;
    let estimateGap = null;
    try {
      const origin = await this.warehouses.resolveOrigin({ destinationPostalCode: pin });
      if (origin.originPincodeMissing) {
        estimateGap = 'ORIGIN_PIN_NOT_CONFIGURED';
      } else {
        const providerCode = await this.resolver.resolveForNewShipment({ destinationPostalCode: pin });
        const tat = await this.orchestrator.getTat({
          providerCode, originPostalCode: origin.postalCode, destinationPostalCode: pin, mode: 'STANDARD',
        });
        deliveryWindow = computeDeliveryWindow(tat, {
          bufferDays: env.PDP_DELIVERY_RANGE_BUFFER_DAYS,
          dispatchLagDays: env.PDP_DISPATCH_LAG_DAYS,
        });
        if (!deliveryWindow) estimateGap = 'PROVIDER_TAT_INCONCLUSIVE';
      }
    } catch (error) {
      estimateGap = error?.status === 503 ? 'PROVIDER_UNAVAILABLE' : (error?.message || 'PROVIDER_TAT_UNAVAILABLE');
    }

    return {
      postalCode: pin,
      serviceable: true,
      locality: quote.locality || null, // { city, state } — carrier-reported, null when it does not say
      methodName: opt?.name || null,
      codAvailable,
      deliveryWindow, // { earliestDate, latestDate, transitDays, source } | null
      deliveryEstimateGap: estimateGap, // non-null => serviceable but no dates (never invented)
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Phase 2 · Slice 7 — re-check a frozen checkout shipping quote at place-order
   * time. Returns { ok } or { ok:false, reason, freshChargeMinor? }. MOCK mode
   * is deterministic so this always passes there.
   */
  /**
   * Per-LANE serviceability + transit time: can each of these warehouses
   * actually reach this destination, and how fast?
   *
   * Allocation previously asked only "is this PIN serviceable at all?", which
   * answers a different question. A carrier can serve a destination from one
   * origin and not another, so a destination-only answer cannot express the
   * case that matters: a warehouse that holds the stock but cannot ship it
   * there. It also left ranking with no real transit times, so "nearest by PIN
   * prefix" stood in for "fastest".
   *
   * Failure handling is deliberately per-lane and fail-closed only when it
   * knows something. A lane is marked unserviceable ONLY when the provider
   * says so; a timeout or an error makes it INCONCLUSIVE, which the caller
   * treats as "no worse than before" rather than as a refusal — a provider
   * hiccup should not empty the candidate list and refuse every order.
   *
   * @param {{destinationPostalCode: string, origins: Array<{warehouseId: string, postalCode: string|null}>}} input
   * @returns {Promise<Map<string, {serviceable: boolean|null, transitDays: number|null, reason: string}>>}
   */
  async laneServiceability({ destinationPostalCode, origins = [] }) {
    const out = new Map();
    if (!PIN_RE.test(String(destinationPostalCode || ''))) {
      throw new AppError('INVALID_POSTAL_CODE', 'PIN code must be exactly 6 digits.', 400);
    }

    // The mock carrier is destination-only by construction, so per-lane
    // questions have no meaning there. Answering INCONCLUSIVE keeps every
    // existing MOCK-mode expectation intact instead of inventing lane rules
    // the mock cannot model.
    if (env.SHIPPING_PROVIDER_MODE !== 'REAL') {
      for (const o of origins) out.set(o.warehouseId, { serviceable: null, transitDays: null, reason: 'MOCK_MODE' });
      return out;
    }

    let providerCode;
    try {
      providerCode = await this.resolver.resolveForNewShipment({ destinationPostalCode });
    } catch {
      for (const o of origins) out.set(o.warehouseId, { serviceable: null, transitDays: null, reason: 'NO_PROVIDER' });
      return out;
    }

    await Promise.all(origins.map(async (origin) => {
      if (!origin.postalCode) {
        // A warehouse with no PIN cannot be lane-checked. Not its fault and
        // not a refusal — it simply cannot be ranked on transit time.
        out.set(origin.warehouseId, { serviceable: null, transitDays: null, reason: 'ORIGIN_PIN_NOT_CONFIGURED' });
        return;
      }
      try {
        const tat = await this.orchestrator.getTat({
          providerCode,
          originPostalCode: origin.postalCode,
          destinationPostalCode,
          mode: 'STANDARD',
        });
        const days = Number(tat?.transitDays ?? tat?.days ?? NaN);
        // An explicit negative from the carrier is the one case that removes a
        // warehouse from the running.
        if (tat && tat.serviceable === false) {
          out.set(origin.warehouseId, { serviceable: false, transitDays: null, reason: 'NOT_SERVICEABLE_FROM_ORIGIN' });
          return;
        }
        out.set(origin.warehouseId, {
          serviceable: true,
          transitDays: Number.isFinite(days) && days > 0 ? days : null,
          reason: Number.isFinite(days) && days > 0 ? 'LANE_TAT' : 'SERVICEABLE_NO_TAT',
        });
      } catch (error) {
        out.set(origin.warehouseId, {
          serviceable: null,
          transitDays: null,
          reason: error?.status === 503 ? 'PROVIDER_UNAVAILABLE' : 'LANE_CHECK_FAILED',
        });
      }
    }));

    return out;
  }

  async revalidateQuote({ postalCode, quoteSnapshot, items = [] }) {
    if (!quoteSnapshot) return { ok: true, skipped: 'NO_QUOTE' };

    // Owner Delivery is config-driven, not provider-driven — re-check the zone
    // in every mode (a store could disable it or change the charge after the
    // customer selected it).
    if ((quoteSnapshot.serviceLevel || quoteSnapshot.serviceLevelCode) === OWNER_DELIVERY_METHOD) {
      if (quoteSnapshot.quoteExpiresAt && new Date(quoteSnapshot.quoteExpiresAt) <= new Date()) return { ok: false, reason: 'QUOTE_EXPIRED' };
      const match = await ownerDeliveryRepository.matchForPincode(postalCode).catch(() => null);
      if (!match) return { ok: false, reason: 'OWNER_DELIVERY_UNAVAILABLE' };
      const before = Number(quoteSnapshot.customerShippingChargeMinor ?? quoteSnapshot.chargeMinor ?? quoteSnapshot.rateMinor ?? 0);
      if (match.chargeMinor !== before) {
        return { ok: false, reason: 'RATE_CHANGED', freshChargeMinor: match.chargeMinor, priorChargeMinor: before };
      }
      return { ok: true };
    }

    if (env.SHIPPING_PROVIDER_MODE !== 'REAL') return { ok: true, skipped: 'MOCK_MODE' };
    if (!PIN_RE.test(String(postalCode || ''))) return { ok: false, reason: 'INVALID_POSTAL_CODE' };

    if (quoteSnapshot.quoteExpiresAt && new Date(quoteSnapshot.quoteExpiresAt) <= new Date()) {
      return { ok: false, reason: 'QUOTE_EXPIRED' };
    }

    let fresh;
    try {
      const normalizedItems = await this.fulfillment.resolveItems(items);
      fresh = await this.orchestrator.quote({
        originPostalCode: env.SHIPPING_ORIGIN_POSTAL_CODE || null,
        destinationPostalCode: String(postalCode), items: normalizedItems,
        shipmentValueMinor: null, contextType: 'CHECKOUT',
      });
    } catch (error) {
      // A transient provider failure must not strand a ready-to-pay customer.
      return { ok: true, skipped: 'PROVIDER_UNREACHABLE', detail: error?.message || null };
    }
    return compareQuoteToFresh(quoteSnapshot, fresh, { toleranceMinor: Number(env.SHIPPING_REVALIDATION_TOLERANCE_MINOR) || 0 });
  }

  resolveQuote(result, quoteId) {
    const option = result?.methods?.flatMap((method) => method.options || []).find((candidate) => candidate.quoteId === quoteId);
    if (!option) throw new AppError('INVALID_SHIPPING_OPTION', 'Selected shipping option is not available.', 409);
    if (!option.quoteExpiresAt || new Date(option.quoteExpiresAt) <= new Date()) throw new AppError('SHIPPING_QUOTE_EXPIRED', 'The shipping quote has expired. Check delivery again.', 409);
    return option;
  }

  toPublic(result) {
    const visible = result.providerChoiceMode === PROVIDER_CHOICE_MODES.CUSTOMER_VISIBLE;
    return { shippingRequestId: result.shippingRequestId, postalCode: result.postalCode, serviceable: result.serviceable, status: result.status, providerChoiceMode: result.providerChoiceMode, quoteIssuedAt: result.quoteIssuedAt, quoteExpiresAt: result.quoteExpiresAt, informational: result.informational, shippingDataGap: result.shippingDataGap, methods: result.methods.map((method) => ({ code: method.code, name: method.name, options: method.options.map((option) => publicOption(option, visible)) })) };
  }
}

export const shippingService = new ShippingService();
