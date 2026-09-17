import { AppError } from '../../utils/errors.js';
import { inventoryService } from '../inventory/service.js';
import { shippingService } from '../shipping/service.js';
import { allocationItemsFingerprint, serializeAllocation } from './allocationSnapshot.js';
import { warehouseRepository } from './repository.js';
import { rankWarehousesForDestination } from './warehouseSelection.js';

export { allocationItemsFingerprint, serializeAllocation };

export const ALLOCATION_STATUS = Object.freeze({
  ALLOCATED: 'ALLOCATED',
  PARTIALLY_UNAVAILABLE: 'PARTIALLY_UNAVAILABLE',
  UNALLOCATABLE: 'UNALLOCATABLE',
});

export const ITEM_STATE = Object.freeze({
  AVAILABLE_FOR_DESTINATION: 'AVAILABLE_FOR_DESTINATION',
  OUT_OF_STOCK_FOR_DESTINATION: 'OUT_OF_STOCK_FOR_DESTINATION',
  NOT_SERVICEABLE: 'NOT_SERVICEABLE',
});

const normalize = (items) => {
  const map = new Map();
  for (const item of items || []) {
    if (!item?.skuId || !Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 'Allocation items require a SKU and a positive integer quantity.', 400);
    }
    map.set(item.skuId, (map.get(item.skuId) || 0) + item.quantity);
  }
  if (!map.size) throw new AppError('VALIDATION_ERROR', 'At least one item is required for allocation.', 400);
  return [...map].map(([skuId, quantity]) => ({ skuId, quantity }));
};

/**
 * Generic N-warehouse allocation. Knows nothing about how many warehouses
 * exist or where they are — it reads ACTIVE warehouses in priority order,
 * checks per-warehouse sellable stock and destination serviceability, and
 * produces the fewest fulfilment splits that satisfy the order.
 *
 * Strategy: one warehouse if any single ACTIVE warehouse can ship everything;
 * otherwise split across the priority-ordered set; otherwise report what could
 * not be sourced. Adding a 4th/10th/100th warehouse is CMS data only.
 */
export class WarehouseAllocationService {
  constructor({ repository = warehouseRepository, inventory = inventoryService, shipping = shippingService } = {}) {
    this.repository = repository;
    this.inventory = inventory;
    this.shipping = shipping;
  }

  /**
   * Which warehouses can actually reach this destination, and how fast.
   *
   * Asks the carrier per LANE (this warehouse's PIN -> the customer's PIN),
   * which is the only way to express a warehouse that holds the stock but
   * cannot ship it there. The previous version asked one destination-only
   * question and answered it for every warehouse at once, so that case could
   * not exist.
   *
   * A warehouse is dropped ONLY on an explicit negative from the carrier.
   * Anything inconclusive — mock mode, no provider, no origin PIN, a timeout —
   * falls back to the destination-only check that was here before, so a
   * provider hiccup degrades to the old behaviour instead of emptying the
   * candidate list and refusing every order.
   *
   * @returns {{serviceableIds: Set<string>, tatByWarehouse: Map<string, number>, basis: string}}
   */
  async #laneEligibility(warehouses, destinationPostalCode) {
    const all = new Set(warehouses.map((w) => w.id));
    if (!destinationPostalCode) return { serviceableIds: all, tatByWarehouse: new Map(), basis: 'NO_DESTINATION' };

    let lanes = new Map();
    try {
      lanes = await this.shipping.laneServiceability({
        destinationPostalCode,
        origins: warehouses.map((w) => ({ warehouseId: w.id, postalCode: w.postal_code || null })),
      });
    } catch (error) {
      if (error.code === 'INVALID_POSTAL_CODE') throw error;
      lanes = new Map();
    }

    const conclusive = [...lanes.values()].some((l) => l.serviceable === true || l.serviceable === false);
    if (!conclusive) {
      // Nothing lane-specific is known. Fall back to the destination-only
      // question, exactly as before.
      let serviceable = false;
      try {
        const quote = await this.shipping.quote({ postalCode: destinationPostalCode, contextType: 'CHECKOUT' });
        serviceable = Boolean(quote?.serviceable);
      } catch (error) {
        if (error.code === 'INVALID_POSTAL_CODE') throw error;
        serviceable = false;
      }
      return {
        serviceableIds: serviceable ? all : new Set(),
        tatByWarehouse: new Map(),
        basis: 'DESTINATION_ONLY',
      };
    }

