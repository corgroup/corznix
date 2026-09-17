import { useEffect, useMemo, useState } from 'react';
import { Badge } from '../../../components/ui/Badge.jsx';
import { Button } from '../../../components/ui/Button.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../../api/adminApi.js';

// Stock per SKU per warehouse.
//
// One product, one SKU, many warehouses — a SKU stocked in five places is
// still ONE product on the storefront. Nothing here creates catalogue rows:
// storefront identity comes from Product -> Variant/SKU, and these are only
// inventory allocations against it. The PLP query groups by variant and never
// joins `inventory`, so adding a warehouse can never duplicate a product.
//
// Every quantity entered is posted as a DELTA to
// POST /admin/warehouses/:id/inventory/adjust — the same endpoint the
// Inventory and Warehouses modules use, which runs inventoryService.adjustStock
// in a transaction, refuses to push on-hand below reserved, and writes an
// inventory_movements ledger row. One source of truth: a sale, a return
// restock, a transfer and an edit made here all land in the same table.
export function InventoryTab({ product, canWrite = false, onSaved }) {
  const rows = useMemo(
    () => product.variants.flatMap((v) => v.skus.map((s) => ({ v, s }))),
    [product],
  );
  const sum = product.inventorySummary;

  const [warehouses, setWarehouses] = useState([]);
  const [whError, setWhError] = useState('');
  // { [skuId]: { [warehouseId]: '12' } } — only non-zero cells are applied.
  const [deltas, setDeltas] = useState({});
  const [reason, setReason] = useState('Initial stock');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [okMsg, setOkMsg] = useState('');

  useEffect(() => {
    let alive = true;
    adminApi.warehouses.list({ status: 'ACTIVE' })
      .then((res) => {
        if (!alive) return;
        const list = res?.warehouses || res?.data?.warehouses || res || [];
        setWarehouses(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (alive) setWhError('Could not load warehouses — stock cannot be edited until they load.'); });
    return () => { alive = false; };
  }, []);

  const onHandAt = (sku, warehouseId) => {
    const row = (sku.inventoryByWarehouse || []).find((r) => r.warehouseId === warehouseId);
    return row ? row.onHand : 0;
  };
  const cell = (skuId, warehouseId) => deltas[skuId]?.[warehouseId] ?? '';
  const setCell = (skuId, warehouseId, value) => setDeltas((d) => ({
    ...d, [skuId]: { ...(d[skuId] || {}), [warehouseId]: value },
  }));

  // Every non-zero cell across every SKU and warehouse, flattened.
  const pending = Object.entries(deltas).flatMap(([skuId, byWh]) => Object.entries(byWh)
    .map(([warehouseId, raw]) => ({ skuId, warehouseId, delta: Number.parseInt(raw, 10) }))
    .filter((d) => Number.isInteger(d.delta) && d.delta !== 0));

  const applyStock = async () => {
    if (pending.length === 0) return;
    setBusy(true); setError(null); setOkMsg('');
    try {
      // Sequential, not parallel: each adjustment is its own audited
      // transaction, and a partial failure must leave a clear trail of what
      // was applied rather than an ambiguous burst.
      let applied = 0;
      for (const { skuId, warehouseId, delta } of pending) {
        await adminApi.warehouses.adjustInventory(warehouseId, {
          skuId, delta, reason: reason.trim() || 'Stock adjustment',
        });
        applied += 1;
      }
      setDeltas({});
      setOkMsg(`Applied ${applied} stock change${applied === 1 ? '' : 's'}.`);
      if (onSaved) await onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const editable = canWrite && warehouses.length > 0 && rows.length > 0;

  return (
    <div className="tab-body">
      <div className="dash-grid dash-grid--tight">
        <div className="stat-card"><p className="stat-card__label">On hand (all warehouses)</p><p className="stat-card__value">{sum.totalOnHand}</p></div>
        <div className="stat-card"><p className="stat-card__label">Reserved</p><p className="stat-card__value">{sum.totalReserved}</p></div>
        <div className="stat-card"><p className="stat-card__label">Available</p><p className="stat-card__value">{sum.totalAvailable}</p></div>
        <div className="stat-card"><p className="stat-card__label">SKUs configured</p><p className="stat-card__value">{sum.configuredSkus} / {sum.totalSkus}</p></div>
      </div>

      <p className="tab-body__hint">
        A SKU can be stocked in any number of warehouses — enter a quantity under each one.
        The product still appears once on the storefront; these are stock allocations, not
        catalogue entries. Available = on hand − reserved, computed by the backend.
      </p>

      {whError && <InlineAlert tone="error">{whError}</InlineAlert>}

      {editable && (
        <div className="form-field" style={{ maxWidth: 320, marginBottom: 12 }}>
          <label htmlFor="inv-reason">Reason</label>
          <input id="inv-reason" value={reason} disabled={busy}
            onChange={(e) => setReason(e.target.value)} placeholder="Initial stock" />
          <p className="form-field__hint">Recorded against every movement in the audit ledger.</p>
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table inventory-matrix">
          <thead>
            <tr>
              <th>Colour</th><th>SKU</th><th>Size</th>
              {warehouses.map((w) => (
                <th key={w.id} title={w.code || w.name}>{w.name}{w.isDefault ? ' ★' : ''}</th>
              ))}
              <th>Total</th><th>Reserved</th><th>Available</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ v, s }) => (
              <tr key={s.id}>
                <td>{v.colorName || '—'}</td>
                <td>{s.sku}</td>
                <td>{s.size}</td>
                {warehouses.map((w) => (
                  <td key={w.id} className="inventory-matrix__cell">
                    <span className="inventory-matrix__current">{onHandAt(s, w.id)}</span>
                    {editable && (
                      <input
                        type="number"
                        step={1}
                        value={cell(s.id, w.id)}
                        disabled={busy}
                        placeholder="0"
                        aria-label={`Adjust ${s.sku} at ${w.name}`}
                        onChange={(e) => setCell(s.id, w.id, e.target.value)}
                      />
                    )}
                  </td>
                ))}
                {s.inventory.configured === false
                  ? <td colSpan={3}><Badge tone="muted">Not configured</Badge></td>
                  : (
                    <>
                      <td><strong>{s.inventory.onHand}</strong></td>
                      <td>{s.inventory.reserved}</td>
                      <td>{s.inventory.available}</td>
                    </>
                  )}
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6 + warehouses.length} className="data-table__empty">
                  No SKUs yet — add colours and sizes in Variants first.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      {okMsg && <InlineAlert tone="info">{okMsg}</InlineAlert>}

      {editable && (
        <Button type="button" busy={busy} disabled={pending.length === 0} onClick={applyStock}>
          {pending.length === 0
            ? 'Enter a quantity to apply'
            : `Apply ${pending.length} stock change${pending.length === 1 ? '' : 's'}`}
        </Button>
      )}
    </div>
  );
}

export default InventoryTab;
