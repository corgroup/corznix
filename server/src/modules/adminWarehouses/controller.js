import { adminWarehouseService } from './service.js';
import * as v from './validation.js';

// `role` is required — this actor is fed straight into warehouseScopeForStaff
// (adminWarehouseService.list/get/... -> #assertAccess), which treats a
// missing role as "no global access" and falls back to (empty) per-staff
// assignment scoping. Without it, SUPER_ADMIN/ADMIN saw zero warehouses and
// were denied every warehouse detail page.
const actorOf = (req) => ({ id: req.staff?.id, email: req.staff?.email, role: req.staff?.role, brandId: req.brandId, ip: req.ip, requestId: req.id });
const ok = (res, data, status = 200) => res.status(status).json({ data });

export async function listWarehouses(req, res, next) {
  try {
    const q = v.listQuerySchema.parse(req.query);
    ok(res, await adminWarehouseService.list(actorOf(req), { status: q.status ?? null }));
  } catch (err) { next(err); }
}

export async function getWarehouse(req, res, next) {
  try { ok(res, await adminWarehouseService.get(actorOf(req), req.params.id)); } catch (err) { next(err); }
}

export async function createWarehouse(req, res, next) {
  try {
    const body = v.createWarehouseSchema.parse(req.body);
    ok(res, await adminWarehouseService.create(actorOf(req), body), 201);
  } catch (err) { next(err); }
}

export async function updateWarehouse(req, res, next) {
  try {
    const body = v.updateWarehouseSchema.parse(req.body);
    ok(res, await adminWarehouseService.update(actorOf(req), req.params.id, body));
  } catch (err) { next(err); }
}

export async function setWarehouseStatus(req, res, next) {
  try {
    const { status } = v.setStatusSchema.parse(req.body);
    ok(res, await adminWarehouseService.setStatus(actorOf(req), req.params.id, status));
  } catch (err) { next(err); }
}

export async function setWarehouseDefault(req, res, next) {
  try { ok(res, await adminWarehouseService.setDefault(actorOf(req), req.params.id)); } catch (err) { next(err); }
}

export async function assignStaff(req, res, next) {
  try {
    const { staffUserId } = v.assignStaffSchema.parse(req.body);
    ok(res, await adminWarehouseService.assignStaff(actorOf(req), req.params.id, staffUserId), 201);
  } catch (err) { next(err); }
}

export async function unassignStaff(req, res, next) {
  try {
    ok(res, await adminWarehouseService.unassignStaff(actorOf(req), req.params.id, req.params.staffUserId));
  } catch (err) { next(err); }
}

export async function warehouseInventory(req, res, next) {
  try {
    const q = v.inventoryQuerySchema.parse(req.query);
    ok(res, await adminWarehouseService.inventory_(actorOf(req), req.params.id, { skuId: q.skuId ?? null }));
  } catch (err) { next(err); }
}

export async function adjustInventory(req, res, next) {
  try {
    const body = v.adjustInventorySchema.parse(req.body);
    ok(res, await adminWarehouseService.adjustInventory(actorOf(req), req.params.id, body));
  } catch (err) { next(err); }
}

export async function previewAllocation(req, res, next) {
  try {
    const body = v.allocationPreviewSchema.parse(req.body);
    ok(res, await adminWarehouseService.previewAllocation(actorOf(req), body));
  } catch (err) { next(err); }
}

export async function setProviderLocation(req, res, next) {
  try {
    const body = v.providerLocationSchema.parse(req.body);
    ok(res, await adminWarehouseService.setProviderLocation(actorOf(req), req.params.id, req.params.providerCode, body));
  } catch (err) { next(err); }
}

export async function removeProviderLocation(req, res, next) {
  try {
    ok(res, await adminWarehouseService.removeProviderLocation(actorOf(req), req.params.id, req.params.providerCode));
  } catch (err) { next(err); }
}

export async function providerSyncStatus(req, res, next) {
  try {
    ok(res, await adminWarehouseService.providerSyncStatus(actorOf(req), { providerCode: req.query.providerCode || undefined }));
  } catch (err) { next(err); }
}
