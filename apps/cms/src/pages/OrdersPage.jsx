import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Select } from '../components/ui/Select.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { RowMenu } from '../components/ui/RowMenu.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useAuth } from '../auth/useAuth.js';
import { normalizeApiError } from '../utils/errors.js';
import { formatMoney, formatDateTime } from '../utils/format.js';
import './OrdersPage.css';

// Task-first Orders workbench.
//
// Three questions, answerable without opening anything: how many orders need
// action, which ones, and what the next action is for each. The workflow tabs
// answer the first two; the per-row action button answers the third.
//
// The row's action label comes from the BACKEND (`nextOperatorLabel`) — the
// same authority the order detail page uses. This file contains no transition
// logic of its own.

const WORKFLOW_TABS = [
  ['ALL', 'All'],
  ['NEEDS_ACTION', 'Needs action'],
  ['PREPARING', 'Preparing'],
  ['READY_TO_SHIP', 'Ready to ship'],
  ['READY_FOR_PICKUP', 'Ready for pickup'],
  ['IN_TRANSIT', 'In transit'],
  ['OUT_FOR_DELIVERY', 'Out for delivery'],
  ['DELIVERED', 'Delivered'],
  ['CANCELLED', 'Cancelled'],
  ['RETURNS', 'Returns'],
];

const PAYMENT_OPTIONS = [['PAID', 'Paid'], ['PARTIALLY_PAID', 'Partially paid'], ['COD_DUE', 'COD due']];
const PAGE_SIZE = 25;

const STAGE_TONE = {
  Placed: 'warn',
  Confirmed: 'info',
  Preparing: 'info',
  'Ready to ship': 'good',
  'Ready for pickup': 'good',
  'In transit': 'info',
  'Out for delivery': 'info',
  Delivered: 'good',
  Cancelled: 'muted',
  'Owner delivery': 'muted',
  'Returning to origin': 'warn',
};

const PAYMENT_LABEL = {
  PREPAID: 'Prepaid', FULL_COD: 'Full COD', PARTIAL_COD: 'Partial COD',
  PAID: 'Paid', PARTIALLY_PAID: 'Partially paid', COD_DUE: 'COD due',
};

// The row button for an order the operator cannot act on yet — it should still
// take them somewhere useful rather than being absent.
const PASSIVE_LABEL = {
  'Ready for pickup': 'View shipment',
  'In transit': 'Track',
  'Out for delivery': 'Track',
  Delivered: 'View order',
};

