import { AppError } from '../../utils/errors.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { inventoryQuarantineService } from './service.js';
import { inventoryQuarantineRepository } from './repository.js';
import * as v from './validation.js';

const actorOf = (req) => ({ id: req.staff?.id, email: req.staff?.email, ip: req.ip, requestId: req.id });
const ok = (res, data, status = 200) => res.status(status).json({ data });
// Phase 6 security pass (DESIGN.md §5.3) — brandId threaded through so
// warehouseScopeForStaff's "all" case for ADMIN/SUPER_ADMIN is bounded to
// THIS company's warehouses, not every warehouse in the whole install (see
// requireWarehouseAccess.js). Every membership check below is now against
// the always-complete scope.warehouseIds, never short-circuited on
// scope.all.
const scopeOf = (req) => warehouseScopeForStaff({ id: req.staff?.id, role: req.staff?.role }, req.brandId);

export async function listQuarantine(req, res, next) {
  try {
    const q = v.listQuerySchema.parse(req.query ?? {});
    const scope = await scopeOf(req);
    if (q.warehouseId && !scope.warehouseIds.includes(q.warehouseId)) {
      throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this warehouse.', 403);
    }
    ok(res, await inventoryQuarantineService.list({
      status: q.status ?? null,
      warehouseId: q.warehouseId ?? null,
      warehouseIds: scope.warehouseIds,
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    }));
  } catch (err) { next(err); }
}

async function assertScoped(req, id) {
  const batch = await inventoryQuarantineRepository.findById(id);
  // Brand check FIRST, independent of warehouse-assignment scope — a batch
  // that exists but belongs to another company 404s the same as a missing
  // one, never leaking existence across brands (DESIGN.md §5.3).
  if (!batch || (req.brandId && batch.brand_id !== req.brandId)) {
    throw new AppError('QUARANTINE_NOT_FOUND', 'Quarantine batch not found.', 404);
  }
  const scope = await scopeOf(req);
  if (!scope.all && !scope.warehouseIds.includes(batch.warehouse_id)) {
    // Same company, just not assigned to this specific warehouse — a real
    // 403, not a leak.
    throw new AppError('WAREHOUSE_ACCESS_DENIED', 'You are not assigned to this warehouse.', 403);
  }
}

export async function getQuarantine(req, res, next) {
  try {
    await assertScoped(req, req.params.id);
    ok(res, await inventoryQuarantineService.detail(req.params.id));
  } catch (err) { next(err); }
}

export async function disposeQuarantine(req, res, next) {
  try {
    await assertScoped(req, req.params.id);
    const body = v.disposeBodySchema.parse(req.body ?? {});
    ok(res, await inventoryQuarantineService.dispose(req.params.id, body, actorOf(req)));
  } catch (err) { next(err); }
}
