import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { inventoryService } from '../inventory/service.js';
import { warehouseRepository } from '../warehouses/repository.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { warehouseTransferRepository } from './repository.js';
import { assertTransferTransition } from './transitions.js';

const audit = new StaffAuditRepository();

const toDto = (row, items = []) => ({
  id: row.id,
  transferNumber: row.transfer_number,
  status: row.status,
  source: { id: row.source_warehouse_id, name: row.source_warehouse_name },
  destination: { id: row.destination_warehouse_id, name: row.destination_warehouse_name },
  note: row.note,
  createdByStaffId: row.created_by_staff_id,
  createdAt: row.created_at,
  dispatchedAt: row.dispatched_at,
  receivedAt: row.received_at,
  cancelledAt: row.cancelled_at,
  lineCount: row.line_count != null ? Number(row.line_count) : items.length,
  unitCount: row.unit_count != null ? Number(row.unit_count) : items.reduce((n, i) => n + Number(i.quantity), 0),
  items: items.map((i) => ({
    id: i.id,
    skuId: i.sku_id,
    sku: i.sku,
    quantity: Number(i.quantity),
    quantityReceived: Number(i.quantity_received),
  })),
});

class WarehouseTransferService {
  async list({ status, warehouseId, warehouseIds, limit, offset } = {}) {
    const [rows, total] = await Promise.all([
      warehouseTransferRepository.list({ status, warehouseId, warehouseIds, limit, offset }),
      warehouseTransferRepository.count({ status, warehouseId, warehouseIds }),
    ]);
    return { transfers: rows.map((r) => toDto(r)), total, limit: limit ?? 50, offset: offset ?? 0 };
  }

  async detail(id) {
    const row = await warehouseTransferRepository.findById(id);
    if (!row) throw new AppError('TRANSFER_NOT_FOUND', 'Transfer not found.', 404);
    const items = await warehouseTransferRepository.items(id);
    return toDto(row, items);
  }

  /**
   * Create a DRAFT transfer. No stock moves yet. There is deliberately no
   * approval gate — the transfer approval workflow is [BUSINESS_INPUT]
   * (audit external-input register #17); a DRAFT is dispatched directly by
   * `inventory.adjust` staff for now.
   */
  async create({ sourceWarehouseId, destinationWarehouseId, note = null, lines = [] }, actor = {}) {
    if (sourceWarehouseId === destinationWarehouseId) {
      throw new AppError('TRANSFER_SAME_WAREHOUSE', 'Source and destination must be different warehouses.', 400);
    }
    if (!Array.isArray(lines) || lines.length === 0) {
      throw new AppError('TRANSFER_NO_LINES', 'A transfer needs at least one line.', 400);
    }
    const seen = new Set();
    for (const line of lines) {
      if (!line.skuId || !Number.isInteger(line.quantity) || line.quantity <= 0) {
        throw new AppError('TRANSFER_LINE_INVALID', 'Every line needs a SKU and a positive quantity.', 400);
      }
      if (seen.has(line.skuId)) throw new AppError('TRANSFER_LINE_DUPLICATE', `SKU ${line.skuId} appears more than once.`, 400);
      seen.add(line.skuId);
    }

    const [source, destination] = await Promise.all([
      warehouseRepository.findById(sourceWarehouseId),
      warehouseRepository.findById(destinationWarehouseId),
    ]);
    if (!source || !destination) throw new AppError('WAREHOUSE_NOT_FOUND', 'A warehouse in the transfer does not exist.', 404);
    if (source.status !== 'ACTIVE' || destination.status !== 'ACTIVE') {
      throw new AppError('WAREHOUSE_NOT_ACTIVE', 'Both warehouses must be ACTIVE.', 409);
    }

    const created = await withTransaction(async (connection) => {
      const transfer = await warehouseTransferRepository.create(connection, {
        sourceWarehouseId, destinationWarehouseId, note, createdByStaffId: actor.id ?? null,
      });
      for (const line of lines) {
        await warehouseTransferRepository.addItem(connection, transfer.id, line);
      }
      return transfer;
    });

    await audit.log({
      staffUserId: actor.id ?? null, actorEmail: actor.email ?? null, ipAddress: actor.ip ?? null, requestId: actor.requestId ?? null,
      action: 'WAREHOUSE_TRANSFER_CREATED', resourceType: 'warehouse_transfer', resourceId: created.id,
      metadata: { transferNumber: created.transfer_number, sourceWarehouseId, destinationWarehouseId, lines: lines.length },
    });
    return this.detail(created.id);
  }

