import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Select } from '../components/ui/Select.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { StatStrip } from '../components/ui/StatStrip.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { formatDateTime } from '../utils/format.js';

const TYPE_OPTIONS = [
  ['RETURN', 'Return'], ['REPLACEMENT', 'Replacement'],
  ['SAME_STYLE_EXCHANGE', 'Same-style exchange'], ['DIFFERENT_STYLE_EXCHANGE', 'Different-style exchange'],
];
const TABS = [
  ['', 'All'], ['RETURN', 'Returns'],
  ['EXCHANGE', 'Exchanges'], ['REPLACEMENT', 'Replacement'],
];
const PENDING_STATUSES = new Set(['REQUESTED', 'RECEIVED', 'RESOLUTION_PENDING', 'MANUAL_RETURN_LOGISTICS_REQUIRED']);
const label = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/\b\w/, (c) => c.toUpperCase());
const statusTone = (s) => (['REJECTED', 'CANCELLED', 'EXPIRED'].includes(s) ? 'muted'
  : ['QC_FAILED', 'MANUAL_RETURN_LOGISTICS_REQUIRED', 'RESOLUTION_PENDING'].includes(s) ? 'warn'
    : s === 'COMPLETED' ? 'good' : 'warn');

export function ReturnsPage() {
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState(null);
  const [statusFilter, setStatusFilter] = useState(null);
  const [scope, setScope] = useState(''); // '' | 'qc' | 'resolution'
  const [tab, setTab] = useState('');

  const serverFilters = {
    ...(typeFilter ? { requestType: typeFilter } : {}),
    ...(scope === 'qc' ? { qcPending: true } : scope === 'resolution' ? { resolutionPending: true } : {}),
  };
  const { status, data, error, reload } = useApiResource(() => adminApi.returns.list(serverFilters));
  const all = useMemo(() => data?.returns ?? [], [data]);

  const isExchange = (t) => t === 'SAME_STYLE_EXCHANGE' || t === 'DIFFERENT_STYLE_EXCHANGE';

  const tabbed = useMemo(() => {
    if (tab === 'RETURN') return all.filter((r) => r.requestType === 'RETURN');
    if (tab === 'REPLACEMENT') return all.filter((r) => r.requestType === 'REPLACEMENT');
    if (tab === 'EXCHANGE') return all.filter((r) => isExchange(r.requestType));
    return all;
  }, [all, tab]);

  const rows = useMemo(() => {
    let list = tabbed;
    const n = q.trim().toLowerCase();
    if (n) list = list.filter((r) => `${r.requestNumber} ${r.orderNumber} ${r.customerName || ''}`.toLowerCase().includes(n));
    if (statusFilter) list = list.filter((r) => r.status === statusFilter);
    return list;
  }, [tabbed, q, statusFilter]);

  const facets = useMemo(() => ({
    total: all.length,
    pending: all.filter((r) => PENDING_STATUSES.has(r.status)).length,
    approved: all.filter((r) => r.status === 'APPROVED').length,
    rejected: all.filter((r) => r.status === 'REJECTED').length,
    refundsPending: all.filter((r) => r.refundStatus && !['SUCCEEDED', 'COMPLETED'].includes(r.refundStatus)).length,
    exchanges: all.filter((r) => isExchange(r.requestType)).length,
  }), [all]);

  const tabCounts = useMemo(() => ({
    '': all.length,
    RETURN: all.filter((r) => r.requestType === 'RETURN').length,
    EXCHANGE: all.filter((r) => isExchange(r.requestType)).length,
    REPLACEMENT: all.filter((r) => r.requestType === 'REPLACEMENT').length,
  }), [all]);

  const statusOptions = useMemo(
    () => [...new Set(all.map((r) => r.status))].sort().map((s) => [s, label(s)]),
    [all],
  );
  const anyFilter = Boolean(q.trim() || typeFilter || statusFilter || scope || tab);
  const clearAll = () => { setQ(''); setTypeFilter(null); setStatusFilter(null); setScope(''); setTab(''); reload(); };

  return (
    <PageShell
      title="Returns & Exchanges"
      description="Operational inbox for return, replacement and exchange requests. Every lifecycle action is state-driven; money movement is separately gated."
      actions={<a className="btn btn--secondary" href={adminApi.returns.exportUrl(serverFilters)}>Export CSV</a>}
    >
      <StatStrip cards={[
        { label: 'Total requests', value: facets.total, hint: 'All time', tone: 'neutral', active: !anyFilter, onClick: clearAll },
        { label: 'Pending action', value: facets.pending, hint: 'Needs your attention', tone: facets.pending ? 'warn' : 'neutral', active: scope === 'qc', onClick: () => { setScope(scope === 'qc' ? '' : 'qc'); reload(); } },
        { label: 'Approved', value: facets.approved, hint: 'Ready to process', tone: 'good', active: statusFilter === 'APPROVED', onClick: () => setStatusFilter(statusFilter === 'APPROVED' ? null : 'APPROVED') },
        { label: 'Rejected', value: facets.rejected, hint: 'Not eligible', tone: 'neutral', active: statusFilter === 'REJECTED', onClick: () => setStatusFilter(statusFilter === 'REJECTED' ? null : 'REJECTED') },
        { label: 'Refunds pending', value: facets.refundsPending, hint: 'Awaiting payment', tone: facets.refundsPending ? 'warn' : 'neutral' },
        { label: 'Exchanges', value: facets.exchanges, hint: 'In progress', tone: 'neutral', active: tab === 'EXCHANGE', onClick: () => setTab(tab === 'EXCHANGE' ? '' : 'EXCHANGE') },
      ]} min={150} />

      <div className="wb-toolbar">
        <input className="wb-toolbar__search" type="search" placeholder="Search by request #, order #, customer name…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <Select id="ret-type" label="Type" value={typeFilter} onChange={(v) => { setTypeFilter(v); reload(); }}
          options={TYPE_OPTIONS} includeBlank blankLabel="All types" />
        <Select id="ret-status" label="Status" value={statusFilter} onChange={setStatusFilter}
          options={statusOptions} includeBlank blankLabel="All statuses" />
        {anyFilter && <Button variant="ghost" onClick={clearAll}>Clear</Button>}
      </div>

      <div className="returns-tabs" role="tablist">
        {TABS.map(([value, text]) => (
          <button key={value || 'all'} type="button" role="tab" aria-selected={tab === value}
            className={`wb-chip-tab${tab === value ? ' is-active' : ''}`} onClick={() => setTab(value)}>
            {text} <span className="wb-chip-tab__count">{tabCounts[value] ?? 0}</span>
          </button>
        ))}
      </div>

      {status === 'loading' && <LoadingState label="Loading returns…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        all.length === 0 ? (
          <div className="wb-empty">
            <svg className="wb-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7" />
            </svg>
            <p className="wb-empty__title">No return requests yet</p>
            <p className="wb-empty__body">Return, replacement and exchange requests from customers will appear here.</p>
          </div>
        ) : (
          <>
            <p className="wb-count">{rows.length} of {all.length} request{all.length === 1 ? '' : 's'}</p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Request</th><th>Type</th><th>Order</th><th>Customer</th><th>Units</th>
                    <th>Reverse</th><th>Refund</th><th>Status</th><th>Requested</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td><Link to={`/returns/${r.id}`}>{r.requestNumber}</Link></td>
                      <td>{label(r.requestType)}</td>
                      <td><Link to={`/orders`} onClick={(e) => e.stopPropagation()}>{r.orderNumber}</Link></td>
                      <td>{r.customerName || <span className="text-faint">—</span>}</td>
                      <td>{r.unitCount}</td>
                      <td className="text-faint">{r.reverseStatus ? label(r.reverseStatus) : '—'}</td>
                      <td className="text-faint">{r.refundStatus ? `${r.refundMethod} · ${label(r.refundStatus)}` : '—'}</td>
                      <td><Badge tone={statusTone(r.status)}>{label(r.status)}</Badge></td>
                      <td>{formatDateTime(r.requestedAt)}</td>
                    </tr>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={9} className="data-table__empty">No requests match.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      <div className="wb-about">
        <svg className="wb-about__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" strokeLinecap="round" /></svg>
        <span><strong>Important</strong>Values are indicative. Final GST / accounting treatment of any credit note requires accountant review.</span>
      </div>
    </PageShell>
  );
}

export default ReturnsPage;
