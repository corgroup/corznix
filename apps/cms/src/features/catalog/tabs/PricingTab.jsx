import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../../api/adminApi.js';
import { useMutation } from '../useMutation.js';
import { formatMoney, rupeesToMinor, minorToRupees } from '../../../utils/format.js';

const PriceRow = forwardRef(function PriceRow({ variant, sku, canWrite, onSaved, onDirty }, ref) {
  const [price, setPrice] = useState(minorToRupees(sku.priceMinor));
  const [sale, setSale] = useState(sku.salePriceMinor != null ? minorToRupees(sku.salePriceMinor) : '');
  const [localErr, setLocalErr] = useState('');
  const [update, { busy, error, reset }] = useMutation((body) => adminApi.catalog.updateSku(sku.id, body));

  const dirty = price !== minorToRupees(sku.priceMinor)
    || sale !== (sku.salePriceMinor != null ? minorToRupees(sku.salePriceMinor) : '');

  useEffect(() => { onDirty?.(sku.id, dirty); }, [dirty, onDirty, sku.id]);
  useEffect(() => () => onDirty?.(sku.id, false), [onDirty, sku.id]);

  const doSave = async () => {
    setLocalErr(''); reset();
    const p = rupeesToMinor(price);
    if (!p.ok) { setLocalErr(p.message); throw new Error(p.message); }
    let saleMinor;
    if (sale === '') saleMinor = null;
    else {
      const sv = rupeesToMinor(sale);
      if (!sv.ok) { setLocalErr(sv.message); throw new Error(sv.message); }
      if (sv.minor > p.minor) { const m = 'Sale price cannot exceed the regular price.'; setLocalErr(m); throw new Error(m); }
      saleMinor = sv.minor;
    }
    const updated = await update({ priceMinor: p.minor, salePriceMinor: saleMinor });
    onSaved(updated);
    return updated;
  };
  useImperativeHandle(ref, () => ({ isDirty: dirty, save: doSave }));

  return (
    <tr>
      <td>{variant.colorName || '—'}</td>
      <td>{sku.sku}</td>
      <td>{sku.size}</td>
      <td>
        <input className="cell-input" type="number" min="0" step="0.01" value={price}
          onChange={(e) => setPrice(e.target.value)} disabled={!canWrite} />
      </td>
      <td>
        <input className="cell-input" type="number" min="0" step="0.01" placeholder="—" value={sale}
          onChange={(e) => setSale(e.target.value)} disabled={!canWrite} />
      </td>
      <td className="text-faint">{formatMoney(sku.salePriceMinor ?? sku.priceMinor, sku.currency)} effective</td>
      <td>
        {(localErr || error) && <InlineAlert tone="error">{localErr || error.message}</InlineAlert>}
        {canWrite && <Button variant="secondary" busy={busy} disabled={!dirty} onClick={doSave}>Save</Button>}
      </td>
    </tr>
  );
});

// The one price the SKU rows below cannot express: what the product shows
// BEFORE a size is chosen — on a listing card, and on the PDP at first paint.
// Left empty, the storefront falls back to the cheapest active SKU, which is
// how one discounted size used to speak for the whole product.
const StandardPriceRow = forwardRef(function StandardPriceRow({ product, canWrite, onSaved, onDirtyChange }, ref) {
  const stored = product.displayPriceMinor != null ? minorToRupees(product.displayPriceMinor) : '';
  const [value, setValue] = useState(stored);
  const [localErr, setLocalErr] = useState('');
  const [update, { busy, error, reset }] = useMutation((body) => adminApi.catalog.updateProduct(product.id, body));

  const dirty = value !== stored;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const doSave = async () => {
    setLocalErr(''); reset();
    let minor = null;
    if (value !== '') {
      const parsed = rupeesToMinor(value);
      if (!parsed.ok) { setLocalErr(parsed.message); throw new Error(parsed.message); }
      minor = parsed.minor;
    }
    const updated = await update({ displayPriceMinor: minor });
    onSaved(updated);
    return updated;
  };
  useImperativeHandle(ref, () => ({ isDirty: dirty, save: doSave }));

  const cheapest = product.variants
    .flatMap((v) => v.skus)
    .filter((s) => s.status === 'ACTIVE')
    .map((s) => s.salePriceMinor ?? s.priceMinor);

  return (
    <section className="editor-card standard-price">
      <div className="editor-card__head">
        <div>
          <h3 className="editor-card__title">Standard price</h3>
          <p className="editor-card__desc">
            Shown wherever no size is selected — listing cards, and the product page before a size is picked.
            Leave it empty to show the lowest priced size
            {cheapest.length ? ` (currently ${formatMoney(Math.min(...cheapest))})` : ''}.
            Customers are always charged the price of the size they choose, never this one.
          </p>
        </div>
      </div>
      <div className="editor-card__body standard-price__body">
        <input
          className="cell-input" type="number" min="0" step="0.01" placeholder="Lowest priced size"
          value={value} onChange={(e) => setValue(e.target.value)} disabled={!canWrite}
          aria-label="Standard display price in rupees"
        />
        {canWrite && <Button variant="secondary" busy={busy} disabled={!dirty} onClick={doSave}>Save</Button>}
        {(localErr || error) && <InlineAlert tone="error">{localErr || error.message}</InlineAlert>}
      </div>
    </section>
  );
});

export const PricingTab = forwardRef(function PricingTab({ product, canWrite, onSaved, onDirtyChange }, ref) {
  const rows = product.variants.flatMap((v) => v.skus.map((s) => ({ v, s })));
  const rowRefs = useRef(new Map());
  const standardRef = useRef(null);
  const [standardDirty, setStandardDirty] = useState(false);
  const [dirtyRows, setDirtyRows] = useState(() => new Set());

  const report = useCallback((skuId, isDirty) => {
    setDirtyRows((prev) => {
      const had = prev.has(skuId);
      if (Boolean(isDirty) === had) return prev;
      const next = new Set(prev);
      if (isDirty) next.add(skuId); else next.delete(skuId);
      return next;
    });
  }, []);

  const dirty = dirtyRows.size > 0 || standardDirty;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  useImperativeHandle(ref, () => ({
    isDirty: dirty,
    save: async () => {
      if (standardDirty) await standardRef.current?.save();
      for (const { s } of rows) {
        if (dirtyRows.has(s.id)) {
          const h = rowRefs.current.get(s.id);
          if (h) await h.save();
        }
      }
    },
  }));

  return (
    <div className="tab-body">
      <StandardPriceRow
        ref={standardRef} product={product} canWrite={canWrite}
        onSaved={onSaved} onDirtyChange={setStandardDirty}
      />
      <p className="tab-body__hint">Prices are stored in paise; enter rupees. Sale price must not exceed the regular price.</p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Colour</th><th>SKU</th><th>Size</th><th>Price (₹)</th><th>Sale (₹)</th><th>Effective</th><th /></tr>
          </thead>
          <tbody>
            {rows.map(({ v, s }) => (
              <PriceRow
                key={s.id}
                ref={(h) => { if (h) rowRefs.current.set(s.id, h); else rowRefs.current.delete(s.id); }}
                variant={v} sku={s} canWrite={canWrite} onSaved={onSaved} onDirty={report}
              />
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="data-table__empty">Add a variant and SKU first.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
});

export default PricingTab;
