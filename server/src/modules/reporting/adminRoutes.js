import { Router } from 'express';
import { requireStaffPermission } from '../../middleware/requireStaffPermission.js';
import { warehouseScopeForStaff } from '../../middleware/requireWarehouseAccess.js';
import { PERMISSIONS } from '../staff/permissions.js';
import { StaffAuditRepository } from '../staff/repositories.js';
import { reportingService } from './reportingService.js';
import { reconciliationService } from './reconciliationService.js';
import { reportingRepository as R } from './reportingRepository.js';
import { resolvePeriod } from './reportTime.js';
import { parsePagination, parseSort, toCsv } from './guards.js';
import { SORTABLE } from './metricDefinitions.js';

const audit = new StaffAuditRepository();
const router = Router();
const reports = requireStaffPermission(PERMISSIONS.REPORTS_READ);
const finance = requireStaffPermission(PERMISSIONS.FINANCE_READ);
const exporter = requireStaffPermission(PERMISSIONS.REPORTS_EXPORT);
const recon = requireStaffPermission(PERMISSIONS.RECONCILIATION_MANAGE);

const send = (res, data) => res.json({ data });
const wrap = (fn) => async (req, res, next) => { try { await fn(req, res); } catch (err) { next(err); } };

// ---- metric registry (transparency) ----------------------------
router.get('/reports/meta', reports, wrap(async (req, res) => send(res, reportingService.meta())));

// ---- operational reports (reports.read) -----------------------
router.get('/reports/overview', reports, wrap(async (req, res) => send(res, await reportingService.overview(req.query, req.brandId))));
router.get('/reports/sales', reports, wrap(async (req, res) => send(res, await reportingService.sales(req.query, req.brandId))));
router.get('/reports/orders', reports, wrap(async (req, res) => send(res, await reportingService.orders(req.query, req.brandId))));
router.get('/reports/products', reports, wrap(async (req, res) => send(res, await reportingService.products(req.query, req.brandId))));
router.get('/reports/returns', reports, wrap(async (req, res) => send(res, await reportingService.returns(req.query, req.brandId))));
router.get('/reports/customers', reports, wrap(async (req, res) => send(res, await reportingService.customers(req.query, req.brandId))));
router.get('/reports/logistics', reports, wrap(async (req, res) => send(res, await reportingService.logistics(req.query, req.brandId))));
router.get('/reports/marketing', reports, wrap(async (req, res) => send(res, await reportingService.marketing(req.query, req.brandId))));

// Warehouse-scoped: non-global staff see only their assigned warehouses (§59).
router.get('/reports/inventory', reports, wrap(async (req, res) => {
  send(res, await reportingService.inventory(req.query, await warehouseScopeForStaff(req.staff), req.brandId));
}));
router.get('/reports/warehouses', reports, wrap(async (req, res) => {
  send(res, await reportingService.warehouses(req.query, await warehouseScopeForStaff(req.staff), req.brandId));
}));

// ---- finance reports (finance.read) --------------------------
router.get('/reports/payments', finance, wrap(async (req, res) => send(res, await reportingService.payments(req.query, req.brandId))));
router.get('/reports/cod', finance, wrap(async (req, res) => send(res, await reportingService.cod(req.query, req.brandId))));
router.get('/reports/store-credit', finance, wrap(async (req, res) => send(res, await reportingService.storeCredit(req.brandId))));
router.get('/reports/credit-notes', finance, wrap(async (req, res) => send(res, await reportingService.creditNotes(req.query, req.brandId))));

