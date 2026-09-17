import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';

const STATUSES = ['', 'PENDING', 'WAREHOUSE_CONFIRMED', 'READY', 'PROCESSING', 'PARTIALLY_FULFILLED', 'FULFILLED', 'ON_HOLD', 'CANCELLED'];
const tone = (s) => (s === 'FULFILLED' ? 'good' : s === 'CANCELLED' || s === 'ON_HOLD' ? 'muted' : s === 'PENDING' ? 'warn' : 'good');

// The operator works one step at a time, and which step that is comes from
// the backend (`nextOperatorStatus` on the fulfilment) rather than from a copy
// of the transition graph kept here. The copy that used to live in this file
// had already drifted from transitions.js — it omitted PARTIALLY_FULFILLED
// from PROCESSING — which is what a second source of truth always does.
//
// Only the exceptional actions are still listed locally: they are available
// from most states, they are not part of the forward sequence, and both are
// re-validated by the backend anyway.
const EXCEPTION_ACTIONS = ['ON_HOLD', 'CANCELLED'];

// What the primary action is called, as an operator would say it.
const ACTION_LABEL = {
  WAREHOUSE_CONFIRMED: 'Confirm order',
  PROCESSING: 'Start processing',
  FULFILLED: 'Mark fulfilled',
  READY: 'Mark ready',
  PENDING: 'Return to pending',
};

function Detail({ id, canManage, onChanged }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.fulfillments.get(id));
  const [transition, tState] = useMutation(({ toStatus, note: n }) => adminApi.fulfillments.transition(id, toStatus, n));
  const [note, setNote] = useState('');

  if (status === 'loading') return <LoadingState label="Loading fulfilment…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  const move = async (toStatus) => {
    await transition({ toStatus, note: note.trim() || undefined });
    setNote('');
    reload();
    onChanged?.();
  };
  // One forward action, decided by the domain. Null at a terminal state.
  const primary = data.nextOperatorStatus || null;
  const exceptions = ['FULFILLED', 'CANCELLED'].includes(data.status)
    ? []
    : EXCEPTION_ACTIONS.filter((s) => s !== data.status);

  return (
    <section className="account-card" style={{ marginTop: 16 }}>
      <h3>{data.fulfillmentNumber} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {data.type} · <Link to={`/orders/${data.orderId}`}>{data.orderNumber}</Link> ({data.orderStatus}) · {data.warehouseName}</span></h3>
      <p>
        <span className={`pill pill--${tone(data.status)}`}>{data.status}</span>
        {'  '}Readiness: {data.readinessStatus}{data.blockReason ? ` · ${data.blockReason}` : ''}
      </p>

      {/* Booking readiness above is a different thing from the confirmation
          below: the first is derived from carrier metadata, the second is a
          named person at the warehouse accepting the order. */}
      {data.warehouseConfirmation && (
        <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>
          Confirmed by warehouse on {new Date(data.warehouseConfirmation.at).toLocaleString()}
          {data.warehouseConfirmation.note ? (' — ' + data.warehouseConfirmation.note) : ''}
        </p>
      )}

      {canManage && (primary || exceptions.length > 0) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
          <input className="form-field__input" style={{ maxWidth: 220 }} placeholder="Note (optional)"
            value={note} onChange={(e) => setNote(e.target.value)} />
          {/* Exactly one forward action, so the operator is never asked to
              pick which stage of the workflow they are at. */}
          {primary && (
            <Button busy={tState.busy} onClick={() => move(primary)}>
              {ACTION_LABEL[primary] || primary.replaceAll('_', ' ')}
            </Button>
          )}
          {exceptions.map((s) => (
            <Button key={s} variant={s === 'ON_HOLD' ? 'warning' : 'danger'} busy={tState.busy} onClick={() => move(s)}>
              {s === 'ON_HOLD' ? 'Put on hold' : 'Cancel'}
            </Button>
          ))}
        </div>
      )}
      {tState.error && <InlineAlert tone="error">{tState.error.message}</InlineAlert>}

      <h4>Items</h4>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>SKU</th><th>Qty</th></tr></thead>
        <tbody>{data.items.map((i) => <tr key={i.id}><td><code>{i.skuId}</code></td><td>{i.quantity}</td></tr>)}</tbody>
      </table></div>

      <h4>Shipments</h4>
      {data.shipments.length === 0 ? <p style={{ color: 'var(--text-muted)' }}>None.</p> : (
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Shipment</th><th>Status</th><th>Booking</th><th>AWB</th></tr></thead>
          <tbody>{data.shipments.map((s) => (
            <tr key={s.id}><td>{s.shipmentNumber}</td><td>{s.status}</td><td>{s.bookingStatus}</td><td>{s.awbNumber || '—'}</td></tr>
          ))}</tbody>
        </table></div>
      )}

      <h4>Events</h4>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>When</th><th>Type</th><th>From → To</th><th>Note</th></tr></thead>
        <tbody>{data.events.map((e, i) => (
          <tr key={i}>
            <td>{new Date(e.at).toLocaleString()}</td>
            <td>{e.type}</td>
            <td>{e.fromStatus || '—'} → {e.toStatus || '—'}</td>
            <td style={{ color: 'var(--text-muted)' }}>{e.detail?.note || e.detail?.via || '—'}</td>
          </tr>
        ))}</tbody>
      </table></div>
    </section>
  );
}

