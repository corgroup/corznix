import { PROVIDER_CHOICE_MODES } from './providerContract.js';
import { shippingConfigurationRepository } from './repository.js';

const truthy = (value) => Boolean(Number(value));

export class ShippingConfigurationService {
  constructor({ repository = shippingConfigurationRepository } = {}) { this.repository = repository; }

  async getConfiguration(postalCode) {
    const [settings, providerRows, serviceRows, zoneRows] = await Promise.all([
      this.repository.getSettings(), this.repository.getProviders(), this.repository.getServices(), this.repository.getZones(),
    ]);
    const servicesByProvider = new Map();
    for (const row of serviceRows) {
      const list = servicesByProvider.get(row.provider_code) || [];
      list.push({ providerServiceCode: row.provider_service_code, normalizedServiceLevel: row.normalized_service_level, displayName: row.display_name, enabled: truthy(row.enabled), customerVisible: truthy(row.customer_visible), rateOverrideMinor: row.rate_override_minor == null ? null : Number(row.rate_override_minor) });
      servicesByProvider.set(row.provider_code, list);
    }
    const zonesByProvider = new Map();
    for (const row of zoneRows) {
      const list = zonesByProvider.get(row.provider_code) || [];
      list.push({ type: row.rule_type, prefix: row.postal_code_prefix });
      zonesByProvider.set(row.provider_code, list);
    }
    const providers = providerRows.map((row) => {
      const zones = zonesByProvider.get(row.provider_code) || [];
      const blocked = zones.some((zone) => zone.type === 'BLOCK' && postalCode.startsWith(zone.prefix));
      const allowRules = zones.filter((zone) => zone.type === 'ALLOW');
      const allowed = allowRules.length === 0 || allowRules.some((zone) => postalCode.startsWith(zone.prefix));
      return { providerCode: row.provider_code, displayName: row.display_name, enabled: truthy(row.enabled), priority: Number(row.priority), customerVisible: truthy(row.customer_visible), isDefault: truthy(row.is_default), eligibleForZone: !blocked && allowed, services: servicesByProvider.get(row.provider_code) || [] };
    });
    return { providerChoiceMode: settings?.provider_choice_mode || PROVIDER_CHOICE_MODES.BACKEND_SELECTED, quoteTtlSeconds: Number(settings?.quote_ttl_seconds || 900), providers };
  }
}

export const shippingConfigurationService = new ShippingConfigurationService();
