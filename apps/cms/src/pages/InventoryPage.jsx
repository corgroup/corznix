import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
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

const productLabel = (r) =>
  (r.productName ? `${r.productName}${r.colorName ? ` · ${r.colorName}` : ''}${r.size ? ` · ${r.size}` : ''}` : '—');

const MOVEMENT_LABEL = {
  STOCK_RECEIVED: 'Stock received', ORDER_RESERVED: 'Reserved to order', ORDER_ALLOCATED: 'Allocated',
  RESERVATION_RELEASED: 'Reservation released', RESERVATION_EXPIRED: 'Reservation expired',
  INVENTORY_CONSUMED: 'Consumed by order', ORDER_CANCELLED: 'Order cancelled', RETURN_RESTOCKED: 'Return restocked',
  DAMAGED: 'Damaged', MANUAL_ADJUSTMENT: 'Manual adjustment', TRANSFER_OUT: 'Transfer out', TRANSFER_IN: 'Transfer in',
};

function Detail({ warehouseId, skuId, canAdjust, onChanged }) {
  const { status, data, error, reload } = useApiResource(() => adminApi.inventory.detail(warehouseId, skuId));
  const [thresholdInput, setThresholdInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [save, saveState] = useMutation((value) => adminApi.inventory.setThreshold(warehouseId, skuId, value));

  if (status === 'loading') return <LoadingState label="Loading item…" />;
  if (status === 'error') return <ErrorState message={error?.message} onRetry={reload} />;

  const startEdit = () => { setThresholdInput(data.lowStockThreshold == null ? '' : String(data.lowStockThreshold)); setEditing(true); };
  const submitThreshold = async (e) => {
    e.preventDefault();
    const value = thresholdInput.trim() === '' ? null : Number(thresholdInput);
    await save(value);
    setEditing(false);
    reload();
    onChanged?.();
  };

  return (
    <section className="account-card" style={{ marginTop: 16 }}>
      <h3>{data.sku} — {productLabel(data)} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>@ {data.warehouseName}</span></h3>
      <p>
        <strong>On hand {data.onHand}</strong> · Reserved {data.reserved} · <strong>Available {data.available}</strong>
        {data.nonSellable > 0 && <span className="pill pill--muted" style={{ marginLeft: 8 }}>quarantine {data.nonSellable}</span>}
        {data.lowStock && <span className="pill pill--muted" style={{ marginLeft: 8 }}>low stock</span>}
      </p>

      <div style={{ margin: '8px 0' }}>
        Low-stock threshold: <strong>{data.lowStockThreshold == null ? 'not set' : data.lowStockThreshold}</strong>
        {canAdjust && !editing && <button type="button" className="btn btn--secondary" style={{ marginLeft: 8 }} onClick={startEdit}>Edit</button>}
        {editing && (
          <form onSubmit={submitThreshold} style={{ display: 'inline-flex', gap: 8, marginLeft: 8 }}>
            <input style={{ maxWidth: 120 }} inputMode="numeric" placeholder="blank = none"
              value={thresholdInput} onChange={(e) => setThresholdInput(e.target.value)} />
            <Button type="submit" busy={saveState.busy}>Save</Button>
            <button type="button" className="btn btn--secondary" onClick={() => setEditing(false)}>Cancel</button>
          </form>
        )}
        {saveState.error && <InlineAlert tone="error">{saveState.error.message}</InlineAlert>}
      </div>

      <h4>Open reservations</h4>
      {data.openReservations.length === 0 ? <p className="text-faint">None.</p> : (
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>Qty</th><th>Customer</th><th>Expires</th></tr></thead>
          <tbody>
            {data.openReservations.map((r) => (
              <tr key={r.reservationId}>
                <td>{r.quantity}</td>
                <td>{r.customerId ? r.customerId.slice(0, 8) : 'guest'}</td>
                <td>{formatDateTime(r.expiresAt)}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}

      <h4>Movement history</h4>
      {data.movements.length === 0 ? <p className="text-faint">No movements recorded.</p> : (
        <div className="table-wrap"><table className="data-table">
          <thead><tr><th>When</th><th>Type</th><th>Δ</th><th>On hand after</th><th>Actor</th><th>Reason / ref</th></tr></thead>
          <tbody>
            {data.movements.map((m) => (
              <tr key={m.id}>
                <td>{formatDateTime(m.occurredAt)}</td>
                <td>{MOVEMENT_LABEL[m.type] || m.type}</td>
                <td>{m.quantityDelta > 0 ? `+${m.quantityDelta}` : m.quantityDelta}</td>
                <td>{m.balanceAfter == null ? '—' : m.balanceAfter}</td>
                <td>{m.actor || 'system'}</td>
                <td className="text-faint">{m.reason || m.referenceId || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
    </section>
  );
}

export function InventoryPage() {
  const { hasPermission } = useAuth();
  const canAdjust = hasPermission('inventory.adjust');
  const [q, setQ] = useState('');
  const [warehouseId, setWarehouseId] = useState(null);
  const [stockFilter, setStockFilter] = useState(null); // in | out
  const [lowOnly, setLowOnly] = useState(false);
  const [selected, setSelected] = useState(null);

  const warehouses = useApiResource(() => adminApi.warehouses.list());
  const { status, data, error, reload } = useApiResource(() => adminApi.inventory.list({
    ...(warehouseId ? { warehouseId } : {}),
    ...(lowOnly ? { lowStockOnly: true } : {}),
    limit: 200,
  }));

  const all = useMemo(() => data?.items ?? [], [data]);
  const serverTotal = data?.total ?? 0;
  const partial = serverTotal > all.length;

  const rows = useMemo(() => {
    let list = [...all];
    const n = q.trim().toLowerCase();
    if (n) list = list.filter((r) => `${r.sku} ${r.productName || ''} ${r.colorName || ''}`.toLowerCase().includes(n));
    if (stockFilter === 'in') list = list.filter((r) => r.available > 0);
    if (stockFilter === 'out') list = list.filter((r) => r.available <= 0);
    return list;
  }, [all, q, stockFilter]);

  const facets = useMemo(() => ({
    total: partial ? serverTotal : all.length,
    inStock: all.filter((r) => r.available > 0).length,
    reserved: all.reduce((n, r) => n + r.reserved, 0),
    low: all.filter((r) => r.lowStock).length,
    warehouses: (warehouses.data?.warehouses ?? []).filter((w) => w.status === 'ACTIVE').length,
  }), [all, partial, serverTotal, warehouses.data]);

  const anyFilter = Boolean(q.trim() || warehouseId || stockFilter || lowOnly);
  const clearAll = () => { setQ(''); setWarehouseId(null); setStockFilter(null); setLowOnly(false); setSelected(null); reload(); };
  const exportParams = { ...(warehouseId ? { warehouseId } : {}), ...(lowOnly ? { lowStockOnly: true } : {}) };

  return (
    <PageShell
      title="Inventory"
      description="One balance-of-record per (warehouse, SKU). Available is always on-hand − reserved. Stock adjustments are made from the warehouse page."
      actions={<a className="btn btn--secondary" href={adminApi.inventory.exportUrl(exportParams)}>Export CSV</a>}
    >
      <StatStrip cards={[
        { label: 'Total SKUs', value: facets.total, hint: 'Across all warehouses', tone: 'neutral', active: !anyFilter, onClick: clearAll },
        { label: 'In stock', value: facets.inStock, hint: 'Available to sell', tone: 'good', active: stockFilter === 'in', onClick: () => setStockFilter(stockFilter === 'in' ? null : 'in') },
        { label: 'Reserved', value: facets.reserved, hint: 'In orders / fulfilment', tone: 'neutral' },
        { label: 'Low stock', value: facets.low, hint: 'At or below threshold', tone: facets.low ? 'warn' : 'neutral', active: lowOnly, onClick: () => { setLowOnly(!lowOnly); reload(); } },
        { label: 'Warehouses', value: facets.warehouses, hint: 'Active locations', tone: 'neutral' },
      ]} />

      <div className="wb-toolbar">
        <input className="wb-toolbar__search" type="search" placeholder="Search by SKU, product name or variant…"
          value={q} onChange={(e) => setQ(e.target.value)} />
        <Select id="inv-wh" label="Warehouse" value={warehouseId} onChange={(v) => { setWarehouseId(v); setSelected(null); reload(); }}
          options={(warehouses.data?.warehouses ?? []).map((w) => [w.id, w.name])} includeBlank blankLabel="All warehouses" />
        <Select id="inv-stock" label="Stock level" value={stockFilter} onChange={setStockFilter}
          options={[['in', 'In stock'], ['out', 'Out of stock']]} includeBlank blankLabel="Any level" />
        <label className="form-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <input type="checkbox" checked={lowOnly} onChange={(e) => { setLowOnly(e.target.checked); setSelected(null); reload(); }} />
          <span>Low stock only</span>
        </label>
        {anyFilter && <Button variant="ghost" onClick={clearAll}>Clear</Button>}
      </div>

      {status === 'loading' && <LoadingState label="Loading inventory…" />}
      {status === 'error' && <ErrorState message={error?.message} onRetry={reload} />}
      {status === 'ready' && (
        all.length === 0 ? (
          <div className="wb-empty">
            <svg className="wb-empty__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 7l9-4 9 4-9 4-9-4zM3 7v10l9 4 9-4V7M12 11v10" />
            </svg>
            <p className="wb-empty__title">No inventory records yet</p>
            <p className="wb-empty__body">Inventory appears here once you add warehouses and stock is received.</p>
            <div className="wb-empty__actions">
              <Link className="btn btn--secondary" to="/warehouses">View warehouses</Link>
            </div>
          </div>
        ) : (
          <>
            <p className="wb-count">
              {rows.length} of {all.length} row{all.length === 1 ? '' : 's'}
              {partial && ` (showing first ${all.length} of ${serverTotal})`}
            </p>
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr><th>SKU</th><th>Product</th><th>Warehouse</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Threshold</th><th>Status</th><th aria-label="Actions" /></tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const isSel = selected && selected.warehouseId === r.warehouseId && selected.skuId === r.skuId;
                    return (
                      <tr key={`${r.warehouseId}:${r.skuId}`} className={isSel ? 'data-table__row--selected' : undefined}>
                        <td><code>{r.sku}</code></td>
                        <td>{productLabel(r)}</td>
                        <td>{r.warehouseName}</td>
                        <td>{r.onHand}</td>
                        <td>{r.reserved}</td>
                        <td>{r.available}</td>
                        <td>{r.lowStockThreshold == null ? <span className="text-faint">—</span> : r.lowStockThreshold}</td>
                        <td>{r.lowStock ? <Badge tone="warn">Low stock</Badge> : r.available > 0 ? <Badge tone="good">In stock</Badge> : <Badge tone="muted">Out</Badge>}</td>
                        <td>
                          <button type="button" className="linkish"
                            onClick={() => setSelected(isSel ? null : { warehouseId: r.warehouseId, skuId: r.skuId })}>
                            {isSel ? 'Hide' : 'Details'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  {rows.length === 0 && <tr><td colSpan={9} className="data-table__empty">No inventory rows match.</td></tr>}
                </tbody>
              </table>
            </div>

            {selected && (
              <Detail key={`${selected.warehouseId}:${selected.skuId}`}
                warehouseId={selected.warehouseId} skuId={selected.skuId} canAdjust={canAdjust} onChanged={reload} />
            )}
          </>
        )
      )}

      <div className="wb-about">
        <svg className="wb-about__icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="9" /><path d="M12 16v-4M12 8h.01" strokeLinecap="round" /></svg>
        <span><strong>About inventory</strong>Inventory is managed per warehouse and SKU. To update stock, create a transfer, receive inventory or use an adjustment from the warehouse page.</span>
      </div>
    </PageShell>
  );
}

export default InventoryPage;
