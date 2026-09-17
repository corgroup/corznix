import { Fragment, useMemo, useState } from 'react';
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

const SOURCE_LABEL = { RETURN_QC_FAIL: 'QC fail', RTO_RECEIVED: 'RTO' };

function Dispose({ batch, onDone }) {
  const [action, setAction] = useState('RELEASE');
  const [qty, setQty] = useState(String(batch.quantityRemaining));
  const [note, setNote] = useState('');
  const [dispose, dState] = useMutation((body) => adminApi.quarantine.dispose(batch.id, body));
  const submit = async (e) => {
    e.preventDefault();
    await dispose({ action, quantity: Number(qty), note: note.trim() || undefined });
    onDone?.();
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
      <select value={action} onChange={(e) => setAction(e.target.value)} style={{ maxWidth: 170 }}>
        <option value="RELEASE">Release to sellable</option>
        <option value="SCRAP">Scrap (write-off)</option>
      </select>
      <input style={{ width: 80 }} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
      <input style={{ width: 200 }} placeholder="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} />
      <Button type="submit" busy={dState.busy}>Confirm</Button>
      {dState.error && <InlineAlert tone="error">{dState.error.message}</InlineAlert>}
    </form>
  );
}

export function QuarantinePage() {
  const { hasPermission } = useAuth();
  const canManage = hasPermission('inventory.adjust');
  const [status, setStatus] = useState('OPEN');
  const [expanded, setExpanded] = useState(null);
  const [q, setQ] = useState('');
  const [warehouseFilter, setWarehouseFilter] = useState(null);
  const [sourceFilter, setSourceFilter] = useState(null);

  const { status: load, data, error, reload } = useApiResource(() => adminApi.quarantine.list({
    ...(status ? { status } : {}), limit: 200,
  }));
  const batches = useMemo(() => data?.batches ?? [], [data]);

  const warehouses = useMemo(() => {
    const m = new Map();
    for (const b of batches) if (b.warehouse?.id) m.set(b.warehouse.id, b.warehouse.name);
    return [...m.entries()];
  }, [batches]);
  const sources = useMemo(() => [...new Set(batches.map((b) => b.sourceType))], [batches]);

  const rows = useMemo(() => {
    let list = [...batches];
    const n = q.trim().toLowerCase();
    if (n) list = list.filter((b) => `${b.sku} ${b.productName || ''} ${b.reason || ''}`.toLowerCase().includes(n));
    if (warehouseFilter) list = list.filter((b) => b.warehouse?.id === warehouseFilter);
    if (sourceFilter) list = list.filter((b) => b.sourceType === sourceFilter);
    return list;
  }, [batches, q, warehouseFilter, sourceFilter]);

  const facets = useMemo(() => ({
    units: batches.reduce((n, b) => n + b.quantity, 0),
    open: batches.filter((b) => b.status === 'OPEN').reduce((n, b) => n + b.quantityRemaining, 0),
    released: batches.reduce((n, b) => n + b.quantityReleased, 0),
    scrapped: batches.reduce((n, b) => n + b.quantityScrapped, 0),
    skus: new Set(batches.map((b) => b.sku)).size,
  }), [batches]);

  const anyFilter = Boolean(q.trim() || warehouseFilter || sourceFilter);
  const clearAll = () => { setQ(''); setWarehouseFilter(null); setSourceFilter(null); };

  return (
    <PageShell
      title="Quarantine"
      description="Units that failed return QC sit in the non-sellable bucket. Release them back to sellable stock once reworked, or scrap them as a write-off."
      actions={
        <Select id="qtn-status" label={null} value={status} onChange={(v) => { setStatus(v); setExpanded(null); reload(); }}
          options={[['OPEN', 'Open'], ['RESOLVED', 'Resolved']]} includeBlank blankLabel="All statuses" />
      }
    >
      <StatStrip cards={[
        { label: 'Total units', value: facets.units, hint: 'In quarantine', tone: 'neutral', active: !anyFilter, onClick: clearAll },
        { label: 'Open', value: facets.open, hint: 'Awaiting action', tone: facets.open ? 'warn' : 'neutral', active: status === 'OPEN', onClick: () => { setStatus('OPEN'); reload(); } },
        { label: 'Released', value: facets.released, hint: 'Back to stock', tone: 'good' },
        { label: 'Scrapped', value: facets.scrapped, hint: 'Written off', tone: 'neutral' },
        { label: 'SKUs', value: facets.skus, hint: 'Distinct SKUs', tone: 'neutral' },
      ]} />

      <div className="wb-toolbar">
        <input className="wb-toolbar__search" type="search" placeholder="Search by SKU, product or reason…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <Select id="qtn-wh" label="Warehouse" value={warehouseFilter} onChange={setWarehouseFilter}
          options={warehouses.map(([id, name]) => [id, name])} includeBlank blankLabel="All warehouses" />
        <Select id="qtn-src" label="Source" value={sourceFilter} onChange={setSourceFilter}
          options={sources.map((s) => [s, SOURCE_LABEL[s] || s])} includeBlank blankLabel="All sources" />
        {anyFilter && <Button variant="ghost" onClick={clearAll}>Clear</Button>}
      </div>

      {load === 'loading' && <LoadingState label="Loading quarantine…" />}
      {load === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {load === 'ready' && (
        batches.length === 0 ? (
          <div className="wb-empty">
            <svg className="wb-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7" />
            </svg>
            <p className="wb-empty__title">Nothing in quarantine</p>
            <p className="wb-empty__body">Units that fail return QC or come back via RTO will appear here for release or write-off.</p>
          </div>
        ) : (
          <>
            <p className="wb-count">{rows.length} of {batches.length} batch{batches.length === 1 ? '' : 'es'}</p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>SKU</th><th>Product</th><th>Warehouse</th><th>Source</th><th>Qty</th>
                    <th>Released</th><th>Scrapped</th><th>Remaining</th><th>Reason</th><th>Status</th><th>Added on</th>{canManage && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => (
                    <Fragment key={b.id}>
                      <tr>
                        <td><code>{b.sku}</code></td>
                        <td>{b.productName ? `${b.productName}${b.colorName ? ` · ${b.colorName}` : ''}` : <span className="text-faint">—</span>}</td>
                        <td>{b.warehouse.name}</td>
                        <td><span className="chip">{SOURCE_LABEL[b.sourceType] || b.sourceType}</span></td>
                        <td>{b.quantity}</td>
                        <td>{b.quantityReleased}</td>
                        <td>{b.quantityScrapped}</td>
                        <td>{b.quantityRemaining}</td>
                        <td className="text-faint">{b.reason || '—'}</td>
                        <td><Badge tone={b.status === 'RESOLVED' ? 'good' : 'warn'}>{b.status}</Badge></td>
                        <td className="text-faint">{formatDateTime(b.createdAt)}</td>
                        {canManage && (
                          <td>
                            {b.status === 'OPEN' && (
                              <button type="button" className="linkish" onClick={() => setExpanded(expanded === b.id ? null : b.id)}>
                                {expanded === b.id ? 'Close' : 'Dispose'}
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                      {canManage && expanded === b.id && b.status === 'OPEN' && (
                        <tr><td colSpan={12}><Dispose batch={b} onDone={() => { setExpanded(null); reload(); }} /></td></tr>
                      )}
                    </Fragment>
                  ))}
                  {rows.length === 0 && <tr><td colSpan={canManage ? 12 : 11} className="data-table__empty">No batches match.</td></tr>}
                </tbody>
              </table>
            </div>
          </>
        )
      )}

      <div className="wb-about">
        <svg className="wb-about__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" strokeLinecap="round" /></svg>
        <span><strong>About quarantine</strong>Quarantine holds units that failed return QC. You can release them back to sellable stock once reworked, or scrap them as a write-off.</span>
      </div>
    </PageShell>
  );
}

export default QuarantinePage;
