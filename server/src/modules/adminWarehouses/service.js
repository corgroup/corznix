import { AppError } from '../../utils/errors.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { inventoryService } from '../inventory/service.js';
import { inventoryRepository, inventoryMovementRepository } from '../inventory/repository.js';
import { StaffAuditRepository, StaffWarehouseAssignmentRepository } from '../staff/repositories.js';
import { warehouseService } from '../warehouses/service.js';
import { warehouseAllocationService } from '../warehouses/allocationService.js';
import { warehouseProviderLocationRepository } from '../shipping/warehouseProviderRepository.js';
import { PROVIDER_CODES } from '../shipping/providerContract.js';
import { getWarehouseSyncService } from '../shipping/warehouseSyncService.js';

const providerLocationDto = (row) => ({
  providerCode: row.provider_code,
  pickupMode: row.pickup_mode,
  identifier: row.provider_location_identifier,
  returnIdentifier: row.provider_return_identifier || null,
  registeredAt: row.registered_at ? new Date(row.registered_at).toISOString() : null,
  // A weaker, human claim than registeredAt — someone read this name in the
  // carrier's panel. Never conflate the two.
  panelVerifiedAt: row.panel_verified_at ? new Date(row.panel_verified_at).toISOString() : null,
  status: row.status,
  notes: row.notes || null,
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
});

const inventoryRowDto = (row) => ({
  warehouseId: row.warehouse_id,
  skuId: row.sku_id,
  sku: row.sku,
  size: row.size ?? null,
  colorName: row.color_name ?? null,
  productId: row.product_id ?? null,
  productName: row.product_name ?? null,
  onHand: Number(row.on_hand),
  reserved: Number(row.reserved),
  available: Number(row.on_hand) - Number(row.reserved),
});

/**
 * Admin-facing orchestration for the CMS Warehouses module. The generic
 * warehouse domain (create / update / snapshot) lives in
 * modules/warehouses/service.js; this layer adds staff scoping, the
 * warehouse-inventory read, the single inventory-adjustment write, and the
 * staff audit trail.
 */
export class AdminWarehouseService {
  constructor({
    warehouses = warehouseService,
    inventory = inventoryService,
    inventoryRepo = inventoryRepository,
    movements = inventoryMovementRepository,
    assignments = new StaffWarehouseAssignmentRepository(),
    audit = new StaffAuditRepository(),
    allocation = warehouseAllocationService,
    providerLocations = warehouseProviderLocationRepository,
    sync = getWarehouseSyncService,
  } = {}) {
    this.providerLocations = providerLocations;
    this.sync = sync;
    this.warehouses = warehouses;
    this.inventory = inventory;
    this.inventoryRepo = inventoryRepo;
    this.movements = movements;
    this.assignments = assignments;
    this.audit = audit;
    this.allocation = allocation;
  }

