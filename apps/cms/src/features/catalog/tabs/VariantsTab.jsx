import { useState } from 'react';
import { Button } from '../../../components/ui/Button.jsx';
import { FormField } from '../../../components/ui/FormField.jsx';
import { Select } from '../../../components/ui/Select.jsx';
import { Badge } from '../../../components/ui/Badge.jsx';
import { InlineAlert } from '../../../components/feedback/InlineAlert.jsx';
import { adminApi } from '../../../api/adminApi.js';
import { useMutation } from '../useMutation.js';
import { rupeesToMinor } from '../../../utils/format.js';
import {
  useSkuOptions, allowedSizes, normalizeDesignCode, designCodeError,
} from '../skuIdentity.js';

function variantCodes(options, product, variant) {
  const pt = (options?.productTypes || []).find((t) => t.id === product.productTypeCodeId);
  const fit = (options?.fits || []).find((f) => f.id === product.fitCodeId);
  const color = (options?.colors || []).find((c) => c.id === variant.colorCodeId);
  return {
    productTypeCode: pt?.code || null,
    fitCode: fit?.code || null,
    colorCode: color?.code || null,
    designCode: variant.designCode || null,
    sizeFamily: pt?.sizeFamily || null,
  };
}

// ---- multi-size add for one colour ---------------------------------
function SizeMultiAdd({ productId, variant, codes, defaultPrice, canWrite, onSaved, preselect = [] }) {
  const [picked, setPicked] = useState(() => preselect);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  if (!canWrite) return null;

  const missing = [];
  if (!codes.productTypeCode) missing.push('product type code');
  if (!codes.fitCode) missing.push('fit code');
  if (!codes.colorCode) missing.push('colour code');
  if (!codes.designCode) missing.push('design code');
  if (missing.length) {
    return <p className="tab-body__hint">Set the {missing.join(', ')} above to add sizes.</p>;
  }

  const all = allowedSizes({ sizeRules: codes.sizeRules }, codes.sizeFamily);
  const existing = new Set(variant.skus.map((s) => s.size));
  const available = all.filter((z) => !existing.has(z));
  if (available.length === 0) return <p className="text-faint">Every size for this size family has been added.</p>;

  const toggle = (z) => setPicked((p) => (p.includes(z) ? p.filter((x) => x !== z) : [...p, z]));
  const pickedCount = picked.filter((z) => available.includes(z)).length;

  const add = async () => {
    setErr('');
    const price = rupeesToMinor(defaultPrice);
    if (!price.ok) { setErr(`Default price: ${price.message}`); return; }
    setBusy(true);
    let last;
    try {
      for (const size of picked.filter((z) => available.includes(z))) {
        last = await adminApi.catalog.createSku(productId, { variantId: variant.id, size, priceMinor: price.minor });
      }
      setPicked([]);
      if (last) onSaved(last);
    } catch (e) {
      setErr(e?.message || 'Could not add every size.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="size-multi-add">
      <p className="tab-body__hint">Pick the sizes to add. Each becomes its own SKU at the default price (editable after).</p>
      <div className="size-chips">
        {available.map((z) => (
          <label key={z} className={`size-chip${picked.includes(z) ? ' is-on' : ''}`}>
            <input type="checkbox" checked={picked.includes(z)} onChange={() => toggle(z)} />
            {z}
          </label>
        ))}
      </div>
      {err && <InlineAlert tone="error">{err}</InlineAlert>}
      <Button variant="soft" busy={busy} disabled={pickedCount === 0}
        onClick={add}>
        Add {pickedCount || ''} size{pickedCount === 1 ? '' : 's'}
      </Button>
    </div>
  );
}

// ---- one SKU row (inline price + status + remove) ------------------
function SkuRow({ sku, canWrite, onSaved }) {
  const [price, setPrice] = useState(sku.priceMinor == null ? '' : String(sku.priceMinor / 100));
  const [sale, setSale] = useState(sku.salePriceMinor == null ? '' : String(sku.salePriceMinor / 100));
  const [localErr, setLocalErr] = useState('');
  const [update, { busy, error, reset }] = useMutation((body) => adminApi.catalog.updateSku(sku.id, body));
  const locked = sku.identityLocked;

  const dirty = price !== (sku.priceMinor == null ? '' : String(sku.priceMinor / 100))
    || sale !== (sku.salePriceMinor == null ? '' : String(sku.salePriceMinor / 100));

  const savePrice = async () => {
    setLocalErr(''); reset();
    const p = rupeesToMinor(price);
    if (!p.ok) { setLocalErr(p.message); return; }
    let saleMinor;
    if (sale === '') saleMinor = null;
    else {
      const s = rupeesToMinor(sale);
      if (!s.ok) { setLocalErr(s.message); return; }
      if (s.minor > p.minor) { setLocalErr('Sale price cannot exceed the regular price.'); return; }
      saleMinor = s.minor;
    }
    onSaved(await update({ priceMinor: p.minor, salePriceMinor: saleMinor }));
  };
  const remove = async () => {
    if (!window.confirm(`Remove ${sku.sku}?`)) return;
    onSaved(await update({ status: 'ARCHIVED' }));
  };

  return (
    <tr>
      <td><code>{sku.sku}</code>{locked && <span className="badge-pill badge-pill--warn" style={{ marginLeft: 6 }} title="Has order/inventory history">locked</span>}</td>
      <td>{sku.size}</td>
      <td>
        <input className="cell-input" type="number" min="0" step="0.01" value={price} disabled={!canWrite}
          onChange={(e) => setPrice(e.target.value)} aria-label={`${sku.sku} price`} />
      </td>
      <td>
        <input className="cell-input" type="number" min="0" step="0.01" placeholder="—" value={sale} disabled={!canWrite}
          onChange={(e) => setSale(e.target.value)} aria-label={`${sku.sku} sale price`} />
      </td>
      <td><Badge>{sku.status}</Badge></td>
      <td className="sku-row__actions">
        {(localErr || error) && <InlineAlert tone="error">{localErr || error.message}</InlineAlert>}
        {canWrite && dirty && <button type="button" className="linkish" onClick={savePrice} disabled={busy}>Save</button>}
        {canWrite && !locked && <button type="button" className="linkish linkish--danger" onClick={remove} disabled={busy}>Remove</button>}
      </td>
    </tr>
  );
}

// ---- one colour variant ------------------------------------------
function VariantBlock({ productId, product, variant, options, defaultPrice, canWrite, onSaved, offeredSizes = [] }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    colorName: variant.colorName || '', badge: variant.badge || '', colorCodeId: variant.colorCodeId || '',
    designName: variant.designName || '', designCode: variant.designCode || '',
  });
  const [update, { busy, error }] = useMutation((body) => adminApi.catalog.updateVariant(variant.id, body));

  const codes = { ...variantCodes(options, product, variant), sizeRules: options?.sizeRules };
  const dcErr = designCodeError(form.designCode);
  const anyLocked = variant.skus.some((s) => s.identityLocked);
  const activeSkus = variant.skus.filter((s) => s.status !== 'ARCHIVED');
  const colours = (options?.colors || []).filter((c) => c.status === 'ACTIVE');

  const saveVariant = async () => {
    const updated = await update({
      colorName: form.colorName.trim(),
      badge: form.badge.trim() || null,
      colorCodeId: form.colorCodeId || null,
      designName: form.designName.trim() || null,
      designCode: normalizeDesignCode(form.designCode) || null,
    });
    setEditing(false);
    onSaved(updated);
  };
  const removeColour = async () => {
    if (anyLocked) return;
    if (!window.confirm(`Remove the ${variant.colorName || 'colour'} variant and its ${activeSkus.length} SKU(s)?`)) return;
    onSaved(await update({ status: 'ARCHIVED' }));
  };

  return (
    <div className="variant-block">
      <div className="variant-block__head">
        <span className="variant-block__swatch" style={{ background: variant.colorHex || '#ccc' }} aria-hidden="true" />
        {editing ? (
          <form className="inline-editor inline-editor--row" onSubmit={(e) => { e.preventDefault(); saveVariant(); }}>
            <FormField id={`vn-${variant.id}`} label="Colour name" value={form.colorName} onChange={(v) => setForm((s) => ({ ...s, colorName: v }))} />
            <Select id={`vcc-${variant.id}`} label="Colour code" value={form.colorCodeId || ''} onChange={(v) => setForm((s) => ({ ...s, colorCodeId: v || '' }))}
              includeBlank blankLabel="— choose —" disabled={anyLocked} options={colours.map((c) => [c.id, `${c.label} (${c.code})`])} />
            <FormField id={`vdn-${variant.id}`} label="Design name" value={form.designName} onChange={(v) => setForm((s) => ({ ...s, designName: v }))} placeholder="e.g. Plain" />
            <FormField id={`vdc-${variant.id}`} label="Design code" value={form.designCode} onChange={(v) => setForm((s) => ({ ...s, designCode: v }))} disabled={anyLocked} placeholder="e.g. PLN" />
            <FormField id={`vb-${variant.id}`} label="Badge (optional)" value={form.badge} onChange={(v) => setForm((s) => ({ ...s, badge: v }))} />
            {dcErr && <InlineAlert tone="warning">{dcErr}</InlineAlert>}
            {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
            <div className="inline-editor__actions">
              <Button type="submit" busy={busy} disabled={Boolean(dcErr)}>Save colour</Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <>
            <div>
              <strong>{variant.colorName || 'Unnamed colour'}</strong>
              {codes.colorCode && <span className="variant-block__meta">{codes.colorCode}</span>}
              {variant.designCode && <span className="variant-block__meta">/ {variant.designCode}{variant.designName ? ` · ${variant.designName}` : ''}</span>}
              {variant.badge && <span className="variant-block__badge">{variant.badge}</span>}
            </div>
            {canWrite && <button type="button" className="linkish" onClick={() => setEditing(true)}>Edit</button>}
            {canWrite && !anyLocked && <button type="button" className="linkish linkish--danger" onClick={removeColour}>Remove colour</button>}
          </>
        )}
      </div>

      {/* Scrolls sideways inside its own box. The editor card clips overflow
          (for its rounded corners), so a SKU table wider than the card used
          to cut off the price inputs and the Remove action. */}
      {activeSkus.length > 0 && (
        <div className="table-wrap table-wrap--nested">
          <table className="data-table data-table--nested">
            <thead>
              <tr><th>SKU</th><th>Size</th><th>Price (₹)</th><th>Sale (₹)</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {activeSkus.map((s) => <SkuRow key={s.id} sku={s} canWrite={canWrite} onSaved={onSaved} />)}
            </tbody>
          </table>
        </div>
      )}

      <SizeMultiAdd productId={productId} variant={variant} codes={codes} defaultPrice={defaultPrice} canWrite={canWrite} onSaved={onSaved} preselect={offeredSizes} />
    </div>
  );
}

// ---- add a colour ------------------------------------------------
function AddColour({ productId, options, canWrite, onSaved }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ colorName: '', colorHex: '', colorCodeId: '', designName: '', designCode: '', badge: '' });
  const [create, { busy, error }] = useMutation((body) => adminApi.catalog.createVariant(productId, body));
  const set = (k) => (v) => setForm((s) => ({ ...s, [k]: v }));
  const dcErr = designCodeError(form.designCode);
  const colours = (options?.colors || []).filter((c) => c.status === 'ACTIVE');
  if (!canWrite) return null;
  if (!open) return <Button variant="soft" onClick={() => setOpen(true)}>+ Add colour</Button>;

  return (
    <form
      className="inline-editor"
      onSubmit={async (e) => {
        e.preventDefault();
        const updated = await create({
          colorName: form.colorName.trim(),
          colorHex: form.colorHex.trim() || undefined,
          colorCodeId: form.colorCodeId || null,
          designName: form.designName.trim() || null,
          designCode: normalizeDesignCode(form.designCode) || null,
          badge: form.badge.trim() || undefined,
        });
        setForm({ colorName: '', colorHex: '', colorCodeId: '', designName: '', designCode: '', badge: '' });
        setOpen(false);
        onSaved(updated);
      }}
    >
      <FormField id="v-color" label="Colour name" value={form.colorName} onChange={set('colorName')} required placeholder="e.g. Black" />
      <FormField id="v-hex" label="Hex (optional)" value={form.colorHex} onChange={set('colorHex')} placeholder="111111" />
      <Select id="v-cc" label="Colour code" value={form.colorCodeId || ''} onChange={(v) => set('colorCodeId')(v || '')} includeBlank blankLabel="— choose —"
        options={colours.map((c) => [c.id, `${c.label} (${c.code})`])} />
      <FormField id="v-dn" label="Design name" value={form.designName} onChange={set('designName')} placeholder="e.g. Plain" />
      <FormField id="v-dc" label="Design code" value={form.designCode} onChange={set('designCode')} placeholder="e.g. PLN" />
      <FormField id="v-badge" label="Badge (optional)" value={form.badge} onChange={set('badge')} />
      {dcErr && <InlineAlert tone="warning">{dcErr}</InlineAlert>}
      {error && <InlineAlert tone="error">{error.message}</InlineAlert>}
      <div className="inline-editor__actions">
        <Button variant="soft" type="submit" busy={busy} disabled={!form.colorName.trim() || Boolean(dcErr)}>Add colour</Button>
        <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
      </div>
    </form>
  );
}

