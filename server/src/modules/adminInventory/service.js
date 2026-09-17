import { AppError } from '../../utils/errors.js';
import { withTransaction } from '../../database/connection/transaction.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { inventoryRepository, inventoryMovementRepository, reservationRepository } from '../inventory/repository.js';
import { StaffAuditRepository } from '../staff/repositories.js';

// WP-12 — the standalone Inventory CMS surface. Read-only cross-warehouse
// search + a per-(warehouse, sku) detail view (balances, movement history
// with actor + resulting balance, open reservations) + the low-stock
// threshold editor. It does NOT touch the inventory authority — stock
// adjustments still go through the existing
// POST /warehouses/:id/inventory/adjust path.

const audit = new StaffAuditRepository();

const lowStock = (onHand, reserved, threshold) =>
  threshold != null && (Number(onHand) - Number(reserved)) <= Number(threshold);

const rowDto = (r) => ({
  warehouseId: r.warehouse_id,
  warehouseName: r.warehouse_name ?? null,
  skuId: r.sku_id,
  sku: r.sku,
  size: r.size ?? null,
  colorName: r.color_name ?? null,
  productId: r.product_id ?? null,
  productName: r.product_name ?? null,
  onHand: Number(r.on_hand),
  nonSellable: Number(r.non_sellable ?? 0),
  reserved: Number(r.reserved),
  available: Number(r.on_hand) - Number(r.reserved),
  lowStockThreshold: r.low_stock_threshold == null ? null : Number(r.low_stock_threshold),
  lowStock: lowStock(r.on_hand, r.reserved, r.low_stock_threshold),
});

const movementDto = (m) => ({
  id: m.id,
  type: m.movement_type,
  quantityDelta: Number(m.quantity_delta),
  balanceAfter: m.balance_after == null ? null : Number(m.balance_after),
  referenceType: m.reference_type ?? null,
  referenceId: m.reference_id ?? null,
  reason: m.reason ?? null,
  actor: m.actor_email ?? null,
  occurredAt: m.created_at,
});

export class AdminInventoryService {
  constructor({
    inventoryRepo = inventoryRepository,
    movements = inventoryMovementRepository,
    reservations = reservationRepository,
    transaction = withTransaction,
  } = {}) {
    this.inventoryRepo = inventoryRepo;
    this.movements = movements;
    this.reservations = reservations;
    this.transaction = transaction;
  }

  async #scopedWarehouseIds(actor, requestedWarehouseId = null) {
    // Phase 6 security pass — when a real brandId is available (every HTTP
    // route), warehouseIds is the caller's real, brand-bounded set (see
    // requireWarehouseAccess.js) and membership is checked unconditionally.
    // With NO brandId (a handful of test fixtures call this service
    // directly with a hand-built actor, no request in scope) this falls
    // back to the pre-Phase-6 behaviour — scope.all means "no filter at
    // all" — rather than misreading the fallback's empty warehouseIds as
    // "assigned to nothing".
    const scope = await warehouseScopeForStaff(actor, actor?.brandId);
    const brandBounded = Boolean(actor?.brandId);
    if (requestedWarehouseId) {
      const allowed = brandBounded ? scope.warehouseIds.includes(requestedWarehouseId) : (scope.all || scope.warehouseIds.includes(requestedWarehouseId));
      if (!allowed) {
        throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this warehouse.', 403);
      }
      return [requestedWarehouseId];
    }
    if (!brandBounded && scope.all) return null;
    return scope.warehouseIds;
  }

  async list(actor, { q = null, warehouseId = null, lowStockOnly = false, limit = 50, offset = 0 } = {}) {
    const warehouseIds = await this.#scopedWarehouseIds(actor, warehouseId);
    // A scoped staff member with zero assignments sees nothing.
    if (warehouseIds && warehouseIds.length === 0) {
      return { items: [], total: 0, limit, offset };
    }
    const filter = { warehouseIds, q, lowStockOnly, limit, offset };
    const [rows, total] = await Promise.all([
      this.inventoryRepo.search(filter),
      this.inventoryRepo.countSearch(filter),
    ]);
    return { items: rows.map(rowDto), total, limit, offset };
  }

  async detail(actor, warehouseId, skuId) {
    await this.#scopedWarehouseIds(actor, warehouseId);
    const row = await this.inventoryRepo.oneWithProduct(warehouseId, skuId);
    if (!row) throw new AppError('INVENTORY_NOT_CONFIGURED', 'No inventory row for this warehouse and SKU.', 404);
    const [movements, reservations] = await Promise.all([
      this.movements.forWarehouseSku(warehouseId, skuId, 100),
      this.reservations.openForWarehouseSku(warehouseId, skuId),
    ]);
    return {
      ...rowDto(row),
      movements: movements.map(movementDto),
      openReservations: reservations.map((r) => ({
        reservationId: r.reservation_id,
        customerId: r.customer_id ?? null,
        quantity: Number(r.quantity),
        expiresAt: r.expires_at,
        createdAt: r.created_at,
      })),
    };
  }

  async setThreshold(actor, warehouseId, skuId, threshold) {
    await this.#scopedWarehouseIds(actor, warehouseId);
    const row = await this.inventoryRepo.oneWithProduct(warehouseId, skuId);
    if (!row) throw new AppError('INVENTORY_NOT_CONFIGURED', 'No inventory row for this warehouse and SKU.', 404);
    const previous = row.low_stock_threshold == null ? null : Number(row.low_stock_threshold);
    await this.transaction((tx) => this.inventoryRepo.updateLowStockThreshold(tx, warehouseId, skuId, threshold));
    await audit.log({
      staffUserId: actor?.id || null,
      actorEmail: actor?.email || null,
      ipAddress: actor?.ip || null,
      action: 'INVENTORY_THRESHOLD_CHANGED',
      resourceType: 'inventory',
      resourceId: `${warehouseId}:${skuId}`,
      metadata: { warehouseId, skuId, from: previous, to: threshold },
    });
    return this.detail(actor, warehouseId, skuId);
  }
}

export const adminInventoryService = new AdminInventoryService();
