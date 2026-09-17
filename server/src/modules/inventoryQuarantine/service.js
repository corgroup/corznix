import { withTransaction } from '../../database/connection/transaction.js';
import { AppError } from '../../utils/errors.js';
import { inventoryService } from '../inventory/service.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { inventoryQuarantineRepository } from './repository.js';

const audit = new StaffAuditRepository();

const toDto = (row) => {
  const quantity = Number(row.quantity);
  const released = Number(row.quantity_released);
  const scrapped = Number(row.quantity_scrapped);
  return {
    id: row.id,
    status: row.status,
    warehouse: { id: row.warehouse_id, name: row.warehouse_name },
    skuId: row.sku_id,
    sku: row.sku,
    productName: row.product_name || null,
    colorName: row.color_name || null,
    quantity,
    quantityReleased: released,
    quantityScrapped: scrapped,
    quantityRemaining: quantity - released - scrapped,
    reason: row.reason,
    sourceType: row.source_type,
    sourceRef: row.source_ref,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
};

class InventoryQuarantineService {
  /**
   * Open a quarantine batch for units that failed return QC (GAP-INV-03).
   * Called by returnLifecycleService inside the QC transaction — the units are
   * physically at `warehouseId`, so non_sellable goes up and a batch records
   * why. Never restocks anything sellable.
   */
  async openFromReturnQc({ warehouseId, skuId, quantity, returnRequestId, returnNumber, staffId = null, connection }) {
    if (!connection) throw new AppError('VALIDATION_ERROR', 'A transaction connection is required.', 500);
    await inventoryService.applyQuarantineDelta({
      warehouseId, skuId, quantity, action: 'QUARANTINE',
      referenceType: 'RETURN_REQUEST', referenceId: returnRequestId,
      reason: returnNumber ? `RETURN ${returnNumber} — QC FAIL` : 'Return QC FAIL',
      actorStaffId: staffId, connection,
    });
    return inventoryQuarantineRepository.create(connection, {
      warehouseId, skuId, quantity,
      reason: returnNumber ? `Return ${returnNumber} failed QC` : 'Return failed QC',
      sourceType: 'RETURN_QC_FAIL', sourceRef: returnRequestId, createdByStaffId: staffId,
    });
  }

  /**
   * WP-04 / GAP-INV-02 — units returned to origin (RTO) are physically back at
   * the dispatch warehouse but were never re-tracked (a phantom loss). Route
   * them into quarantine pending inspection; staff then RELEASE (restock) or
   * SCRAP via the same surface as a QC-FAIL batch. Idempotent on the shipment.
   * Composes into the RTO bridge's transaction (`connection` required).
   *
   * @param {{shipmentId:string, warehouseId:string, shipmentNumber?:string, lines:Array<{skuId:string, quantity:number}>, connection:object}} input
   */
  async openFromRtoReceipt({ shipmentId, warehouseId, shipmentNumber = null, lines, connection }) {
    if (!connection) throw new AppError('VALIDATION_ERROR', 'A transaction connection is required.', 500);
    const existing = await inventoryQuarantineRepository.bySource('RTO_RECEIVED', shipmentId, connection);
    if (existing.length) {
      return { skipped: 'ALREADY_QUARANTINED', batches: [] };
    }
    const batches = [];
    for (const line of lines) {
      const quantity = Number(line.quantity);
      if (!(quantity > 0)) continue;
      await inventoryService.applyQuarantineDelta({
        warehouseId, skuId: line.skuId, quantity, action: 'QUARANTINE',
        referenceType: 'SHIPMENT', referenceId: shipmentId,
        reason: shipmentNumber ? `RTO ${shipmentNumber}` : 'Return to origin',
        connection,
      });
      const batch = await inventoryQuarantineRepository.create(connection, {
        warehouseId, skuId: line.skuId, quantity,
        reason: shipmentNumber ? `RTO received — ${shipmentNumber}` : 'RTO received',
        sourceType: 'RTO_RECEIVED', sourceRef: shipmentId, createdByStaffId: null,
      });
      batches.push(batch.id);
    }
    return { skipped: null, batches };
  }

  async list({ status, warehouseId, warehouseIds, limit, offset } = {}) {
    const [rows, total] = await Promise.all([
      inventoryQuarantineRepository.list({ status, warehouseId, warehouseIds, limit, offset }),
      inventoryQuarantineRepository.count({ status, warehouseId, warehouseIds }),
    ]);
    return { batches: rows.map(toDto), total, limit: limit ?? 50, offset: offset ?? 0 };
  }

  async detail(id) {
    const row = await inventoryQuarantineRepository.findById(id);
    if (!row) throw new AppError('QUARANTINE_NOT_FOUND', 'Quarantine batch not found.', 404);
    return toDto(row);
  }

  /**
   * Dispose of some or all of a quarantine batch: RELEASE units back to
   * sellable on-hand (rework passed) or SCRAP them (write-off). Partial
   * dispositions accumulate; the batch resolves once every unit is accounted
   * for.
   */
  async dispose(id, { action, quantity, note = null }, actor = {}) {
    if (!['RELEASE', 'SCRAP'].includes(action)) {
      throw new AppError('VALIDATION_ERROR', 'action must be RELEASE or SCRAP.', 400);
    }
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new AppError('VALIDATION_ERROR', 'quantity must be a positive integer.', 400);
    }

    const result = await withTransaction(async (connection) => {
      const batch = await inventoryQuarantineRepository.findById(id, connection, { lock: true });
      if (!batch) throw new AppError('QUARANTINE_NOT_FOUND', 'Quarantine batch not found.', 404);
      const remaining = Number(batch.quantity) - Number(batch.quantity_released) - Number(batch.quantity_scrapped);
      if (batch.status === 'RESOLVED' || remaining <= 0) {
        throw new AppError('QUARANTINE_ALREADY_RESOLVED', 'This quarantine batch is fully disposed.', 409);
      }
      if (quantity > remaining) {
        throw new AppError('QUARANTINE_OVER_DISPOSE', `Only ${remaining} unit(s) remain in this batch.`, 409);
      }

      await inventoryService.applyQuarantineDelta({
        warehouseId: batch.warehouse_id, skuId: batch.sku_id, quantity,
        action, referenceType: 'INVENTORY_QUARANTINE', referenceId: batch.id,
        reason: note || `Quarantine ${action.toLowerCase()}`,
        actorStaffId: actor.id ?? null, connection,
      });

      return inventoryQuarantineRepository.applyDisposition(connection, id, {
        releasedDelta: action === 'RELEASE' ? quantity : 0,
        scrappedDelta: action === 'SCRAP' ? quantity : 0,
      });
    });

    await audit.log({
      staffUserId: actor.id ?? null, actorEmail: actor.email ?? null, ipAddress: actor.ip ?? null, requestId: actor.requestId ?? null,
      action: action === 'RELEASE' ? 'QUARANTINE_RELEASED' : 'QUARANTINE_SCRAPPED',
      resourceType: 'inventory_quarantine', resourceId: id,
      metadata: { quantity, note: note || null, skuId: result.sku_id, warehouseId: result.warehouse_id },
    });
    return toDto(result);
  }
}

export const inventoryQuarantineService = new InventoryQuarantineService();