  /** DRAFT -> DISPATCHED. Decrements source on-hand per line (TRANSFER_OUT). */
  async dispatch(id, actor = {}) {
    const result = await withTransaction(async (connection) => {
      const transfer = await warehouseTransferRepository.findById(id, connection, { lock: true });
      if (!transfer) throw new AppError('TRANSFER_NOT_FOUND', 'Transfer not found.', 404);
      assertTransferTransition(transfer.status, 'DISPATCHED');
      const items = await warehouseTransferRepository.items(id, connection);
      if (items.length === 0) throw new AppError('TRANSFER_NO_LINES', 'A transfer needs at least one line.', 400);
      for (const item of items) {
        await inventoryService.applyTransferLeg({
          warehouseId: transfer.source_warehouse_id, skuId: item.sku_id, quantity: Number(item.quantity),
          direction: 'OUT', transferId: id, actorStaffId: actor.id ?? null, connection,
        });
      }
      await warehouseTransferRepository.markDispatched(connection, id);
      return { transfer, items };
    });
    await audit.log({
      staffUserId: actor.id ?? null, actorEmail: actor.email ?? null, ipAddress: actor.ip ?? null, requestId: actor.requestId ?? null,
      action: 'WAREHOUSE_TRANSFER_DISPATCHED', resourceType: 'warehouse_transfer', resourceId: id,
      metadata: { transferNumber: result.transfer.transfer_number, lines: result.items.length },
    });
    return this.detail(id);
  }

  /**
   * DISPATCHED -> RECEIVED. Increments destination on-hand per line
   * (TRANSFER_IN). `received` may under-report a line (units lost in transit)
   * but never over-report it. Omitted lines receive their full dispatched qty.
   */
  async receive(id, { received = [] } = {}, actor = {}) {
    const byId = new Map((received || []).map((r) => [r.skuId, r.quantityReceived]));
    const result = await withTransaction(async (connection) => {
      const transfer = await warehouseTransferRepository.findById(id, connection, { lock: true });
      if (!transfer) throw new AppError('TRANSFER_NOT_FOUND', 'Transfer not found.', 404);
      assertTransferTransition(transfer.status, 'RECEIVED');
      const items = await warehouseTransferRepository.items(id, connection);
      let discrepancy = 0;
      for (const item of items) {
        const dispatched = Number(item.quantity);
        const qty = byId.has(item.sku_id) ? Number(byId.get(item.sku_id)) : dispatched;
        if (!Number.isInteger(qty) || qty < 0 || qty > dispatched) {
          throw new AppError('TRANSFER_RECEIVE_INVALID', `Received quantity for ${item.sku} must be between 0 and ${dispatched}.`, 400);
        }
        if (qty > 0) {
          await inventoryService.applyTransferLeg({
            warehouseId: transfer.destination_warehouse_id, skuId: item.sku_id, quantity: qty,
            direction: 'IN', transferId: id, actorStaffId: actor.id ?? null, connection,
          });
        }
        await warehouseTransferRepository.setItemReceived(connection, item.id, qty);
        discrepancy += dispatched - qty;
      }
      await warehouseTransferRepository.markReceived(connection, id);
      return { transfer, items, discrepancy };
    });
    await audit.log({
      staffUserId: actor.id ?? null, actorEmail: actor.email ?? null, ipAddress: actor.ip ?? null, requestId: actor.requestId ?? null,
      action: 'WAREHOUSE_TRANSFER_RECEIVED', resourceType: 'warehouse_transfer', resourceId: id,
      metadata: { transferNumber: result.transfer.transfer_number, lines: result.items.length, discrepancyUnits: result.discrepancy },
    });
    return this.detail(id);
  }

  /** DRAFT -> CANCELLED. Only reachable before dispatch (no stock has moved). */
  async cancel(id, actor = {}) {
    await withTransaction(async (connection) => {
      const transfer = await warehouseTransferRepository.findById(id, connection, { lock: true });
      if (!transfer) throw new AppError('TRANSFER_NOT_FOUND', 'Transfer not found.', 404);
      assertTransferTransition(transfer.status, 'CANCELLED');
      await warehouseTransferRepository.markCancelled(connection, id);
    });
    await audit.log({
      staffUserId: actor.id ?? null, actorEmail: actor.email ?? null, ipAddress: actor.ip ?? null, requestId: actor.requestId ?? null,
      action: 'WAREHOUSE_TRANSFER_CANCELLED', resourceType: 'warehouse_transfer', resourceId: id,
    });
    return this.detail(id);
  }
}

export const warehouseTransferService = new WarehouseTransferService();