export function FulfillmentPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('fulfillment.manage');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState('');
  const [orderNumber, setOrderNumber] = useState('');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const limit = 50;

  const { status: load, data, error, reload } = useApiResource(() => adminApi.fulfillments.list({
    ...(status ? { status } : {}), ...(orderNumber ? { orderNumber } : {}), limit, offset,
  }));
  const rows = data?.fulfillments ?? [];
  const total = data?.total ?? 0;

  const apply = (patch) => {
    setOffset(0); setSelected(null);
    if ('status' in patch) setStatus(patch.status);
    if ('orderNumber' in patch) setOrderNumber(patch.orderNumber);
    reload();
  };

  return (
    <PageShell
      title="Fulfillment"
      description="One fulfilment per (order, warehouse). Move it through pick → pack → ready → fulfilled; a hold pauses it. Marking every fulfilment FULFILLED completes the order."
      actions={
        <form style={{ display: 'inline-flex', gap: 8 }} onSubmit={(e) => { e.preventDefault(); apply({ orderNumber: pending }); }}>
          <input className="form-field__input" style={{ maxWidth: 200 }} placeholder="Order #…"
            value={pending} onChange={(e) => setPending(e.target.value)} />
          <select value={status} onChange={(e) => apply({ status: e.target.value })} className="form-field__input" style={{ maxWidth: 180 }}>
            {STATUSES.map((s) => <option key={s} value={s}>{s || 'All statuses'}</option>)}
          </select>
        </form>
      }
    >
      {load === 'loading' && <LoadingState label="Loading fulfilments…" />}
      {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {load === 'ready' && (
        <>
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>Fulfilment</th><th>Order</th><th>Warehouse</th><th>Items</th><th>Shipments</th><th>Readiness</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map((f) => {
                const isSel = selected === f.id;
                return (
                  <tr key={f.id} style={isSel ? { background: 'var(--surface-2)' } : undefined}>
                    <td>{f.fulfillmentNumber}</td>
                    <td><Link to={`/orders/${f.orderId}`}>{f.orderNumber}</Link></td>
                    <td>{f.warehouseName}</td>
                    <td>{f.itemCount}</td>
                    <td>{f.shipmentCount}</td>
                    <td>{f.readinessStatus}{f.blockReason ? ` · ${f.blockReason}` : ''}</td>
                    <td><span className={`pill pill--${tone(f.status)}`}>{f.status}</span></td>
                    <td><button type="button" className="btn btn--secondary" onClick={() => setSelected(isSel ? null : f.id)}>{isSel ? 'Hide' : 'Open'}</button></td>
                  </tr>
                );
              })}
              {rows.length === 0 && <tr><td colSpan={8} className="data-table__empty">No fulfilments match.</td></tr>}
            </tbody>
          </table></div>

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 12, color: 'var(--text-muted)' }}>
            <span>{total} fulfilment{total === 1 ? '' : 's'}</span>
            <button type="button" className="btn btn--secondary" disabled={offset === 0} onClick={() => { setOffset(Math.max(0, offset - limit)); setSelected(null); reload(); }}>Previous</button>
            <button type="button" className="btn btn--secondary" disabled={offset + limit >= total} onClick={() => { setOffset(offset + limit); setSelected(null); reload(); }}>Next</button>
          </div>

          {selected && <Detail key={selected} id={selected} canManage={canManage} onChanged={reload} />}
        </>
      )}
    </PageShell>
  );
}

export default FulfillmentPage;
