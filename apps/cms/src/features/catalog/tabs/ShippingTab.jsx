import { forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { Select } from '../../../components/ui/Select.jsx';
import { Badge } from '../../../components/ui/Badge.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../../api/adminApi.js';
import { useMutation } from '../useMutation.js';
import { toGrams, toMillimetres, gramsToDisplay, mmToDisplay, formatDateTime } from '../../../utils/format.js';

export const ShippingTab = forwardRef(function ShippingTab({ product, canWrite, onSaved, onDirtyChange, embedded = false }, ref) {
  const s = product?.shipping || { weightGrams: null, lengthMm: null, widthMm: null, heightMm: null, status: 'INCOMPLETE', rateReady: false, activeSkuCount: 0, skusWithWeightOverride: 0 };
  const [weightUnit, setWeightUnit] = useState('g');
  const [dimUnit, setDimUnit] = useState('mm');
  const [weight, setWeight] = useState(gramsToDisplay(s.weightGrams, 'g'));
  const [length, setLength] = useState(mmToDisplay(s.lengthMm, 'mm'));
  const [width, setWidth] = useState(mmToDisplay(s.widthMm, 'mm'));
  const [height, setHeight] = useState(mmToDisplay(s.heightMm, 'mm'));
  const [localErr, setLocalErr] = useState('');
  const [result, setResult] = useState(null);
  const [save, { busy, error, reset }] = useMutation((body) => adminApi.catalog.putShipping(product.id, body));

  const norm = (v) => String(v ?? '').trim();
  const dirty = norm(weight) !== norm(gramsToDisplay(s.weightGrams, weightUnit))
    || norm(length) !== norm(mmToDisplay(s.lengthMm, dimUnit))
    || norm(width) !== norm(mmToDisplay(s.widthMm, dimUnit))
    || norm(height) !== norm(mmToDisplay(s.heightMm, dimUnit));

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  const switchWeightUnit = (u) => {
    setWeightUnit(u);
    if (s.weightGrams != null) setWeight(gramsToDisplay(s.weightGrams, u));
  };
  const switchDimUnit = (u) => {
    setDimUnit(u);
    if (s.lengthMm != null) { setLength(mmToDisplay(s.lengthMm, u)); setWidth(mmToDisplay(s.widthMm, u)); setHeight(mmToDisplay(s.heightMm, u)); }
  };

  const doSave = async () => {
    setLocalErr(''); setResult(null); reset();

    // Weight is required — it is the checkout shipping-rate gate (§6).
    if (String(weight).trim() === '') {
      const m = 'Weight is required to calculate checkout shipping rates.';
      setLocalErr(m); throw new Error(m);
    }
    const g = toGrams(weight, weightUnit);
    if (!g.ok) { setLocalErr(g.message); throw new Error(g.message); }

    // Dimensions are optional physical defaults (§7): all three together, or none.
    const dimInputs = [length, width, height].map((v) => String(v).trim());
    const filled = dimInputs.filter((v) => v !== '').length;
    let dims = { lengthMm: null, widthMm: null, heightMm: null };
    if (filled > 0 && filled < 3) {
      const m = 'Enter all three dimensions (length, width, height) together, or leave them all blank.';
      setLocalErr(m); throw new Error(m);
    }
    if (filled === 3) {
      const l = toMillimetres(length, dimUnit);
      const w = toMillimetres(width, dimUnit);
      const h = toMillimetres(height, dimUnit);
      const bad = [l, w, h].find((x) => !x.ok);
      if (bad) { setLocalErr(bad.message); throw new Error(bad.message); }
      dims = { lengthMm: l.value, widthMm: w.value, heightMm: h.value };
    }

    const res = await save({ weightGrams: g.value, ...dims });
    setResult(res);
    onSaved();
    return res;
  };
  useImperativeHandle(ref, () => ({ isDirty: dirty, save: doSave }));

  const submit = async (e) => {
    e.preventDefault();
    try { await doSave(); } catch { /* localErr / error already surfaced */ }
  };

  return (
    <form className="tab-body editor-form" onSubmit={submit}>
      <div className="shipping-status">
        <Badge tone={s.rateReady ? 'good' : 'bad'}>
          Shipping rate ready: {s.rateReady ? 'YES' : 'NO'}
        </Badge>
        <Badge tone={s.status === 'COMPLETE' ? 'good' : 'warn'}>
          {s.status === 'COMPLETE' ? 'Metadata complete' : 'Metadata incomplete'}
        </Badge>
        <span className="text-faint">
          {s.rateReady
            ? 'Weight is set — checkout can quote real Surface / Express rates for this product.'
            : 'Weight is missing — checkout cannot calculate shipping rates and this product is not sellable with real rates.'}
          {' '}
          {s.status === 'COMPLETE'
            ? `Full package metadata set${s.updatedAt ? `, updated ${formatDateTime(s.updatedAt)}` : ''}.`
            : 'Length / width / height are recommended for accurate manifestation (final packed dimensions are confirmed at fulfilment).'}
        </span>
      </div>

      {s.activeSkuCount > 0 && s.skusWithWeightOverride > 0 && (
        <p className="tab-body__hint">
          {s.skusWithWeightOverride} of {s.activeSkuCount} active size(s) carry their own weight override (set on the Variants tab).
          A size without an override uses the product weight below.
        </p>
      )}

      <p className="tab-body__hint">
        Stored as exact grams / millimetres. Enter real measured values — nothing is estimated or defaulted.
      </p>

      <div className="editor-form__grid">
        <div className="unit-field">
          <label htmlFor="ship-weight">Weight <span aria-hidden="true">*</span></label>
          <div className="unit-field__row">
            <input id="ship-weight" type="number" min="0" step="any" required value={weight} onChange={(e) => setWeight(e.target.value)} disabled={!canWrite} />
            <Select id="ship-weight-unit" value={weightUnit} onChange={switchWeightUnit} options={[['g', 'g'], ['kg', 'kg']]} disabled={!canWrite} />
          </div>
        </div>
      </div>

      <div className="editor-form__grid">
        {[['length', length, setLength], ['width', width, setWidth], ['height', height, setHeight]].map(([name, val, setter]) => (
          <div className="unit-field" key={name}>
            <label htmlFor={`ship-${name}`}>{name[0].toUpperCase() + name.slice(1)}</label>
            <div className="unit-field__row">
              <input id={`ship-${name}`} type="number" min="0" step="any" value={val} onChange={(e) => setter(e.target.value)} disabled={!canWrite} />
              <span className="unit-field__unit">{dimUnit}</span>
            </div>
          </div>
        ))}
        <Select id="ship-dim-unit" label="Dimension unit" value={dimUnit} onChange={switchDimUnit} options={[['mm', 'mm'], ['cm', 'cm']]} disabled={!canWrite} />
      </div>

      {(localErr || error) && <InlineAlert tone="error">{localErr || error.message}</InlineAlert>}
      {result && (
        <InlineAlert tone="info">
          Saved. {result.readiness.affectedOrders === 0
            ? 'No open fulfillments reference this product.'
            : `${result.readiness.affectedOrders} open fulfillment(s) re-evaluated, ${result.readiness.changed} changed. Shipments stay in DRAFT — no carrier is contacted.`}
        </InlineAlert>
      )}
      {canWrite && !embedded && <Button type="submit" busy={busy} disabled={!dirty}>Save shipping metadata</Button>}
    </form>
  );
});

export default ShippingTab;