export function VariantsTab({ product, canWrite, onSaved, offeredSizes = [] }) {
  const skuOptions = useSkuOptions();
  const options = skuOptions.data;
  const [startPrice, setStartPrice] = useState('');

  const activeVariants = product.variants.filter((v) => v.status !== 'ARCHIVED');
  const skuCount = activeVariants.reduce((n, v) => n + v.skus.filter((s) => s.status !== 'ARCHIVED').length, 0);
  const hasCodes = Boolean(product.productTypeCodeId && product.fitCodeId);

  return (
    <div className="tab-body">
      {skuOptions.status === 'error' && <InlineAlert tone="warning">Could not load the SKU code list.</InlineAlert>}

      {!hasCodes && (
        <InlineAlert tone="warning">
          Choose a product type code and fit code in <strong>Basic information</strong> before building SKUs.
        </InlineAlert>
      )}

      <p className="tab-body__hint">
        Add a colour (with its colour + design code), then pick the sizes to generate. Each size becomes one SKU;
        the SKU code is generated by the backend. Set final prices in the <strong>Pricing</strong> step.
      </p>

      <div className="editor-form__grid" style={{ maxWidth: 360 }}>
        <FormField id="start-price" label="Starting price (₹)" type="number" value={startPrice}
          onChange={setStartPrice} placeholder="e.g. 1199" />
      </div>
      <p className="tab-body__hint">New SKUs are created at this price — adjust each one in the Pricing step.</p>

      {activeVariants.map((v) => (
        <VariantBlock
          key={v.id} productId={product.id} product={product} variant={v} options={options}
          defaultPrice={startPrice} canWrite={canWrite} onSaved={onSaved} offeredSizes={offeredSizes}
        />
      ))}
      {activeVariants.length === 0 && <p className="text-faint">No colours yet — add one to start building SKUs.</p>}

      <AddColour productId={product.id} options={options} canWrite={canWrite} onSaved={onSaved} />

      {skuCount > 0 && <p className="tab-body__hint">{skuCount} SKU{skuCount === 1 ? '' : 's'} across {activeVariants.length} colour{activeVariants.length === 1 ? '' : 's'}.</p>}
    </div>
  );
}

export default VariantsTab;
