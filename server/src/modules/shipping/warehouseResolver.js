import { AppError } from '../../utils/errors.js';
import { warehouseRepository } from '../warehouses/repository.js';
import { rankWarehousesForDestination } from '../warehouses/warehouseSelection.js';
import { warehouseProviderLocationRepository } from './warehouseProviderRepository.js';

// Phase 2 §11 — resolve the dispatch-origin warehouse for a shipment.
//
// Today CORCOTTON runs one active warehouse, so the result is deterministic:
// the default warehouse, else the highest-priority ACTIVE one. Nothing is
// hardcoded (no `warehouse_id = 1`, no fixed origin PIN) — the resolver is the
// single seam a future multi-warehouse strategy (stock availability -> provider
// serviceability -> TAT -> business priority) plugs into.
export class WarehouseResolver {
  constructor({ warehouses = warehouseRepository, providerLocations = warehouseProviderLocationRepository } = {}) {
    this.warehouses = warehouses;
    this.providerLocations = providerLocations;
  }

  #dto(w) {
    return {
      warehouseId: w.id,
      code: w.code,
      name: w.name,
      postalCode: w.postal_code || null,
      city: w.city || null,
      state: w.state || null,
      country: w.country || 'IN',
      addressLine1: w.address_line1 || null,
      addressLine2: w.address_line2 || null,
      contactName: w.contact_name || null,
      contactPhone: w.contact_phone || null,
      isDefault: Boolean(w.is_default),
      // origin PIN is mandatory for TAT / shipping-cost / manifest — surface
      // the gap, never substitute a value.
      originPincodeMissing: !/^\d{6}$/.test(String(w.postal_code || '')),
    };
  }

  /**
   * @param {{ destinationPostalCode?: string|null, skuQuantities?: Record<string,number>|null, warehouseId?: string|null }} [ctx]
   */
  async resolveOrigin(ctx = {}) {
    // An explicit fulfilment origin (Slice 8+ passes this) wins.
    if (ctx.warehouseId) {
      const explicit = await this.warehouses.findById(ctx.warehouseId);
      if (!explicit) throw new AppError('WAREHOUSE_NOT_FOUND', 'Origin warehouse not found.', 404);
      return this.#dto(explicit);
    }

    const active = await this.warehouses.activeOrderedByPriority();
    if (!active.length) {
      throw new AppError('NO_ELIGIBLE_WAREHOUSE', 'No active warehouse is available to dispatch this shipment.', 409);
    }
    // A confirmed order carries its dispatch origin on the fulfilment
    // (destination-aware allocation already ran) — callers pass ctx.warehouseId
    // for that. This path is for pre-allocation estimates (PDP / checkout):
    // rank by destination proximity (TAT plugs in later), then default, then
    // priority. Stock filtering for ctx.skuQuantities plugs in the same way.
    const { ranked } = rankWarehousesForDestination(active, ctx.destinationPostalCode || null, null);
    const chosen = (ctx.destinationPostalCode ? ranked[0] : null)
      || ranked.find((w) => Number(w.is_default) === 1)
      || ranked[0];
    return this.#dto(chosen);
  }

  /**
   * The provider's registered pickup-location identifier for a warehouse.
   * Returns null when the warehouse is not registered with that provider —
   * the caller MUST block booking with a clear message (§35), never guess.
   */
  async providerLocation(warehouseId, providerCode) {
    const row = await this.providerLocations.activeIdentifier(warehouseId, providerCode);
    if (!row) return null;
    return {
      identifier: row.provider_location_identifier,
      returnIdentifier: row.provider_return_identifier || row.provider_location_identifier,
      registeredAt: row.registered_at || null,
    };
  }
}

export const warehouseResolver = new WarehouseResolver();
