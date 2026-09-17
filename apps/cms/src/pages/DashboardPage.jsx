import { useMemo } from 'react';
import { useDashboardData, DASHBOARD_RANGES } from '../features/dashboard/useDashboardData.js';
import {
  formatMoneyCompact,
  formatMoneyFull,
  formatNumber,
  humanize,
  trendFromRatio,
  trendFromValues,
  fillSeriesGaps,
} from '../features/dashboard/dashboardFormat.js';
import { MetricCard } from '../features/dashboard/components/MetricCard.jsx';
import { SectionCard } from '../features/dashboard/components/SectionCard.jsx';
import { AttentionItem } from '../features/dashboard/components/AttentionItem.jsx';
import { ActivityItem } from '../features/dashboard/components/ActivityItem.jsx';
import { SalesChart } from '../features/dashboard/components/SalesChart.jsx';
import { OrdersByStatus } from '../features/dashboard/components/OrdersByStatus.jsx';
import { Skeleton } from '../components/feedback/Skeleton.jsx';
import { EmptyState } from '../components/feedback/EmptyState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import '../features/dashboard/DashboardPage.css';

/* ------------------------------------------------------------------ *
 * Small inline glyphs (stroke-based, inherit colour). Decorative —
 * every one sits next to a real text label.
 * ------------------------------------------------------------------ */
const Glyph = {
  revenue: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15h9a3 3 0 000-6H6M6 9h12M6 12h9" /></svg>,
  orders: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2l1.5 3h9L18 2M4 7h16l-1.3 12a2 2 0 01-2 1.8H7.3a2 2 0 01-2-1.8z" /></svg>,
  aov: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l6-6 4 4 8-8M21 7v5M21 7h-5" /></svg>,
  returns: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14L4 9l5-5M4 9h11a5 5 0 010 10H8" /></svg>,
  stock: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8l-9-5-9 5 9 5zM3 8v8l9 5 9-5V8M12 13v8" /></svg>,
  ship: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7h11v8H3zM14 10h4l3 3v2h-7M6.5 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.5 18a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" /></svg>,
  reviews: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3l2.7 5.5 6 .9-4.3 4.2 1 6-5.4-2.8L6.6 22l1-6L3.3 9.4l6-.9z" /></svg>,
  finance: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18v12H3zM3 10h18M7 15h4" /></svg>,
  tax: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8zM14 3v5h5M9 13h6M9 17h4" /></svg>,
  check: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>,
};

const HEALTH_TONE = { good: 'success', warn: 'warn', bad: 'danger', neutral: 'neutral' };

