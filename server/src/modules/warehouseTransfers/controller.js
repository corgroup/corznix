import { AppError } from '../../utils/errors.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { warehouseTransferService } from './service.js';
import { warehouseTransferRepository } from './repository.js';
import * as v from './validation.js';

const actorOf = (req) => ({ id: req.staff?.id, email: req.staff?.email, ip: req.ip, requestId: req.id });
const ok = (res, data, status = 200) => res.status(status).json({ data });

// Phase 6 security pass (DESIGN.md §5.3) — brandId threaded through so
// ADMIN/SUPER_ADMIN's "all" scope from warehouseScopeForStaff is bounded to
// THIS company's warehouses only (see requireWarehouseAccess.js); a
// cross-brand transfer id 404s (checked independently, below) rather than
// relying on the warehouse-assignment scope alone.
const scopeOf = (req) => warehouseScopeForStaff({ id: req.staff?.id, role: req.staff?.role }, req.brandId);

// A scoped staffer may only act on a transfer that touches a warehouse they
// are assigned to; `which` narrows it to one endpoint for dispatch/receive.
async function assertScopedToTransfer(req, transferId, which = 'either') {
  const t = await warehouseTransferRepository.findById(transferId);
  // Brand check first, independent of assignment scope — a transfer that
  // exists but belongs to another company 404s the same as a missing one.
  if (!t || (req.brandId && t.brand_id !== req.brandId)) {
    throw new AppError('TRANSFER_NOT_FOUND', 'Transfer not found.', 404);
  }
  const scope = await scopeOf(req);
  if (scope.all) return;
  const wanted = which === 'source' ? [t.source_warehouse_id]
    : which === 'destination' ? [t.destination_warehouse_id]
    : [t.source_warehouse_id, t.destination_warehouse_id];
  if (!wanted.some((id) => scope.warehouseIds.includes(id))) {
    throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to a warehouse on this transfer.', 403);
  }
}

export async function listTransfers(req, res, next) {
  try {
    const q = v.listQuerySchema.parse(req.query ?? {});
    const scope = await scopeOf(req);
    if (q.warehouseId && !scope.warehouseIds.includes(q.warehouseId)) {
      throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this warehouse.', 403);
    }
    ok(res, await warehouseTransferService.list({
      status: q.status ?? null,
      warehouseId: q.warehouseId ?? null,
      warehouseIds: scope.warehouseIds,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    }));
  } catch (err) { next(err); }
}

export async function getTransfer(req, res, next) {
  try {
    await assertScopedToTransfer(req, req.params.id);
    ok(res, await warehouseTransferService.detail(req.params.id));
  } catch (err) { next(err); }
}

export async function createTransfer(req, res, next) {
  try {
    const body = v.createBodySchema.parse(req.body ?? {});
    const scope = await scopeOf(req);
    if (!scope.all) {
      for (const id of [body.sourceWarehouseId, body.destinationWarehouseId]) {
        if (!scope.warehouseIds.includes(id)) {
          throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to both warehouses in this transfer.', 403);
        }
      }
    } else {
      // Even with blanket role access, both warehouses must be in THIS
      // company — warehouseIds is already brand-bounded, so re-use it here
      // too rather than trusting the body's ids unconditionally.
      for (const id of [body.sourceWarehouseId, body.destinationWarehouseId]) {
        if (!scope.warehouseIds.includes(id)) {
          throw new AppError('WAREHOUSE_NOT_FOUND', 'Warehouse not found.', 404);
        }
      }
    }
    ok(res, await warehouseTransferService.create(body, actorOf(req)), 201);
  } catch (err) { next(err); }
}

export async function dispatchTransfer(req, res, next) {
  try {
    await assertScopedToTransfer(req, req.params.id, 'source');
    ok(res, await warehouseTransferService.dispatch(req.params.id, actorOf(req)));
  } catch (err) { next(err); }
}

export async function receiveTransfer(req, res, next) {
  try {
    await assertScopedToTransfer(req, req.params.id, 'destination');
    const body = v.receiveBodySchema.parse(req.body ?? {});
    ok(res, await warehouseTransferService.receive(req.params.id, body, actorOf(req)));
  } catch (err) { next(err); }
}

export async function cancelTransfer(req, res, next) {
  try {
    await assertScopedToTransfer(req, req.params.id, 'source');
    ok(res, await warehouseTransferService.cancel(req.params.id, actorOf(req)));
  } catch (err) { next(err); }
}