// ---- exports (reports.export) --------------------------------
const EXPORTS = {
  orders: {
    perm: 'reports',
    columns: [
      { key: 'order_number', label: 'order_number' }, { key: 'order_status', label: 'status' },
      { key: 'payment_mode', label: 'payment_mode' }, { key: 'subtotal_minor', label: 'subtotal_minor' },
      { key: 'discount_minor', label: 'discount_minor' }, { key: 'total_minor', label: 'total_minor' },
      { key: 'placed_at', label: 'placed_at' },
    ],
    fetch: async (q, staff, brandId) => {
      const period = resolvePeriod(q);
      const sort = parseSort(q, SORTABLE.orders, 'placed_at');
      return R.ordersDetail({ ...period, sort, offset: 0, limit: 10000, brandId });
    },
  },
  refunds: {
    perm: 'finance',
    columns: [
      { key: 'refund_number', label: 'refund_number' }, { key: 'status', label: 'status' },
      { key: 'method', label: 'method' }, { key: 'provider_code', label: 'provider' },
      { key: 'amount_minor', label: 'amount_minor' }, { key: 'created_at', label: 'created_at' },
    ],
    fetch: async (q, staff, brandId) => {
      const period = resolvePeriod(q);
      return R.refundsDetail({ ...period, offset: 0, limit: 10000, brandId });
    },
  },
  'stock-movements': {
    perm: 'reports',
    columns: [
      { key: 'created_at', label: 'created_at' }, { key: 'warehouse_code', label: 'warehouse' },
      { key: 'sku', label: 'sku' }, { key: 'movement_type', label: 'movement_type' },
      { key: 'quantity_delta', label: 'quantity_delta' }, { key: 'reference_type', label: 'reference_type' },
    ],
    fetch: async (q, staff, brandId) => {
      const period = resolvePeriod(q);
      const scope = await warehouseScopeForStaff(staff);
      return R.stockMovements({ ...period, warehouseIds: scope.all ? [] : scope.warehouseIds, offset: 0, limit: 10000, brandId });
    },
  },
};

router.get('/reports/export/:report', exporter, wrap(async (req, res) => {
  const spec = EXPORTS[req.params.report];
  if (!spec) { res.status(404).json({ error: { code: 'UNKNOWN_REPORT', message: 'No such export.' } }); return; }
  const rows = await spec.fetch(req.query, req.staff, req.brandId);
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'REPORT_EXPORTED', resourceType: 'report', resourceId: req.params.report, metadata: { rows: rows.length, filters: req.query }, ipAddress: req.ip });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.report}.csv"`);
  res.send(toCsv(rows, spec.columns));
}));

// ---- reconciliation (reconciliation.manage) ------------------
router.get('/reconciliation/exceptions', finance, wrap(async (req, res) => send(res, await reconciliationService.list(req.query, req.brandId))));
router.get('/reconciliation/exceptions/:id', finance, wrap(async (req, res) => send(res, await reconciliationService.detail(req.params.id, req.brandId))));

router.post('/reconciliation/scan', recon, wrap(async (req, res) => {
  const result = await reconciliationService.runScan(req.brandId);
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'RECONCILIATION_SCAN_RUN', resourceType: 'reconciliation', resourceId: null, metadata: result.raised, ipAddress: req.ip });
  send(res, result);
}));

router.post('/reconciliation/exceptions/:id/act', recon, wrap(async (req, res) => {
  const { action, note } = req.body ?? {};
  const result = await reconciliationService.act({ id: req.params.id, action, note, staffId: req.staff.id, brandId: req.brandId });
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: `RECONCILIATION_${action}`, resourceType: 'reconciliation_exception', resourceId: req.params.id, metadata: { action }, ipAddress: req.ip });
  send(res, result);
}));

router.post('/reconciliation/settlement-import', recon, wrap(async (req, res) => {
  const { providerCode, kind, fileName, csvText } = req.body ?? {};
  const result = await reconciliationService.importSettlement({ providerCode, kind, fileName, csvText, staffId: req.staff.id, brandId: req.brandId });
  await audit.log({ staffUserId: req.staff.id, actorEmail: req.staff.email, action: 'RECONCILIATION_SETTLEMENT_IMPORTED', resourceType: 'provider_settlement_import', resourceId: result.importId, metadata: { provider: providerCode, kind, rowCount: result.rowCount, exceptionCount: result.exceptionCount, deduped: result.deduped }, ipAddress: req.ip });
  send(res, result);
}));

export default router;