export function DashboardPage() {
  const { range, setRange, sections, reloadAll } = useDashboardData();

  const overview = sections.overview;
  const sales = sections.sales;
  const ordersRep = sections.orders;
  const products = sections.products;
  const marketing = sections.marketing;
  const shipping = sections.shipping;
  const health = sections.health;

  const rangeLabel = (DASHBOARD_RANGES.find((r) => r.value === range) || {}).label || '';
  const kpiLoading = overview.status === 'loading';
  const kpiUnavailable = overview.status === 'error' || overview.status === 'forbidden';
  const k = overview.data?.kpis || {};
  const cmp = overview.data?.comparison || {};

  const filledSeries = useMemo(() => {
    if (sales.status !== 'ready') return [];
    const p = sales.data?.period || {};
    return fillSeriesGaps(sales.data?.series, p.start, p.end);
  }, [sales.status, sales.data]);
  const seriesHasValue = filledSeries.some((d) => Number(d.netMinor) > 0 || Number(d.orders) > 0);

  /* ---- KPI cards ------------------------------------------------- */
  const shippingComplete = shipping.status === 'ready' && shipping.data
    ? `${formatNumber(shipping.data.complete)} / ${formatNumber(shipping.data.total)}`
    : null;

  const kpis = [
    {
      label: 'Captured revenue',
      icon: Glyph.revenue,
      tone: 'primary',
      value: formatMoneyCompact(k.capturedRevenueMinor),
      subtext: `Net ${formatMoneyCompact(k.netCapturedMinor)} after refunds`,
    },
    {
      label: 'Orders',
      icon: Glyph.orders,
      tone: 'info',
      value: formatNumber(k.orders),
      trend: trendFromRatio(cmp.ordersGrowth),
      trendLabel: 'vs. previous period',
      to: '/orders',
    },
    {
      label: 'Average order value',
      icon: Glyph.aov,
      tone: 'primary',
      value: k.aovMinor == null ? '—' : formatMoneyFull(k.aovMinor),
      subtext: k.aovMinor == null ? 'No orders in period' : 'Net order value ÷ orders',
    },
    {
      label: 'Return requests',
      icon: Glyph.returns,
      tone: 'neutral',
      value: formatNumber(k.returnRequests),
      subtext: `In ${rangeLabel.toLowerCase()}`,
      to: '/returns',
    },
    {
      label: 'Low-stock SKUs',
      icon: Glyph.stock,
      tone: k.lowStockSkus > 0 ? 'warning' : 'success',
      value: formatNumber(k.lowStockSkus),
      subtext: k.lowStockSkus > 0 ? 'Below configured threshold' : 'All SKUs above threshold',
      to: '/warehouses',
    },
    {
      label: 'Shipping profiles',
      icon: Glyph.ship,
      tone: shipping.data?.incomplete ? 'warning' : 'success',
      value: shippingComplete || '—',
      loadingOverride: shipping.status === 'loading',
      unavailableOverride: shipping.status === 'error' || shipping.status === 'forbidden',
      subtext: shipping.data?.incomplete
        ? `${formatNumber(shipping.data.incomplete)} incomplete — blocks fulfillment`
        : 'Every product ready to ship',
      to: '/products',
    },
  ];

  /* ---- Needs attention ----------------------------------------- */
  const statusCount = (statuses) => {
    const bd = ordersRep.data?.statusBreakdown || [];
    return bd.filter((s) => statuses.includes(s.status)).reduce((sum, s) => sum + Number(s.count || 0), 0);
  };
  const attention = [];
  if (ordersRep.status === 'ready') {
    const toConfirm = statusCount(['PLACED']);
    const inFulfilment = statusCount(['CONFIRMED', 'PROCESSING']);
    if (toConfirm > 0) attention.push({ key: 'confirm', icon: Glyph.orders, count: toConfirm, tone: 'warn', label: 'Orders awaiting confirmation', hint: 'Allocate a warehouse, then start processing', to: '/orders' });
    if (inFulfilment > 0) attention.push({ key: 'fulfil', icon: Glyph.ship, count: inFulfilment, tone: 'info', label: 'Orders in fulfillment', hint: 'Confirmed or processing — book shipments', to: '/orders' });
  }
  if (shipping.status === 'ready' && shipping.data?.incomplete > 0) {
    attention.push({ key: 'ship', icon: Glyph.ship, count: shipping.data.incomplete, tone: 'warn', label: 'Products missing shipping data', hint: 'Weight or dimensions incomplete', to: '/products' });
  }
  if (overview.status === 'ready' && k.lowStockSkus > 0) {
    attention.push({ key: 'stock', icon: Glyph.stock, count: k.lowStockSkus, tone: 'warn', label: 'SKUs low on stock', hint: 'Below their low-stock threshold', to: '/warehouses' });
  }
  if (marketing.status === 'ready' && marketing.data?.reviews && typeof marketing.data.reviews === 'object' && marketing.data.reviews.pending > 0) {
    attention.push({ key: 'reviews', icon: Glyph.reviews, count: marketing.data.reviews.pending, tone: 'info', label: 'Reviews pending moderation', hint: 'Awaiting publish or reject', to: '/reviews' });
  }
  const attentionLoading = [ordersRep, shipping, overview, marketing].some((s) => s.status === 'loading');

  /* ---- Recent orders ------------------------------------------- */
  const recentOrders = (ordersRep.data?.rows || []).slice(0, 6);
  const orderGlyph = (status) => (status === 'CANCELLED' ? Glyph.returns : status === 'COMPLETED' ? Glyph.check : Glyph.orders);

  /* ---- Operational health ------------------------------------- */
  const healthRows = [];
  if (health.status === 'ready') {
    const dbOk = health.data?.db === 'connected';
    healthRows.push({ key: 'api', label: 'API & database', tone: dbOk ? 'good' : 'warn', note: dbOk ? 'Responding normally' : 'API up · database not connected' });
  } else if (health.status === 'error') {
    healthRows.push({ key: 'api', label: 'API & database', tone: 'bad', note: 'Health check unreachable' });
  }
  if (shipping.status === 'ready' && shipping.data) {
    healthRows.push({ key: 'ship', label: 'Shipping readiness', tone: shipping.data.incomplete === 0 ? 'good' : 'warn', note: shipping.data.incomplete === 0 ? 'All products ready' : `${formatNumber(shipping.data.incomplete)} incomplete` });
  }
  if (overview.status === 'ready') {
    healthRows.push({ key: 'stock', label: 'Inventory levels', tone: k.lowStockSkus > 0 ? 'warn' : 'good', note: k.lowStockSkus > 0 ? `${formatNumber(k.lowStockSkus)} SKU${k.lowStockSkus === 1 ? '' : 's'} low` : 'All SKUs above threshold' });
  }

  /* ---- supporting sales metrics ------------------------------- */
  const support = [
    { label: 'Gross order value', value: formatMoneyFull(k.grossOrderValueMinor) },
    { label: 'Net order value', value: formatMoneyFull(k.netOrderValueMinor), trend: trendFromValues(k.netOrderValueMinor, cmp.netOrderValuePrevMinor) },
    { label: 'Captured revenue', value: formatMoneyFull(k.capturedRevenueMinor) },
    { label: 'Refunded', value: formatMoneyFull(k.refundedMinor) },
  ];

  return (
    <div className="dashboard">
      <h1 className="sr-only">Dashboard</h1>
      <div className="dashboard__toolbar">
        <label className="dashboard__range">
          <span className="dashboard__range-label">Period</span>
          <select value={range} onChange={(e) => setRange(e.target.value)}>
            {DASHBOARD_RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      </div>

      {kpiUnavailable && (
        <div className="dashboard__notice" role="status">
          <span>
            {overview.status === 'forbidden'
              ? 'Your role does not include reporting access, so store metrics are hidden. Operational panels below still apply.'
              : 'Store metrics could not be loaded.'}
          </span>
          {overview.status === 'error' && (
            <button type="button" className="btn btn--secondary" onClick={reloadAll}>Retry</button>
          )}
        </div>
      )}

      {/* SECTION 1 — KPI cards */}
      <div className="dashboard__kpis">
        {kpis.map((kpi) => (
          <MetricCard
            key={kpi.label}
            label={kpi.label}
            icon={kpi.icon}
            tone={kpi.tone}
            value={kpi.value}
            trend={kpi.trend}
            trendLabel={kpi.trendLabel}
            subtext={kpi.subtext}
            to={kpi.to}
            loading={kpi.loadingOverride ?? kpiLoading}
            unavailable={kpi.unavailableOverride ?? kpiUnavailable}
          />
        ))}
      </div>

      <div className="dashboard__grid">
        {/* SECTION 2 — Sales overview */}
        <SectionCard
          title="Sales overview"
          subtitle={sales.data?.period?.label ? `${sales.data.period.label} · ${sales.data.timezone}` : `Net order value · ${rangeLabel}`}
          className="dashboard__span-2"
          actionTo="/reports"
          actionLabel="Open reports"
        >
          {sales.status === 'loading' && <Skeleton height={240} radius={10} />}
          {sales.status === 'error' && <ErrorState message={sales.error?.message} onRetry={reloadAll} />}
          {sales.status === 'forbidden' && (
            <EmptyState tone="warn" title="Reporting access required" message="Sales analytics need the reports permission." />
          )}
          {sales.status === 'ready' && (
            seriesHasValue ? (
              <>
                <SalesChart series={filledSeries} />
                <dl className="support-metrics">
                  {support.map((s) => (
                    <div key={s.label} className="support-metrics__item">
                      <dt>{s.label}</dt>
                      <dd>
                        {s.value}
                        {s.trend && <span className={`trend trend--${s.trend.direction}`}>{s.trend.text}</span>}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            ) : (
              <EmptyState title="No sales in this period" message={`Nothing was ordered during ${rangeLabel.toLowerCase()}. Try a wider range.`} />
            )
          )}
        </SectionCard>

        {/* SECTION 3 — Needs attention */}
        <SectionCard title="Needs attention" subtitle="Open operational items">
          {attentionLoading && attention.length === 0 && <Skeleton lines={4} height={44} />}
          {!attentionLoading && attention.length === 0 && (
            <EmptyState icon={Glyph.check} title="You're all caught up" message="No orders, stock, review or reconciliation items need action." />
          )}
          {attention.length > 0 && (
            <div className="attention-list">
              {attention.map((a) => (
                <AttentionItem key={a.key} icon={a.icon} count={a.count} label={a.label} hint={a.hint} to={a.to} tone={a.tone} />
              ))}
            </div>
          )}
        </SectionCard>

        {/* SECTION 4 — Recent orders (real order rows; there is no audit-feed API) */}
        <SectionCard title="Recent orders" subtitle="Latest orders placed" actionTo="/orders" actionLabel="All orders">
          {ordersRep.status === 'loading' && <Skeleton lines={5} height={40} />}
          {ordersRep.status === 'error' && <ErrorState message={ordersRep.error?.message} onRetry={reloadAll} />}
          {ordersRep.status === 'forbidden' && (
            <EmptyState tone="warn" title="Reporting access required" />
          )}
          {ordersRep.status === 'ready' && (
            recentOrders.length === 0 ? (
              <EmptyState title="No orders yet" message={`No orders placed during ${rangeLabel.toLowerCase()}.`} />
            ) : (
              <div className="activity-list">
                {recentOrders.map((o) => (
                  <ActivityItem
                    key={o.id}
                    icon={orderGlyph(o.status)}
                    title={`Order ${o.orderNumber}`}
                    meta={`${humanize(o.status)} · ${formatMoneyFull(o.totalMinor)} · ${humanize(o.paymentMode)}`}
                    timestamp={o.placedAt}
                    to={`/orders/${o.id}`}
                  />
                ))}
              </div>
            )
          )}
        </SectionCard>

        {/* SECTION 5 — business / operations detail */}
        <SectionCard title="Top-selling products" subtitle={`By units · ${rangeLabel}`} actionTo="/reports" actionLabel="Full report">
          {products.status === 'loading' && <Skeleton lines={5} height={34} />}
          {products.status === 'error' && <ErrorState message={products.error?.message} onRetry={reloadAll} />}
          {products.status === 'forbidden' && <EmptyState tone="warn" title="Reporting access required" />}
          {products.status === 'ready' && (
            (products.data?.topProducts || []).length === 0 ? (
              <EmptyState title="No product sales" message={`Nothing sold during ${rangeLabel.toLowerCase()}.`} />
            ) : (
              <ol className="rank-list">
                {products.data.topProducts.slice(0, 5).map((p, i) => (
                  <li key={p.productId}>
                    <span className="rank-list__pos" aria-hidden="true">{i + 1}</span>
                    <span className="rank-list__thumb" aria-hidden="true">
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M6 3l1.5 3h9L18 3M4 7h16l-1.2 12a2 2 0 01-2 1.8H7.2a2 2 0 01-2-1.8z" />
                      </svg>
                    </span>
                    <span className="rank-list__name">{p.productName}</span>
                    <span className="rank-list__units">{formatNumber(p.units)} units</span>
                    <span className="rank-list__value">{formatMoneyFull(p.revenueMinor)}</span>
                  </li>
                ))}
              </ol>
            )
          )}
        </SectionCard>

        <SectionCard title="Orders by status" subtitle={rangeLabel} actionTo="/orders" actionLabel="Manage">
          {ordersRep.status === 'loading' && <Skeleton lines={3} height={30} />}
          {ordersRep.status === 'error' && <ErrorState message={ordersRep.error?.message} onRetry={reloadAll} />}
          {ordersRep.status === 'forbidden' && <EmptyState tone="warn" title="Reporting access required" />}
          {ordersRep.status === 'ready' && (
            (ordersRep.data?.statusBreakdown || []).length === 0
              ? <EmptyState title="No orders in this period" />
              : <OrdersByStatus breakdown={ordersRep.data.statusBreakdown} />
          )}
        </SectionCard>

        <SectionCard title="Operational health" subtitle="Live system checks and key readiness indicators">
          {healthRows.length === 0 && health.status === 'loading' && <Skeleton lines={4} height={30} />}
          {healthRows.length === 0 && health.status !== 'loading' && (
            <EmptyState title="No checks available" message="Health signals need reporting or catalog access." />
          )}
          {healthRows.length > 0 && (
            <ul className="health-list">
              {healthRows.map((row) => (
                <li key={row.key}>
                  <span className={`health-dot health-dot--${HEALTH_TONE[row.tone] || 'neutral'}`} aria-hidden="true" />
                  <span className="health-list__label">{row.label}</span>
                  <span className="health-list__note">{row.note}</span>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>

      <p className="dashboard__foot">
        Metrics reflect the selected period in Asia/Kolkata and read live from authoritative domains.
        {overview.data?.generatedAt && ` Refreshed ${new Date(overview.data.generatedAt).toLocaleTimeString('en-IN')}.`}
        {' '}
        <button type="button" className="linkish" onClick={reloadAll}>Refresh now</button>
      </p>
    </div>
  );
}

export default DashboardPage;