  #audit(actor, entry) {
    return this.audit.log({
      staffUserId: actor?.id || null,
      actorEmail: actor?.email || null,
      ipAddress: actor?.ip || null,
      requestId: actor?.requestId || null,
      ...entry,
    });
  }

  async list(actor, opts) {
    const scope = await warehouseScopeForStaff(actor);
    const rows = await this.warehouses.list({ ...opts, brandId: actor.brandId });
    const visible = scope.all ? rows : rows.filter((row) => scope.warehouseIds.includes(row.id));
    return { warehouses: visible, scope: scope.all ? 'ALL' : 'ASSIGNED' };
  }

  async get(actor, id) {
    await this.#assertAccess(actor, id);
    const warehouse = await this.warehouses.get(id);
    const [staff, providerLocations] = await Promise.all([
      this.assignments.staffForWarehouse(id),
      warehouseProviderLocationRepository.listForWarehouse(id),
    ]);
    return {
      ...warehouse,
      assignedStaff: staff.map((s) => ({ id: s.id, email: s.email, firstName: s.first_name, lastName: s.last_name, role: s.role, status: s.status })),
      providerLocations: providerLocations.map(providerLocationDto),
    };
  }

  // ---- Phase 2 §35 — carrier pickup-location mapping -------------------

  async setProviderLocation(actor, id, providerCode, body) {
    await this.#assertAccess(actor, id);
    if (!Object.values(PROVIDER_CODES).includes(providerCode) || providerCode === PROVIDER_CODES.MOCK) {
      throw new AppError('INVALID_PROVIDER_CODE', 'Unknown shipping provider.', 422);
    }
    const warehouse = await this.warehouses.get(id); // 404s if missing

    // `register` actually creates the pickup location AT the carrier and only
    // then stores the mapping, so we can never persist an identifier the
    // carrier has never heard of. `link` is the escape hatch for a location
    // that already exists in the carrier panel — it is recorded as
    // unregistered (registeredAt stays null) and detectDrift flags it,
    // because there is no read API to confirm the name really matches.
    if (body.mode === 'register') {
      const sync = await this.sync();
      const registered = await sync.register(
        { ...warehouse, providerLocationName: body.identifier ?? warehouse.code },
        { providerCode, pickupMode: body.pickupMode ?? 'API', notes: body.notes ?? null },
      );
      await this.#audit(actor, {
        action: 'WAREHOUSE_PROVIDER_LOCATION_REGISTERED', resourceType: 'warehouse', resourceId: id,
        metadata: { providerCode, identifier: registered.provider_location_identifier },
      });
      return providerLocationDto(registered);
    }

    const row = await warehouseProviderLocationRepository.upsert(warehouse.id, providerCode, {
      identifier: body.identifier,
      returnIdentifier: body.returnIdentifier ?? null,
      registeredAt: body.registeredAt ?? null,
      // Stamped only when a person says they read this name in the carrier's
      // panel. It never becomes registeredAt — the carrier still has not
      // confirmed anything to us — it only says the warning has been looked at.
      panelVerifiedAt: body.panelVerified ? new Date() : null,
      panelVerifiedBy: body.panelVerified ? (actor?.id ?? null) : null,
      pickupMode: body.pickupMode ?? null,
      status: body.status ?? 'ACTIVE',
      notes: body.notes ?? null,
    });
    await this.#audit(actor, {
      action: 'WAREHOUSE_PROVIDER_LOCATION_SET', resourceType: 'warehouse', resourceId: id,
      metadata: { providerCode, identifier: body.identifier, status: row.status, panelVerified: Boolean(body.panelVerified) },
    });
    return providerLocationDto(row);
  }

  async removeProviderLocation(actor, id, providerCode) {
    await this.#assertAccess(actor, id);
    const removed = await warehouseProviderLocationRepository.remove(id, providerCode);
    if (!removed) throw new AppError('PROVIDER_LOCATION_NOT_FOUND', 'No mapping for that provider.', 404);
    await this.#audit(actor, {
      action: 'WAREHOUSE_PROVIDER_LOCATION_REMOVED', resourceType: 'warehouse', resourceId: id, metadata: { providerCode },
    });
    return { removed: true };
  }

  async create(actor, input) {
    const warehouse = await this.warehouses.create({ ...input, brandId: actor.brandId });
    await this.#audit(actor, { action: 'WAREHOUSE_CREATED', resourceType: 'warehouse', resourceId: warehouse.id, metadata: { code: warehouse.code, name: warehouse.name, priority: warehouse.priority } });
    return warehouse;
  }

  async update(actor, id, patch) {
    await this.#assertAccess(actor, id);

    // A carrier pickup-location `name` is IMMUTABLE (contract row 14 — there is
    // no rename endpoint) and it is derived from `code`. Letting the code
    // change would silently orphan the mapping: CORCOTTON would show the new
    // code while every manifest kept sending the old `pickup_location`.
    const mapping = await this.providerLocations.find(id, PROVIDER_CODES.DELHIVERY);
    if (mapping && patch.code !== undefined) {
      const current = await this.warehouses.get(id);
      if (String(patch.code) !== String(current.code)) {
        throw new AppError(
          'WAREHOUSE_CODE_LOCKED',
          `This warehouse is registered with the carrier as "${mapping.provider_location_identifier}", and carriers do not support renaming a pickup location. Remove the carrier mapping first, or create a new warehouse.`,
          409,
        );
      }
    }

    const warehouse = await this.warehouses.update(id, patch);

    // Push the address/phone change on to the carrier. This runs AFTER the
    // local write so a carrier outage cannot lose the operator's edit, and it
    // throws rather than swallowing: a CMS address that silently disagrees
    // with the courier's pickup address is the whole failure mode here.
    let providerSync = { pushed: false, reason: 'NO_ACTIVE_MAPPING' };
    if (mapping) {
      const sync = await this.sync();
      providerSync = await sync.pushAddressChange(id, patch, { providerCode: PROVIDER_CODES.DELHIVERY });
    }

    await this.#audit(actor, {
      action: 'WAREHOUSE_UPDATED', resourceType: 'warehouse', resourceId: id,
      metadata: { fields: Object.keys(patch), providerSync },
    });
    return { ...warehouse, providerSync };
  }

  /**
   * Mapping health for the Warehouses page. Carriers expose no read endpoint,
   * so this is derived from CORCOTTON's own state — it never claims to have
   * compared against the carrier panel.
   */
  async providerSyncStatus(actor, { providerCode = PROVIDER_CODES.DELHIVERY } = {}) {
    const scope = await warehouseScopeForStaff(actor);
    const rows = await this.warehouses.list({ brandId: actor.brandId });
    const warehouses = scope.all ? rows : rows.filter((row) => scope.warehouseIds.includes(row.id));
    const sync = await this.sync();
    const report = await sync.detectDrift(warehouses, { providerCode });
    return { ...report, providerReadSupported: false };
  }

  async setStatus(actor, id, status) {
    await this.#assertAccess(actor, id);
    const warehouse = await this.warehouses.setStatus(id, status);
    await this.#audit(actor, { action: status === 'DISABLED' ? 'WAREHOUSE_DISABLED' : 'WAREHOUSE_ENABLED', resourceType: 'warehouse', resourceId: id, metadata: { status } });
    return warehouse;
  }

  async setDefault(actor, id) {
    await this.#assertAccess(actor, id);
    const warehouse = await this.warehouses.setDefault(id);
    await this.#audit(actor, { action: 'DEFAULT_WAREHOUSE_CHANGED', resourceType: 'warehouse', resourceId: id, metadata: { code: warehouse.code } });
    return warehouse;
  }

  async assignStaff(actor, id, staffUserId) {
    await this.#assertAccess(actor, id);
    await this.warehouses.get(id); // 404 if missing
    await this.assignments.assign(staffUserId, id);
    await this.#audit(actor, { action: 'WAREHOUSE_STAFF_ASSIGNED', resourceType: 'warehouse', resourceId: id, metadata: { staffUserId } });
    return this.get(actor, id);
  }

  async unassignStaff(actor, id, staffUserId) {
    await this.#assertAccess(actor, id);
    const removed = await this.assignments.unassign(staffUserId, id);
    if (!removed) throw new AppError('WAREHOUSE_STAFF_NOT_ASSIGNED', 'That staff member is not assigned to this warehouse.', 404);
    await this.#audit(actor, { action: 'WAREHOUSE_STAFF_UNASSIGNED', resourceType: 'warehouse', resourceId: id, metadata: { staffUserId } });
    return this.get(actor, id);
  }

  async inventory_(actor, id, { skuId = null } = {}) {
    await this.#assertAccess(actor, id);
    await this.warehouses.get(id);
    const rows = await this.inventoryRepo.findForWarehouse(id, { skuIds: skuId ? [skuId] : null });
    return { warehouseId: id, items: rows.map(inventoryRowDto) };
  }

  async adjustInventory(actor, id, { skuId, delta, reason }) {
    await this.#assertAccess(actor, id);
    await this.warehouses.get(id);
    const result = await this.inventory.adjustStock({ warehouseId: id, skuId, delta, reason, actorStaffId: actor?.id || null });
    await this.#audit(actor, {
      action: 'INVENTORY_ADJUSTED',
      resourceType: 'inventory',
      resourceId: `${id}:${skuId}`,
      metadata: { warehouseId: id, skuId, delta, reason, onHandBefore: result.onHandBefore, onHandAfter: result.onHandAfter },
    });
    return result;
  }

  async previewAllocation(actor, { destinationPostalCode = null, items }) {
    const result = await this.allocation.allocate({ destinationPostalCode, items });
    const scope = await warehouseScopeForStaff(actor);
    if (scope.all) return result;
    // Scoped staff only see whether their own warehouses participate.
    return {
      ...result,
      allocations: result.allocations.filter((a) => scope.warehouseIds.includes(a.warehouseId)),
    };
  }

  // Multi-company (DESIGN.md §5.3 security checklist) — a real gap found
  // while wiring this phase: this only ever checked warehouse-ASSIGNMENT
  // scope, never company. A staff member with `scope.all` (unrestricted
  // warehouse-assignment role) could read/mutate another company's
  // warehouse by id if they knew it, even though every real UI path would
  // never surface it. 404, not 403 — never confirm the id exists elsewhere.
  async #assertAccess(actor, id) {
    const warehouse = await this.warehouses.getRow(id).catch(() => null);
    if (!warehouse || (actor.brandId && warehouse.brand_id !== actor.brandId)) {
      throw new AppError('WAREHOUSE_NOT_FOUND', 'Warehouse not found.', 404);
    }
    const scope = await warehouseScopeForStaff(actor);
    if (!scope.all && !scope.warehouseIds.includes(id)) {
      throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this warehouse.', 403);
    }
  }
}

export const adminWarehouseService = new AdminWarehouseService();
