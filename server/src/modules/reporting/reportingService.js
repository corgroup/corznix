import { reportingRepository as R } from './reportingRepository.js';
import { resolvePeriod } from './reportTime.js';
import { METRIC_DEFINITIONS, SOURCE_OF_TRUTH_MAP, REPORT_TIMEZONE } from './metricDefinitions.js';
import { ratio, parsePagination, parseSort } from './guards.js';
import { SORTABLE } from './metricDefinitions.js';

const n = (v) => Number(v || 0);

// Wave 8H reporting orchestration. Direct queries → near-real-time; the
// response always carries the resolved period + timezone + freshness so a
// caller never mistakes a projection for live truth.
//
// Multi-company: every method takes the caller's brandId (req.brandId) and
// folds it into the period object handed to the repository, so a report is
// always one company's numbers. The repository throws BRAND_REQUIRED rather
// than silently aggregating if a caller ever forgets it.
export class ReportingService {
  meta() {
    return { metricDefinitions: METRIC_DEFINITIONS, sourceOfTruth: SOURCE_OF_TRUTH_MAP, timezone: REPORT_TIMEZONE };
  }

  #envelope(period, extra) {
    return { period: { range: period.range, start: period.start, end: period.end, label: period.label }, timezone: period.timezone, freshness: 'live', generatedAt: new Date(), ...extra };
  }

  async overview(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [sales, captured, prevSales, returns, refunds, sc, cod, lowStock] = await Promise.all([
      R.salesSummary(period), R.capturedRevenue(period), R.salesSummary({ ...period.previous, brandId }),
      R.returnsSummary(period), R.refundSummary(period), R.storeCreditLiability(brandId),
      R.codSummary(period), R.lowStock({ warehouseIds: [], threshold: null, brandId }),
    ]);
    const refundedSucceeded = refunds.filter((r) => r.status === 'SUCCEEDED').reduce((s, r) => s + n(r.amount_minor), 0);
    return this.#envelope(period, {
      kpis: {
        orders: n(sales.orders),
        grossOrderValueMinor: n(sales.gross_minor),
        discountMinor: n(sales.discount_minor),
        netOrderValueMinor: n(sales.net_minor),
        capturedRevenueMinor: n(captured.captured_minor),
        netCapturedMinor: n(captured.captured_minor) - refundedSucceeded,
        unitsSold: n(sales.units),
        aovMinor: sales.orders > 0 ? Math.round(n(sales.net_minor) / n(sales.orders)) : null,
        returnRequests: n(returns.requests),
        refundedMinor: refundedSucceeded,
        storeCreditLiabilityMinor: n(sc.ledger_liability_minor),
        codOutstandingMinor: n(cod.cod_due_minor) - n(cod.cod_collected_minor),
        lowStockSkus: lowStock.length,
      },
      comparison: {
        ordersPrev: n(prevSales.orders),
        netOrderValuePrevMinor: n(prevSales.net_minor),
        ordersGrowth: ratio(n(sales.orders) - n(prevSales.orders), n(prevSales.orders)),
      },
    });
  }

  async sales(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [summary, series, captured] = await Promise.all([R.salesSummary(period), R.salesTimeSeries(period), R.capturedRevenue(period)]);
    return this.#envelope(period, {
      summary: {
        orders: n(summary.orders), grossMinor: n(summary.gross_minor), discountMinor: n(summary.discount_minor),
        shippingMinor: n(summary.shipping_minor), netMinor: n(summary.net_minor),
        capturedRevenueMinor: n(captured.captured_minor),
        aovMinor: summary.orders > 0 ? Math.round(n(summary.net_minor) / n(summary.orders)) : null,
      },
      series: series.map((d) => ({ day: d.day, orders: n(d.orders), grossMinor: n(d.gross_minor), discountMinor: n(d.discount_minor), netMinor: n(d.net_minor) })),
    });
  }

  async orders(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const { offset, pageSize, page } = parsePagination(q);
    const sort = parseSort(q, SORTABLE.orders, 'placed_at');
    const [statusB, modeB, split, rows, total] = await Promise.all([
      R.orderStatusBreakdown(period), R.paymentModeBreakdown(period), R.splitFulfilmentCount(period),
      R.ordersDetail({ ...period, sort, offset, limit: pageSize }), R.ordersCount(period),
    ]);
    return this.#envelope(period, {
      statusBreakdown: statusB.map((s) => ({ status: s.status, count: n(s.n), valueMinor: n(s.value_minor) })),
      paymentModeBreakdown: modeB.map((m) => ({ mode: m.mode, count: n(m.n), onlineMinor: n(m.online_minor), codMinor: n(m.cod_minor) })),
      splitFulfilmentOrders: split,
      pagination: { page, pageSize, total },
      rows: rows.map((o) => ({ id: o.id, orderNumber: o.order_number, status: o.order_status, paymentStatus: o.payment_status, paymentMode: o.payment_mode, subtotalMinor: n(o.subtotal_minor), discountMinor: n(o.discount_minor), totalMinor: n(o.total_minor), placedAt: o.placed_at })),
    });
  }

  async products(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [products, skus, categories] = await Promise.all([R.topProducts(period), R.topSkus(period), R.categoryPerformanceCurrent(period)]);
    return this.#envelope(period, {
      attributionNote: 'Product/SKU rows use the immutable order-item snapshot. Category rollup uses CURRENT product classification (labelled) — orders do not snapshot category (§49).',
      topProducts: products.map((p) => ({ productId: p.product_id, productName: p.product_name, units: n(p.units), revenueMinor: n(p.revenue_minor) })),
      topSkus: skus.map((s) => ({ skuId: s.sku_id, sku: s.sku, productName: s.product_name, units: n(s.units), revenueMinor: n(s.revenue_minor) })),
      categoryCurrent: categories.map((c) => ({ categoryId: c.category_id, categoryName: c.category_name || '(uncategorised)', units: n(c.units), revenueMinor: n(c.revenue_minor) })),
    });
  }

  async returns(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [summary, units, reasons, deliveredUnits, exch, rec] = await Promise.all([
      R.returnsSummary(period), R.returnUnits(period), R.reasonBreakdown(period),
      R.deliveredUnits(period), R.exchangeSummary(period), R.reservedExchangeCredit(brandId),
    ]);
    return this.#envelope(period, {
      returns: {
        requests: n(summary.requests), approved: n(summary.approved), rejected: n(summary.rejected),
        cancelled: n(summary.cancelled), completed: n(summary.completed),
        qcPass: n(summary.qc_pass), qcFail: n(summary.qc_fail),
        typeReturn: n(summary.type_return), typeReplacement: n(summary.type_replacement),
        typeSameStyleExchange: n(summary.type_same_style_exchange), typeDifferentStyleExchange: n(summary.type_different_style_exchange),
        returnedUnits: n(units.returned_units), returnValueMinor: n(units.return_value_minor),
        returnRate: ratio(n(units.returned_units), deliveredUnits),
      },
      reasons: reasons.map((r) => ({ reason: r.reason, count: n(r.n) })),
      financialClassification: {
        note: 'refund / store-credit resolution / replacement / exchange are reported as distinct resolutions — never all labelled "refund" (§44).',
      },
      exchanges: {
        transactions: n(exch.transactions), eligibleValueMinor: n(exch.eligible_value_minor),
        reserved: n(exch.reserved), consumed: n(exch.consumed), cancelled: n(exch.cancelled), expired: n(exch.expired),
      },
      reservedExchangeCredit: {
        note: 'kept OUT of spendable store-credit liability (§75)',
        reservedMinor: n(rec.reserved_minor), consumedMinor: n(rec.consumed_minor),
        cancelledMinor: n(rec.cancelled_minor), expiredMinor: n(rec.expired_minor),
      },
    });
  }

  async customers(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [summary, repeat] = await Promise.all([R.customerSummary(period), R.repeatRate(brandId)]);
    return this.#envelope(period, {
      rule: "new = customer's first paid order falls in period; returning = a later paid order (§46).",
      newCustomers: n(summary.new_customers),
      returningCustomers: n(summary.returning_customers),
      totalCustomers: n(summary.total_customers),
      repeatRate: ratio(n(repeat.repeat_customers), n(repeat.customers_with_orders)),
    });
  }

  async inventory(q, scope, brandId) {
    const warehouseIds = scope?.all ? [] : (scope?.warehouseIds || []);
    const threshold = q.threshold != null && q.threshold !== '' ? Math.max(0, Math.floor(Number(q.threshold))) : null;
    const [byWarehouse, low] = await Promise.all([
      R.inventoryByWarehouse({ warehouseIds, brandId }), R.lowStock({ warehouseIds, threshold, brandId }),
    ]);
    return {
      timezone: REPORT_TIMEZONE, freshness: 'live', generatedAt: new Date(),
      scope: scope?.all ? 'ALL_WAREHOUSES' : 'SCOPED',
      lowStockPolicy: threshold != null ? `report parameter threshold=${threshold}` : 'per-SKU inventory.low_stock_threshold (POLICY_NOT_CONFIGURED where NULL)',
      byWarehouse: byWarehouse.map((w) => ({ warehouseId: w.warehouse_id, code: w.warehouse_code, name: w.warehouse_name, skuLines: n(w.sku_lines), onHand: n(w.on_hand), reserved: n(w.reserved), available: n(w.available) })),
      lowStock: low.map((l) => ({ warehouseCode: l.warehouse_code, sku: l.sku, onHand: n(l.on_hand), reserved: n(l.reserved), available: n(l.available), threshold: l.low_stock_threshold })),
      inventoryAging: 'DEFERRED_DATA_MODEL_REQUIRED — no receipt-lot history (§57)',
    };
  }

  async warehouses(q, scope, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const warehouseIds = scope?.all ? [] : (scope?.warehouseIds || []);
    const [ops, stock] = await Promise.all([R.warehouseOps({ ...period, warehouseIds }), R.inventoryByWarehouse({ warehouseIds, brandId })]);
    const byId = Object.fromEntries(stock.map((s) => [s.warehouse_id, s]));
    return this.#envelope(period, {
      scope: scope?.all ? 'ALL_WAREHOUSES' : 'SCOPED',
      warehouses: ops.map((w) => ({
        warehouseId: w.warehouse_id, code: w.warehouse_code,
        onHand: n(byId[w.warehouse_id]?.on_hand), reserved: n(byId[w.warehouse_id]?.reserved), available: n(byId[w.warehouse_id]?.available),
        fulfillments: n(w.fulfillments), shipments: n(w.shipments), returnsReceived: n(w.returns_received),
      })),
    });
  }

  async logistics(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [fwd, rev, provider, rto] = await Promise.all([
      R.forwardShipments(period), R.reverseShipments(period), R.providerBreakdown(period), R.rtoSummary(period),
    ]);
    return this.#envelope(period, {
      forward: fwd.map((s) => ({ status: s.status, count: n(s.n), avgDeliveryHours: s.avg_delivery_hours == null ? null : Math.round(n(s.avg_delivery_hours)) })),
      reverse: rev.map((s) => ({ status: s.status, count: n(s.n) })),
      providers: provider.map((p) => ({ provider: p.provider_code, shipments: n(p.shipments), delivered: n(p.delivered), rto: n(p.rto), deliveryRate: ratio(n(p.delivered), n(p.shipments)) })),
      rto: { count: n(rto.rto_count), forwardTerminal: n(rto.forward_terminal), rate: ratio(n(rto.rto_count), n(rto.forward_terminal)) },
      note: 'forward and reverse shipments are reported separately; only normalized statuses (§60/§61).',
    });
  }

  async payments(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [summary, failures, refunds] = await Promise.all([R.paymentSummary(period), R.paymentFailureCategories(period), R.refundSummary(period)]);
    const agg = (rows, statuses) => rows.filter((r) => statuses.includes(r.status)).reduce((a, r) => ({ n: a.n + n(r.n), amount: a.amount + n(r.amount_minor) }), { n: 0, amount: 0 });
    return this.#envelope(period, {
      payments: {
        succeeded: agg(summary, ['SUCCEEDED', 'AUTHORIZED']), failed: agg(summary, ['FAILED', 'CANCELLED', 'EXPIRED']),
        // The domain has no terminal "UNKNOWN" payment status — a stuck
        // PENDING/CREATED attempt is the reconciliation-exception case (§70/§129).
        unknown: agg(summary, ['PENDING', 'CREATED', 'UNKNOWN']),
        byProvider: summary.map((s) => ({ status: s.status, provider: s.provider_code, count: n(s.n), amountMinor: n(s.amount_minor) })),
      },
      failureCategories: failures.map((f) => ({ code: f.failure_code, count: n(f.n) })),
      refunds: {
        succeeded: agg(refunds, ['SUCCEEDED']), failed: agg(refunds, ['FAILED']),
        processing: agg(refunds, ['PROCESSING','PENDING']), unknown: agg(refunds, ['UNKNOWN']),
        note: 'UNKNOWN is a reconciliation exception — never folded into succeeded/failed (§70).',
      },
    });
  }

  async cod(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [summary, mismatches] = await Promise.all([R.codSummary(period), R.codSplitMismatches(brandId)]);
    return this.#envelope(period, {
      codDueMinor: n(summary.cod_due_minor),
      codCollectedMinor: n(summary.cod_collected_minor),
      codOutstandingMinor: n(summary.cod_due_minor) - n(summary.cod_collected_minor),
      partialCod: { orders: n(summary.partial_cod_orders), prepaidComponentMinor: n(summary.prepaid_component_minor), note: 'online + COD components reported separately (§73).' },
      splitCodInvariant: {
        status: mismatches.length === 0 ? 'PASS' : 'MISMATCH',
        mismatches: mismatches.map((m) => ({ orderNumber: m.order_number, codDueMinor: n(m.cod_due_minor), allocatedMinor: n(m.allocated_minor) })),
      },
      externalReconciliation: 'SOURCE_NOT_AVAILABLE — no carrier remittance feed integrated (§87). CSV import seam ready.',
    });
  }

  async storeCredit(brandId) {
    const [liability, drift, exch] = await Promise.all([R.storeCreditLiability(brandId), R.storeCreditLedgerDrift(brandId), R.reservedExchangeCredit(brandId)]);
    return {
      timezone: REPORT_TIMEZONE, freshness: 'live', generatedAt: new Date(),
      liability: {
        grantedMinor: n(liability.granted_minor),
        consumedExpiredMinor: n(liability.consumed_expired_minor),
        expiredMinor: n(liability.expired_minor),
        reversalMinor: n(liability.reversal_minor),
        outstandingLiabilityMinor: n(liability.ledger_liability_minor),
        accountsBalanceMinor: n(liability.accounts_balance_minor),
      },
      ledgerReconciliation: {
        status: drift.length === 0 && n(liability.ledger_liability_minor) === n(liability.accounts_balance_minor) ? 'PASS' : 'DRIFT',
        driftedAccounts: drift.map((d) => ({ accountId: d.account_id, balanceMinor: n(d.balance_minor), ledgerSumMinor: n(d.ledger_sum), lastBalanceAfterMinor: n(d.last_balance_after) })),
      },
      reservedExchangeCredit: { note: 'reported separately — NOT part of spendable liability (§75)', reservedMinor: n(exch.reserved_minor), consumedMinor: n(exch.consumed_minor) },
    };
  }

  async creditNotes(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [summary, dupes] = await Promise.all([R.creditNoteSummary(period), R.creditNoteDuplicates(brandId)]);
    return this.#envelope(period, {
      byStatus: summary.map((s) => ({ status: s.status, type: s.credit_note_type, count: n(s.n), amountMinor: n(s.amount_minor) })),
      duplicateReturnLinkage: dupes.map((d) => ({ returnRequestId: d.return_request_id, count: n(d.n) })),
      accounting: {
        FINAL_ACCOUNTING_GST_VALIDATION: 'NOT_YET — credit-note rows existing does not imply GST reconciliation compliance (§77).',
        PRODUCT_HSN_GST_CONFIGURATION: 'preserved as-is — no HSN/GST mappings fabricated for reports (§78).',
        ACCOUNTING_REVIEW_REQUIRED: 'YES',
      },
    });
  }

  async marketing(q, brandId) {
    const period = { ...resolvePeriod(q), brandId };
    const [reviews, promos, comms] = await Promise.all([
      R.reviewSummary(period).catch(() => null),
      R.promotionSummary(period).catch(() => null),
      R.communicationSummary(period).catch(() => null),
    ]);
    return this.#envelope(period, {
      reviews: reviews ? { pending: n(reviews.pending), published: n(reviews.published), rejected: n(reviews.rejected), total: n(reviews.total), avgPublishedRating: reviews.avg_published_rating } : 'SOURCE_NOT_AVAILABLE',
      promotions: promos ? promos.map((p) => ({ name: p.name, type: p.discount_type, redemptions: n(p.redemptions), discountMinor: n(p.discount_minor) })) : 'SOURCE_NOT_AVAILABLE',
      communications: comms ? comms.map((c) => ({ classification: c.classification, status: c.status, count: n(c.n) })) : 'SOURCE_NOT_AVAILABLE',
    });
  }
}

export const reportingService = new ReportingService();
