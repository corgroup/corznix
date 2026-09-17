import { query } from '../../database/connection/pool.js';

export class ShippingConfigurationRepository {
  async getSettings() {
    const rows = await query('SELECT provider_choice_mode,quote_ttl_seconds FROM shipping_settings WHERE id=1 LIMIT 1');
    return rows[0] || null;
  }

  async getProviders() {
    return query('SELECT provider_code,display_name,enabled,priority,customer_visible,is_default FROM shipping_providers ORDER BY priority,provider_code');
  }

  async getServices() {
    return query('SELECT provider_code,provider_service_code,normalized_service_level,display_name,enabled,customer_visible,rate_override_minor FROM shipping_provider_services');
  }

  async getZones() {
    return query('SELECT provider_code,rule_type,postal_code_prefix,enabled FROM shipping_provider_zones WHERE enabled=1');
  }
}

export const shippingConfigurationRepository = new ShippingConfigurationRepository();
