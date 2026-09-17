import { adminInventoryService } from './service.js';
import { toCsv, sendCsv } from '../../utils/csv.js';
import * as v from './validation.js';

// `role` is required — this actor is fed straight into warehouseScopeForStaff
// (adminInventoryService.list/detail/setThreshold), which treats a missing
// role as "no global access" and falls back to (empty) per-staff assignment
// scoping. Without it, SUPER_ADMIN/ADMIN saw zero inventory rows.
const actorOf = (req) => ({ id: req.staff?.id, email: req.staff?.email, role: req.staff?.role, brandId: req.brandId, ip: req.ip, requestId: req.id });
const ok = (res, data, status = 200) => res.status(status).json({ data });

export async function listInventory(req, res, next) {
  try {
    const q = v.listQuerySchema.parse(req.query ?? {});
    ok(res, await adminInventoryService.list(actorOf(req), {
      q: q.q ?? null,
      warehouseId: q.warehouseId ?? null,
      lowStockOnly: Boolean(q.lowStockOnly),
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    }));
  } catch (err) { next(err); }
}

export async function inventoryDetail(req, res, next) {
  try {
    ok(res, await adminInventoryService.detail(actorOf(req), req.params.warehouseId, req.params.skuId));
  } catch (err) { next(err); }
}

export async function exportInventory(req, res, next) {
  try {
    const q = v.listQuerySchema.parse(req.query ?? {});
    const { items } = await adminInventoryService.list(actorOf(req), {
      q: q.q ?? null,
      warehouseId: q.warehouseId ?? null,
      lowStockOnly: Boolean(q.lowStockOnly),
      limit: 10000,
      offset: 0,
    });
    const headers = ['SKU', 'Product', 'Colour', 'Size', 'Warehouse', 'On hand', 'Reserved', 'Available', 'Non-sellable', 'Low-stock threshold', 'Low stock'];
    sendCsv(res, 'inventory', toCsv(headers, items.map((r) => [
      r.sku, r.productName || '', r.colorName || '', r.size || '', r.warehouseName || '',
      r.onHand, r.reserved, r.available, r.nonSellable,
      r.lowStockThreshold == null ? '' : r.lowStockThreshold, r.lowStock ? 'yes' : 'no',
    ])));
  } catch (err) { next(err); }
}

export async function setThreshold(req, res, next) {
  try {
    const { threshold } = v.thresholdBodySchema.parse(req.body ?? {});
    ok(res, await adminInventoryService.setThreshold(actorOf(req), req.params.warehouseId, req.params.skuId, threshold));
  } catch (err) { next(err); }
}
