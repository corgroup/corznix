import { withTransaction } from '../../database/connection/transaction.js';
import { fulfillmentRepository } from '../fulfillment/repository.js';
import { orderOpsRepository } from '../orderOps/repository.js';
import { inventoryQuarantineService } from '../inventoryQuarantine/service.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { logger } from '../../utils/logger.js';

const log = logger('logistics-rto-bridge');
const audit = new StaffAuditRepository();

// WP-04 / GAP-INV-02 — when a WP-01 scan marks a shipment RTO_RETURNED, the
// units are physically back at the dispatch warehouse but nothing re-tracked
// them (08e: "RTO NOT_IMPLEMENTED for inventory" — a permanent phantom loss).
//
// This bridge routes those units into quarantine (source RTO_RECEIVED),
// pending inspection. Staff then RELEASE (restock) or SCRAP them from the
// existing Quarantine surface. It deliberately does NOT decide the order's
// fate (refund / re-attempt / re-ship) — that is a business-policy layer
// (WP-04 scope boundary). Best-effort like the completion bridge: a failure
// is logged, never rolled back onto the webhook.
export async function runRtoBridge({ shipmentId }) {
  const shipment = await orderOpsRepository.shipment(shipmentId);
  if (!shipment) return { quarantined: false, reason: 'SHIPMENT_NOT_FOUND' };

  const warehouseId = shipment.warehouse_id;
  const items = await fulfillmentRepository.items(null, shipment.fulfillment_id);
  const lines = items.map((i) => ({ skuId: i.sku_id, quantity: Number(i.quantity) })).filter((l) => l.quantity > 0);
  if (!warehouseId || !lines.length) {
    return { quarantined: false, reason: 'NO_LINES_OR_WAREHOUSE' };
  }

  const result = await withTransaction((connection) => inventoryQuarantineService.openFromRtoReceipt({
    shipmentId,
    warehouseId,
    shipmentNumber: shipment.shipment_number,
    lines,
    connection,
  }));

  if (result.skipped) {
    log.info('rto_already_quarantined', { shipmentId });
    return { quarantined: false, reason: result.skipped };
  }

  await audit.log({
    action: 'RTO_RECEIVED_QUARANTINED', resourceType: 'shipment', resourceId: shipmentId,
    metadata: { warehouseId, batches: result.batches.length, units: lines.reduce((n, l) => n + l.quantity, 0) },
  }).catch(() => {});

  log.info('rto_quarantined', { shipmentId, batches: result.batches.length });
  return { quarantined: true, batches: result.batches };
}
