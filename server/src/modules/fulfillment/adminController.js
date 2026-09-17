import { z } from 'zod';
import { AppError } from '../../utils/errors.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { fulfillmentService } from './service.js';
import { fulfillmentRepository } from './repository.js';
import { tryCompleteOrder } from '../logistics/completionBridge.js';

// WP-11 — the standalone Fulfillment CMS surface. Read is fulfillment.read;
// every state transition is fulfillment.manage and warehouse-scoped. The
// transition itself goes through FulfillmentService.transitionStatus (the
// single state-machine authority — §41).

const audit = new StaffAuditRepository();
const ok = (res, data, status = 200) => res.status(status).json({ data });
const staffOf = (req) => ({ id: req.staff?.id, role: req.staff?.role });

const listQuery = z.object({
  status: z.enum(['PENDING', 'WAREHOUSE_CONFIRMED', 'READY', 'PROCESSING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'ON_HOLD', 'CANCELLED']).optional(),
  warehouseId: z.string().uuid().optional(),
  orderNumber: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// The transitions a staff member can drive from the CMS. The state machine
// (transitions.js) still validates the specific from->to edge.
const transitionBody = z.object({
  toStatus: z.enum(['PENDING', 'WAREHOUSE_CONFIRMED', 'READY', 'PROCESSING', 'ON_HOLD', 'FULFILLED', 'CANCELLED']),
  note: z.string().trim().max(255).optional(),
});

async function scopedWarehouseIds(req, requiredWarehouseId = null) {
  const scope = await warehouseScopeForStaff(staffOf(req));
  if (requiredWarehouseId && !scope.all && !scope.warehouseIds.includes(requiredWarehouseId)) {
    throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this warehouse.', 403);
  }
  return scope.all ? null : scope.warehouseIds;
}

export async function listFulfillments(req, res, next) {
  try {
    const q = listQuery.parse(req.query ?? {});
    const warehouseIds = await scopedWarehouseIds(req, q.warehouseId ?? null);
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;
    if (warehouseIds && warehouseIds.length === 0) return ok(res, { fulfillments: [], total: 0, limit, offset });
    ok(res, await fulfillmentService.adminList({
      status: q.status ?? null,
      warehouseIds: q.warehouseId ? [q.warehouseId] : warehouseIds,
      orderNumber: q.orderNumber ?? null,
      limit, offset,
    }));
  } catch (err) { next(err); }
}

export async function getFulfillment(req, res, next) {
  try {
    const f = await fulfillmentRepository.adminById(req.params.id);
    if (!f) throw new AppError('FULFILLMENT_NOT_FOUND', 'Fulfillment not found.', 404);
    await scopedWarehouseIds(req, f.warehouse_id);
    ok(res, await fulfillmentService.adminDetail(req.params.id));
  } catch (err) { next(err); }
}

export async function transitionFulfillment(req, res, next) {
  try {
    const { toStatus, note } = transitionBody.parse(req.body ?? {});
    const f = await fulfillmentRepository.adminById(req.params.id);
    if (!f) throw new AppError('FULFILLMENT_NOT_FOUND', 'Fulfillment not found.', 404);
    await scopedWarehouseIds(req, f.warehouse_id);

    // Warehouse confirmation goes through its own door, which refuses without
    // a named actor. Everything else keeps the generic transition.
    const result = toStatus === 'WAREHOUSE_CONFIRMED'
      ? await fulfillmentService.confirmByWarehouse(req.params.id, {
        actorStaffId: req.staff?.id || null,
        note: note ?? null,
      })
      : await fulfillmentService.transitionStatus(req.params.id, toStatus, {
        detail: { via: 'CMS', actorStaffId: req.staff?.id || null, note: note ?? null, fromStatus: f.status },
      });

    await audit.log({
      staffUserId: req.staff?.id || null, actorEmail: req.staff?.email || null, ipAddress: req.ip,
      action: 'FULFILLMENT_TRANSITIONED', resourceType: 'fulfillment', resourceId: req.params.id,
      metadata: { orderId: f.order_id, from: f.status, to: toStatus, note: note ?? null },
    });

    // WP-11 x WP-01 — a staff-marked FULFILLED can complete the order, same
    // as a delivered-scan does through the completion bridge.
    let orderCompleted = false;
    if (toStatus === 'FULFILLED') {
      orderCompleted = (await tryCompleteOrder(f.order_id).catch(() => ({ completed: false }))).completed === true;
    }

    ok(res, { fulfillment: await fulfillmentService.adminDetail(req.params.id), orderCompleted });
  } catch (err) { next(err); }
}
