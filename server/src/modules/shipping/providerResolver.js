import { env } from '../../config/index.js';
import { AppError } from '../../utils/errors.js';
import { PROVIDER_CODES } from './providerContract.js';

// Phase 2 §2/§3/§32 — provider selection.
//
//  * A NEW shipment's provider is chosen BEFORE booking, from configuration.
//  * Once a shipment is booked, it stays owned by that provider for its whole
//    life (tracking / label / pickup / cancel / documents) — even if the system
//    default later changes. `resolveForShipment` honours `shipment.provider_code`.
//  * There is NO silent fallback. If the resolved provider cannot perform an
//    operation, that is a 503 the operator must see — never a swap to another
//    carrier or to MOCK.
export class ProviderResolver {
  constructor({ registry, configurationService, runtimeEnv = env } = {}) {
    this.registry = registry;
    this.configurationService = configurationService;
    this.env = runtimeEnv;
  }

  get mode() {
    return this.env.SHIPPING_PROVIDER_MODE === 'REAL' ? 'REAL' : 'MOCK';
  }

  /**
   * The provider a new shipment would be booked with.
   * MOCK mode ⇒ MOCK. REAL mode ⇒ the enabled default provider from shipping
   * configuration (falls back to DELHIVERY, the first real provider, only if
   * configuration names no default — never to MOCK).
   */
  async resolveForNewShipment({ destinationPostalCode = null } = {}) {
    if (this.mode === 'MOCK') return PROVIDER_CODES.MOCK;

    let providers = [];
    try {
      const config = await this.configurationService.getConfiguration(String(destinationPostalCode || ''));
      providers = config.providers || [];
    } catch {
      providers = [];
    }
    const enabled = providers
      .filter((p) => p.enabled && p.providerCode !== PROVIDER_CODES.MOCK)
      .filter((p) => destinationPostalCode == null || p.eligibleForZone !== false)
      .sort((a, b) => (b.isDefault === true) - (a.isDefault === true) || a.priority - b.priority);

    const chosen = enabled[0]?.providerCode || PROVIDER_CODES.DELHIVERY;
    const adapter = this.registry.resolve(chosen);
    if (!adapter || !adapter.implemented || !adapter.configured) {
      throw new AppError(
        'SHIPPING_PROVIDER_UNAVAILABLE',
        `Shipping provider ${chosen} is not configured for real bookings.`,
        503,
      );
    }
    return chosen;
  }

  /** The provider that owns an existing shipment (or the new-shipment default). */
  async resolveForShipment(shipment, context = {}) {
    if (shipment?.provider_code) return shipment.provider_code;
    return this.resolveForNewShipment(context);
  }

  /**
   * Assert the provider that owns `shipment` can perform `operation` right now.
   * Throws 503 — the caller must surface it, never retry on another provider.
   */
  async assertCanPerform(shipment, operation, context = {}) {
    const providerCode = await this.resolveForShipment(shipment, context);
    const adapter = this.registry.resolve(providerCode);
    if (!adapter || !adapter.implemented || !adapter.configured || !adapter.supports(operation)) {
      throw new AppError(
        'SHIPPING_PROVIDER_OPERATION_UNAVAILABLE',
        `Provider ${providerCode} cannot perform "${operation}".`,
        503,
      );
    }
    return providerCode;
  }
}
