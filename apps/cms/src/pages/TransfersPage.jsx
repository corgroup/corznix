import { useMemo, useState } from 'react';
import { PageShell } from '../layout/PageShell.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Select } from '../components/ui/Select.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { StatStrip } from '../components/ui/StatStrip.jsx';
import { InlineAlert } from '../components/feedback/InlineAlert.jsx';
import { LoadingState } from '../components/feedback/LoadingState.jsx';
import { ErrorState } from '../components/feedback/ErrorState.jsx';
import { adminApi } from '../api/adminApi.js';
import { useApiResource } from '../hooks/useApiResource.js';
import { useMutation } from '../features/catalog/useMutation.js';
import { useAuth } from '../auth/useAuth.js';
import { formatDateTime } from '../utils/format.js';
import './TransfersPage.css';

const STATUS_OPTIONS = [['DRAFT', 'Draft'], ['DISPATCHED', 'Dispatched'], ['RECEIVED', 'Received'], ['CANCELLED', 'Cancelled']];
const tone = (s) => (s === 'RECEIVED' ? 'good' : s === 'CANCELLED' ? 'muted' : s === 'DRAFT' ? 'warn' : 'good');

function NewTransfer({ warehouses, onCreated }) {
  const [source, setSource] = useState('');
  const [destination, setDestination] = useState('');
  const [note, setNote] = useState('');
  const [skuCode, setSkuCode] = useState('');
  const [qty, setQty] = useState('');
  const [lines, setLines] = useState([]);
  const [lookupErr, setLookupErr] = useState('');
  const [create, cState] = useMutation((body) => adminApi.transfers.create(body));

  const addLine = async () => {
    setLookupErr('');
    const code = skuCode.trim();
    const n = Number(qty);
    if (!code || !Number.isInteger(n) || n <= 0) { setLookupErr('Enter a SKU code and a positive quantity.'); return; }
    if (!source) { setLookupErr('Choose a source warehouse first.'); return; }
    try {
      const res = await adminApi.inventory.list({ q: code, warehouseId: source, limit: 10 });
      const match = (res.items || []).find((i) => i.sku.toLowerCase() === code.toLowerCase());
      if (!match) { setLookupErr(`No SKU "${code}" at the source warehouse.`); return; }
      if (lines.some((l) => l.skuId === match.skuId)) { setLookupErr('That SKU is already on the transfer.'); return; }
      setLines((prev) => [...prev, { skuId: match.skuId, sku: match.sku, quantity: n }]);
      setSkuCode(''); setQty('');
    } catch (err) { setLookupErr(err.message || 'SKU lookup failed.'); }
  };

  const submit = async (e) => {
    e.preventDefault();
    await create({
      sourceWarehouseId: source,
      destinationWarehouseId: destination,
      note: note.trim() || undefined,
      lines: lines.map((l) => ({ skuId: l.skuId, quantity: l.quantity })),
    });
    setSource(''); setDestination(''); setNote(''); setLines([]);
    onCreated?.();
  };

  const canSubmit = source && destination && source !== destination && lines.length > 0 && !cState.busy;

  return (
    <section className="account-card" style={{ marginBottom: 16 }}>
      <h3>New transfer</h3>
      <form onSubmit={submit}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select style={{ maxWidth: 220 }} value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="">Source warehouse…</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <span aria-hidden>→</span>
          <select style={{ maxWidth: 220 }} value={destination} onChange={(e) => setDestination(e.target.value)}>
            <option value="">Destination warehouse…</option>
            {warehouses.filter((w) => w.id !== source).map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
          <input style={{ maxWidth: 240 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '10px 0' }}>
          <input style={{ maxWidth: 200 }} placeholder="SKU code" value={skuCode} onChange={(e) => setSkuCode(e.target.value)} />
          <input style={{ maxWidth: 90 }} inputMode="numeric" placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
          <button type="button" className="btn btn--secondary" onClick={addLine}>Add line</button>
        </div>
        {lookupErr && <InlineAlert tone="error">{lookupErr}</InlineAlert>}
        {lines.length > 0 && (
          <div className="table-wrap"><table className="data-table">
            <thead><tr><th>SKU</th><th>Qty</th><th /></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.skuId}>
                  <td><code>{l.sku}</code></td>
                  <td>{l.quantity}</td>
                  <td><button type="button" className="linkish" onClick={() => setLines((prev) => prev.filter((x) => x.skuId !== l.skuId))}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {cState.error && <InlineAlert tone="error">{cState.error.message}</InlineAlert>}
        <div style={{ marginTop: 10 }}><Button type="submit" busy={cState.busy} disabled={!canSubmit}>Create draft</Button></div>
      </form>
    </section>
  );
}

function Detail({ id, canManage, onChanged }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.transfers.get(id));
  const [dispatch, dState] = useMutation(() => adminApi.transfers.dispatch(id));
  const [receive, rState] = useMutation((received) => adminApi.transfers.receive(id, received));
  const [cancel, cState] = useMutation(() => adminApi.transfers.cancel(id));
  const [recv, setRecv] = useState(null);

  if (status === 'loading') return <LoadingState label="Loading transfer…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  const after = (fn) => async (...args) => { await fn(...args); setRecv(null); reload(); onChanged?.(); };
  const startReceive = () => setRecv(Object.fromEntries(data.items.map((i) => [i.skuId, String(i.quantity)])));
  const submitReceive = after(() => receive(Object.entries(recv).map(([skuId, quant]) => ({ skuId, quantityReceived: Number(quant) }))));
  const busy = dState.busy || rState.busy || cState.busy;
  const err = dState.error || rState.error || cState.error;

  return (
    <section className="account-card" style={{ marginTop: 16 }}>
      <h3>{data.transferNumber} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {data.source.name} → {data.destination.name}</span></h3>
      <p>
        <Badge tone={tone(data.status)}>{data.status}</Badge>
        {data.note ? <span style={{ marginLeft: 8, color: 'var(--text-muted)' }}>{data.note}</span> : null}
      </p>
      {canManage && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0' }}>
          {data.status === 'DRAFT' && <Button variant="secondary" busy={busy} onClick={after(dispatch)}>Dispatch</Button>}
          {data.status === 'DRAFT' && <Button variant="ghost" busy={busy} onClick={after(cancel)}>Cancel</Button>}
          {data.status === 'DISPATCHED' && !recv && <Button variant="secondary" busy={busy} onClick={startReceive}>Receive…</Button>}
        </div>
      )}
      {err && <InlineAlert tone="error">{err.message}</InlineAlert>}
      <h4>Lines</h4>
      <div className="table-wrap"><table className="data-table">
        <thead><tr><th>SKU</th><th>Qty</th><th>Received</th>{recv && <th>Receiving</th>}</tr></thead>
        <tbody>
          {data.items.map((i) => (
            <tr key={i.skuId}>
              <td><code>{i.sku}</code></td>
              <td>{i.quantity}</td>
              <td>{i.quantityReceived}</td>
              {recv && (
                <td>
                  <input style={{ maxWidth: 80 }} inputMode="numeric"
                    value={recv[i.skuId] ?? ''} onChange={(e) => setRecv((p) => ({ ...p, [i.skuId]: e.target.value }))} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table></div>
      {recv && (
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button variant="success" busy={busy} onClick={submitReceive}>Confirm receipt</Button>
          <button type="button" className="btn btn--secondary" onClick={() => setRecv(null)}>Cancel</button>
        </div>
      )}
    </section>
  );
}

const STEPS = [
  ['Create transfer', 'Select source and destination warehouses and add items to move.'],
  ['Dispatch from source', 'Dispatch the transfer to decrement stock at the source warehouse.'],
  ['Receive at destination', 'Receive the transfer to add units into the destination warehouse.'],
];

export function TransfersPage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('inventory.adjust');
  const [statusFilter, setStatusFilter] = useState(null);
  const [warehouseFilter, setWarehouseFilter] = useState(null);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const warehouses = useApiResource(() => adminApi.warehouses.list());
  const { status: load, data, error, reload } = useApiResource(() => adminApi.transfers.list({
    ...(statusFilter ? { status: statusFilter } : {}), limit: 200,
  }));
  const all = useMemo(() => data?.transfers ?? [], [data]);
  const activeWarehouses = (warehouses.data?.warehouses ?? []).filter((w) => w.status === 'ACTIVE');

  const rows = useMemo(() => {
    let list = [...all];
    const n = q.trim().toLowerCase();
    if (n) list = list.filter((t) => `${t.transferNumber} ${t.source.name} ${t.destination.name}`.toLowerCase().includes(n));
    if (warehouseFilter) list = list.filter((t) => t.source.id === warehouseFilter || t.destination.id === warehouseFilter);
    return list;
  }, [all, q, warehouseFilter]);

  const facets = useMemo(() => ({
    total: all.length,
    inTransit: all.filter((t) => t.status === 'DISPATCHED').reduce((n, t) => n + t.unitCount, 0),
    readyToDispatch: all.filter((t) => t.status === 'DRAFT').length,
    completed: all.filter((t) => t.status === 'RECEIVED').length,
  }), [all]);

  const anyFilter = Boolean(q.trim() || statusFilter || warehouseFilter);
  const clearAll = () => { setQ(''); setStatusFilter(null); setWarehouseFilter(null); setSelected(null); reload(); };

  return (
    <PageShell
      title="Transfers"
      description="Move on-hand stock between warehouses. Dispatch decrements the source; units stay in transit until the destination receives them."
      actions={canManage ? <Button onClick={() => setShowNew((v) => !v)}>{showNew ? 'Close' : 'New transfer'}</Button> : null}
    >
      <StatStrip cards={[
        { label: 'Total transfers', value: facets.total, hint: 'All time', tone: 'neutral', active: !anyFilter, onClick: clearAll },
        { label: 'In transit', value: facets.inTransit, hint: 'Units in transit', tone: facets.inTransit ? 'warn' : 'neutral', active: statusFilter === 'DISPATCHED', onClick: () => { setStatusFilter(statusFilter === 'DISPATCHED' ? null : 'DISPATCHED'); reload(); } },
        { label: 'Ready to dispatch', value: facets.readyToDispatch, hint: 'Awaiting dispatch', tone: 'neutral', active: statusFilter === 'DRAFT', onClick: () => { setStatusFilter(statusFilter === 'DRAFT' ? null : 'DRAFT'); reload(); } },
        { label: 'Completed', value: facets.completed, hint: 'Received', tone: 'good', active: statusFilter === 'RECEIVED', onClick: () => { setStatusFilter(statusFilter === 'RECEIVED' ? null : 'RECEIVED'); reload(); } },
      ]} />

      {showNew && canManage && <NewTransfer warehouses={activeWarehouses} onCreated={() => { setShowNew(false); reload(); }} />}

      <div className="transfers-layout">
        <div className="transfers-layout__main">
          <div className="wb-toolbar">
            <input className="wb-toolbar__search" type="search" placeholder="Search transfers…"
              value={q} onChange={(e) => setQ(e.target.value)} />
            <Select id="tr-status" label="Status" value={statusFilter} onChange={(v) => { setStatusFilter(v); setSelected(null); reload(); }}
              options={STATUS_OPTIONS} includeBlank blankLabel="All statuses" />
            <Select id="tr-wh" label="Warehouse" value={warehouseFilter} onChange={setWarehouseFilter}
              options={activeWarehouses.map((w) => [w.id, w.name])} includeBlank blankLabel="All warehouses" />
            {anyFilter && <Button variant="ghost" onClick={clearAll}>Clear</Button>}
          </div>

          {load === 'loading' && <LoadingState label="Loading transfers…" />}
          {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
          {load === 'ready' && (
            all.length === 0 ? (
              <div className="wb-empty">
                <svg className="wb-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 7h11v10H3zM14 10h4l3 3v4h-7M6.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.5 20a1.5 1.5 0 100-3 1.5 1.5 0 000 3z" />
                </svg>
                <p className="wb-empty__title">No transfers yet</p>
                <p className="wb-empty__body">You haven&rsquo;t created any transfers. Create your first transfer to move stock between warehouses.</p>
                {canManage && <div className="wb-empty__actions"><Button variant="soft" onClick={() => setShowNew(true)}>Create first transfer</Button></div>}
              </div>
            ) : (
              <>
                <p className="wb-count">{rows.length} of {all.length} transfer{all.length === 1 ? '' : 's'}</p>
                <div className="table-wrap">
                  <table className="data-table">
                    <thead><tr><th>Transfer</th><th>Route</th><th>Lines</th><th>Units</th><th>Created</th><th>Status</th><th aria-label="Actions" /></tr></thead>
                    <tbody>
                      {rows.map((t) => {
                        const isSel = selected === t.id;
                        return (
                          <tr key={t.id} className={isSel ? 'data-table__row--selected' : undefined}>
                            <td>{t.transferNumber}</td>
                            <td>{t.source.name} → {t.destination.name}</td>
                            <td>{t.lineCount}</td>
                            <td>{t.unitCount}</td>
                            <td>{formatDateTime(t.createdAt)}</td>
                            <td><Badge tone={tone(t.status)}>{t.status}</Badge></td>
                            <td><button type="button" className="linkish" onClick={() => setSelected(isSel ? null : t.id)}>{isSel ? 'Hide' : 'Open'}</button></td>
                          </tr>
                        );
                      })}
                      {rows.length === 0 && <tr><td colSpan={7} className="data-table__empty">No transfers match.</td></tr>}
                    </tbody>
                  </table>
                </div>
                {selected && <Detail key={selected} id={selected} canManage={canManage} onChanged={reload} />}
              </>
            )
          )}
        </div>

        <aside className="transfers-layout__rail">
          <div className="rail-card">
            <h3 className="rail-card__title">How transfers work</h3>
            <ol className="transfers-steps">
              {STEPS.map(([t, d], i) => (
                <li key={t}><span className="transfers-steps__n">{i + 1}</span><div><strong>{t}</strong><p>{d}</p></div></li>
              ))}
            </ol>
            <p className="transfers-tip">Transfers remain <em>in transit</em> until they are received at the destination.</p>
          </div>
        </aside>
      </div>
    </PageShell>
  );
}

export default TransfersPage;