    const serviceableIds = new Set();
    const tatByWarehouse = new Map();
    for (const w of warehouses) {
      const lane = lanes.get(w.id);
      // Keep the inconclusive ones: not knowing is not the same as knowing no.
      if (!lane || lane.serviceable !== false) serviceableIds.add(w.id);
      if (Number.isFinite(lane?.transitDays)) tatByWarehouse.set(w.id, lane.transitDays);
    }
    return { serviceableIds, tatByWarehouse, basis: 'PER_LANE' };
  }

  async allocate({ destinationPostalCode = null, items }) {
    const lines = normalize(items);
    const warehouses = await this.repository.activeOrderedByPriority();
    if (!warehouses.length) {
      return {
        status: ALLOCATION_STATUS.UNALLOCATABLE, strategy: 'NONE', allocations: [],
        unmet: lines.map((l) => ({ ...l })),
        perItem: lines.map((l) => ({ ...l, state: ITEM_STATE.OUT_OF_STOCK_FOR_DESTINATION, warehouseIds: [] })),
      };
    }

    const { serviceableIds, tatByWarehouse, basis: serviceabilityBasis } =
      await this.#laneEligibility(warehouses, destinationPostalCode);
    // Order candidates by how well each warehouse serves THIS destination:
    // real per-lane TAT when the carrier gave us one, else PIN-code proximity,
    // else priority. The single-warehouse pick and the split loop below both
    // walk this order, so the destination-best warehouse is chosen rather than
    // merely the highest-priority or the nearest one.
    const { ranked: candidates, reason: selectionReason } = rankWarehousesForDestination(
      warehouses.filter((w) => serviceableIds.has(w.id)),
      destinationPostalCode,
      tatByWarehouse.size ? tatByWarehouse : null,
    );

    // Per-warehouse sellable stock for every requested SKU, in one read.
    const skuIds = lines.map((l) => l.skuId);
    const rows = await this.inventory.inventory.findForSkuIds(skuIds);
    const stock = new Map(); // `${warehouseId} ${skuId}` -> sellable
    for (const row of rows) {
      stock.set(`${row.warehouse_id} ${row.sku_id}`, Math.max(Number(row.on_hand) - Number(row.reserved), 0));
    }
    const sellable = (warehouseId, skuId) => stock.get(`${warehouseId} ${skuId}`) || 0;

    // 1. Single-warehouse: first (best priority) candidate that covers everything.
    const single = candidates.find((w) => lines.every((l) => sellable(w.id, l.skuId) >= l.quantity));
    let allocationMap; // warehouseId -> Map(skuId -> qty)
    let strategy;
    const unmet = [];

    if (single) {
      strategy = 'SINGLE';
      allocationMap = new Map([[single.id, new Map(lines.map((l) => [l.skuId, l.quantity]))]]);
    } else {
      // 2. Split greedily by priority.
      strategy = 'SPLIT';
      allocationMap = new Map();
      for (const line of lines) {
        let remaining = line.quantity;
        for (const w of candidates) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, sellable(w.id, line.skuId));
          if (take <= 0) continue;
          if (!allocationMap.has(w.id)) allocationMap.set(w.id, new Map());
          allocationMap.get(w.id).set(line.skuId, take);
          remaining -= take;
        }
        if (remaining > 0) unmet.push({ skuId: line.skuId, quantity: remaining });
      }
      if (allocationMap.size <= 1 && !unmet.length) strategy = 'SINGLE';
    }

    const byId = new Map(warehouses.map((w) => [w.id, w]));
    const rankIndex = new Map(candidates.map((w, i) => [w.id, i]));
    const allocations = [...allocationMap.entries()]
      .map(([warehouseId, skuMap]) => {
        const w = byId.get(warehouseId);
        return {
          warehouseId, code: w.code, name: w.name, priority: w.priority,
          items: [...skuMap.entries()].map(([skuId, quantity]) => ({ skuId, quantity })).sort((a, b) => a.skuId.localeCompare(b.skuId)),
        };
      })
      // Primary fulfilment first = the destination-best warehouse.
      .sort((a, b) => (rankIndex.get(a.warehouseId) ?? 999) - (rankIndex.get(b.warehouseId) ?? 999) || a.warehouseId.localeCompare(b.warehouseId));

    const perItem = lines.map((line) => {
      const placed = allocations
        .filter((a) => a.items.some((i) => i.skuId === line.skuId))
        .map((a) => a.warehouseId);
      const unmetLine = unmet.find((u) => u.skuId === line.skuId);
      let state = ITEM_STATE.AVAILABLE_FOR_DESTINATION;
      if (!candidates.length) state = ITEM_STATE.NOT_SERVICEABLE;
      else if (unmetLine && !placed.length) {
        state = warehouses.some((w) => sellable(w.id, line.skuId) > 0) ? ITEM_STATE.NOT_SERVICEABLE : ITEM_STATE.OUT_OF_STOCK_FOR_DESTINATION;
      } else if (unmetLine) state = ITEM_STATE.OUT_OF_STOCK_FOR_DESTINATION;
      return { skuId: line.skuId, quantity: line.quantity, state, warehouseIds: placed };
    });

    let status = ALLOCATION_STATUS.ALLOCATED;
    if (!allocations.length) status = ALLOCATION_STATUS.UNALLOCATABLE;
    else if (unmet.length) status = ALLOCATION_STATUS.PARTIALLY_UNAVAILABLE;

    return {
      status, strategy: allocations.length ? strategy : 'NONE', allocations, unmet, perItem,
      // Why this warehouse ordering — surfaced to order confirmation + CMS.
      selectionReason: allocations.length ? selectionReason : 'NONE',
      // How serviceability was decided: PER_LANE means each warehouse was
      // checked against this destination individually; DESTINATION_ONLY means
      // the carrier could not answer per lane and the older, coarser check
      // stood in. Recorded so an allocation decision can be explained after
      // the fact rather than inferred.
      serviceabilityBasis,
      laneTransitDays: tatByWarehouse.size ? Object.fromEntries(tatByWarehouse) : null,
    };
  }

  /** Flatten an allocation result into reservable (warehouseId, skuId, quantity) lines. */
  toReservationItems(allocation) {
    return allocation.allocations.flatMap((a) => a.items.map((i) => ({ warehouseId: a.warehouseId, skuId: i.skuId, quantity: i.quantity })));
  }
}

export const warehouseAllocationService = new WarehouseAllocationService();
