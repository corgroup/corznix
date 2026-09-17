import { useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useAuth } from '../auth/useAuth.js';

const RANGES = ['today', 'yesterday', 'last_7_days', 'last_30_days', 'month_to_date'];
const inr = (minor) => `₹${(Number(minor || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const pct = (r) => (r == null ? 'N/A' : `${(r * 100).toFixed(1)}%`);

// Report name → { title, needs: permission, kpis: [{label, get}], table?: {columns, rows} }
const SECTIONS = {
  overview: { title: 'Overview', perm: 'reports.read' },
  sales: { title: 'Sales', perm: 'reports.read' },
  orders: { title: 'Orders', perm: 'reports.read', export: 'orders' },
  products: { title: 'Products', perm: 'reports.read' },
  returns: { title: 'Returns & Exchanges', perm: 'reports.read' },
  customers: { title: 'Customers', perm: 'reports.read' },
  logistics: { title: 'Logistics', perm: 'reports.read' },
  payments: { title: 'Payments & Refunds', perm: 'finance.read', export: 'refunds' },
  cod: { title: 'COD', perm: 'finance.read' },
  'store-credit': { title: 'Store Credit', perm: 'finance.read' },
  'credit-notes': { title: 'Credit Notes', perm: 'finance.read' },
  marketing: { title: 'Promotions & Comms', perm: 'reports.read' },
};

function KpiCard({ label, value, sub }) {
  return (
    <div className="stat-card stat-card--neutral">
      <p className="stat-card__label">{label}</p>
      <p className="stat-card__value">{value}</p>
      {sub && <p className="stat-card__meta">{sub}</p>}
    </div>
  );
}

function renderKpis(section, d) {
  if (!d) return null;
  const k = d.kpis || d.summary || {};
  const rows = [];
  const push = (label, value, sub) => rows.push(<KpiCard key={label} label={label} value={value} sub={sub} />);
  if (section === 'overview') {
    push('Orders', k.orders, `AOV ${inr(k.aovMinor)}`);
    push('Gross order value', inr(k.grossOrderValueMinor));
    push('Discounts', `- ${inr(k.discountMinor)}`);
    push('Net order value', inr(k.netOrderValueMinor));
    push('Captured revenue', inr(k.capturedRevenueMinor));
    push('Net captured', inr(k.netCapturedMinor), 'captured − refunds');
    push('Units sold', k.unitsSold);
    push('Returns', k.returnRequests);
    push('Refunded', inr(k.refundedMinor));
    push('Store credit liability', inr(k.storeCreditLiabilityMinor));
    push('COD outstanding', inr(k.codOutstandingMinor));
    push('Low-stock SKUs', k.lowStockSkus);
  } else if (section === 'sales') {
    push('Orders', k.orders, `AOV ${inr(k.aovMinor)}`);
    push('Gross', inr(k.grossMinor)); push('Discount', `- ${inr(k.discountMinor)}`);
    push('Shipping', inr(k.shippingMinor)); push('Net', inr(k.netMinor));
    push('Captured revenue', inr(k.capturedRevenueMinor));
  } else if (section === 'returns') {
    const r = d.returns || {};
    push('Requests', r.requests); push('Completed', r.completed); push('Rejected', r.rejected);
    push('QC pass / fail', `${r.qcPass} / ${r.qcFail}`);
    push('Returned units', r.returnedUnits, `rate ${pct(r.returnRate)}`);
    push('Return value', inr(r.returnValueMinor));
    push('Reserved exchange credit', inr(d.reservedExchangeCredit?.reservedMinor), 'separate from store credit');
  } else if (section === 'customers') {
    push('New customers', d.newCustomers); push('Returning', d.returningCustomers);
    push('Total customers', d.totalCustomers); push('Repeat rate', pct(d.repeatRate));
  } else if (section === 'payments') {
    const p = d.payments || {};
    push('Succeeded', `${p.succeeded?.n ?? 0} · ${inr(p.succeeded?.amount)}`);
    push('Failed', p.failed?.n ?? 0);
    push('Unknown / stuck', p.unknown?.n ?? 0, 'reconciliation exception');
    const rf = d.refunds || {};
    push('Refunds succeeded', `${rf.succeeded?.n ?? 0} · ${inr(rf.succeeded?.amount)}`);
    push('Refunds unknown', rf.unknown?.n ?? 0);
  } else if (section === 'cod') {
    push('COD due', inr(d.codDueMinor)); push('COD collected', inr(d.codCollectedMinor));
    push('COD outstanding', inr(d.codOutstandingMinor));
    push('Split-COD invariant', d.splitCodInvariant?.status);
  } else if (section === 'store-credit') {
    const l = d.liability || {};
    push('Outstanding liability', inr(l.outstandingLiabilityMinor));
    push('Granted', inr(l.grantedMinor)); push('Consumed / expired', inr(l.consumedExpiredMinor));
    push('Ledger reconciliation', d.ledgerReconciliation?.status);
    push('Reserved exchange credit', inr(d.reservedExchangeCredit?.reservedMinor), 'separate');
  } else if (section === 'logistics') {
    push('RTO rate', pct(d.rto?.rate), `${d.rto?.count ?? 0} of ${d.rto?.forwardTerminal ?? 0}`);
  }
  return rows;
}

export function ReportsPage() {
  const { hasPermission } = useAuth();
  const [section, setSection] = useState('overview');
  const [range, setRange] = useState('last_30_days');
  const spec = SECTIONS[section];
  const params = ['store-credit'].includes(section) ? {} : { range };
  const { status, data, error, reload } = useApiResource(() => adminApi.reports.get(section, params));

  const available = Object.entries(SECTIONS).filter(([, s]) => hasPermission(s.perm));

  return (
    <PageShell
      title="Analytics & Reports"
      description="Derived read-only projections over authoritative domains. Reporting reads business truth — it never becomes business truth."
      actions={
        <span style={{ display: 'inline-flex', gap: 8 }}>
          <select className="form-field__input" style={{ maxWidth: 200 }} value={section} onChange={(e) => { setSection(e.target.value); reload(); }}>
            {available.map(([key, s]) => <option key={key} value={key}>{s.title}</option>)}
          </select>
          {section !== 'store-credit' && (
            <select className="form-field__input" style={{ maxWidth: 160 }} value={range} onChange={(e) => { setRange(e.target.value); reload(); }}>
              {RANGES.map((r) => <option key={r} value={r}>{r.replaceAll('_', ' ')}</option>)}
            </select>
          )}
          {spec?.export && hasPermission('reports.export') && (
            <a className="btn btn--secondary" href={adminApi.reports.exportUrl(spec.export, params)}>Export CSV</a>
          )}
        </span>
      }
    >
      {status === 'loading' && <LoadingState label="Loading…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        <>
          {data.period && <p style={{ opacity: 0.65 }}>{data.period.label} · {data.timezone} · {data.freshness}</p>}
          <div className="stat-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))', gap: 12, margin: '12px 0 24px' }}>
            {renderKpis(section, data)}
          </div>

          {section === 'sales' && Array.isArray(data.series) && (
            <div className="table-wrap"><table className="data-table">
              <thead><tr><th>Day</th><th>Orders</th><th>Gross</th><th>Discount</th><th>Net</th></tr></thead>
              <tbody>{data.series.map((s) => <tr key={s.day}><td>{s.day}</td><td>{s.orders}</td><td>{inr(s.grossMinor)}</td><td>-{inr(s.discountMinor)}</td><td>{inr(s.netMinor)}</td></tr>)}
                {data.series.length === 0 && <tr><td colSpan={5} className="data-table__empty">No data for this period.</td></tr>}
              </tbody></table></div>
          )}

          {section === 'orders' && (
            <>
              <p>Status: {(data.statusBreakdown || []).map((s) => `${s.status} ${s.count}`).join(' · ') || 'No data.'}</p>
              <p>Payment mix: {(data.paymentModeBreakdown || []).map((m) => `${m.mode} ${m.count}`).join(' · ')}</p>
              <p>Split-fulfilment orders: {data.splitFulfilmentOrders} <em>(a split order is still ONE order)</em></p>
              <div className="table-wrap"><table className="data-table">
                <thead><tr><th>Order</th><th>Status</th><th>Mode</th><th>Subtotal</th><th>Discount</th><th>Total</th></tr></thead>
                <tbody>{(data.rows || []).map((o) => <tr key={o.id}><td>{o.orderNumber}</td><td>{o.status}</td><td>{o.paymentMode}</td><td>{inr(o.subtotalMinor)}</td><td>-{inr(o.discountMinor)}</td><td>{inr(o.totalMinor)}</td></tr>)}</tbody>
              </table></div>
            </>
          )}

          {section === 'products' && (
            <>
              <InlineAlert tone="info">{data.attributionNote}</InlineAlert>
              <div className="table-wrap"><table className="data-table">
                <thead><tr><th>Product</th><th>Units</th><th>Revenue</th></tr></thead>
                <tbody>{(data.topProducts || []).map((p) => <tr key={p.productId}><td>{p.productName}</td><td>{p.units}</td><td>{inr(p.revenueMinor)}</td></tr>)}</tbody>
              </table></div>
            </>
          )}

          {section === 'logistics' && (
            <div className="table-wrap"><table className="data-table">
              <thead><tr><th>Provider</th><th>Shipments</th><th>Delivered</th><th>RTO</th><th>Delivery rate</th></tr></thead>
              <tbody>{(data.providers || []).map((p) => <tr key={p.provider}><td>{p.provider}</td><td>{p.shipments}</td><td>{p.delivered}</td><td>{p.rto}</td><td>{pct(p.deliveryRate)}</td></tr>)}</tbody>
            </table></div>
          )}

          {['payments', 'cod', 'credit-notes'].includes(section) && (
            <InlineAlert tone="info">
              {section === 'credit-notes' && `FINAL_ACCOUNTING_GST_VALIDATION = ${data.accounting?.FINAL_ACCOUNTING_GST_VALIDATION?.split(' —')[0] || 'NOT_YET'}. `}
              UNKNOWN payment / refund states are shown as reconciliation exceptions — never counted as success or failure.
            </InlineAlert>
          )}
        </>
      )}
    </PageShell>
  );
}

export default ReportsPage;