// One control instead of two date inputs.
const DATE_PRESETS = [
  ['today', 'Today'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['90d', 'Last 90 days'],
];

function localDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function presetRange(key) {
  if (key === 'today') return { placedFrom: localDay(0), placedTo: localDay(0) };
  if (key === '7d') return { placedFrom: localDay(6), placedTo: localDay(0) };
  if (key === '30d') return { placedFrom: localDay(29), placedTo: localDay(0) };
  if (key === '90d') return { placedFrom: localDay(89), placedTo: localDay(0) };
  return { placedFrom: null, placedTo: null };
}

function DateRange({ from, to, onChange }) {
  const [open, setOpen] = useState(false);
  const label = from || to
    ? `${from || '…'} → ${to || '…'}`
    : 'Any date';
  return (
    <div className="ord-daterange">
      <button type="button" className="ord-daterange__button" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="ord-daterange__icon" aria-hidden="true">▤</span>
        {label}
      </button>
      {open && (
        <div className="ord-daterange__pop">
          <div className="ord-daterange__presets">
            {DATE_PRESETS.map(([k, l]) => (
              <button key={k} type="button" onClick={() => { onChange(presetRange(k)); setOpen(false); }}>{l}</button>
            ))}
          </div>
          <div className="ord-daterange__custom">
            <label className="form-field">
              <span>From</span>
              <input type="date" value={from || ''} max={to || undefined}
                onChange={(e) => onChange({ placedFrom: e.target.value || null, placedTo: to || null })} />
            </label>
            <label className="form-field">
              <span>To</span>
              <input type="date" value={to || ''} min={from || undefined}
                onChange={(e) => onChange({ placedFrom: from || null, placedTo: e.target.value || null })} />
            </label>
          </div>
          <button type="button" className="ord-daterange__clear"
            onClick={() => { onChange({ placedFrom: null, placedTo: null }); setOpen(false); }}>
            Clear dates
          </button>
        </div>
      )}
    </div>
  );
}

function SearchBox({ initial, onSubmit }) {
  const [value, setValue] = useState(initial);
  return (
    <form className="ord-search" onSubmit={(e) => { e.preventDefault(); onSubmit(value.trim() || null); }}>
      <span className="ord-search__icon" aria-hidden="true">⌕</span>
      <input type="search" placeholder="Order ID, customer, email or phone…"
        value={value} onChange={(e) => setValue(e.target.value)} />
    </form>
  );
}

export function OrdersPage() {
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  const canFinance = hasPermission('finance.read');
  const [searchParams, setSearchParams] = useSearchParams();

  const query = useMemo(() => ({
    q: searchParams.get('q') || '',
    workflow: searchParams.get('workflow') || 'ALL',
    paymentStatus: searchParams.get('paymentStatus') || null,
    placedFrom: searchParams.get('placedFrom') || '',
    placedTo: searchParams.get('placedTo') || '',
    page: Number(searchParams.get('page') || 1),
  }), [searchParams]);

  const anyFilter = Boolean(query.q || query.workflow !== 'ALL' || query.paymentStatus || query.placedFrom || query.placedTo);

  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [facets, setFacets] = useState(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    adminApi.orders.facets().then(
      (d) => { if (!cancelled) setFacets(d); },
      () => { if (!cancelled) setFacets(null); },
    );
    return () => { cancelled = true; };
  }, [nonce]);

  useEffect(() => {
    let cancelled = false;
    adminApi.orders.list({
      q: query.q || undefined,
      workflow: query.workflow !== 'ALL' ? query.workflow : undefined,
      paymentStatus: query.paymentStatus || undefined,
      placedFrom: query.placedFrom || undefined,
      placedTo: query.placedTo || undefined,
      limit: PAGE_SIZE,
      offset: (query.page - 1) * PAGE_SIZE,
    }).then(
      (data) => { if (!cancelled) setState({ status: 'ready', data, error: null }); },
      (err) => { if (!cancelled) setState({ status: 'error', data: null, error: normalizeApiError(err) }); },
    );
    return () => { cancelled = true; };
  }, [query, nonce]);

  const patch = (obj) => {
    const next = new URLSearchParams(searchParams);
    for (const [k, v] of Object.entries(obj)) {
      if (v === null || v === undefined || v === '') next.delete(k);
      else next.set(k, String(v));
    }
    if (!('page' in obj)) next.delete('page');
    setSearchParams(next, { replace: true });
  };
  const clearAll = () => setSearchParams(new URLSearchParams(), { replace: true });

  const data = state.data;
  const rows = data?.orders || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const counts = facets?.workflow || {};
  const needsAction = counts.NEEDS_ACTION ?? facets?.needsAction ?? 0;

  return (
    <PageShell
      title="Orders"
      description="Everything waiting on the warehouse, and what to do about it."
    >
      {/* 1 — how many need action */}
      <div className="ord-summary">
        <button type="button" className={`ord-sum ord-sum--action${query.workflow === 'NEEDS_ACTION' ? ' is-active' : ''}`}
          onClick={() => patch({ workflow: 'NEEDS_ACTION' })}>
          <span className="ord-sum__value">{needsAction}</span>
          <span className="ord-sum__label">Need action now</span>
        </button>
        <div className="ord-sum">
          <span className="ord-sum__value">{counts.READY_FOR_PICKUP ?? '—'}</span>
          <span className="ord-sum__label">Awaiting carrier pickup</span>
        </div>
        <div className="ord-sum">
          <span className="ord-sum__value">{(counts.IN_TRANSIT ?? 0) + (counts.OUT_FOR_DELIVERY ?? 0)}</span>
          <span className="ord-sum__label">With the carrier</span>
        </div>
        {canFinance && (
          <div className="ord-sum">
            <span className="ord-sum__value">{facets ? formatMoney(facets.codDueMinor) : '—'}</span>
            <span className="ord-sum__label">COD due</span>
          </div>
        )}
      </div>

      {/* 2 — which ones */}
      <div className="ord-tabs" role="tablist" aria-label="Order workflow">
        {WORKFLOW_TABS.map(([key, label]) => {
          const n = counts[key];
          const active = query.workflow === key;
          return (
            <button key={key} type="button" role="tab" aria-selected={active}
              className={`ord-tab${active ? ' is-active' : ''}`}
              onClick={() => patch({ workflow: key === 'ALL' ? null : key })}>
              {label}
              {n != null && n > 0 && <span className="ord-tab__count">{n}</span>}
            </button>
          );
        })}
      </div>

      <div className="ord-filters">
        <SearchBox key={query.q} initial={query.q} onSubmit={(q) => patch({ q })} />
        <DateRange from={query.placedFrom} to={query.placedTo}
          onChange={({ placedFrom, placedTo }) => patch({ placedFrom, placedTo })} />
        <Select id="o-payment" label="Payment" value={query.paymentStatus}
          onChange={(v) => patch({ paymentStatus: v })}
          options={PAYMENT_OPTIONS} includeBlank blankLabel="Any payment" />
        {anyFilter && <Button variant="ghost" onClick={clearAll}>Clear</Button>}
        <span className="ord-filters__count">{total} order{total === 1 ? '' : 's'}</span>
      </div>

      {state.status === 'loading' && !data && <LoadingState label="Loading orders…" />}
      {state.status === 'error' && <ErrorState message={state.error?.message} onRetry={() => setNonce((n) => n + 1)} />}

      {data && (
        <>
          <div className="table-wrap">
            <table className="data-table ord-table">
              <thead>
                <tr>
                  <th>Order</th><th>Customer</th><th>Placed</th><th>Payment</th>
                  <th>Total</th><th>Stage</th><th>Next action</th><th aria-label="More" />
                </tr>
              </thead>
              <tbody>
                {rows.map((o) => {
                  const stage = o.workflowStage || '—';
                  const passive = PASSIVE_LABEL[stage];
                  return (
                    <tr key={o.id} className="data-table__row-link" onClick={() => navigate(`/orders/${o.id}`)}>
                      <td>
                        <Link to={`/orders/${o.id}`} onClick={(e) => e.stopPropagation()}>{o.order_number}</Link>
                        <div className="data-table__sub">{o.itemCount} item{o.itemCount === 1 ? '' : 's'}</div>
                      </td>
                      <td>
                        {o.customer_name || <span className="text-faint">—</span>}
                        {o.customer_email && <div className="data-table__sub">{o.customer_email}</div>}
                      </td>
                      <td>{formatDateTime(o.placed_at)}</td>
                      <td>
                        <span>{PAYMENT_LABEL[o.payment_mode] || o.payment_mode}</span>
                        {o.cod_due_minor > 0 && <div className="data-table__sub ord-cod">{formatMoney(o.cod_due_minor)} due</div>}
                      </td>
                      <td>{formatMoney(o.total_minor)}</td>
                      <td><Badge tone={STAGE_TONE[stage] || 'muted'}>{stage}</Badge></td>
                      <td onClick={(e) => e.stopPropagation()}>
                        {o.nextOperatorLabel ? (
                          <Button variant="secondary" size="sm" className="ord-next"
                            onClick={() => navigate(`/orders/${o.id}#section-fulfilment`)}>
                            {o.nextOperatorLabel}
                          </Button>
                        ) : passive ? (
                          <Link className="ord-next-link" to={`/orders/${o.id}`}>{passive}</Link>
                        ) : <span className="text-faint">—</span>}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <RowMenu label={`More actions for ${o.order_number}`}>
                          <button type="button" role="menuitem" onClick={() => navigate(`/orders/${o.id}`)}>Open order</button>
                          {o.customer_id && <Link role="menuitem" to={`/customers/${o.customer_id}`}>View customer</Link>}
                        </RowMenu>
                      </td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={8} className="data-table__empty">
                    {query.workflow === 'NEEDS_ACTION' ? 'Nothing needs action right now.'
                      : anyFilter ? 'No orders match these filters.' : 'No orders yet.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="pager">
            <span className="pager__summary">
              {total === 0 ? '0 of 0' : `${(query.page - 1) * PAGE_SIZE + 1}–${Math.min(query.page * PAGE_SIZE, total)} of ${total}`}
            </span>
            <div className="pager__buttons">
              <Button variant="secondary" disabled={query.page <= 1} onClick={() => patch({ page: query.page - 1 })}>Previous</Button>
              <span className="pager__gap">Page {query.page} / {totalPages}</span>
              <Button variant="secondary" disabled={query.page >= totalPages} onClick={() => patch({ page: query.page + 1 })}>Next</Button>
            </div>
          </div>
        </>
      )}
    </PageShell>
  );
}

export default OrdersPage;
